/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * TUI 应用状态机：键事件 + Agent 运行时事件 → 视图状态。
 *
 * 本模块**不接触终端**（不读 stdin / 不写 stdout）：屏幕参数由调用方给，
 * 帧渲染交给 views.composeFrame，退出/响铃等副作用走 onQuit 回调。
 * 因此可以用脚本化键事件 + 字符串屏幕做完整自动化测试。
 */

'use strict';

const { LineEditor } = require('./editor.js');
const { themeFromEnv, themeFromSettings } = require('./theme.js');
const {
  parseInput,
  suggestCommands,
  suggestArgs,
  expandCustomCommand,
  helpLines,
  loadCustomCommands,
  defaultCommandDirs,
} = require('./commands.js');
const views = require('./views.js');
const { t, setLanguage } = require('./text.js');
const { pointAt, selectedText } = require('./selection');
const { ConfigBrowser } = require('./config');
const { TranscriptSearch } = require('./transcript-search');

const MODES = ['chat', 'babe', 'code'];

class TuiApp {
  constructor(options = {}) {
    this.runtime = options.runtime;
    if (!this.runtime) throw new TypeError('TuiApp: runtime is required');
    this.theme = options.theme || themeFromEnv();
    this.onQuit = options.onQuit || (() => {});
    this.onCopy = options.onCopy || require('./clipboard').copyText;
    this.preferences = options.preferences;
    this._thinkingExpanded = true;
    this.clock = options.clock || (() => Date.now());
    this.editor = new LineEditor({ history: options.history || [] });
    this.attachments = [];
    this.env = options.env || (typeof process !== 'undefined' ? process.env : {});
    this.customCommands = new Map();
    this._completionSelected = 0;

    this.state = {
      theme: this.theme,
      width: options.width || 100,
      height: options.height || 30,
      mode: 'chat',
      messages: [],
      modal: null,
      running: false,
      blink: true,
      spinnerFrame: 0,
      spinnerLabel: t('ui.tui.spinnerThinking', '思考中'),
      elapsedMs: 0,
      scrollOffset: 0,
      toast: null,
      title: '',
      model: '',
      workspace: '',
      affection: null,
      usage: null,
      costUSD: 0,
      context: null,
      compaction: null,
      boot: null, // VM 启动中：{ progress, detail }；就绪/失败后置 null
      thinkingExpanded: true, // TUI-only persisted /thinking preference
      todos: [],
      editorText: '',
      editorCursor: 0,
    };

    this.configBrowser = new ConfigBrowser(this);
    this.transcriptSearch = new TranscriptSearch(this);
    this.activeKey = null;
    this.quitArmedAt = null;
    this._toolEntries = new Map(); // callId / seq → 工具条目
    this._streamEntry = null;
    this._startedAt = 0;
    this._eventQueue = Promise.resolve();
    this._unsubscribe = null;
    this._pending = Promise.resolve();
    this._sessionViews = new Map();
  }

  // ---------------------------------------------------------------- 生命周期函数

  /** 启动：建会话、订阅事件、渲染欢迎语 */
  async start(opts = {}) {
    const mode = MODES.includes(opts.mode) ? opts.mode : 'chat';
    this.state.mode = mode;
    this._unsubscribe = this.runtime.onEvent((event) => {
      this._eventQueue = this._eventQueue
        .then(() => this.handleRuntimeEvent(event))
        .catch(() => {});
    });

    try {
      this._systemDark = (await this.runtime.getSystemTheme?.())?.shouldUseDarkColors;
      const settings = await this.runtime.getSettings();
      const model = settings && settings.llm ? settings.llm.model : '';
      this.state.model = model || '';
      if (settings && settings.babe && typeof settings.babe.initialAffection === 'number') {
        this.state.initialAffection = settings.babe.initialAffection;
      }
      this._applySettings(settings);
    } catch {
      /* 设置读取失败不阻塞启动 */
    }
    if (this._disposed) return this;
    if (this.preferences && !this.state.settings?.tui) {
      try {
        const saved = await this.preferences.load();
        this._thinkingExpanded = saved?.thinkingExpanded !== false;
        this.state.thinkingExpanded = this._thinkingExpanded;
      } catch {
        /* Default to showing complete reasoning. */
      }
    }
    if (this._disposed) return this;
    // Create the first view with the saved language, appearance and affection.
    const existing =
      !opts.workspacePath &&
      this.runtime
        .listSessions?.()
        .filter((session) => session.mode === mode && session.profile !== 'settings-assistant')
        .at(-1);
    if (existing) await this._switchSession(existing.key);
    else await this.newSession(mode, opts.workspacePath, { local: opts.workspaceLocal });
    if (typeof this.runtime.getTodos === 'function')
      this.state.todos = await this.runtime.getTodos();
    this.pushEntry({
      kind: 'notice',
      text: t('ui.tui.brand', 'CIBYP · 全能 AI 伙伴 · 终端模式（/help 查看命令）'),
    });
    this._reloadCustomCommands();
    return this;
  }

  /**
   * 沿用 GUI 的设置项：主题（dark/light/system）、强调色、界面语言。
   * CIBYP_TUI_THEME 显式指定时优先于设置。
   */
  _applySettings(settings) {
    if (!settings) return;
    this.theme = themeFromSettings(settings, this.env, this._systemDark);
    if (settings.tui) this._thinkingExpanded = settings.tui.thinkingExpanded !== false;
    this.state.thinkingExpanded = this._thinkingExpanded;
    this.state.theme = this.theme;
    for (const [key, view] of this._sessionViews) {
      view.state.settings = settings;
      view.state.theme = this.theme;
      view.state.thinkingExpanded = this._thinkingExpanded;
      view.state.tarotVisible = settings.tarotVisible !== false;
      view.state.model = this.runtime.getSession?.(key)?.model || settings.llm?.model || '';
    }
    this.state.settings = settings;
    this.state.tarotVisible = settings.tarotVisible !== false;
    this.state.model =
      this.runtime.getSession?.(this.activeKey)?.model || settings.llm?.model || '';
    // 界面语言：中文为源文（回退），en/de 走 i18n 词典（与 GUI 的 settings.language 一致）
    try {
      const language = settings.language || 'zh-CN';
      setLanguage(language);
      if (typeof this.runtime.setLanguage === 'function') {
        this.runtime.setLanguage(language);
      } else if (typeof globalThis.i18nSetLanguage === 'function') {
        globalThis.i18nSetLanguage(language);
      }
    } catch {
      /* 语言设置失败不阻塞 */
    }
  }

  async refreshSettings() {
    this._systemDark = (await this.runtime.getSystemTheme?.())?.shouldUseDarkColors;
    this._applySettings(await this.runtime.getSettings());
    this._reloadCustomCommands();
  }

  /** 重载自定义命令（用户目录 + 工作区目录） */
  _reloadCustomCommands() {
    this.customCommands = loadCustomCommands(
      defaultCommandDirs({ env: this.env, workspace: this.state.workspace || undefined }),
    );
    return this.customCommands;
  }

  dispose() {
    this._disposed = true;
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
    for (const key of this._sessionViews.keys()) this.runtime.stop(key);
  }

  /** 等待事件队列排空（测试用） */
  settled() {
    return this._eventQueue;
  }

  /** 设置 VM 启动进度（null = 清除，进主界面） */
  setBootStatus(boot) {
    this.state.boot = boot && typeof boot === 'object' ? boot : null;
    if (this.state.boot) this.state.scrollOffset = 0;
  }

  resize(width, height) {
    this.state.selection = null;
    this.state.width = width;
    this.state.height = height;
    this.state.scrollOffset = 0;
  }

  /** 动画时钟（spinner / 闪烁 / 计时） */
  tick() {
    for (const view of this._sessionViews.values()) {
      if (view.state.toast?.expiresAt <= this.clock()) view.state.toast = null;
    }
    this.state.spinnerFrame =
      this.state.settings?.animations === false ? 0 : (this.state.spinnerFrame + 1) % 12;
    this.state.blink = this.state.settings?.animations === false ? false : !this.state.blink;
    const selection = this.state.selection;
    if (selection?.dragging && selection.moved) {
      const transcript = this.frame().transcript;
      if (transcript?.rowLines.length) {
        const direction =
          selection.mouse.y <= 2 ? 2 : selection.mouse.y >= transcript.rowLines.length ? -2 : 0;
        if (direction) {
          this._scroll(direction);
          this._extendSelection(selection.mouse);
        }
      }
    }
    if (this.state.running && this._startedAt) {
      this.state.elapsedMs = this.clock() - this._startedAt;
    }
  }

  /** 渲染一帧 */
  frame() {
    this.state.now = this.clock();
    this.state.editorText = this.editor.value;
    this.state.editorCursor = this.editor.cursor;
    this.state.completion = this._computeCompletion();
    let frame = views.composeFrame(this.state, {
      hints: this._footerHints(),
      inputHint: this._inputHint(),
    });
    if (this.state.search) {
      const locate = this.state.search.locate;
      this.transcriptSearch.update(
        frame.transcript?.lines || [],
        frame.transcript?.rowLines.length || 10,
      );
      if (locate) {
        this.state.scrollLineCount = frame.scroll?.totalLines;
        frame = views.composeFrame(this.state, {
          hints: this._footerHints(),
          inputHint: this.state.search.hint,
        });
      }
    }
    this.state.scrollOffset = frame.scroll?.offset || 0;
    this.state.scrollLineCount = frame.scroll?.totalLines;
    frame.title = this.state.title;
    frame.palette = { foreground: this.theme.text, background: this.theme.background };
    frame.mouseEnabled = this.state.settings?.tui?.mouse !== false;
    return frame;
  }

  /** Bound navigation using the same wrapped lines and viewport as rendering. */
  _scroll(delta) {
    const { offset = 0, maxOffset = 0 } = this.frame().scroll || {};
    this.state.scrollOffset = Math.max(0, Math.min(maxOffset, offset + delta));
  }

