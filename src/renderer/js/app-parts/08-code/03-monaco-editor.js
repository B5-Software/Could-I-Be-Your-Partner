  // ---- Monaco integration ----
  function ensureMonaco() {
    if (monacoReady) return monacoReady;
    monacoReady = new Promise((resolve, reject) => {
      if (typeof require === 'undefined' || !require.config) {
        reject(new Error('Monaco loader not available (require.config missing)'));
        return;
      }
      // Configure loader to use local monaco-editor resources (no CDN)
      require.config({ paths: { vs: '../../../node_modules/monaco-editor/min/vs' } });
      // Worker setup for Electron file:// — load worker via blob URL
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
      }, function (err) { reject(err); });
    });
    return monacoReady;
  }

  async function initMonacoEditor() {
    if (monacoEditor) return monacoEditor;
    const host = document.getElementById('code-editor-host');
    if (!host) return null;
    await ensureMonaco();
    host.innerHTML = '';
    // 跟随当前主题
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    monacoEditor = monaco.editor.create(host, {
      value: '',
      language: 'plaintext',
      theme: isDark ? 'vs-dark' : 'vs',
      automaticLayout: true,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      fontSize: 13,
      tabSize: 2,
      wordWrap: 'on',
      smoothScrolling: true
    });
    // Ctrl/Cmd+S to save current file
    monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
      await saveCurrentFile();
    });
    return monacoEditor;
  }

  async function openFileInMonaco(filePath, fileName) {
    try {
      await initMonacoEditor();
    } catch (e) {
      window.showMessageModal?.('Monaco 编辑器加载失败: ' + e.message, '错误', 'error');
      return;
    }
    // Switch if already open
    const existing = codeOpenTabs.find(t => t.path === filePath);
    if (existing) {
      switchTab(filePath);
      return;
    }
    const readRes = await window.api.readFile(filePath);
    if (!readRes.ok) {
      window.showMessageModal?.('无法读取文件: ' + (readRes.error || '未知错误'), '错误', 'error');
      return;
    }
    const content = readRes.content || '';
    const lang = detectMonacoLanguage(fileName);
    const model = monaco.editor.createModel(content, lang);
    const tab = { path: filePath, name: fileName, model, originalContent: content, dirty: false };
    model.onDidChangeContent(() => {
      tab.dirty = model.getValue() !== tab.originalContent;
      renderEditorTabs();
    });
    codeOpenTabs.push(tab);
    switchTab(filePath);
  }

  function switchTab(filePath) {
    const tab = codeOpenTabs.find(t => t.path === filePath);
    if (!tab || !monacoEditor) return;
    codeActiveTabPath = filePath;
    monacoEditor.setModel(tab.model);
    renderEditorTabs();
    highlightFileTreeNode(filePath);
    hideEditorEmptyState();
  }

  function closeTab(filePath) {
    const idx = codeOpenTabs.findIndex(t => t.path === filePath);
    if (idx === -1) return;
    const tab = codeOpenTabs[idx];
    if (tab.dirty && !confirm('文件 ' + tab.name + ' 有未保存的更改，确定关闭吗？')) return;
    tab.model.dispose();
    codeOpenTabs.splice(idx, 1);
    if (codeActiveTabPath === filePath) {
      if (codeOpenTabs.length > 0) {
        switchTab(codeOpenTabs[Math.max(0, idx - 1)].path);
      } else {
        codeActiveTabPath = null;
        if (monacoEditor) monacoEditor.setModel(monaco.editor.createModel('', 'plaintext'));
        showEditorEmptyState();
      }
    }
    renderEditorTabs();
  }

  function renderEditorTabs() {
    const tabsEl = document.getElementById('code-editor-tabs');
    if (!tabsEl) return;
    tabsEl.innerHTML = '';
    for (const tab of codeOpenTabs) {
      const el = document.createElement('div');
      el.className = 'editor-tab' + (tab.path === codeActiveTabPath ? ' active' : '');
      const icon = fileIconClass(tab.name);
      el.innerHTML = '<i class="fa-solid ' + icon + '"></i>' +
        '<span>' + escapeHtml(tab.name) + '</span>' +
        (tab.dirty ? '<span style="color:#f59e0b;margin-left:2px">●</span>' : '') +
        '<span class="tab-close" title="关闭"><i class="fa-solid fa-xmark"></i></span>';
      el.addEventListener('click', () => switchTab(tab.path));
      const closeBtn = el.querySelector('.tab-close');
      if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.path); });
      tabsEl.appendChild(el);
    }
    // 增量推送：编辑器 tab 栏更新后同步到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-editor-tabs', html: tabsEl.innerHTML });
  }

  function showEditorEmptyState() {
    const host = document.getElementById('code-editor-host');
    if (!host) return;
    let placeholder = host.querySelector('.editor-placeholder');
    if (!placeholder) {
      placeholder = document.createElement('div');
      placeholder.className = 'editor-placeholder';
      placeholder.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--text-secondary);opacity:0.5;pointer-events:none;';
      placeholder.innerHTML = '<i class="fa-solid fa-file-code" style="font-size:32px;margin-bottom:8px;"></i><p>点击文件树中的文件以打开</p>';
      host.appendChild(placeholder);
    }
    placeholder.style.display = 'flex';
  }

  function hideEditorEmptyState() {
    const host = document.getElementById('code-editor-host');
    if (!host) return;
    const placeholder = host.querySelector('.editor-placeholder');
    if (placeholder) placeholder.style.display = 'none';
  }

  async function saveCurrentFile() {
    const tab = codeOpenTabs.find(t => t.path === codeActiveTabPath);
    if (!tab) return;
    const content = tab.model.getValue();
    const result = await window.api.writeFile(tab.path, content);
    if (result && result.ok) {
      tab.originalContent = content;
      tab.dirty = false;
      renderEditorTabs();
    } else {
      window.showMessageModal?.('保存失败: ' + (result?.error || '未知错误'), '错误', 'error');
    }
  }

  function detectMonacoLanguage(fileName) {
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    const map = {
      js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
      ts: 'typescript', tsx: 'typescript',
      json: 'json', json5: 'json',
      html: 'html', htm: 'html', xhtml: 'html',
      css: 'css', scss: 'scss', less: 'less',
      md: 'markdown', markdown: 'markdown',
      xml: 'xml', svg: 'xml',
      py: 'python',
      java: 'java',
      c: 'c', h: 'c',
      cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
      cs: 'csharp',
      go: 'go',
      rb: 'ruby',
      php: 'php',
      rs: 'rust',
      sh: 'shell', bash: 'shell', zsh: 'shell',
      sql: 'sql',
      yaml: 'yaml', yml: 'yaml',
      ini: 'ini', conf: 'ini',
      bat: 'bat',
      ps1: 'powershell',
      kt: 'kotlin', kts: 'kotlin',
      swift: 'swift',
      dart: 'dart',
      r: 'r',
      lua: 'lua',
      pl: 'perl',
      txt: 'plaintext'
    };
    return map[ext] || 'plaintext';
  }

  function fileIconClass(fileName) {
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    const map = {
      js: 'fa-file-code', jsx: 'fa-file-code', ts: 'fa-file-code', tsx: 'fa-file-code',
      json: 'fa-file-code', html: 'fa-file-code', css: 'fa-file-code', scss: 'fa-file-code',
      md: 'fa-file-lines', txt: 'fa-file-lines', log: 'fa-file-lines',
      png: 'fa-file-image', jpg: 'fa-file-image', jpeg: 'fa-file-image', gif: 'fa-file-image',
      bmp: 'fa-file-image', webp: 'fa-file-image',
      svg: 'fa-file-image',
      pdf: 'fa-file-pdf',
      zip: 'fa-file-zipper', gz: 'fa-file-zipper', tar: 'fa-file-zipper', '7z': 'fa-file-zipper',
      rar: 'fa-file-zipper',
      exe: 'fa-file-exe', msi: 'fa-file-exe',
      mp3: 'fa-file-audio', wav: 'fa-file-audio',
      mp4: 'fa-file-video', avi: 'fa-file-video', mkv: 'fa-file-video',
      xls: 'fa-file-excel', xlsx: 'fa-file-excel',
      doc: 'fa-file-word', docx: 'fa-file-word',
      ppt: 'fa-file-powerpoint', pptx: 'fa-file-powerpoint'
    };
    return map[ext] || 'fa-file';
  }

  function highlightFileTreeNode(filePath) {
    document.querySelectorAll('.code-file-tree .tree-node.active').forEach(el => el.classList.remove('active'));
    const escaped = filePath.replace(/"/g, '\\"');
    const target = document.querySelector('.code-file-tree .tree-node[data-path="' + escaped + '"]');
    if (target) target.classList.add('active');
  }
