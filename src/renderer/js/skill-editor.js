/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

(function () {
  'use strict';

  const api = window.skillEditorAPI;
  if (!api) {
    document.body.innerHTML = '<div style="padding:24px;color:#e74c3c">Skill Editor preload API 未加载。</div>';
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const initialId = params.get('id') || '';
  const initialReadonly = params.get('readonly') === '1';

  const EXT_LANGUAGE = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', pyw: 'python',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    ps1: 'powershell', bat: 'bat', cmd: 'bat',
    json: 'json', md: 'markdown', markdown: 'markdown',
    txt: 'plaintext'
  };

  let monacoEditor = null;
  let monacoReady = null;
  let promptModel = null;
  let scriptModels = new Map();
  let skillData = createBlankSkill();
  let scripts = [];
  let currentTab = { type: 'prompt', id: null };
  let readonly = initialReadonly;
  let dirty = false;
  let initialLoading = true;

  function $(id) {
    return document.getElementById(id);
  }

  function createBlankSkill() {
    return {
      id: '',
      name: '',
      description: '',
      prompt: '',
      license: '',
      compatibility: '',
      allowedTools: [],
      metadata: {},
      runtime: 'javascript',
      type: 'custom',
      sourceType: 'manual',
      scripts: []
    };
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function basename(p) {
    return String(p || '').split(/[\\/]/).pop() || '';
  }

  function extname(name) {
    const base = basename(name);
    const idx = base.lastIndexOf('.');
    return idx >= 0 ? base.slice(idx + 1).toLowerCase() : '';
  }

  function inferRuntime(name) {
    const ext = extname(name);
    if (ext === 'py' || ext === 'pyw') return 'python';
    if (ext === 'sh' || ext === 'bash' || ext === 'zsh' || ext === 'ps1' || ext === 'bat' || ext === 'cmd') return 'shell';
    if (ext === 'mjs' || ext === 'cjs') return 'node';
    return 'javascript';
  }

  function inferLanguage(name, runtime) {
    const ext = extname(name);
    if (EXT_LANGUAGE[ext]) return EXT_LANGUAGE[ext];
    if (runtime === 'node' || runtime === 'javascript') return 'javascript';
    if (runtime === 'python') return 'python';
    if (runtime === 'shell') return 'shell';
    return 'plaintext';
  }

  function normalizeScript(script, index) {
    const s = script && typeof script === 'object' ? script : {};
    const name = String(s.name || `script_${index + 1}.js`);
    return {
      id: String(s.id || `script_${Date.now().toString(36)}_${index}`),
      name,
      path: String(s.path || ''),
      code: String(s.code || ''),
      runtime: String(s.runtime || inferRuntime(name))
    };
  }

  function parseAllowedTools(value) {
    return String(value || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  }

  function parseMetadata(text) {
    const value = String(text || '').trim();
    if (!value) return {};
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* fall through to line parser */ }

    const result = {};
    value.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const match = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (!match) return;
      let val = match[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else if (val === '') {
        val = '';
      } else {
        try { val = JSON.parse(val); } catch { /* keep string */ }
      }
      result[match[1].trim()] = val;
    });
    return result;
  }

  function metadataToText(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '';
    try {
      const text = JSON.stringify(metadata, null, 2);
      return text === '{}' ? '' : text;
    } catch {
      return '';
    }
  }

  function setDirty(value) {
    if (readonly || initialLoading) return;
    dirty = !!value;
    $('se-dirty-badge').classList.toggle('hidden', !dirty);
    updateStatusMessage(dirty ? '有未保存的更改' : '已保存');
  }

  function updateStatusMessage(message) {
    const el = $('status-message');
    if (el) el.textContent = message || '就绪';
  }

  function updateRunButton() {
    const btn = $('btn-run-script');
    if (btn) btn.disabled = readonly || currentTab.type !== 'script';
  }

  function updateCursorStatus(position) {
    if (!position) return;
    const el = $('status-cursor');
    if (el) el.textContent = `行 ${position.lineNumber}，列 ${position.column}`;
  }

  function updateLanguageStatus(language) {
    const el = $('status-language');
    if (el) el.textContent = language || 'plaintext';
  }

  function applyReadOnly() {
    const enabled = !readonly;
    ['skill-name', 'skill-description', 'skill-license', 'skill-runtime', 'skill-compatibility', 'skill-allowed-tools', 'skill-metadata']
      .forEach(id => { const el = $(id); if (el) el.disabled = !enabled; });
    ['btn-save', 'btn-add-script', 'btn-import-script'].forEach(id => {
      const el = $(id); if (el) el.disabled = !enabled;
    });
    updateRunButton();
    if (monacoEditor) monacoEditor.updateOptions({ readOnly: readonly });
    $('se-readonly-badge').classList.toggle('hidden', !readonly);
    $('se-title').textContent = readonly ? '查看 Skill' : 'Skill 编辑器';
  }

  function notify(message, type = 'info') {
    const colors = {
      info: '#2196f3',
      success: '#27ae60',
      error: '#e74c3c',
      warn: '#f39c12'
    };
    const iconMap = {
      info: 'fa-circle-info',
      success: 'fa-circle-check',
      error: 'fa-circle-xmark',
      warn: 'fa-triangle-exclamation'
    };
    const color = colors[type] || colors.info;
    const icon = iconMap[type] || iconMap.info;
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;top:52px;right:18px;z-index:9999;display:flex;align-items:center;gap:8px;padding:10px 13px;border-radius:8px;background:${color};color:#fff;box-shadow:0 8px 24px rgba(0,0,0,0.22);font-size:12px;pointer-events:none;animation:se-toast-in .22s ease;`;
    el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${escapeHtml(message)}</span>`;
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s ease, transform .25s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(-6px)';
      setTimeout(() => el.remove(), 250);
    }, 2600);
  }

  function showOutput(text, isError = false) {
    const panel = $('output-panel');
    const content = $('output-content');
    if (!panel || !content) return;
    panel.classList.remove('hidden');
    content.textContent = text || '';
    content.classList.toggle('error', !!isError);
  }

  function clearOutput() {
    const panel = $('output-panel');
    const content = $('output-content');
    if (panel) panel.classList.add('hidden');
    if (content) content.textContent = '';
  }

  function ensureMonaco() {
    if (monacoReady) return monacoReady;
    monacoReady = new Promise((resolve, reject) => {
      if (typeof require === 'undefined' || !require.config) {
        reject(new Error('Monaco loader 不可用'));
        return;
      }
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
      require(['vs/editor/editor.main'], function () {
        resolve(window.monaco);
      }, reject);
    });
    return monacoReady;
  }

  function cssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function colorWithAlpha(color, alpha) {
    if (!color) return `rgba(79,140,255,${alpha})`;
    const c = color.trim();
    let r = 79, g = 140, b = 255;
    if (c.startsWith('#')) {
      if (c.length === 4) {
        r = parseInt(c[1] + c[1], 16);
        g = parseInt(c[2] + c[2], 16);
        b = parseInt(c[3] + c[3], 16);
      } else if (c.length >= 7) {
        r = parseInt(c.slice(1, 3), 16);
        g = parseInt(c.slice(3, 5), 16);
        b = parseInt(c.slice(5, 7), 16);
      }
    } else {
      const match = c.match(/rgba?\(([^)]+)\)/);
      if (match) {
        const parts = match[1].split(',').map(s => parseFloat(s.trim()));
        r = parts[0] || r;
        g = parts[1] || g;
        b = parts[2] || b;
      }
    }
    if ([r, g, b].some(v => !Number.isFinite(v))) return `rgba(79,140,255,${alpha})`;
    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
  }

  function defineMonacoTheme() {
    if (!window.monaco) return;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const accent = cssVar('--accent', isDark ? '#6c8cff' : '#4f8cff');
    const background = cssVar('--bg-secondary', isDark ? '#222240' : '#ffffff');
    const foreground = cssVar('--text-primary', isDark ? '#e8e8f0' : '#1a1a2e');
    const secondary = cssVar('--text-secondary', isDark ? '#a0a0c0' : '#5a5a7a');
    const border = cssVar('--border', isDark ? '#333360' : '#e2e6ee');
    const hover = cssVar('--bg-hover', isDark ? '#333360' : '#e8ecf2');

    window.monaco.editor.defineTheme('cipyp-skill', {
      base: isDark ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [
        { token: '', foreground: foreground, background: background },
        { token: 'comment', foreground: isDark ? '#7a8ca8' : '#8590a2' },
        { token: 'keyword', foreground: accent },
        { token: 'string', foreground: isDark ? '#8fd39a' : '#2e7d4f' },
        { token: 'number', foreground: isDark ? '#ffc66d' : '#b26a00' },
        { token: 'type', foreground: accent },
        { token: 'function', foreground: accent }
      ],
      colors: {
        'editor.background': background,
        'editor.foreground': foreground,
        'editorLineNumber.foreground': secondary,
        'editorLineNumber.activeForeground': accent,
        'editorCursor.foreground': accent,
        'editor.selectionBackground': colorWithAlpha(accent, 0.26),
        'editor.inactiveSelectionBackground': colorWithAlpha(accent, 0.16),
        'editor.lineHighlightBackground': colorWithAlpha(accent, 0.08),
        'editorLineNumber.activeBackground': colorWithAlpha(accent, 0.08),
        'editorIndentGuide.background1': colorWithAlpha(accent, 0.16),
        'editorIndentGuide.activeBackground1': colorWithAlpha(accent, 0.36),
        'editorWidget.background': background,
        'editorWidget.border': border,
        'editorSuggestWidget.background': background,
        'editorSuggestWidget.border': border,
        'editorSuggestWidget.selectedBackground': colorWithAlpha(accent, 0.18),
        'editorHoverWidget.background': background,
        'editorHoverWidget.border': border,
        'minimap.background': background,
        'scrollbarSlider.background': colorWithAlpha(accent, 0.22),
        'scrollbarSlider.hoverBackground': colorWithAlpha(accent, 0.32),
        'scrollbarSlider.activeBackground': colorWithAlpha(accent, 0.42),
        'editorGutter.background': background,
        'editorOverviewRuler.border': border,
        'focusBorder': colorWithAlpha(accent, 0.5)
      }
    });
  }

  function applyMonacoTheme() {
    if (!window.monaco || !monacoEditor) return;
    defineMonacoTheme();
    monacoEditor.setTheme('cipyp-skill');
  }

  async function initMonacoEditor() {
    if (monacoEditor) return monacoEditor;
    await ensureMonaco();
    defineMonacoTheme();
    const host = $('editor-host');
    if (!host) return null;
    host.innerHTML = '';

    promptModel = window.monaco.editor.createModel(skillData.prompt || '', 'markdown');
    promptModel.onDidChangeContent(() => setDirty(true));

    monacoEditor = window.monaco.editor.create(host, {
      model: promptModel,
      theme: 'cipyp-skill',
      language: 'markdown',
      automaticLayout: true,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      fontSize: 13,
      tabSize: 2,
      wordWrap: 'on',
      smoothScrolling: true,
      readOnly: readonly,
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      padding: { top: 8, bottom: 8 }
    });

    monacoEditor.onDidChangeCursorPosition(e => updateCursorStatus(e.position));
    monacoEditor.onDidChangeModel(() => {
      const model = monacoEditor.getModel();
      updateLanguageStatus(model ? model.getLanguageId() : 'plaintext');
    });

    updateLanguageStatus('markdown');
    updateCursorStatus({ lineNumber: 1, column: 1 });
    applyReadOnly();
    return monacoEditor;
  }

  function getScriptCode(id) {
    const model = scriptModels.get(id);
    return model ? model.getValue() : '';
  }

  function currentScript() {
    if (currentTab.type !== 'script') return null;
    return scripts.find(s => s.id === currentTab.id) || null;
  }

  function renderScriptsList() {
    const list = $('scripts-list');
    const empty = $('scripts-empty');
    if (!list || !empty) return;
    list.innerHTML = '';
    empty.classList.toggle('hidden', scripts.length > 0);
    scripts.forEach(script => {
      const item = document.createElement('div');
      item.className = 'se-script-item' + (currentTab.type === 'script' && currentTab.id === script.id ? ' active' : '');
      item.innerHTML = `
        <i class="fa-solid fa-file-code"></i>
        <div class="se-script-info">
          <span class="se-script-name">${escapeHtml(script.name)}</span>
          <span class="se-script-runtime">${escapeHtml(script.runtime || inferRuntime(script.name))}</span>
        </div>
        <button class="se-script-delete" title="删除脚本"><i class="fa-solid fa-trash-can"></i></button>
      `;
      item.addEventListener('click', () => openScript(script.id));
      const del = item.querySelector('.se-script-delete');
      del.addEventListener('click', e => {
        e.stopPropagation();
        deleteScript(script.id);
      });
      list.appendChild(item);
    });
  }

  function renderTabs() {
    const container = $('editor-tabs');
    if (!container) return;
    container.innerHTML = '';

    const promptTab = document.createElement('div');
    promptTab.className = 'se-tab' + (currentTab.type === 'prompt' ? ' active' : '');
    promptTab.innerHTML = '<i class="fa-solid fa-book"></i><span>Prompt</span>';
    promptTab.addEventListener('click', () => switchTab('prompt', null));
    container.appendChild(promptTab);

    scripts.forEach(script => {
      const tab = document.createElement('div');
      tab.className = 'se-tab' + (currentTab.type === 'script' && currentTab.id === script.id ? ' active' : '');
      tab.innerHTML = `
        <i class="fa-solid fa-file-code"></i>
        <span>${escapeHtml(script.name)}</span>
        <i class="fa-solid fa-xmark se-tab-close" title="删除脚本"></i>
      `;
      tab.addEventListener('click', () => openScript(script.id));
      const close = tab.querySelector('.se-tab-close');
      close.addEventListener('click', e => {
        e.stopPropagation();
        deleteScript(script.id);
      });
      container.appendChild(tab);
    });
  }

  function switchTab(type, id) {
    currentTab = { type, id };
    if (type === 'prompt') {
      if (monacoEditor && promptModel) monacoEditor.setModel(promptModel);
      updateLanguageStatus('markdown');
    } else {
      const script = scripts.find(s => s.id === id);
      const model = scriptModels.get(id);
      if (monacoEditor && model) monacoEditor.setModel(model);
      updateLanguageStatus(script ? inferLanguage(script.name, script.runtime) : 'plaintext');
    }
    renderTabs();
    renderScriptsList();
    updateRunButton();
  }

  async function openScript(id) {
    const script = scripts.find(s => s.id === id);
    if (!script) return;
    if (!scriptModels.has(id)) {
      if (!script.code && script.path) {
        try {
          const res = await api.readFile(script.path);
          if (res && res.ok) script.code = res.content || '';
        } catch { /* leave empty */ }
      }
      const model = window.monaco.editor.createModel(script.code || '', inferLanguage(script.name, script.runtime));
      model.onDidChangeContent(() => setDirty(true));
      scriptModels.set(id, model);
    }
    switchTab('script', id);
  }

  async function deleteScript(id) {
    const script = scripts.find(s => s.id === id);
    if (!script) return;
    if (!window.confirm(`确定删除脚本“${script.name}”吗？`)) return;
    const model = scriptModels.get(id);
    if (model) {
      model.dispose();
      scriptModels.delete(id);
    }
    scripts = scripts.filter(s => s.id !== id);
    if (currentTab.type === 'script' && currentTab.id === id) {
      switchTab('prompt', null);
    } else {
      renderTabs();
      renderScriptsList();
    }
    setDirty(true);
  }

  async function loadSkill(id, forceReadonly) {
    readonly = !!forceReadonly;
    dirty = false;
    $('se-dirty-badge').classList.add('hidden');

    let nextSkill = createBlankSkill();
    if (id) {
      const res = await api.getSkill(id);
      if (!res || res.ok === false) {
        notify(res?.error || '技能不存在', 'error');
        nextSkill = createBlankSkill();
        readonly = true;
      } else {
        nextSkill = res.skill || createBlankSkill();
        readonly = !!(forceReadonly || res.readonly);
      }
    }

    skillData = nextSkill;
    scripts = Array.isArray(skillData.scripts) ? skillData.scripts.map(normalizeScript) : [];
    skillData.scripts = scripts;

    populateForm();
    renderTabs();
    renderScriptsList();
    switchTab('prompt', null);

    if (promptModel) {
      promptModel.setValue(skillData.prompt || '');
    }

    updateStatusMessage(readonly ? '只读查看模式' : '就绪');
    applyReadOnly();
  }

  function populateForm() {
    $('skill-name').value = skillData.name || '';
    $('skill-description').value = skillData.description || '';
    $('skill-license').value = skillData.license || '';
    $('skill-runtime').value = skillData.runtime || 'javascript';
    $('skill-compatibility').value = skillData.compatibility || '';
    $('skill-allowed-tools').value = Array.isArray(skillData.allowedTools) ? skillData.allowedTools.join(' ') : String(skillData.allowedTools || '');
    $('skill-metadata').value = metadataToText(skillData.metadata);
  }

  async function saveSkill() {
    if (readonly) return;
    const name = $('skill-name').value.trim();
    const description = $('skill-description').value.trim();
    if (!name) {
      notify('请填写技能名称', 'warn');
      $('skill-name').focus();
      return;
    }
    if (!description) {
      notify('请填写技能描述', 'warn');
      $('skill-description').focus();
      return;
    }

    scripts = scripts.map(script => ({
      ...script,
      code: scriptModels.has(script.id) ? scriptModels.get(script.id).getValue() : (script.code || '')
    }));

    const payload = {
      ...skillData,
      name,
      description,
      prompt: promptModel ? promptModel.getValue() : (skillData.prompt || ''),
      license: $('skill-license').value.trim(),
      compatibility: $('skill-compatibility').value.trim(),
      allowedTools: parseAllowedTools($('skill-allowed-tools').value),
      metadata: parseMetadata($('skill-metadata').value),
      runtime: $('skill-runtime').value || 'javascript',
      scripts,
      type: skillData.type || 'custom',
      sourceType: skillData.sourceType || 'manual'
    };

    try {
      if (skillData.id) {
        const res = await api.updateSkill(skillData.id, payload);
        if (!res || res.ok === false) throw new Error(res?.error || '更新失败');
        skillData = res.skill || { ...skillData, ...payload };
      } else {
        const created = await api.createSkill(payload);
        if (!created || !created.id) throw new Error('创建失败');
        skillData = created;
      }
      scripts = Array.isArray(skillData.scripts) ? skillData.scripts.map(normalizeScript) : scripts;
      dirty = false;
      $('se-dirty-badge').classList.add('hidden');
      updateStatusMessage('已保存');
      notify('技能已保存', 'success');
    } catch (e) {
      notify(e.message || '保存失败', 'error');
    }
  }

  function runResultToText(result) {
    if (!result) return '无返回';
    if (result.ok === false) return result.error || result.stderr || '执行失败';
    if (result.result && typeof result.result === 'object') {
      const r = result.result;
      if (r.error) return r.error;
      const parts = [r.output, r.result].filter(v => typeof v === 'string' && v.trim());
      return parts.join('\n') || '执行完成';
    }
    if (typeof result.output === 'string' && result.output.trim()) return result.output;
    if (result.stderr) return result.stderr;
    return typeof result.result === 'string' ? result.result : '执行完成';
  }

  async function runScriptCode(script, code) {
    const ext = extname(script.name);
    const runtime = String(script.runtime || '').toLowerCase();
    if (ext === 'py' || ext === 'pyw' || runtime === 'python') {
      return await api.runPython(code);
    }
    if (ext === 'sh' || ext === 'bash' || ext === 'zsh' || ext === 'ps1' || ext === 'bat' || ext === 'cmd' || runtime === 'shell') {
      return await api.runShell(code);
    }
    if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || runtime === 'javascript' || runtime === 'node') {
      const needsNode = runtime === 'node'
        || ext === 'mjs'
        || ext === 'cjs'
        || /\brequire\s*\(|\bprocess\.\b|\bfs\.\b|\bpath\.\b|\bBuffer\b|__dirname|__filename|\bimport\s+/.test(code || '');
      return needsNode ? await api.runNodeJS(code) : await api.runJS(code);
    }
    return { ok: false, error: '不支持的脚本类型' };
  }

  async function runCurrentScript() {
    const script = currentScript();
    if (!script) {
      notify('请先选择一个脚本', 'warn');
      return;
    }
    const model = scriptModels.get(script.id);
    const code = model ? model.getValue() : (script.code || '');
    script.code = code;
    showOutput('正在运行...', false);
    updateStatusMessage(`正在运行 ${script.name}`);
    try {
      const result = await runScriptCode(script, code);
      const text = runResultToText(result);
      showOutput(text, result && result.ok === false);
      updateStatusMessage(result && result.ok === false ? '运行失败' : '运行完成');
    } catch (e) {
      showOutput(e.message || '运行失败', true);
      updateStatusMessage('运行失败');
    }
  }

  async function addScript() {
    const index = scripts.length;
    const script = normalizeScript({ name: `script_${index + 1}.js`, code: '// 在此编写脚本代码\n' }, index);
    scripts.push(script);
    renderTabs();
    renderScriptsList();
    await openScript(script.id);
    setDirty(true);
  }

  async function importScriptFile() {
    const res = await api.openFileDialog({
      title: '选择脚本文件',
      multiple: true,
      filters: [{ name: 'Skill Scripts', extensions: ['js', 'mjs', 'cjs', 'py', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd'] }]
    });
    if (!res || !res.ok || !Array.isArray(res.paths) || res.paths.length === 0) return;
    for (const filePath of res.paths) {
      const read = await api.readFile(filePath);
      const name = basename(filePath);
      const script = normalizeScript({
        name,
        path: filePath,
        code: read?.ok ? (read.content || '') : '',
        runtime: inferRuntime(name)
      }, scripts.length);
      scripts.push(script);
      if (read?.ok) {
        const model = window.monaco.editor.createModel(script.code || '', inferLanguage(name, script.runtime));
        model.onDidChangeContent(() => setDirty(true));
        scriptModels.set(script.id, model);
      }
    }
    renderTabs();
    renderScriptsList();
    if (scripts.length) await openScript(scripts[scripts.length - 1].id);
    setDirty(true);
    notify(`已导入 ${res.paths.length} 个脚本`, 'success');
  }

  function bindEvents() {
    ['skill-name', 'skill-description', 'skill-license', 'skill-runtime', 'skill-compatibility', 'skill-allowed-tools', 'skill-metadata']
      .forEach(id => {
        const el = $(id);
        if (el) el.addEventListener('input', () => setDirty(true));
      });

    $('btn-save').addEventListener('click', saveSkill);
    $('btn-add-script').addEventListener('click', addScript);
    $('btn-import-script').addEventListener('click', importScriptFile);
    $('btn-run-script').addEventListener('click', runCurrentScript);
    $('btn-clear-output').addEventListener('click', clearOutput);
    $('btn-close-output').addEventListener('click', clearOutput);
    $('btn-close').addEventListener('click', () => {
      if (dirty && !window.confirm('当前修改尚未保存，确定关闭吗？')) return;
      api.closeWindow();
    });

    window.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveSkill();
      }
    });
  }

  async function init() {
    bindEvents();
    await loadSkill(initialId, initialReadonly);
    await initMonacoEditor();
    await new Promise(resolve => setTimeout(resolve, 60));
    applyMonacoTheme();
    initialLoading = false;
    setDirty(false);

    api.onThemeApply(() => {
      setTimeout(applyMonacoTheme, 0);
    });
    api.onThemeChanged(() => {
      setTimeout(applyMonacoTheme, 80);
    });
    api.onSettingsChanged(() => {
      setTimeout(applyMonacoTheme, 80);
    });
    api.onOpenRequest(async payload => {
      if (dirty && !window.confirm('当前修改尚未保存，切换技能会丢失更改。确定继续吗？')) return;
      await loadSkill(payload?.id || '', !!payload?.readonly);
      if (monacoEditor) {
        monacoEditor.setModel(promptModel);
        applyMonacoTheme();
      }
    });
  }

  init().catch(err => {
    console.error('[SkillEditor] init failed:', err);
    const host = $('editor-host');
    if (host) host.innerHTML = `<div style="padding:20px;color:var(--se-danger)">初始化失败：${escapeHtml(err.message)}</div>`;
  });
})();