  /** 输入框上方的补全面板（命令 / 参数） */
  _computeCompletion() {
    const text = this.editor.value;
    // Esc 关闭过面板：同一段文本不再弹出，直到文本变化
    if (this._completionDismissedText != null) {
      if (this._completionDismissedText === text) return null;
      this._completionDismissedText = null;
    }
    const trimmed = text.trimStart();
    if (!trimmed.startsWith('/')) return null;
    const hasSpace = /\s/.test(trimmed);
    if (!hasSpace) {
      const items = suggestCommands(trimmed, { customCommands: this.customCommands });
      if (items.length === 0) return null;
      return {
        kind: 'command',
        items,
        selected: Math.min(this._completionSelected, items.length - 1),
      };
    }
    const spaceIndex = trimmed.search(/\s/);
    const name = trimmed.slice(1, spaceIndex).toLowerCase();
    const argPrefix = trimmed.slice(spaceIndex + 1);
    if (/\s/.test(argPrefix)) return null;
    const items = suggestArgs(name, argPrefix, { modes: MODES });
    if (items.length === 0) return null;
    return {
      kind: 'arg',
      items,
      selected: Math.min(this._completionSelected, items.length - 1),
    };
  }

  /** 补全面板按键；返回 true=已消费，'submit'=接受并执行 */
  _handleCompletionKey(key) {
    const completion = this.state.completion;
    if (!completion || !key) return false;
    const items = completion.items;
    if (key.name === 'escape') {
      this._completionSelected = 0;
      this.state.completion = null;
      this._completionDismissedText = this.editor.value;
      return true;
    }
    if (key.name === 'up' || (key.name === 'char' && key.ctrl && key.char === 'p')) {
      this._completionSelected = (completion.selected + items.length - 1) % items.length;
      return true;
    }
    if (key.name === 'down' || (key.name === 'char' && key.ctrl && key.char === 'n')) {
      this._completionSelected = (completion.selected + 1) % items.length;
      return true;
    }
    if (key.name === 'tab') {
      this._acceptCompletion(items[completion.selected]);
      return true;
    }
    if (key.name === 'enter' && !key.alt && completion.kind === 'command') {
      // 命令补全面板打开时回车 = 补全并执行选中命令
      this._acceptCompletion(items[completion.selected]);
      return 'submit';
    }
    return false;
  }

  /** 把选中的补全项写回输入框 */
  _acceptCompletion(item) {
    if (!item) return;
    const text = this.editor.value;
    const trimmed = text.trimStart();
    const lead = text.length - trimmed.length;
    if (this.state.completion && this.state.completion.kind === 'arg') {
      const spaceIndex = trimmed.search(/\s/);
      const head = text.slice(0, lead + spaceIndex + 1);
      this.editor.setValue(head + item.value + ' ');
    } else {
      this.editor.setValue(item.value + (item.hint ? ' ' : ''));
    }
    this._completionSelected = 0;
    // 接受补全后对同一段文本不再弹出（避免刚补完又弹建议）
    this._completionDismissedText = this.editor.value;
  }

  // ---------------------------------------------------------------- 键事件

  /** @returns {Promise<boolean>} 是否消费了该按键 */
  async handleKey(key) {
    const state = this.state;
    if (!(key?.ctrl && key.name === 'char' && ['c', 'd'].includes(key.char)))
      this.quitArmedAt = null;
    if (!this.state.toast?.expiresAt) this.state.toast = null;
    // 先刷新补全面板：面板必须与当前输入同步，
    // 否则文本变化后回车会"补全"成陈旧建议（吞掉已输入的参数）。
    this.state.completion = this._computeCompletion();
    try {
      return await this._dispatchKey(key);
    } catch (error) {
      state.messages.push({ kind: 'system', text: error.message || String(error) });
      return true;
    } finally {
      this.state.completion = this._computeCompletion();
    }
  }

  async _dispatchKey(key) {
    if (this.state.boot || !this.activeKey) {
      if (key?.name === 'escape' || (key?.ctrl && ['c', 'd'].includes(key.char))) this.onQuit();
      return true;
    }
    if (key?.name === 'mouse') return this._handleMouse(key);
    if (key?.name === 'wheel') return this._handleWheel(key);
    if (this.state.selection && key?.ctrl && key.char === 'c') {
      const text = selectedText(this.state.selection, this.frame().transcript?.lines || []);
      if (text) {
        try {
          await this.onCopy(text);
          this.state.toast = { text: t('ui.tui.copied', '已复制选中的消息') };
        } catch (error) {
          this.state.toast = { text: error.message || String(error) };
        }
        return true;
      }
    }
    if (this.state.selection && key?.name === 'escape') {
      this.state.selection = null;
      return true;
    }
    if (!['wheel', 'pageup', 'pagedown'].includes(key?.name)) this.state.selection = null;
    if (this.state.modal?.kind?.startsWith('config')) return this.configBrowser.handle(key);
    if (this.state.modal) return this._handleModalKey(key);
    if (key.ctrl && key.char === 'f') {
      this.transcriptSearch.open();
      return true;
    }
    if (this.transcriptSearch.handle(key)) return true;

    const completionResult = this._handleCompletionKey(key);
    if (completionResult === 'submit') {
      const text = this.editor.commit();
      this._completionSelected = 0;
      await this._submit(text);
      return true;
    }
    if (completionResult) return true;

    const global = await this._handleGlobalKey(key);
    if (global) return true;

    const result = this.editor.handleKey(key);
    if (result === 'submit') {
      const text = this.editor.commit();
      this._completionSelected = 0;
      await this._submit(text);
      return true;
    }
    return result === 'handled';
  }

  async _handleGlobalKey(key) {
    if (!key) return false;
    if (key.name === 'wheel') {
      // 鼠标滚轮：滚动聊天记录（历史调阅只走 ↑↓/Ctrl+P/N，不再被滚轮触发）
      const step = key.ctrl ? Math.floor(this.state.height / 2) : 3;
      this._scroll(key.direction === 'up' ? step : -step);
      if (this.state.selection?.dragging) this._extendSelection(this.state.selection.mouse);
      return true;
    }
    if (key.name === 'escape') {
      if (this.state.running) {
        this._stop();
      } else if (!this.editor.isEmpty) {
        this.editor.clear();
      }
      return true;
    }
    if (key.name === 'char' && key.ctrl && key.char === 'c') {
      return this._armQuitOrStop();
    }
    if (key.name === 'char' && key.ctrl && key.char === 'd') {
      if (this.editor.isEmpty) return this._armQuitOrStop();
      return false; // 非空输入交给编辑器（删除）
    }
    if (key.name === 'char' && key.ctrl && key.char === 'l') {
      this.state.scrollOffset = 0;
      return true;
    }
    if (key.name === 'char' && key.ctrl && key.char === 't') {
      this._openTodoModal();
      return true;
    }
    if (key.name === 'char' && key.ctrl && key.char === 'r') {
      await this._openHistoryModal();
      return true;
    }
    if (key.name === 'tab' && key.shift) {
      const next = MODES[(MODES.indexOf(this.state.mode) + 1) % MODES.length];
      await this.newSession(next);
      return true;
    }
    if (key.name === 'pageup') {
      this._scroll(Math.floor(this.state.height / 2));
      return true;
    }
    if (key.name === 'pagedown') {
      this._scroll(-Math.floor(this.state.height / 2));
      return true;
    }
    return false;
  }

  async _handleMouse(key) {
    if (this.state.settings?.tui?.mouse === false || key.shift) return true;
    if (key.button === 'right' && key.press && this.state.selection?.moved) {
      await this._copySelection();
      return true;
    }
    if (key.button !== 'left') return true;
    const frame = this.frame();
    const toast = frame.toastBounds;
    if (
      toast &&
      key.y > toast.top &&
      key.y <= toast.top + toast.height &&
      key.x > toast.left &&
      key.x <= toast.left + toast.width
    )
      return true;
    const hit = frame.hits?.modal.find((item) => item.row === key.y);
    const modal = this.state.modal;
    if (modal && hit) {
      if (key.press && !key.motion) {
        modal.selected = hit.index;
        this._mouseOption = { modal, index: hit.index };
      } else if (!key.press) {
        const pressed = this._mouseOption;
        this._mouseOption = null;
        if (pressed?.modal === modal && pressed.index === hit.index && !modal.busy) {
          if (modal.kind.startsWith('config')) await this.configBrowser.handle({ name: 'enter' });
          else await this._chooseModalOption(hit.index);
        }
      }
      return true;
    }
    const input = frame.hits?.input.find((item) => item.row === key.y);
    if (input && key.press && !key.motion && key.x > 1 && key.x < this.state.width) {
      const editor = this.state.search?.active
        ? this.state.search.editor
        : modal?.inputMode
          ? modal.editor
          : !modal
            ? this.editor
            : null;
      if (editor) {
        const nearest = input.points.reduce((best, point) =>
          Math.abs(point.column - key.x) < Math.abs(best.column - key.x) ? point : best,
        );
        editor.cursor = nearest.index;
      }
      this.state.selection = null;
      this._mouseOption = null;
      return true;
    }
    const completion = frame.hits?.completion.find((item) => item.row === key.y);
    if (!modal && completion) {
      if (key.press && !key.motion) {
        this._completionSelected = completion.index;
        this._mouseCompletion = this.state.completion?.items[completion.index];
      } else if (!key.press) {
        const item = this.state.completion?.items[completion.index];
        // Complete on release, but leave execution to Enter so a misplaced
        // click cannot submit a destructive command.
        if (
          item?.value === this._mouseCompletion?.value &&
          item?.label === this._mouseCompletion?.label
        )
          this._acceptCompletion(item);
        this._mouseCompletion = null;
      }
      return true;
    }
    if (modal) {
      this._mouseOption = null;
      return true;
    }
    const selection = this.state.selection;
    if (!key.press) {
      if (selection?.dragging) {
        this._extendSelection(key);
        selection.dragging = false;
        if (selection.moved) await this._copySelection();
      }
      return true;
    }
    if (key.motion) {
      if (selection?.dragging) this._extendSelection(key);
      return true;
    }
    const anchor = pointAt(frame.transcript, key.x, key.y);
    this.state.selection = anchor
      ? { anchor, focus: anchor, dragging: true, moved: false, mouse: key }
      : null;
    return true;
  }

