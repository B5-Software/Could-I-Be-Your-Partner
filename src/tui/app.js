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
const { themeFromEnv, themeFromSettings, applyAccent } = require('./theme.js');
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

const MODES = ['chat', 'babe', 'code'];

class TuiApp {
  constructor(options = {}) {
    this.runtime = options.runtime;
    if (!this.runtime) throw new TypeError('TuiApp: runtime is required');
    this.theme = options.theme || themeFromEnv();
    this.onQuit = options.onQuit || (() => {});
    this.clock = options.clock || (() => Date.now());
    this.editor = new LineEditor({ history: options.history || [] });
    this.attachments = [];
    this.env = options.env || (typeof process !== 'undefined' ? process.env : {});
    this.customCommands = new Map();
    this._completionSelected = 0;
    this._historyCache = [];

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
      boot: null, // VM 启动中：{ progress, detail }；就绪/失败后置 null
      thinkingExpanded: false, // /thinking 全局切换推理折叠/展开
      todos: [],
      editorText: '',
      editorCursor: 0,
    };

    this.activeKey = null;
    this.quitArmedAt = 0;
    this._toolEntries = new Map(); // callId / seq → 工具条目
    this._streamEntry = null;
    this._startedAt = 0;
    this._eventQueue = Promise.resolve();
    this._unsubscribe = null;
    this._pending = Promise.resolve();
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

    // 欢迎语放在建会话之后：newSession 会重置消息区
    await this.newSession(mode, opts.workspacePath);
    this.pushEntry({
      kind: 'notice',
      text: t('ui.tui.brand', 'CIBYP · 全能 AI 伙伴 · 终端模式（/help 查看命令）'),
    });
    try {
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
    this._reloadCustomCommands();
    return this;
  }

  /**
   * 沿用 GUI 的设置项：主题（dark/light/system）、强调色、界面语言。
   * CIBYP_TUI_THEME 显式指定时优先于设置。
   */
  _applySettings(settings) {
    if (!settings) return;
    const envTheme = this.env && this.env.CIBYP_TUI_THEME;
    if (!envTheme) {
      this.theme = themeFromSettings(settings, this.env);
    }
    const accent = settings.theme && settings.theme.accentColor;
    if (accent) this.theme = applyAccent(this.theme, accent);
    this.state.theme = this.theme;
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

  /** 重载自定义命令（用户目录 + 工作区目录） */
  _reloadCustomCommands() {
    this.customCommands = loadCustomCommands(
      defaultCommandDirs({ env: this.env, workspace: this.state.workspace || undefined }),
    );
    return this.customCommands;
  }

  dispose() {
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
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
    this.state.width = width;
    this.state.height = height;
    this.state.scrollOffset = 0;
  }

  /** 动画时钟（spinner / 闪烁 / 计时） */
  tick() {
    this.state.spinnerFrame = (this.state.spinnerFrame + 1) % 12;
    this.state.blink = !this.state.blink;
    if (this.state.running && this._startedAt) {
      this.state.elapsedMs = this.clock() - this._startedAt;
    }
  }

  /** 渲染一帧 */
  frame() {
    this.state.editorText = this.editor.value;
    this.state.editorCursor = this.editor.cursor;
    this.state.completion = this._computeCompletion();
    return views.composeFrame(this.state, {
      hints: this._footerHints(),
      inputHint: this._inputHint(),
    });
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
    // 历史类命令的参数补全需要历史清单：按需预取（异步填充，下一帧可见）
    if ((name === 'open' || name === 'delete') && this._historyCache.length === 0) {
      this._prefetchHistory();
    }
    const items = suggestArgs(name, argPrefix, { modes: MODES, history: this._historyCache });
    if (items.length === 0) return null;
    return {
      kind: 'arg',
      items,
      selected: Math.min(this._completionSelected, items.length - 1),
    };
  }

  async _prefetchHistory() {
    try {
      const list = await this.runtime.listHistory(this.state.mode);
      this._historyCache = Array.isArray(list) ? list : [];
    } catch {
      this._historyCache = [];
    }
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
    this.state.toast = null;
    // 先刷新补全面板：面板必须与当前输入同步，
    // 否则文本变化后回车会"补全"成陈旧建议（吞掉已输入的参数）。
    this.state.completion = this._computeCompletion();
    try {
      return await this._dispatchKey(key);
    } finally {
      this.state.completion = this._computeCompletion();
    }
  }

  async _dispatchKey(key) {
    if (this.state.modal) return this._handleModalKey(key);

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
      if (key.direction === 'up') {
        this.state.scrollOffset += step;
      } else {
        this.state.scrollOffset = Math.max(0, this.state.scrollOffset - step);
      }
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
      this.state.scrollOffset += Math.floor(this.state.height / 2);
      return true;
    }
    if (key.name === 'pagedown') {
      this.state.scrollOffset = Math.max(
        0,
        this.state.scrollOffset - Math.floor(this.state.height / 2),
      );
      return true;
    }
    return false;
  }

