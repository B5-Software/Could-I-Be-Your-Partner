/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 自动化任务编辑器窗口：IDE 风格，主题实时跟随主窗口。
 */

(function () {
  'use strict';

  const api = window.automationEditorAPI;
  const $ = (id) => document.getElementById(id);
  let monacoReady = null;
  let monacoEditor = null;
  let currentTask = null;
  let dirty = false;
  let validateTimer = null;

  const initialId = new URLSearchParams(location.search).get('id') || null;

  function setDirty(v) {
    dirty = !!v;
    $('ae-dirty')?.classList.toggle('hidden', !dirty);
    const title = $('ae-title');
    if (title) {
      const name = ($('ae-name')?.value || '').trim() || '未命名任务';
      title.textContent = `${name}${dirty ? ' •' : ''}`;
    }
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function colorWithAlpha(color, alpha) {
    const c = String(color || '').trim();
    let r = 79, g = 140, b = 255;
    if (c.startsWith('#')) {
      if (c.length === 4) {
        r = parseInt(c[1] + c[1], 16); g = parseInt(c[2] + c[2], 16); b = parseInt(c[3] + c[3], 16);
      } else if (c.length >= 7) {
        r = parseInt(c.slice(1, 3), 16); g = parseInt(c.slice(3, 5), 16); b = parseInt(c.slice(5, 7), 16);
      }
    }
    if ([r, g, b].some((x) => !Number.isFinite(x))) return `rgba(79,140,255,${alpha})`;
    return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;
  }

  function applyCssTheme(theme, shouldUseDarkColors) {
    document.documentElement.setAttribute('data-theme', shouldUseDarkColors ? 'dark' : 'light');
    if (theme && typeof theme === 'object') {
      const map = {
        '--accent': theme.accentColor || theme.accent,
        '--accent-light': theme.accentLight || theme.accentColor,
        '--accent-dark': theme.accentDark || theme.accentColor,
        '--bg-primary': theme.backgroundColor,
        '--text-primary': theme.textColor,
        '--border': theme.borderColor
      };
      for (const [k, v] of Object.entries(map)) {
        if (v) document.documentElement.style.setProperty(k, v);
      }
    }
    applyMonacoTheme();
  }

  function defineMonacoTheme() {
    if (!window.monaco) return;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const accent = cssVar('--accent', isDark ? '#6c8cff' : '#4f8cff');
    const background = cssVar('--bg-primary', isDark ? '#1a1a30' : '#f5f7fa');
    const foreground = cssVar('--text-primary', isDark ? '#e8e8f0' : '#1a1a2e');
    const secondary = cssVar('--text-secondary', isDark ? '#a0a0c0' : '#5a5a7a');
    const border = cssVar('--border', isDark ? '#333360' : '#e2e6ee');
    window.monaco.editor.defineTheme('cipyp-dsl', {
      base: isDark ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: isDark ? '#7a8ca8' : '#8590a2', fontStyle: 'italic' },
        { token: 'keyword', foreground: accent },
        { token: 'string', foreground: isDark ? '#8fd39a' : '#2e7d4f' },
        { token: 'number', foreground: isDark ? '#ffc66d' : '#b26a00' },
        { token: 'type', foreground: accent },
        { token: 'function', foreground: accent },
        { token: 'variable', foreground: isDark ? '#b8c7ff' : '#4a4a7a' }
      ],
      colors: {
        'editor.background': background,
        'editor.foreground': foreground,
        'editorLineNumber.foreground': secondary,
        'editorLineNumber.activeForeground': accent,
        'editorCursor.foreground': accent,
        'editor.selectionBackground': colorWithAlpha(accent, 0.26),
        'editor.lineHighlightBackground': colorWithAlpha(accent, 0.07),
        'editorIndentGuide.background1': colorWithAlpha(accent, 0.14),
        'editorIndentGuide.activeBackground1': colorWithAlpha(accent, 0.32),
        'editorWidget.background': background,
        'editorWidget.border': border,
        'editorSuggestWidget.background': background,
        'editorSuggestWidget.border': border,
        'editorSuggestWidget.selectedBackground': colorWithAlpha(accent, 0.18),
        'scrollbarSlider.background': colorWithAlpha(accent, 0.22),
        'scrollbarSlider.hoverBackground': colorWithAlpha(accent, 0.32),
        'editorGutter.background': background
      }
    });
  }

  function applyMonacoTheme() {
    if (!window.monaco || !monacoEditor) return;
    defineMonacoTheme();
    monacoEditor.updateOptions({ theme: 'cipyp-dsl' });
  }

  function ensureMonaco() {
    if (monacoReady) return monacoReady;
    monacoReady = new Promise((resolve, reject) => {
      if (typeof require === 'undefined' || !require.config) { reject(new Error('Monaco loader 不可用')); return; }
      require.config({ paths: { vs: '../../../node_modules/monaco-editor/min/vs' } });
      window.MonacoEnvironment = {
        getWorkerUrl: function () {
          const base = new URL('../../../node_modules/monaco-editor/min/vs', location.href).href;
          const workerMain = new URL('../../../node_modules/monaco-editor/min/vs/base/worker/workerMain.js', location.href).href;
          const blob = new Blob([
            'self.MonacoEnvironment = { baseUrl: "' + base + '" };',
            'importScripts("' + workerMain + '");'
          ], { type: 'application/javascript' });
          return URL.createObjectURL(blob);
        }
      };
      require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    });
    return monacoReady;
  }

  async function initMonaco() {
    if (monacoEditor) return monacoEditor;
    const monaco = await ensureMonaco();
    const host = $('ae-editor-host');
    if (!host) return null;
    defineMonacoTheme();
    monacoEditor = monaco.editor.create(host, {
      value: currentTask?.dsl || 'return "你好，我是自动化任务。"',
      language: 'javascript',
      theme: 'cipyp-dsl',
      automaticLayout: true,
      minimap: { enabled: true, maxColumn: 80 },
      fontSize: 13,
      fontLigatures: true,
      tabSize: 2,
      scrollBeyondLastLine: false,
      padding: { top: 10, bottom: 10 },
      bracketPairColorization: { enabled: true },
      renderWhitespace: 'selection',
      smoothScrolling: true,
      cursorSmoothCaretAnimation: 'on'
    });
    monacoEditor.onDidChangeModelContent(() => {
      setDirty(true);
      scheduleValidate();
    });
    monacoEditor.onDidChangeCursorPosition((e) => {
      const el = $('ae-status-pos');
      if (el) el.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
    });
    monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
    monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => testRender());
    return monacoEditor;
  }

  function renderTriggerConfig(type) {
    const host = $('ae-trigger-config');
    if (!host) return;
    const cfg = currentTask?.trigger?.config || {};
    if (type === 'schedule') {
      host.innerHTML = `
        <label class="ae-field">
          <span class="ae-label">cron（分 时 日 月 周）</span>
          <input type="text" id="ae-cron" placeholder="*/5 * * * *" value="${escapeAttr(cfg.cron || '*/5 * * * *')}">
        </label>
        <p class="ae-hint">例：<code>*/5 * * * *</code> 每 5 分钟；<code>0 9 * * 1-5</code> 工作日 9 点。</p>`;
    } else if (type === 'notification') {
      host.innerHTML = `
        <div class="ae-config-grid">
          <label class="ae-field full">
            <span class="ae-label">通知类别</span>
            <select id="ae-notif-kind">
              <option value="any" ${cfg.kind === 'any' ? 'selected' : ''}>任意</option>
              <option value="sessionDone" ${cfg.kind === 'sessionDone' ? 'selected' : ''}>会话完成</option>
              <option value="sessionError" ${cfg.kind === 'sessionError' ? 'selected' : ''}>会话失败</option>
              <option value="approval" ${cfg.kind === 'approval' ? 'selected' : ''}>等待审批</option>
              <option value="other" ${cfg.kind === 'other' ? 'selected' : ''}>其他</option>
            </select>
          </label>
          <label class="ae-field">
            <span class="ae-label">标题正则（可选）</span>
            <input type="text" id="ae-notif-title" value="${escapeAttr(cfg.titleRegex || '')}" placeholder=".*完成.*">
          </label>
          <label class="ae-field">
            <span class="ae-label">正文正则（可选）</span>
            <input type="text" id="ae-notif-body" value="${escapeAttr(cfg.bodyRegex || '')}" placeholder=".*失败.*">
          </label>
        </div>`;
    } else {
      host.innerHTML = `
        <p class="ae-hint">启用后自动启动信号服务器（默认 <code>127.0.0.1:8765</code>）。</p>
        <pre style="font-size:11px;background:var(--ae-bg);padding:8px;border-radius:8px;overflow:auto">POST /trigger/{id}
Authorization: Bearer &lt;token&gt;
Content-Type: application/json
{"任意":"JSON 参数 → DSL args"}</pre>`;
    }
    host.querySelectorAll('input, select').forEach((el) => {
      el.addEventListener('input', () => setDirty(true));
      el.addEventListener('change', () => setDirty(true));
    });
  }

  function escapeAttr(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function collectTask() {
    const type = $('ae-trigger-type')?.value || 'schedule';
    let config = {};
    if (type === 'schedule') config = { cron: ($('ae-cron')?.value || '').trim() };
    if (type === 'notification') {
      config = {
        kind: $('ae-notif-kind')?.value || 'any',
        titleRegex: ($('ae-notif-title')?.value || '').trim(),
        bodyRegex: ($('ae-notif-body')?.value || '').trim()
      };
    }
    return {
      id: currentTask?.id || undefined,
      name: ($('ae-name')?.value || '').trim() || '未命名任务',
      enabled: $('ae-enabled')?.checked !== false,
      trigger: { type, config },
      dsl: monacoEditor ? monacoEditor.getValue() : '',
      runCount: currentTask?.runCount || 0,
      lastRunAt: currentTask?.lastRunAt || null,
      lastError: currentTask?.lastError || null
    };
  }

  function showOutput(text, kind) {
    const out = $('ae-output');
    const body = $('ae-output-body');
    if (!out || !body) return;
    out.classList.remove('hidden');
    body.textContent = text || '';
    body.style.color = kind === 'error' ? 'var(--ae-danger)' : 'var(--ae-text)';
  }

  function setValid(ok, message) {
    const el = $('ae-status-valid');
    if (!el) return;
    el.classList.toggle('ae-valid', ok);
    el.classList.toggle('ae-invalid', !ok);
    el.innerHTML = ok
      ? '<i class="fa-solid fa-circle-check"></i> 语法有效'
      : `<i class="fa-solid fa-circle-xmark"></i> ${escapeAttr(message || '语法错误')}`;
  }

  async function scheduleValidate() {
    clearTimeout(validateTimer);
    validateTimer = setTimeout(async () => {
      const r = await api.testTask(collectTask(), {});
      if (r && r.ok) {
        setValid(true);
      } else {
        setValid(false, (r && r.error) || '渲染失败');
      }
    }, 500);
  }

  async function save() {
    const task = collectTask();
    if (task.trigger.type === 'schedule' && !/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(task.trigger.config.cron)) {
      showOutput('cron 需要 5 段（分 时 日 月 周）', 'error');
      return;
    }
    const r = await api.saveTask(task);
    if (!r.ok) { showOutput(r.error || '保存失败', 'error'); return; }
    currentTask = r.task;
    refreshMeta();
    setDirty(false);
    showOutput('已保存：' + (currentTask.name || '未命名任务'), 'ok');
  }

  async function testRender() {
    const r = await api.testTask(collectTask(), {});
    if (r.ok) {
      setValid(true);
      showOutput('—— 渲染结果 ——\n\n' + (r.result?.prompt || ''), 'ok');
    } else {
      setValid(false, r.error);
      showOutput(r.error || '渲染失败', 'error');
    }
  }

  async function runNow() {
    if (dirty) await save();
    if (!currentTask?.id) return;
    const r = await api.runTask(currentTask.id, {});
    showOutput(r.ok
      ? `已触发，正在新建 Chat 会话…（sessionKey: ${r.result?.sessionKey || '—'}）`
      : (r.error || '执行失败'), r.ok ? 'ok' : 'error');
  }

  function refreshMeta() {
    const t = currentTask || {};
    $('ae-run-count').textContent = String(t.runCount || 0);
    $('ae-last-run').textContent = t.lastRunAt ? new Date(t.lastRunAt).toLocaleString() : '—';
    $('ae-task-id').textContent = t.id || '—';
    const err = $('ae-last-error');
    if (err) {
      err.classList.toggle('hidden', !t.lastError);
      err.textContent = t.lastError || '';
    }
    $('ae-tab-name').textContent = `${t.id || 'new'}.dsl`;
    setDirty(false);
  }

  async function loadTask(id) {
    if (id) {
      const r = await api.getTask(id);
      if (r.ok) currentTask = r.task;
    }
    if (!currentTask) {
      currentTask = {
        name: '', enabled: true,
        trigger: { type: 'schedule', config: { cron: '*/5 * * * *' } },
        dsl: 'return "你好，我是自动化任务。"'
      };
    }
    $('ae-name').value = currentTask.name || '';
    $('ae-enabled').checked = !!currentTask.enabled;
    $('ae-trigger-type').value = currentTask.trigger?.type || 'schedule';
    renderTriggerConfig(currentTask.trigger?.type || 'schedule');
    if (monacoEditor) monacoEditor.setValue(currentTask.dsl || '');
    refreshMeta();
  }

  function bindEvents() {
    ['ae-name'].forEach((id) => $(id)?.addEventListener('input', () => setDirty(true)));
    $('ae-enabled')?.addEventListener('change', () => setDirty(true));
    $('ae-trigger-type')?.addEventListener('change', (e) => {
      setDirty(true);
      renderTriggerConfig(e.target.value);
    });
    $('btn-save')?.addEventListener('click', save);
    $('btn-test')?.addEventListener('click', testRender);
    $('btn-run')?.addEventListener('click', runNow);
    $('btn-close-output')?.addEventListener('click', () => $('ae-output')?.classList.add('hidden'));
    $('btn-close')?.addEventListener('click', async () => {
      if (dirty && !window.confirm('当前修改尚未保存，确定关闭吗？')) return;
      api.closeWindow();
    });
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); testRender(); }
    });
    api.onOpenRequest((payload) => {
      if (payload && payload.id) loadTask(payload.id);
    });
    api.onThemeApply(({ theme, shouldUseDarkColors }) => applyCssTheme(theme, shouldUseDarkColors));
    api.onThemeChanged(({ shouldUseDarkColors }) => applyCssTheme(null, shouldUseDarkColors));
  }

  async function init() {
    bindEvents();
    await loadTask(initialId);
    await initMonaco();
    const t = await api.getTheme();
    applyCssTheme(null, t && t.shouldUseDarkColors);
    // 初始完整主题（accent/bg）
    try {
      const settings = await window.automationEditorAPI.getTheme();
      applyCssTheme(null, settings?.shouldUseDarkColors);
    } catch { /* ignore */ }
  }

  init().catch((e) => {
    showOutput('初始化失败：' + (e && e.message ? e.message : String(e)), 'error');
  });
})();