  async _handleWheel(key) {
    if (
      this.state.settings?.tui?.mouse === false ||
      key.shift ||
      !['up', 'down'].includes(key.direction)
    )
      return true;
    const frame = this.frame();
    if (this.state.modal?.kind?.startsWith('config')) return this.configBrowser.handle(key);
    if (this.state.modal) return this._handleModalKey(key);
    if (frame.hits?.completion.some((hit) => hit.row === key.y)) {
      this._completionSelected = Math.max(
        0,
        Math.min(
          (this.state.completion?.items.length || 1) - 1,
          this._completionSelected + (key.direction === 'up' ? -1 : 1),
        ),
      );
      return true;
    }
    if (frame.hits?.input.some((hit) => hit.row === key.y)) {
      const editor = this.state.search?.active ? this.state.search.editor : this.editor;
      editor.vertical(key.direction === 'up' ? -1 : 1);
      return true;
    }
    if (!frame.transcript) return true;
    if (key.y != null && (key.y < 1 || key.y > frame.transcript.rowLines.length)) return true;
    return this._handleGlobalKey(key);
  }

  async _copySelection() {
    const text = selectedText(this.state.selection, this.frame().transcript?.lines || []);
    if (!text) return;
    try {
      await this.onCopy(text);
      this.state.toast = { text: t('ui.tui.copied', '已复制选中的消息') };
    } catch (error) {
      this.state.toast = { text: error.message };
    }
  }

  _extendSelection(mouse) {
    const selection = this.state.selection;
    if (!selection) return;
    const focus = pointAt(this.frame().transcript, mouse.x, mouse.y, true);
    selection.mouse = mouse;
    if (focus) {
      selection.focus = focus;
      selection.moved ||=
        focus.line !== selection.anchor.line || focus.column !== selection.anchor.column;
    }
  }

  _armQuitOrStop() {
    if (this.state.running) {
      this._stop();
      return true;
    }
    const now = this.clock();
    if (this.quitArmedAt !== null && now - this.quitArmedAt < 3000) {
      this.onQuit();
      return true;
    }
    this.quitArmedAt = now;
    this.state.toast = { text: t('ui.tui.quitArm', '再按一次 Ctrl+C 退出（或输入 /quit）') };
    return true;
  }

  // ---------------------------------------------------------------- 模态

  async _handleModalKey(key) {
    const modal = this.state.modal;
    if (!key) return true;
    if (
      ['pageup', 'pagedown'].includes(key.name) ||
      (key.name === 'wheel' && (modal.options?.length || 0) <= 1)
    ) {
      // Clamp before applying navigation, just like the message viewport.
      this.frame();
      modal.scrollOffset = Math.max(
        0,
        (modal.scrollOffset || 0) +
          (key.name === 'pageup' || key.direction === 'up' ? -1 : 1) *
            (key.name === 'wheel' ? 3 : Math.max(1, Math.floor(this.state.height / 2))),
      );
      if ((modal.options?.length || 0) > 1) {
        const count = modal.options.length;
        modal.selected = Math.max(
          0,
          Math.min(
            count - 1,
            (modal.selected || 0) +
              (key.name === 'pageup' ? -1 : 1) * Math.max(1, Math.floor(this.state.height / 2)),
          ),
        );
      }
      this.frame();
      return true;
    }
    if (key.name === 'escape') {
      this._cancelModal();
      return true;
    }
    if (key.name === 'char' && key.ctrl && ['c', 'd'].includes(key.char)) {
      this._cancelModal();
      return this._armQuitOrStop();
    }

    if (modal.inputMode) {
      // 问答的自由文本输入
      if (key.name === 'enter' && !key.alt) {
        const value = modal.editor.value.trim();
        if (modal.kind === 'renameInput') {
          if (!value) {
            this.state.toast = { text: t('ui.tui.titleRequired', '请输入会话标题') };
            return true;
          }
          const state = this.state;
          await this._renameSession(modal.target, value);
          if (state.modal === modal) state.modal = null;
        } else {
          this._answerQuestion(value, modal);
        }
        return true;
      }
      modal.editor.handleKey(key);
      return true;
    }

    const options = modal.options || [];
    const isChar = key.name === 'char';
    const plainChar = isChar && !key.ctrl && !key.alt;
    if (key.name === 'wheel') {
      // Wheel selection stops at the first and last option.
      if (key.direction === 'up') {
        modal.selected = Math.max(0, (modal.selected || 0) - 1);
      } else {
        modal.selected = Math.min(Math.max(0, options.length - 1), (modal.selected || 0) + 1);
      }
      return true;
    }
    if (
      key.name === 'up' ||
      (isChar && key.ctrl && key.char === 'p') ||
      (plainChar && key.char === 'k')
    ) {
      modal.selected = (modal.selected + options.length - 1) % Math.max(1, options.length);
      return true;
    }
    if (
      key.name === 'down' ||
      (isChar && key.ctrl && key.char === 'n') ||
      (plainChar && key.char === 'j')
    ) {
      modal.selected = (modal.selected + 1) % Math.max(1, options.length);
      return true;
    }
    if (key.name === 'enter' || (modal.kind === 'todo' && plainChar && key.char === ' ')) {
      await this._chooseModalOption(modal.selected);
      return true;
    }
    if (key.name === 'char' && !key.ctrl && !key.alt) {
      // 快捷键：模态自带 shortcuts 映射（审批 y/n/a 等），数字键序号速选
      const shortcut = modal.shortcuts && modal.shortcuts[key.char];
      if (shortcut != null) return this._chooseModalOption(shortcut);
      if (/^[1-9]$/.test(key.char)) {
        const index = Number(key.char) - 1;
        if (index < options.length) return this._chooseModalOption(index);
      }
    }
    return true;
  }

  async _chooseModalOption(index) {
    const modal = this.state.modal;
    if (!modal) return;
    const option = (modal.options || [])[index];
    if (!option) return;
    if (modal.kind === 'todo' && option.value !== 'close') {
      if (modal.busy) return;
      modal.busy = true;
      try {
        const result = await this.runtime.toggleTodo(option.value);
        if (result?.ok === false) throw new Error(result.error || 'Todo update failed');
        this.state.todos = await this.runtime.getTodos();
        if (this.state.modal?.kind === 'todo') this._openTodoModal(option.value);
      } catch (error) {
        this.state.toast = {
          text: error.message || String(error),
          type: 'error',
          expiresAt: this.clock() + 6000,
        };
      } finally {
        modal.busy = false;
        if (this.state.modal?.kind === 'todo') this.state.modal.busy = false;
      }
      return;
    }
    this.state.modal = null;

    if (modal.kind === 'updateConfirm') {
      if (option.value) {
        const r = await this.runtime.api.updatesInstall();
        if (!r.ok) throw new Error(r.error);
      }
    } else if (modal.kind === 'approval') {
      this.runtime.respond(this.activeKey, option.value);
    } else if (modal.kind === 'toolAuth') {
      this.runtime.respond(this.activeKey, option.value);
    } else if (modal.kind === 'ask') {
      this._answerQuestion(option.value, modal);
    } else if (modal.kind === 'sessions') {
      await this._switchSession(option.value);
    } else if (modal.kind === 'mode') {
      await this.newSession(option.value);
    } else if (modal.kind === 'workspace') {
      if (option.select) await this._setWorkspace(option.value, { local: true });
      else await this._openWorkspaceModal(option.value);
    } else if (modal.kind === 'history') {
      await this._openHistory(option.value);
    } else if (modal.kind === 'historyDelete') {
      this.state.modal = {
        kind: 'deleteConfirm',
        colorKey: 'error',
        title: t('ui.tui.deleteConfirmTitle', '删除会话'),
        subtitle: option.label,
        body: t('ui.tui.deleteConfirmBody', '会话记录将被删除，无法撤销。'),
        target: option.target,
        options: [
          { label: t('ui.tui.cancel', '取消'), value: false },
          { label: t('ui.tui.delete', '删除'), value: true },
        ],
        selected: 0,
      };
    } else if (modal.kind === 'deleteConfirm' && option.value) {
      const state = this.state;
      const target = modal.target;
      const result = await this.runtime.deleteHistory(target.mode, target.id, target.workspace);
      if (result?.ok === false) throw new Error(result.error || 'Delete failed');
      state.messages.push({
        kind: 'notice',
        text: t('ui.tui.historyDeletedTitle', '已删除会话「{title}」', { title: target.title }),
      });
    } else if (modal.kind === 'renameSelect') {
      const editor = new LineEditor();
      editor.setValue(option.target.title);
      this.state.modal = {
        kind: 'renameInput',
        colorKey: 'permission',
        title: t('ui.tui.renameTitle', '重命名会话'),
        subtitle: option.label,
        target: option.target,
        inputMode: true,
        editor,
        footer: t('ui.tui.renameFooter', '输入新标题 · Enter 保存 · Esc 取消'),
      };
    } else if (modal.kind === 'help' || modal.kind === 'todo') {
      // 纯展示：直接关闭
    }
  }

  _cancelModal() {
    const modal = this.state.modal;
    this.state.modal = null;
    if (!modal) return;
    if (modal.kind === 'approval') {
      this.runtime.respond(this.activeKey, false);
    } else if (modal.kind === 'toolAuth') {
      this.runtime.respond(this.activeKey, 'deny');
    } else if (modal.kind === 'ask') {
      this.runtime.respond(this.activeKey, { answers: modal.answers || [] });
    }
  }

  _answerQuestion(answer, fromModal) {
    const modal = fromModal || this.state.modal;
    if (!modal) return;
    const answers = (modal.answers || []).slice();
    answers[modal.questionIndex] = answer;
    const nextIndex = modal.questionIndex + 1;
    const questions = modal.questions || [];
    if (nextIndex < questions.length) {
      this.state.modal = this._buildAskModal(questions, nextIndex, answers);
      return;
    }
    this.state.modal = null;
    this.runtime.respond(this.activeKey, { answers });
  }