  _armQuitOrStop() {
    if (this.state.running) {
      this._stop();
      return true;
    }
    const now = this.clock();
    if (now - this.quitArmedAt < 3000) {
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

    if (modal.kind === 'ask' && modal.inputMode) {
      // 问答的自由文本输入
      if (key.name === 'enter' && !key.alt) {
        const value = modal.editor.value.trim();
        this._answerQuestion(value, modal);
        return true;
      }
      modal.editor.handleKey(key);
      return true;
    }

    const options = modal.options || [];
    const isChar = key.name === 'char';
    const plainChar = isChar && !key.ctrl && !key.alt;
    if (key.name === 'wheel') {
      // 模态打开时滚轮翻选项（输入框区域滚轮仍滚动聊天记录：见 _handleGlobalKey）
      if (key.direction === 'up') {
        modal.selected = (modal.selected + options.length - 1) % Math.max(1, options.length);
      } else {
        modal.selected = (modal.selected + 1) % Math.max(1, options.length);
      }
      return true;
    }
    if (key.name === 'escape') {
      this._cancelModal();
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
    if (key.name === 'enter') {
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
    this.state.modal = null;

    if (modal.kind === 'approval') {
      this.runtime.respond(this.activeKey, option.value);
    } else if (modal.kind === 'toolAuth') {
      this.runtime.respond(this.activeKey, option.value);
    } else if (modal.kind === 'ask') {
      this._answerQuestion(option.value, modal);
    } else if (modal.kind === 'sessions') {
      await this._switchSession(option.value);
    } else if (modal.kind === 'mode') {
      await this.newSession(
        option.value,
        option.value === 'code' ? this.state.workspace || undefined : undefined,
      );
    } else if (modal.kind === 'history') {
      await this._openHistory(option.value);
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

  async handleRuntimeEvent(event) {
    if (!event || !event.type) return;
    // 只处理属于当前会话的事件（多会话并存时避免互相串扰）
    if (
      event.key &&
      this.activeKey &&
      event.key !== this.activeKey &&
      event.type !== 'session-created'
    ) {
      return;
    }
    switch (event.type) {
      case 'message': {
        if (event.role === 'user') {
          this.pushEntry({ kind: 'user', text: event.content });
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
        // 推理与正文分通道：reasoning 进推理块，content 进正文
        const content = (event.data && event.data.content) || '';
        const reasoning = (event.data && event.data.reasoning) || '';
        if (this._streamEntry && (content || reasoning)) {
          if (content) this._streamEntry.text += content;
          if (reasoning) {
            this._streamEntry.reasoning = (this._streamEntry.reasoning || '') + reasoning;
          }
          this.state.scrollOffset = 0;
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
        const reasoningText = event.data && (event.data.text || event.data.reasoning);
        if (!reasoningText) break;
        const entry = this._lastAssistantEntry();
        if (entry) {
          entry.reasoning = reasoningText;
        } else {
          this.pushEntry({ kind: 'assistant', text: '', reasoning: reasoningText });
        }
        break;
      }
      case 'tool-call': {
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
        this.state.scrollOffset = 0;
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
        this.state.running = event.status === 'running';
        if (this.state.running && !this._startedAt) this._startedAt = this.clock();
        if (!this.state.running) {
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
        const cost = event.costUSD != null ? event.costUSD : event.data && event.data.costUSD;
        if (typeof cost === 'number') this.state.costUSD = cost;
        else if (cost === null) this.state.costUSD = 0;
        break;
      }
      case 'context-progress':
        this.state.context = event.data || null;
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
  }

  // ---------------------------------------------------------------- 会话 / 命令

  async newSession(mode, workspacePath) {
    const key =
      'tui:' + mode + ':' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.activeKey = key;
    this.state.mode = mode;
    this.state.title = '';
    this.state.affection =
      mode === 'babe'
        ? this.state.initialAffection != null
          ? this.state.initialAffection
          : 30
        : null;
    this.state.messages = [];
    this.state.scrollOffset = 0;
    this._toolEntries.clear();
    this._streamEntry = null;
    this.runtime.createSession({ key, mode, workspacePath });
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
                })
              : t('ui.tui.mode.code', '已切换到 Code 模式') +
                t('ui.tui.mode.codeNoWorkspace', '（/workspace <路径> 设置工作区）')
            : t('ui.tui.mode.chat', '已切换到 Chat 模式'),
    });
  }

  async _switchSession(key) {
    const session = this.runtime.getSession(key);
    if (!session) return;
    this.activeKey = key;
    this.state.mode = session.mode || 'chat';
    this.state.title = session.title || '';
    this.state.workspace = session.workspacePath || '';
    this.state.messages = [];
    this.state.scrollOffset = 0;
    this.pushEntry({
      kind: 'notice',
      text: t('ui.tui.switchedToSession', '已切换到会话 {title}', { title: session.title || key }),
    });
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
    const attachments = this.attachments.splice(0, this.attachments.length);
    this.state.scrollOffset = 0;
    this._startedAt = this.clock();
    this.state.running = true;
    try {
      await this.runtime.sendMessage(this.activeKey, text, attachments);
    } catch (error) {
      this.pushEntry({
        kind: 'system',
        text:
          t('ui.tui.sendFailedPrefix', '发送失败：') +
          (error && error.message ? error.message : String(error)),
      });
    } finally {
      this.state.running = false;
      this._startedAt = 0;
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
      if (result && result.url) {
        this.pushEntry({
          kind: 'assistant',
          text: t('ui.tui.vmdeskUrl', 'VM 桌面：{url}', { url: result.url }),
        });
      } else {
        this.pushEntry({ kind: 'notice', text: t('ui.tui.vmdeskOpened', 'VM 桌面已打开') });
      }
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
        await this.newSession(
          mode,
          mode === 'code' ? this.state.workspace || undefined : undefined,
        );
        return;
      }
      case 'new': {
        const mode = MODES.includes(argText.trim().toLowerCase())
          ? argText.trim().toLowerCase()
          : this.state.mode;
        await this.newSession(
          mode,
          mode === 'code' ? this.state.workspace || undefined : undefined,
        );
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
              (s.title || s.key) +
              '  [' +
              (s.mode || 'chat') +
              (s.busy ? ' · ' + t('ui.tui.running', '运行中') : '') +
              ']',
            value: s.key,
          })),
          selected: 0,
        };
        return;
      }
      case 'history': {
        await this._openHistoryModal();
        return;
      }
      case 'open': {
        const id = argText.trim();
        if (!id) {
          this.pushEntry({ kind: 'system', text: '用法：/open <会话 ID>（/history 查看列表）' });
          return;
        }
        await this._openHistory(id);
        return;
      }
      case 'rename': {
        const title = argText.trim();
        if (!title) {
          this.pushEntry({ kind: 'system', text: '用法：/rename <新标题>' });
          return;
        }
        this.state.title = title;
        await this.runtime.setTitle(this.activeKey, title);
        this.pushEntry({
          kind: 'notice',
          text: t('ui.tui.renamedPrefix', '会话已重命名为「') + title + '」',
        });
        return;
      }
      case 'delete': {
        const id = argText.trim();
        if (!id) {
          this.pushEntry({ kind: 'system', text: '用法：/delete <会话 ID>' });
          return;
        }
        await this.runtime.deleteHistory(this.state.mode, id);
        this.pushEntry({
          kind: 'notice',
          text: t('ui.tui.historyDeleted', '已删除历史会话 {id}', { id }),
        });
        return;
      }
      case 'attach': {
        const filePath = argText.trim();
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
        this.attachments.push({ name: filePath.split(/[\\/]/).pop(), path: filePath });
        this.pushEntry({
          kind: 'notice',
          text:
            t('ui.tui.attachedFilePrefix', '已附加文件：') +
            filePath +
            t('ui.tui.attachHint', '（随下一条消息发送）'),
        });
        return;
      }
      case 'workspace': {
        const target = argText.trim();
        if (!target) {
          this.pushEntry({
            kind: 'system',
            text:
              t('ui.tui.workspaceCurrentPrefix', '当前工作区：') +
              (this.state.workspace || t('ui.tui.workspaceUnset', '（未设置）')),
          });
          return;
        }
        this.state.workspace = target;
        await this.runtime.setWorkspace(this.activeKey, target);
        this._reloadCustomCommands();
        this.pushEntry({
          kind: 'notice',
          text: t('ui.tui.workspaceSet', '工作区已设置为 {path}', { path: target }),
        });
        return;
      }
      case 'todo': {
        this._openTodoModal();
        return;
      }
      case 'usage': {
        const stats =
          typeof this.runtime.getStats === 'function'
            ? this.runtime.getStats(this.activeKey)
            : null;
        const usage = (stats && stats.usage) || this.state.usage || {};
        const context = (stats && stats.context) || this.state.context;
        this.pushEntry({
          kind: 'system',
          text:
            t(
              'ui.tui.usageLine',
              '本轮用量：prompt {prompt} · completion {completion} · total {total}',
              {
                prompt: usage.prompt || 0,
                completion: usage.completion || 0,
                total: usage.total || 0,
              },
            ) +
            (context && context.max
              ? '\n' +
                t('ui.tui.usageContext', '上下文占用：{used} / {max}', {
                  used: context.used || 0,
                  max: context.max,
                })
              : '') +
            (stats && typeof stats.affection === 'number'
              ? '\n' + t('ui.tui.usageAffection', '好感度：{value}', { value: stats.affection })
              : ''),
        });
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
        this.state.thinkingExpanded = !this.state.thinkingExpanded;
        this.pushEntry({
          kind: 'notice',
          text: this.state.thinkingExpanded
            ? t('ui.tui.thinkingExpanded', '推理内容：展开')
            : t('ui.tui.thinkingCollapsed', '推理内容：折叠'),
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

  async _openHistoryModal() {
    let list = [];
    try {
      list = (await this.runtime.listHistory(this.state.mode)) || [];
    } catch (error) {
      this.pushEntry({
        kind: 'system',
        text: t('ui.tui.historyReadFailed', '读取历史失败：') + error.message,
      });
      return;
    }
    if (list.length === 0) {
      this.pushEntry({
        kind: 'system',
        text: t('ui.tui.historyEmpty', '（{mode} 模式暂无历史会话）', { mode: this.state.mode }),
      });
      return;
    }
    this.state.modal = {
      kind: 'history',
      colorKey: 'permission',
      title: t('ui.tui.historyTitle', '历史会话（{mode}）', { mode: this.state.mode }),
      options: list.slice(0, 20).map((item) => ({
        label: (item.title || item.id) + (item.date ? '  · ' + String(item.date).slice(0, 10) : ''),
        value: item.id,
      })),
      selected: 0,
    };
  }

  async _openHistory(id) {
    try {
      const loaded = await this.runtime.openHistory(this.activeKey, id);
      if (loaded && loaded.ok === false) {
        this.pushEntry({
          kind: 'system',
          text:
            t('ui.tui.openFailed', '打开失败：') +
            (loaded.error || t('ui.tui.unknownError', '未知错误')),
        });
        return;
      }
      this.state.title = (loaded && loaded.title) || this.state.title;
      this.state.messages = [];
      this._toolEntries.clear();
      this.pushEntry({
        kind: 'notice',
        text: t('ui.tui.historyOpened', '已载入历史会话：{title}', {
          title: this.state.title || id,
        }),
      });
      for (const message of (loaded && loaded.messages) || []) {
        if (message.role === 'user') this.pushEntry({ kind: 'user', text: message.content });
        else if (message.role === 'assistant')
          this.pushEntry({ kind: 'assistant', text: message.content });
        else if (message.role === 'tool')
          this.pushEntry({
            kind: 'tool',
            name: message.name || 'tool',
            status: 'done',
            result: message.content,
          });
      }
    } catch (error) {
      this.pushEntry({
        kind: 'system',
        text:
          t('ui.tui.openFailed', '打开失败：') +
          (error && error.message ? error.message : String(error)),
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

  _openTodoModal() {
    const todos = this.state.todos || [];
    this.state.modal = {
      kind: 'todo',
      colorKey: 'planMode',
      title: t('ui.tui.todoTitle', '待办清单'),
      body:
        todos.length === 0
          ? t('ui.tui.todoEmpty', '（暂无待办）')
          : todos
              .map((item, index) => (item.done ? '[x] ' : '[ ] ') + (index + 1) + '. ' + item.text)
              .join('\n'),
      options: [{ label: t('ui.tui.helpClose', '关闭'), value: 'close' }],
      selected: 0,
    };
  }

  // ---------------------------------------------------------------- 内部工具

  pushEntry(entry) {
    this.state.messages.push(entry);
    this.state.scrollOffset = 0;
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
    if (this.state.running) hints.push(t('ui.tui.escStop', 'esc 停止'));
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