  _buildAskModal(questions, index, answers) {
    const question = questions[index] || {};
    const text =
      question.label || question.title || question.question || t('ui.tui.askDefault', '请回答');
    const options = Array.isArray(question.options)
      ? question.options.map((option) => ({
          label: typeof option === 'string' ? option : option.label || option.value,
          value: typeof option === 'string' ? option : option.value || option.label,
        }))
      : null;
    const modal = {
      kind: 'ask',
      colorKey: 'permission',
      title: t('ui.tui.askTitle', '回答提问（{index}/{total}）', {
        index: index + 1,
        total: questions.length,
      }),
      subtitle: String(text),
      questionIndex: index,
      questions,
      answers,
    };
    if (options && options.length > 0) {
      modal.options = options;
      modal.selected = 0;
    } else {
      modal.inputMode = true;
      modal.editor = new LineEditor();
      modal.footer = t('ui.tui.askFooter', '输入回答后 Enter 确认 · Esc 跳过');
    }
    return modal;
  }

  // ---------------------------------------------------------------- 运行时事件

  handleRuntimeEvent(event) {
    if (!event || !event.type) return;
    if (event.type === 'settingsChanged') return this.refreshSettings();
    if (event.type === 'messages-deleted') {
      this._sessionViews.delete(event.key);
      if (event.key !== this.activeKey) return;
      const editor = this.editor,
        attachments = this.attachments;
      this._switchSession(this.activeKey, { reload: true })
        .then(() => {
          this.editor = editor;
          this.attachments = attachments;
        })
        .catch((error) => {
          this.state.toast = { text: error.message };
        });
      return;
    }
    if (event.type === 'reconnected') {
      const editor = this.editor,
        attachments = this.attachments;
      this._sessionViews.clear();
      this._switchSession(this.activeKey, { reload: true })
        .then(() => {
          this.editor = editor;
          this.attachments = attachments;
        })
        .catch((error) => {
          this.state.toast = { text: error.message };
        });
      return;
    }
    // 只处理属于当前会话的事件（多会话并存时避免互相串扰）
    if (
      event.key &&
      this.activeKey &&
      event.key !== this.activeKey &&
      event.type !== 'session-created'
    ) {
      if (this._sessionViews.has(event.key)) {
        const active = this.activeKey;
        this._saveView();
        this._restoreView(event.key);
        try {
          this.handleRuntimeEvent(event);
        } finally {
          this._saveView();
          this._restoreView(active);
        }
      }
      return;
    }
    switch (event.type) {
      case 'update': {
        const s = event.state || {};
        const text =
          s.phase === 'ready'
            ? s.kind === 'launcher'
              ? t(
                  'ui.update.launcherReady',
                  '新版已下载并校验。执行 /update install 退出后，重新运行原启动命令启用新版。',
                )
              : t('ui.update.ready', '新版已下载并校验。请重启安装（/update install）')
            : s.phase === 'installing'
              ? t('ui.update.installing', '正在退出并安装新版')
              : s.phase === 'current'
                ? t('ui.update.current', '已是最新版本')
                : s.phase === 'error'
                  ? t('ui.update.error', '更新失败：') + s.error
                  : s.phase === 'downloading'
                    ? t('ui.update.downloading', '正在下载新版') +
                      (s.total ? ' ' + Math.round((s.downloaded / s.total) * 100) + '%' : '')
                    : t('ui.update.checking', '正在检查更新');
        this.state.toast = {
          text,
          expiresAt: this.clock() + (s.phase === 'ready' || s.phase === 'error' ? 30000 : 5000),
        };
        if (s.phase === 'ready' || s.phase === 'error') this.pushEntry({ kind: 'notice', text });
        break;
      }
      case 'notification': {
        const payload = event.payload || {};
        if (event.notificationType === 'toast') {
          const delay = Math.max(0, Number(payload.retry?.delayMs) || 0);
          const expiresAt =
            this.clock() +
            Math.max(1000, Number(payload.duration) || 5000, payload.retry ? delay + 2000 : 0);
          this.state.toast = {
            text: payload.message || '',
            type: payload.type,
            retry: payload.retry,
            retryAt: this.clock() + delay,
            expiresAt,
          };
        }
        break;
      }
      case 'message': {
        if (event.role === 'user') {
          this.pushEntry({ kind: 'user', text: event.content, attachments: event.attachments });
          break;
        }
        if (this._streamEntry && event.role === 'assistant') {
          // 非流式兜底：流式条目已有内容时不重复
          if (!this._streamEntry.text) this._streamEntry.text = event.content;
          this._streamEntry.streaming = false;
          this._streamEntry = null;
          break;
        }
        this.pushEntry({
          kind: event.role === 'system' ? 'system' : 'assistant',
          text: event.content,
        });
        break;
      }
      case 'stream-start':
        this._streamEntry = { kind: 'assistant', text: '', reasoning: '', streaming: true };
        this.pushEntry(this._streamEntry);
        break;
      case 'stream-chunk': {
        if (this.state.toast?.retry) this.state.toast = null;
        // 推理与正文分通道：reasoning 进推理块，content 进正文
        const content = (event.data && event.data.content) || '';
        const reasoning = (event.data && event.data.reasoning) || '';
        if (this._streamEntry && (content || reasoning)) {
          if (content) this._streamEntry.text += content;
          if (reasoning) {
            this._streamEntry.reasoning = (this._streamEntry.reasoning || '') + reasoning;
          }
        }
        break;
      }
      case 'stream-end': {
        const content = event.data && event.data.content;
        const reasoning = event.data && event.data.reasoning;
        if (this._streamEntry) {
          if (content && !this._streamEntry.text) this._streamEntry.text = content;
          if (reasoning && !this._streamEntry.reasoning) this._streamEntry.reasoning = reasoning;
          this._streamEntry.streaming = false;
          this._streamEntry = null;
        }
        break;
      }
      case 'assistant-reasoning': {
        // 非流式推理事件：挂到最近一条助手消息上；没有则建一条纯推理条目
        const reasoningText =
          typeof event.data === 'string'
            ? event.data
            : event.data && (event.data.text || event.data.reasoning);
        if (!reasoningText) break;
        // Non-streaming core events arrive BEFORE the matching assistant text.
        // Keep a new entry ready for that text instead of altering an old reply.
        if (!this._streamEntry) {
          this._streamEntry = {
            kind: 'assistant',
            text: '',
            reasoning: reasoningText,
            streaming: false,
          };
          this.pushEntry(this._streamEntry);
        } else this._streamEntry.reasoning = reasoningText;
        break;
      }
      case 'tool-call': {
        if (this._streamEntry && !this._streamEntry.streaming) this._streamEntry = null;
        const key = event.callId || event.name;
        if (event.status === 'running') {
          const entry = { kind: 'tool', name: event.name, args: event.args, status: 'running' };
          this._toolEntries.set(key, entry);
          this.pushEntry(entry);
        } else {
          const entry = this._toolEntries.get(key) || this._lastToolEntry(event.name);
          if (entry) {
            entry.status =
              event.status === 'done' ? 'done' : event.status === 'denied' ? 'denied' : 'error';
            entry.result = event.result;
          } else {
            this.pushEntry({
              kind: 'tool',
              name: event.name,
              status: 'done',
              result: event.result,
            });
          }
        }
        break;
      }
      case 'interaction': {
        if (event.kind === 'approval') {
          this._openApprovalModal(event.payload);
        } else if (event.kind === 'tool-auth') {
          this._openToolAuthModal(event.payload);
        } else if (event.kind === 'questions') {
          const questions = (event.payload && event.payload.questions) || [];
          if (questions.length > 0) {
            this.state.modal = this._buildAskModal(
              questions,
              0,
              new Array(questions.length).fill(''),
            );
          } else {
            this.runtime.respond(this.activeKey, { answers: [] });
          }
        }
        break;
      }
      case 'interaction-resolved':
        if (this.state.modal && ['approval', 'toolAuth', 'ask'].includes(this.state.modal.kind)) {
          this.state.modal = null;
        }
        break;
      case 'status':
        this.state.running = event.status === 'running' || event.status === 'working';
        if (this.state.running && !this._startedAt) this._startedAt = this.clock();
        if (!this.state.running) {
          if (this.state.toast?.retry) this.state.toast = null;
          if (this._streamEntry) this._streamEntry.streaming = false;
          this._streamEntry = null;
          for (const entry of this._toolEntries.values()) {
            if (entry.status === 'running') entry.status = 'denied';
          }
          this._startedAt = 0;
          this.state.elapsedMs = 0;
          this.state.spinnerLabel = t('ui.tui.spinnerThinking', '思考中');
          // 兜底刷新统计（usage 事件是每轮结束推，这里确保状态栏最新）
          try {
            if (typeof this.runtime.getStats === 'function') {
              const stats = this.runtime.getStats(this.activeKey);
              if (stats) {
                this.state.usage = stats.usage || this.state.usage;
                this.state.context = stats.context || this.state.context;
                this.state.costUSD = typeof stats.costUSD === 'number' ? stats.costUSD : 0;
              }
            }
          } catch {
            /* 统计读取失败不影响状态切换 */
          }
        }
        break;
      case 'subscription-usage':
        this.state.subscriptionUsage = event.data;
        break;
      case 'title':
        this.state.title = event.title || '';
        break;
      case 'affection-change': {
        this.state.affection = event.data ? event.data.value : event.value;
        const delta = event.data ? event.data.delta : event.delta;
        if (typeof delta === 'number' && delta !== 0) {
          this.state.toast = {
            text: t('ui.tui.affectionToast', '好感度 {delta} → {value}', {
              delta: (delta > 0 ? '+' : '') + delta,
              value: this.state.affection,
            }),
          };
        }
        break;
      }
      case 'tarot':
        this.pushEntry({ kind: 'tarot', card: event.data || event.card });
        break;
      case 'sub-agent-start':
        this.pushEntry({
          kind: 'subagent',
          task: (event.data && event.data.task) || '',
          status: 'running',
        });
        break;
      case 'sub-agent-done': {
        const entry = this._lastSubAgentEntry();
        if (entry) entry.status = 'done';
        break;
      }
      case 'present-file':
        this.pushEntry({
          kind: 'file',
          path: (event.data && (event.data.fullPath || event.data.path)) || '',
          title: (event.data && (event.data.title || event.data.filename)) || '',
        });
        break;
      case 'todo':
        this.state.todos = (event.data && event.data.items) || event.items || [];
        if (!event.key)
          for (const view of this._sessionViews.values()) view.state.todos = this.state.todos;
        if (this.state.modal?.kind === 'todo') this._openTodoModal();
        break;
      case 'minimal':
        this.state.minimalMode = event.minimalMode === true;
        break;
      case 'usage': {
        // 运行时每轮结束推送：{ usage, context:{used,max,reserve,pct,inputPct,exact}, costUSD }
        const usage = event.usage || (event.data && event.data.usage) || event.data || null;
        if (usage) this.state.usage = usage;
        const context =
          event.context ||
          (event.data && event.data.context) ||
          (event.data && event.data.max ? event.data : null);
        if (context) this.state.context = context;
        if (Object.hasOwn(event, 'compaction')) this.state.compaction = event.compaction;
        const cost = event.costUSD != null ? event.costUSD : event.data && event.data.costUSD;
        if (typeof cost === 'number') this.state.costUSD = cost;
        else if (cost === null) this.state.costUSD = 0;
        break;
      }
      case 'context-progress':
        this.state.context = event.data || null;
        break;
      case 'context-compaction':
        this.state.compaction = event.data;
        break;
      case 'optimize-tools-start':
        this.state.spinnerLabel = t('ui.tui.spinnerOptimizing', '优化工具选择');
        break;
      case 'optimize-tools-end':
        this.state.spinnerLabel = t('ui.tui.spinnerThinking', '思考中');
        break;
      case 'session-created':
      case 'session-closed':
      default:
        break;
    }
    if (this.state.modal) this.state.scrollOffset = 0;
    this._saveView();
  }

  _saveView() {
    if (!this.activeKey) return;
    this._sessionViews.set(this.activeKey, {
      state: this.state,
      editor: this.editor,
      attachments: this.attachments,
      tools: this._toolEntries,
      stream: this._streamEntry,
      started: this._startedAt,
    });
  }

  _restoreView(key) {
    const view = this._sessionViews.get(key);
    const { width, height } = this.state;
    this.activeKey = key;
    this.state = view.state;
    this.state.theme = this.theme;
    this.state.thinkingExpanded = this._thinkingExpanded;
    this.state.width = width;
    this.state.height = height;
    this.editor = view.editor;
    this.attachments = view.attachments;
    this._toolEntries = view.tools;
    this._streamEntry = view.stream;
    this._startedAt = view.started;
  }

  // ---------------------------------------------------------------- 会话 / 命令

  async newSession(mode, workspacePath, options = {}) {
    this._saveView();
    this._completionSelected = 0;
    this._completionDismissedText = null;
    const key =
      'tui:' + mode + ':' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    // Workspace preparation commits the mapped path to the runtime. Do not seed
    // a Code Agent with an unvalidated host path when the execution target is VM.
    await this.runtime.createSession({
      key,
      mode,
      workspacePath: mode === 'code' && this.runtime.prepareWorkspace ? null : workspacePath,
    });
    let hostWorkspace = '';
    let workspaceError = '';
    if (mode === 'code' && this.runtime.prepareWorkspace) {
      try {
        const result = await this.runtime.prepareWorkspace(key, workspacePath, {
          local: options.local ?? Boolean(workspacePath && !workspacePath.startsWith('/workspace')),
        });
        if (!result?.ok) throw new Error(result?.error || 'Workspace cannot be prepared');
        workspacePath = result.workspacePath;
        hostWorkspace = result.hostPath || '';
      } catch (error) {
        if (this.activeKey) {
          await this.runtime.close(key);
          throw error;
        }
        // The first session must remain interactive even when its workspace
        // fails. /workspace and /config can recover without restarting the TUI.
        workspacePath = '';
        workspaceError = error.message || String(error);
      }
    }
    if (this._disposed) {
      await this.runtime.close(key);
      return;
    }
    this.activeKey = key;
    this.state = {
      ...this.state,
      modal: null,
      running: false,
      toast: null,
      usage: null,
      context: null,
      compaction: null,
      costUSD: 0,
      elapsedMs: 0,
      selection: null,
      workspace: workspacePath || '',
      minimalMode: false,
      hostWorkspace,
      workspaceError,
    };
    this.editor = new LineEditor({ history: this.editor.history });
    this.attachments = [];
    this._toolEntries = new Map();
    this._startedAt = 0;
    this.state.mode = mode;
    this.state.title = '';
    this.state.affection =
      mode === 'babe'
        ? this.state.initialAffection != null
          ? this.state.initialAffection
          : 30
        : null;
    this.state.messages = [];
    this.pushEntry({ kind: 'brand' });
    this.state.scrollOffset = 0;
    this._toolEntries.clear();
    this._streamEntry = null;
    if (mode === 'code' && workspacePath) this.state.workspace = workspacePath;
    this.pushEntry({
      kind: 'notice',
      text:
        mode === 'babe'
          ? t('ui.tui.mode.babe', '已切换到 Babe 模式（好感度 {value}）', {
              value: this.state.affection ?? 0,
            })
          : mode === 'code'
            ? workspacePath
              ? t('ui.tui.mode.codeWorkspace', '已切换到 Code 模式 · 工作区 {path}', {
                  path: workspacePath,
                }) +
                (hostWorkspace && hostWorkspace !== workspacePath
                  ? '\n' + t('ui.tui.workspaceLocal', '本地目录：{path}', { path: hostWorkspace })
                  : '')
              : t('ui.tui.mode.code', '已切换到 Code 模式') +
                t('ui.tui.mode.codeNoWorkspace', '（/workspace <路径> 设置工作区）')
            : t('ui.tui.mode.chat', '已切换到 Chat 模式'),
    });
    if (workspaceError) this.pushEntry({ kind: 'system', text: this._workspaceFailure() });
    this._reloadCustomCommands();
    this._saveView();
  }

  async _switchSession(key, { reload = false } = {}) {
    const session = this.runtime.getSession(key);
    if (!session) return;
    if (!reload) this._saveView();
    else this._sessionViews.delete(key);
    this._completionSelected = 0;
    this._completionDismissedText = null;
    if (this._sessionViews.has(key)) {
      const todos = this.state.todos;
      this._restoreView(key);
      this.state.todos = todos;
      this._reloadCustomCommands();
      return;
    }
    this.activeKey = key;
    this.state = {
      ...this.state,
      modal: null,
      running: session.busy === true,
      usage: null,
      context: null,
      compaction: null,
      costUSD: 0,
      elapsedMs: 0,
      workspaceError: '',
    };
    this.editor = new LineEditor({ history: this.editor.history });
    this.attachments = [];
    this._toolEntries = new Map();
    this._streamEntry = null;
    this._startedAt = session.busy ? this.clock() : 0;
    this.state.mode = session.mode || 'chat';
    this.state.minimalMode = session.minimalMode === true;
    this.state.title = session.title || '';
    this.state.workspace = session.workspacePath || '';
    this.state.hostWorkspace = session.hostWorkspacePath || '';
    this.state.affection = session.mode === 'babe' ? session.affection : null;
    this.state.messages = [];
    this.state.scrollOffset = 0;
    this.pushEntry({
      kind: 'notice',
      text: t('ui.tui.switchedToSession', '已切换到会话 {title}', { title: session.title || key }),
    });
    const details = this.runtime.getSessionDetails?.(key);
    if (details) {
      for (const message of details.messages || []) this._appendHistoryMessage(message, this.state);
      if (details.pendingInteraction)
        this.handleRuntimeEvent({ type: 'interaction', key, ...details.pendingInteraction });
      const stats = this.runtime.getStats?.(key);
      if (stats)
        Object.assign(this.state, {
          usage: stats.usage,
          context: stats.context,
          compaction: stats.compaction,
          costUSD: stats.costUSD,
          subscriptionUsage: stats.subscriptionUsage,
        });
    }
    this._reloadCustomCommands();
    this._saveView();
  }

  async _submit(text) {
    const parsed = parseInput(text, { customCommands: this.customCommands });
    if (parsed.kind === 'command') {
      if (parsed.error) {
        this.pushEntry({ kind: 'system', text: parsed.error });
        return;
      }
      if (parsed.custom) {
        // 自定义命令：正文即提示词，$ARGUMENTS / {{args}} 替换为参数
        const prompt = expandCustomCommand(parsed.custom, parsed.argText);
        if (parsed.custom.agent && parsed.custom.agent !== this.state.mode) {
          await this.newSession(parsed.custom.agent);
        }
        this.pushEntry({
          kind: 'notice',
          text: t('ui.tui.execCustom', '执行自定义命令 /{name}', { name: parsed.name }),
        });
        await this._send(prompt || t('ui.tui.emptyCommand', '（空命令）'));
        return;
      }
      await this._runCommand(parsed.name, parsed.argText);
      return;
    }
    if (!parsed.text || !parsed.text.trim()) return;
    await this._send(parsed.text);
  }

  async _send(text) {
    const state = this.state;
    const key = this.activeKey;
    if (state.mode === 'code' && state.workspaceError) {
      this.editor.setValue(text);
      this.pushEntry({ kind: 'system', text: this._workspaceFailure() });
      return;
    }
    const attachments = this.attachments.splice(0, this.attachments.length);
    state.scrollOffset = 0;
    this._startedAt = this.clock();
    state.running = true;
    this._saveView();
    try {
      const result = await this.runtime.sendMessage(key, text, attachments);
      if (result?.ok === false) throw new Error(result.error || 'Request failed');
      if (result?.workspacePath) {
        state.workspace = result.workspacePath;
        if (this.activeKey === key) this._reloadCustomCommands();
      }
    } catch (error) {
      state.messages.push({
        kind: 'system',
        text:
          t('ui.tui.sendFailedPrefix', '发送失败：') +
          (error && error.message ? error.message : String(error)),
      });
    } finally {
      state.running = this.runtime.getSession(key)?.busy === true;
      if (this.activeKey === key && !state.running) this._startedAt = 0;
    }
  }

  _stop() {
    try {
      this.runtime.stop(this.activeKey);
    } catch {
      /* ignore */
    }
    this.state.running = false;
    this._startedAt = 0;
    this.state.toast = { text: t('ui.tui.stopRequested', '已请求停止当前任务') };
  }

  /** 打开 VM 桌面：VM 未启动先提示，图形栈启动中给进度 */
  async _openVmDesktop() {
    if (!this.runtime || typeof this.runtime.openVmDesktop !== 'function') {
      this.pushEntry({
        kind: 'system',
        text: t('ui.tui.vmdeskFailed', '打开 VM 桌面失败：{error}', {
          error: t('ui.tui.vmdeskNeedVm', '请先启动虚拟机（设置 → 虚拟机沙盒）'),
        }),
      });
      return;
    }
    this.pushEntry({ kind: 'notice', text: t('ui.tui.vmdeskStarting', '正在启动 VM 图形栈…') });
    try {
      const result = await this.runtime.openVmDesktop();
      if (result?.ok === false) throw new Error(result.error || 'VM graphics unavailable');
      this.pushEntry({ kind: 'notice', text: t('ui.tui.vmdeskOpened', 'VM 桌面已打开') });
    } catch (error) {
      this.pushEntry({
        kind: 'system',
        text: t('ui.tui.vmdeskFailed', '打开 VM 桌面失败：{error}', {
          error: (error && error.message) || String(error),
        }),
      });
    }
  }

  async _runCommand(name, argText) {
    switch (name) {
      case 'help': {
        this.state.modal = {
          kind: 'help',
          colorKey: 'permission',
          title: t('ui.tui.helpTitle', '命令表'),
          body: helpLines(this.customCommands).join('\n'),
          options: [{ label: t('ui.tui.helpClose', '关闭'), value: 'close' }],
          selected: 0,
        };
        return;
      }
      case 'commands': {
        this._reloadCustomCommands();
        const list = [...this.customCommands.values()];
        this.pushEntry({
          kind: 'system',
          text:
            list.length === 0
              ? '（暂无自定义命令）\n把 *.md 放到 ~/.cibyp/commands/ 或 <工作区>/.cibyp/commands/ 即可：\n---\ndescription: 提交代码\n---\n请整理改动并提交。$ARGUMENTS'
              : '自定义命令：\n' + list.map((c) => '  /' + c.name + '  ' + c.desc).join('\n'),
        });
        return;
      }
      case 'mode': {
        const mode = String(argText || '')
          .trim()
          .toLowerCase();
        if (!mode) {
          // 无参数：弹出模式选择器（当前模式高亮）
          this.state.modal = {
            kind: 'mode',
            colorKey: 'permission',
            title: t('ui.tui.modeTitle', '切换模式'),
            options: [
              {
                label: t('ui.tui.modeOptionChatFull', 'Chat · 日常对话（全工具面）'),
                value: 'chat',
              },
              {
                label: t('ui.tui.modeOptionBabeFull', 'Babe · 陪伴模式（好感度）'),
                value: 'babe',
              },
              {
                label: t('ui.tui.modeOptionCodeFull', 'Code · 编码模式（工作区为中心）'),
                value: 'code',
              },
            ],
            selected: Math.max(0, MODES.indexOf(this.state.mode)),
            footer: t('ui.tui.modeFooter', 'Enter 确认 · Esc 取消 · 也可直接 /mode chat'),
          };
          return;
        }
        if (!MODES.includes(mode)) {
          this.pushEntry({
            kind: 'system',
            text: '用法：/mode <chat|babe|code>（无参数弹出选择器）',
          });
          return;
        }
        await this.newSession(mode);
        return;
      }
      case 'new': {
        const mode = MODES.includes(argText.trim().toLowerCase())
          ? argText.trim().toLowerCase()
          : this.state.mode;
        await this.newSession(mode);
        return;
      }
      case 'sessions': {
        const list = this.runtime.listSessions();
        if (!list || list.length === 0) {
          this.pushEntry({ kind: 'system', text: '暂无其它会话' });
          return;
        }
        this.state.modal = {
          kind: 'sessions',
          colorKey: 'permission',
          title: t('ui.tui.sessionsTitle', '会话列表'),
          options: list.map((s) => ({
            label:
              (s.title || 'New') +
              (s.key === this.activeKey ? ' · ' + t('ui.tui.currentSession', '当前') : '') +
              '  [' +
              (s.mode || 'chat') +
              (s.busy ? ' · ' + t('ui.tui.running', '运行中') : '') +
              ']',
            value: s.key,
          })),
          selected: Math.max(
            0,
            list.findIndex((s) => s.key === this.activeKey),
          ),
        };
        return;
      }
      case 'history': {
        await this._openHistoryModal();
        return;
      }
      case 'open': {
        await this._openHistoryModal('open', argText.trim());
        return;
      }
      case 'rename': {
        const title = argText.trim();
        if (!title) {
          await this._openHistoryModal('rename');
          return;
        }
        await this._renameSession({ key: this.activeKey }, title);
        return;
      }
      case 'delete': {
        await this._openHistoryModal('delete', argText.trim());
        return;
      }
      case 'attach': {
        const filePath = argText.trim().replace(/^(["'])(.*)\1$/, '$2');
        if (!filePath) {
          this.pushEntry({
            kind: 'system',
            text: this.attachments.length
              ? t('ui.tui.pendingAttachmentsPrefix', '待发送附件：') +
                this.attachments.map((a) => a.path).join(', ')
              : '用法：/attach <文件路径>',
          });
          return;
        }
        this.attachments.push({
          name: filePath.split(/[\\/]/).pop(),
          path: filePath,
          isImage: /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(filePath),
        });
        this.pushEntry({
          kind: 'notice',
          text:
            t('ui.tui.attachedFilePrefix', '已附加文件：') +
            filePath +
            t('ui.tui.attachHint', '（随下一条消息发送）'),
        });
        return;
      }
      case 'config':
        await this.configBrowser.open(argText.trim());
        return;
      case 'update': {
        if (argText.trim() && argText.trim() !== 'install') throw new Error('/update [install]');
        if (argText.trim() === 'install') {
          const state = await this.runtime.api.updatesStatus();
          this.state.modal = {
            kind: 'updateConfirm',
            title:
              state.kind === 'launcher'
                ? t(
                    'ui.update.launcherConfirm',
                    '退出当前后台？再次运行原启动命令将启用已下载的新版。',
                  )
                : t('ui.update.confirm', '重启并安装新版？'),
            selected: 0,
            options: [
              { label: t('ui.update.later', '稍后'), value: false },
              { label: t('ui.update.install', '重启安装'), value: true },
            ],
          };
        } else {
          await this.runtime.api.updatesStart();
          this.state.toast = {
            text: t('ui.update.started', '正在检查并下载新版；完成后会提醒重启安装'),
            expiresAt: this.clock() + 5000,
          };
        }
        return;
      }
      case 'cwd': {
        const result = await this.runtime.openCurrentDirectory(this.activeKey);
        if (!result.ok)
          throw new Error(
            result.code === 'NO_DESKTOP'
              ? t('ui.tui.noDesktop', '没有可用的图形桌面，无法打开文件管理器')
              : result.error,
          );
        this.state.toast = { text: result.path };
        return;
      }
      case 'undo': {
        const key = this.activeKey,
          state = this.state,
          editor = this.editor;
        const result = await this.runtime.undo(key);
        if (!result.ok) throw new Error(result.error);
        await this.settled();
        const index = state.messages.findLastIndex((entry) => entry.kind === 'user');
        if (index >= 0) state.messages.splice(index);
        const view = this._sessionViews.get(key);
        view?.tools.clear();
        if (view) view.stream = null;
        if (key === this.activeKey) {
          this._toolEntries.clear();
          this._streamEntry = null;
        }
        state.running = false;
        state.scrollOffset = 0;
        state.selection = null;
        state.search = null;
        state.modal = null;
        editor.setValue(result.text || '');
        state.toast = {
          text: t('ui.tui.undone', '已撤回最近一条消息；已执行的文件修改不会回滚'),
        };
        return;
      }
      case 'workspace': {
        const target = argText.trim();
        if (!target) {
          await this._openWorkspaceModal(this.state.hostWorkspace || undefined);
          return;
        }
        if (target === 'sync') {
          const state = this.state;
          const result = await this.runtime.syncWorkspace(this.activeKey);
          if (result?.ok === false)
            throw new Error(result.error || 'Workspace synchronization failed');
          state.messages.push({
            kind: 'notice',
            text: t('ui.tui.workspaceSynced', '工作区已同步到本地：{path}', {
              path: state.hostWorkspace || state.workspace,
            }),
          });
          return;
        }
        const directory = target.replace(/^(["'])(.*)\1$/, '$2');
        await this._setWorkspace(directory, { local: !directory.startsWith('/workspace') });
        return;
      }
      case 'todo': {
        this._openTodoModal();
        return;
      }
      case 'usage': {
        await this._openUsage();
        return;
      }
      case 'model': {
        const settings = await this.runtime.getSettings();
        const llm = (settings && settings.llm) || {};
        const pool = Array.isArray(llm.pool)
          ? llm.pool.filter((e) => e && e.enabled !== false).map((e) => e.model)
          : [];
        this.pushEntry({
          kind: 'system',
          text:
            t('ui.tui.modelLine', '当前模型：{model}{provider}', {
              model: llm.model || t('ui.tui.workspaceUnset', '（未设置）'),
              provider: llm.provider ? ' @ ' + llm.provider : '',
            }) +
            (pool.length
              ? '\n' + t('ui.tui.modelPool', '模型池：{models}', { models: pool.join('、') })
              : ''),
        });
        return;
      }
      case 'status': {
        const session = this.runtime.getSession(this.activeKey) || {};
        this.pushEntry({
          kind: 'system',
          text:
            t('ui.tui.statusLine', '会话 {key} · 模式 {mode} · 状态 {status}', {
              key: session.key || this.activeKey,
              mode: this.state.mode,
              status: session.status || 'idle',
            }) +
            (this.state.workspace
              ? '\n' + t('ui.tui.statusWorkspace', '工作区：{path}', { path: this.state.workspace })
              : ''),
        });
        return;
      }
      case 'clear': {
        this.state.messages = [];
        this.state.scrollOffset = 0;
        this._toolEntries.clear();
        this._streamEntry = null;
        this._saveView();
        return;
      }
      case 'stop': {
        this._stop();
        return;
      }
      case 'continue': {
        const text = argText.trim() || t('ui.tui.continueDefault', '继续');
        await this._send(text);
        return;
      }
      case 'compact': {
        if (typeof this.runtime.agentAction === 'function') {
          const result = await this.runtime.agentAction(this.activeKey, 'compactNow', [
            argText.trim(),
          ]);
          if (!result.result?.ok)
            this.state.toast = {
              text: result.result?.message || t('ui.compaction.error', '压缩失败 · 上下文已保留'),
              type: 'error',
              expiresAt: this.clock() + 7000,
            };
          return;
        }
        await this._send(
          t(
            'ui.tui.compactHint',
            '请立即压缩上下文（调用 manageContext / autoSummarizeContext），保持任务连续性。',
          ),
        );
        return;
      }
      case 'quit': {
        this.onQuit();
        return;
      }
      case 'thinking': {
        this._thinkingExpanded = !this.state.thinkingExpanded;
        this.state.thinkingExpanded = this._thinkingExpanded;
        for (const view of this._sessionViews.values())
          view.state.thinkingExpanded = this._thinkingExpanded;
        this.state.scrollOffset = 0;
        try {
          await this._saveTuiPreferences({ thinkingExpanded: this._thinkingExpanded });
        } catch (error) {
          this.pushEntry({ kind: 'system', text: error.message || String(error) });
        }
        this.pushEntry({
          kind: 'notice',
          text: this.state.thinkingExpanded
            ? t('ui.tui.thinkingExpanded', '推理内容：展开')
            : t('ui.tui.thinkingCollapsed', '推理内容：折叠'),
        });
        return;
      }
      case 'minimal': {
        const value = argText.trim().toLowerCase();
        if (value && !['on', 'off', 'toggle'].includes(value)) {
          this.pushEntry({
            kind: 'system',
            text: t('ui.tui.minimalUsage', '用法：/minimal [on|off]'),
          });
          return;
        }
        if (this.state.running) {
          this.pushEntry({
            kind: 'notice',
            text: t('ui.tui.minimalBusy', '请先停止当前任务，再切换极简模式'),
          });
          return;
        }
        if (this.state.mode === 'babe') {
          this.pushEntry({
            kind: 'notice',
            text: t('ui.tui.minimalBabe', '极简模式适用于 Chat 和 Code'),
          });
          return;
        }
        const enabled = value === 'on' || (value !== 'off' && !this.state.minimalMode);
        const result = await this.runtime.setMinimalMode(this.activeKey, enabled);
        if (!result?.ok) {
          this.pushEntry({
            kind: 'system',
            text: result?.error || t('ui.tui.unknownError', '未知错误'),
          });
          return;
        }
        this.state.minimalMode = result.minimalMode;
        this.pushEntry({
          kind: 'notice',
          text: this.state.minimalMode
            ? t('ui.tui.minimalOn', 'Minimal 已开启：固定提示词 + shell / 文件编辑')
            : t('ui.tui.minimalOff', 'Minimal 已关闭'),
        });
        return;
      }
      case 'theme': {
        const value = argText.trim().toLowerCase();
        if (value && !['on', 'off', 'toggle'].includes(value)) {
          this.pushEntry({ kind: 'system', text: t('ui.tui.themeUsage', '用法：/theme [on|off]') });
          return;
        }
        const followGuiTheme =
          value === 'on' || (value !== 'off' && this.state.settings?.tui?.followGuiTheme === false);
        await this._saveTuiPreferences({ followGuiTheme });
        this.pushEntry({
          kind: 'notice',
          text: followGuiTheme
            ? t('ui.tui.themeGui', 'TUI 主题：沿用 GUI 色系')
            : t('ui.tui.themeTerminal', 'TUI 主题：终端默认'),
        });
        return;
      }
      case 'mouse': {
        const value = argText.trim().toLowerCase();
        if (value && !['on', 'off', 'toggle'].includes(value)) {
          this.pushEntry({ kind: 'system', text: t('ui.tui.mouseUsage', '用法：/mouse [on|off]') });
          return;
        }
        const mouse =
          value === 'on' || (value !== 'off' && this.state.settings?.tui?.mouse === false);
        await this._saveTuiPreferences({ mouse });
        this.pushEntry({
          kind: 'notice',
          text: mouse
            ? t(
                'ui.tui.mouseOn',
                '鼠标已开启：点击菜单、定位光标、滚轮翻页和拖选复制；Shift 可使用终端原生选择',
              )
            : t('ui.tui.mouseOff', '鼠标捕获已关闭：使用终端原生选择、复制和粘贴'),
        });
        return;
      }
      case 'vmdesk': {
        await this._openVmDesktop();
        return;
      }
      default: {
        this.pushEntry({
          kind: 'system',
          text: t('ui.tui.unknownCommandPrefix', '未知命令 /') + name,
        });
      }
    }
  }

  async _setWorkspace(directory, options) {
    const state = this.state;
    const key = this.activeKey;
    const result = await this.runtime.setWorkspace(key, directory, options);
    if (result?.ok === false) throw new Error(result.error || 'Invalid workspace');
    state.workspace = result?.workspacePath || directory;
    state.hostWorkspace = result?.hostPath || '';
    state.workspaceError = '';
    if (this.activeKey === key) this._reloadCustomCommands();
    state.messages.push({
      kind: 'notice',
      text:
        t('ui.tui.workspaceSet', '工作区已设置为 {path}', { path: state.workspace }) +
        (state.hostWorkspace && state.hostWorkspace !== state.workspace
          ? '\n' + t('ui.tui.workspaceLocal', '本地目录：{path}', { path: state.hostWorkspace })
          : ''),
    });
  }

  async _openUsage() {
    const key = this.activeKey;
    const stats = this.runtime.getStats?.(key) || {};
    const usage = stats.usage || this.state.usage || {};
    const context = stats.context || this.state.context;
    const modal = {
      kind: 'usage',
      title: t('ui.tui.usageTitle', '用量与额度'),
      body:
        t(
          'ui.tui.usageLine',
          '本轮用量：prompt {prompt} · completion {completion} · total {total}',
          { prompt: usage.prompt || 0, completion: usage.completion || 0, total: usage.total || 0 },
        ) +
        (context?.max
          ? '\n' +
            t('ui.tui.usageContext', '上下文占用：{used} / {max}', {
              used: context.used || 0,
              max: context.max,
            })
          : ''),
      subtitle: t('ui.tui.usageLoading', '正在读取额度…'),
      options: [{ label: t('ui.tui.helpClose', '关闭'), value: 'close' }],
      selected: 0,
    };
    this.state.modal = modal;
    try {
      const data =
        (await this.runtime.getSubscriptionUsage?.(key, { force: true, includeWindows: true })) ||
        stats.subscriptionUsage ||
        this.state.subscriptionUsage;
      if (this.activeKey !== key || this.state.modal !== modal) return;
      const { formatUsage } = require('../shared/usage-indicator');
      const language = this.state.settings?.language || 'zh-CN';
      const indicator = data ? formatUsage(data, language) : null;
      modal.subtitle = indicator?.text || t('ui.tui.usageUnavailable', '额度暂不可用');
      modal.usageRows = (data?.windows || []).map((window) => ({
        label:
          (window.label ? window.label + ' · ' : '') +
          t(
            'ui.tui.usagePeriod.' + window.period,
            { '5hour': '5 小时限额', weekly: '周限额', monthly: '月限额', other: '额度' }[
              window.period
            ] || '额度',
          ),
        pct: window.usedPercent,
        detail: window.resetsAt
          ? t('ui.tui.usageReset', '重置时间：{time}', {
              time: new Date(window.resetsAt).toLocaleString(language),
            })
          : '',
      }));
      if (indicator?.title) modal.body += '\n' + indicator.title;
      if (!data?.subscription && Number.isFinite(stats.costUSD))
        modal.body +=
          '\n' +
          t('ui.tui.usageSessionCost', '会话 API 消费：{cost}', {
            cost: '$' + stats.costUSD.toFixed(4),
          });
      if (data?.subscription && data.equivalent) {
        const estimate = formatUsage({ ...data, mode: 'api-equivalent' }, language);
        if (data.mode !== 'api-equivalent') modal.body += '\n' + estimate.text;
      }
    } catch {
      if (this.state.modal === modal) modal.subtitle = t('ui.tui.usageUnavailable', '额度暂不可用');
    }
  }

  _workspaceFailure() {
    return t(
      'ui.tui.workspaceFailed',
      '工作区初始化失败：{error}\n可输入 /workspace 重新选择目录，或 /config 修改设置。草稿会保留，工作区就绪后才能发送。',
      { error: this.state.workspaceError },
    );
  }

  async _openWorkspaceModal(directory) {
    const state = this.state;
    if (!this.runtime.listLocalWorkspaceDirectories) {
      this.pushEntry({ kind: 'system', text: '用法：/workspace <本地目录>' });
      return;
    }
    const result = await this.runtime.listLocalWorkspaceDirectories(directory);
    if (result?.ok === false) throw new Error(result.error || 'Directory cannot be read');
    if (state !== this.state) return;
    this.state.modal = {
      kind: 'workspace',
      colorKey: 'permission',
      title: t('ui.tui.workspacePickerTitle', '选择本地工作区'),
      subtitle: result.path,
      options: [
        { label: t('ui.tui.useDirectory', '✓ 使用此目录'), value: result.path, select: true },
        ...(result.parent !== result.path ? [{ label: '↑ ..', value: result.parent }] : []),
        ...[...new Set([result.home, ...(result.roots || [])])]
          .filter((entry) => entry && entry !== result.path)
          .map((entry) => ({ label: '↗ ' + entry, value: entry })),
        ...(result.directories || []).map((entry) => ({
          label: entry.name + '/',
          value: entry.path,
        })),
      ],
      selected: 0,
      footer: t('ui.tui.workspacePickerFooter', 'Enter 进入文件夹或使用目录 · Esc 取消'),
    };
  }

  async _openHistoryModal(action = 'open', query = '') {
    const state = this.state;
    const mode = state.mode;
    const workspace = state.workspace || undefined;
    const live = (this.runtime.listSessions() || []).filter(
      (session) =>
        session.mode === mode && (mode !== 'code' || session.workspacePath === workspace),
    );
    let list = [];
    try {
      list = (await this.runtime.listHistory(mode, workspace)) || [];
    } catch (error) {
      state.messages.push({
        kind: 'system',
        text: t('ui.tui.historyReadFailed', '读取历史失败：') + error.message,
      });
      if (action !== 'rename') return;
    }
    if (this.state !== state) return;
    const prefix = query.toLowerCase();
    const options = list
      .filter(
        (item) =>
          !prefix ||
          String(item.title || 'New')
            .toLowerCase()
            .includes(prefix) ||
          String(item.id).toLowerCase().includes(prefix),
      )
      .map((item) => {
        const session = live.find((entry) => entry.conversationId === item.id);
        const title = item.title || 'New';
        const current = session?.key === this.activeKey;
        const date =
          item.date ||
          item.updatedAt ||
          (Number(item.ts) > 0 ? new Date(Number(item.ts)).toISOString() : '');
        return {
          label:
            title +
            (current ? ' · ' + t('ui.tui.currentSession', '当前') : '') +
            (date ? '  · ' + String(date).slice(0, 10) : ''),
          value: item.id,
          target: {
            id: item.id,
            mode,
            workspace,
            title,
            ...(action === 'rename' && session ? { key: session.key } : {}),
          },
        };
      });
    if (action === 'rename') {
      const saved = new Set(options.map((option) => option.target.key).filter(Boolean));
      options.unshift(
        ...live
          .filter((session) => !saved.has(session.key))
          .map((session) => ({
            label:
              (session.title || 'New') +
              (session.key === this.activeKey ? ' · ' + t('ui.tui.currentSession', '当前') : ''),
            value: session.key,
            target: { key: session.key, title: session.title || '' },
          })),
      );
    }
    if (options.length === 0) {
      this.pushEntry({
        kind: 'system',
        text: prefix
          ? t('ui.tui.noMatchingSessions', '没有匹配的会话')
          : t('ui.tui.historyEmpty', '（{mode} 模式暂无历史会话）', { mode }),
      });
      return;
    }
    this.state.modal = {
      kind:
        action === 'delete' ? 'historyDelete' : action === 'rename' ? 'renameSelect' : 'history',
      colorKey: 'permission',
      title:
        action === 'delete'
          ? t('ui.tui.deletePickerTitle', '选择要删除的会话（{mode}）', { mode })
          : action === 'rename'
            ? t('ui.tui.renamePickerTitle', '选择要重命名的会话（{mode}）', { mode })
            : t('ui.tui.historyTitle', '历史会话（{mode}）', { mode }),
      options,
      selected: 0,
    };
  }

  async _renameSession(target, title) {
    const state = this.state;
    const result = target.key
      ? await this.runtime.setTitle(target.key, title)
      : await this.runtime.renameHistory(target.mode, target.id, title, target.workspace);
    if (result?.ok === false) throw new Error(result.error || 'Rename failed');
    const view =
      target.key === this.activeKey ? this.state : this._sessionViews.get(target.key)?.state;
    if (view) view.title = title;
    state.messages.push({
      kind: 'notice',
      text: t('ui.tui.renamed', '会话已重命名为「{title}」', { title }),
    });
  }

  async _openHistory(id) {
    const state = this.state;
    const key = this.activeKey;
    try {
      const loaded = await this.runtime.openHistory(key, id);
      if (loaded && loaded.ok === false) {
        state.messages.push({
          kind: 'system',
          text:
            t('ui.tui.openFailed', '打开失败：') +
            (loaded.error || t('ui.tui.unknownError', '未知错误')),
        });
        return;
      }
      state.title = loaded?.title || '';
      state.minimalMode = loaded?.minimalMode === true;
      state.affection = loaded?.affection ?? state.affection;
      state.messages = [];
      state.scrollOffset = 0;
      const view = this._sessionViews.get(key);
      if (view) {
        view.tools.clear();
        view.stream = null;
      }
      if (this.activeKey === key) this._streamEntry = null;
      state.messages.push({
        kind: 'notice',
        text: t('ui.tui.historyOpened', '已载入历史会话：{title}', {
          title: state.title || id,
        }),
      });
      for (const message of (loaded && loaded.messages) || []) {
        this._appendHistoryMessage(message, state);
      }
    } catch (error) {
      state.messages.push({
        kind: 'system',
        text:
          t('ui.tui.openFailed', '打开失败：') +
          (error && error.message ? error.message : String(error)),
      });
    }
  }

  _appendHistoryMessage(message, state) {
    if (message.role === 'tool')
      state.messages.push({
        kind: 'tool',
        name: message.name || 'tool',
        status: 'done',
        result: message.content,
      });
    else if (['user', 'assistant', 'system'].includes(message.role)) {
      const content = Array.isArray(message.content)
        ? message.content
            .map((part) => part.text || '')
            .filter(Boolean)
            .join('\n')
        : message.content;
      if (content || message.reasoning || message.attachments?.length)
        state.messages.push({
          kind: message.role,
          text: content || '',
          reasoning: message.reasoning || '',
          attachments: message.attachments || [],
        });
    }
  }

  _openApprovalModal(payload) {
    this.state.modal = {
      kind: 'approval',
      colorKey: 'permission',
      title: t('ui.tui.approvalTitle', '工具执行确认'),
      subtitle: (payload && payload.toolName) || t('ui.tui.unknownTool', '未知工具'),
      body: payload && payload.args ? views.summarizeArgs(payload.args, 200) : '',
      options: [
        { label: t('ui.tui.allowOnce', '允许一次'), value: true, hint: 'y' },
        { label: t('ui.tui.allowAlways', '总是允许'), value: 'allow-always', hint: 'a' },
        { label: t('ui.tui.deny', '拒绝'), value: false, hint: 'n' },
      ],
      shortcuts: { y: 0, a: 1, n: 2 },
      selected: 0,
      footer: t('ui.tui.approvalFooter', 'y 允许 · a 总是允许 · n 拒绝 · Esc 取消'),
    };
  }

  _openToolAuthModal(payload) {
    this.state.modal = {
      kind: 'toolAuth',
      colorKey: 'permission',
      title: t('ui.tui.toolAuthTitle', '工具首次使用授权'),
      subtitle:
        ((payload && payload.toolName) || '') +
        (payload && payload.category ? '（' + payload.category + '）' : ''),
      body: t('ui.tui.toolAuthBody', '该工具首次使用，需要你的授权。允许并记住后不再询问。'),
      options: [
        { label: t('ui.tui.authAlways', '允许并记住'), value: 'allow-always', hint: 'a' },
        { label: t('ui.tui.authOnce', '仅本次允许'), value: 'allow-once', hint: 'y' },
        { label: t('ui.tui.deny', '拒绝'), value: 'deny', hint: 'n' },
      ],
      shortcuts: { a: 0, y: 1, n: 2 },
      selected: 0,
      footer: t('ui.tui.toolAuthFooter', 'a 允许并记住 · y 仅本次 · n 拒绝 · Esc 取消'),
    };
  }

  async _saveTuiPreferences(patch) {
    if (typeof this.runtime.saveSettings === 'function') {
      const settings = await this.runtime.saveSettings({ tui: patch });
      this._applySettings(settings);
    } else {
      // Compatibility for embedded runtimes using the former preference store.
      const tui = { ...(this.state.settings?.tui || {}), ...patch };
      await this.preferences?.save(tui);
      this._applySettings({ ...this.state.settings, tui });
    }
  }

  _openTodoModal(selectedId) {
    const todos = this.state.todos || [];
    const previous = this.state.modal?.kind === 'todo' ? this.state.modal : null;
    const scrollOffset = previous?.scrollOffset || 0;
    selectedId ??= previous?.options?.[previous.selected]?.value;
    this.state.modal = {
      kind: 'todo',
      scrollOffset,
      colorKey: 'planMode',
      title: t('ui.tui.todoTitle', '待办清单'),
      body: todos.length ? '' : t('ui.tui.todoEmpty', '（暂无待办）'),
      options: todos.length
        ? todos.map((item, index) => ({
            label: (item.done ? '[x] ' : '[ ] ') + (index + 1) + '. ' + item.text,
            value: item.id,
          }))
        : [{ label: t('ui.tui.helpClose', '关闭'), value: 'close' }],
      footer: todos.length
        ? t('ui.tui.todoNav', '↑↓ 选择 · Space / Enter 切换状态 · Esc 关闭')
        : '',
      selected: Math.max(
        0,
        selectedId == null ? 0 : todos.findIndex((item) => item.id === selectedId),
      ),
      busy: previous?.busy || false,
    };
  }

  // ---------------------------------------------------------------- 内部工具

  pushEntry(entry) {
    this.state.messages.push(entry);
  }

  _lastAssistantEntry() {
    for (let i = this.state.messages.length - 1; i >= 0; i -= 1) {
      const entry = this.state.messages[i];
      if (entry.kind === 'assistant') return entry;
    }
    return null;
  }

  _lastToolEntry(name) {
    for (let i = this.state.messages.length - 1; i >= 0; i -= 1) {
      const entry = this.state.messages[i];
      if (entry.kind === 'tool' && entry.name === name) return entry;
    }
    return null;
  }

  _lastSubAgentEntry() {
    for (let i = this.state.messages.length - 1; i >= 0; i -= 1) {
      const entry = this.state.messages[i];
      if (entry.kind === 'subagent') return entry;
    }
    return null;
  }

  _footerHints() {
    const hints = [];
    if (this.state.selection?.moved)
      hints.push(t('ui.tui.selectionHint', 'ctrl+c 复制 · esc 取消选择'));
    else if (this.state.running) hints.push(t('ui.tui.escStop', 'esc 停止'));
    else hints.push(t('ui.tui.enterSend', 'enter 发送'));
    hints.push(t('ui.tui.hints', 'tab 补全 · ctrl+t 待办 · ctrl+r 历史 · /help 命令'));
    if (this.attachments.length > 0) hints.push('附件 ' + this.attachments.length);
    return hints;
  }

  _inputHint() {
    // 补全建议由输入框上方的补全面板呈现，这里只显示会话状态
    const modeLabel = views.MODE_LABEL[this.state.mode] || this.state.mode;
    if (this.state.running) return modeLabel + ' · ' + t('ui.tui.running', '运行中');
    return modeLabel + (this.state.title ? ' · ' + this.state.title : '');
  }
}

module.exports = { TuiApp, MODES };
