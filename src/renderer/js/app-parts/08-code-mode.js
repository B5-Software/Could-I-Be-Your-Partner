  // ---- Code Mode ----
  // Separate agent instance for Code mode, with workspace-scoped history.
  let codeAgent = null;
  let codeWorkspacePath = null;
  let codeCurrentHistoryId = null;
  let codeMessages = []; // [{role, content}]
  let codeCurrentAttachments = []; // Code mode context attachments [{name, path, isImage, content, ext}]
  // 触发文件树刷新的工具集合（执行后可能增删/移动文件）
  const _fileSystemTools = new Set(['createFile', 'deleteFile', 'moveFile', 'copyFile', 'editFile', 'multiEditFile', 'writeFile', 'renameFile', 'mkdir', 'rmdir']);

  // Monaco Editor state
  let monacoEditor = null;
  let monacoReady = null;
  let codeOpenTabs = [];      // [{path, name, model, originalContent, dirty}]
  let codeActiveTabPath = null;
  let codeEditorModeFilter = 'chat';   // 'chat' | 'code' — tools page mode filter

  async function loadCodePage() {
    // 已有进行中的会话时保留内存中的工作区，避免切到 Chat 再切回时回退到上次持久化的工作区
    let wsPath = codeWorkspacePath;
    if (!wsPath) {
      wsPath = await window.api.codeGetLastWorkspace();
    }
    if (wsPath) {
      codeWorkspacePath = wsPath;
      const wsPathEl = document.getElementById('code-workspace-path');
      if (wsPathEl) wsPathEl.textContent = wsPath;
      await loadCodeFileTree(wsPath);
    } else {
      const wsPathEl = document.getElementById('code-workspace-path');
      if (wsPathEl) wsPathEl.textContent = '未选择工作区';
      const treeEl = document.getElementById('code-file-tree');
      if (treeEl) treeEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-folder-tree"></i><p>打开工作区后显示文件树</p></div>';
      // 无工作区时隐藏 ESLint 面板
      const eslintPanel = document.getElementById('code-eslint-panel');
      const eslintResizer = document.getElementById('code-eslint-resizer');
      if (eslintPanel) eslintPanel.style.display = 'none';
      if (eslintResizer) eslintResizer.style.display = 'none';
    }
    // Pre-warm Monaco loader (don't await — start in background)
    ensureMonaco().catch(err => console.warn('[Monaco] preload failed:', err));
  }

  async function loadCodeFileTree(dirPath) {
    const treeEl = document.getElementById('code-file-tree');
    if (!treeEl) return;
    treeEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>加载文件树...</p></div>';
    try {
      const result = await window.api.codeGetFileTree(dirPath);
      if (result.ok && result.tree) {
        renderCodeFileTree(treeEl, result.tree, dirPath);
      } else {
        treeEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-folder-open"></i><p>无法读取文件树</p></div>';
        WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-file-tree', html: treeEl.innerHTML });
      }
    } catch (e) {
      treeEl.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>${e.message}</p></div>`;
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-file-tree', html: treeEl.innerHTML });
    }
    // 自动运行 ESLint（如果是支持的项目）
    if (dirPath) autoRunESLint(dirPath).catch(err => console.warn('[ESLint] auto run failed:', err));
  }

  // ==================== ESLint 状态面板 ====================
  let eslintRunning = false;
  let eslintCurrentWorkspace = null;
  let eslintLastResults = null;
  let eslintEventsBound = false;

  async function autoRunESLint(workspacePath) {
    if (!workspacePath) return;
    eslintCurrentWorkspace = workspacePath;
    // 检测是否为支持的项目
    let lintable = false;
    try {
      const r = await window.api.eslintIsLintable(workspacePath);
      lintable = !!(r.ok && r.lintable);
    } catch (e) {
      console.warn('[ESLint] isLintable failed:', e);
    }
    const panel = document.getElementById('code-eslint-panel');
    const resizer = document.getElementById('code-eslint-resizer');
    if (!lintable) {
      // 不支持：隐藏面板和分割器
      if (panel) panel.style.display = 'none';
      if (resizer) resizer.style.display = 'none';
      const summary = document.getElementById('code-eslint-summary');
      if (summary) summary.innerHTML = '<span class="es-null">不适用（非 JS/TS 项目）</span>';
      return;
    }
    if (panel) panel.style.display = '';
    if (resizer) resizer.style.display = '';
    bindESLintEvents();
    await runESLint(workspacePath);
  }

  async function runESLint(workspacePath) {
    if (!workspacePath) return;
    if (eslintRunning) return;
    eslintRunning = true;
    eslintCurrentWorkspace = workspacePath;
    const summary = document.getElementById('code-eslint-summary');
    const body = document.getElementById('code-eslint-body');
    const refreshBtn = document.getElementById('btn-eslint-refresh');
    if (refreshBtn) refreshBtn.classList.add('spin');
    if (summary) summary.innerHTML = '<span class="es-running"><i class="fa-solid fa-spinner fa-spin"></i> 扫描中…</span>';
    if (body) body.innerHTML = '<div class="code-eslint-empty"><i class="fa-solid fa-spinner fa-spin"></i> 正在扫描工作区…</div>';
    try {
      const result = await window.api.eslintLint(workspacePath, { maxFiles: 500 });
      if (!result.ok) {
        if (summary) summary.innerHTML = `<span class="es-error"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtmlSimple(result.error || '失败')}</span>`;
        if (body) body.innerHTML = `<div class="code-eslint-empty" style="color:var(--danger)"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtmlSimple(result.error || '运行失败')}</div>`;
        eslintLastResults = null;
        return;
      }
      eslintLastResults = result;
      renderESLintResults(result);
    } catch (e) {
      if (summary) summary.innerHTML = `<span class="es-error"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtmlSimple(e.message)}</span>`;
      if (body) body.innerHTML = `<div class="code-eslint-empty" style="color:var(--danger)">${escapeHtmlSimple(e.message)}</div>`;
      eslintLastResults = null;
    } finally {
      eslintRunning = false;
      if (refreshBtn) refreshBtn.classList.remove('spin');
    }
  }

  function renderESLintResults(result) {
    const summary = document.getElementById('code-eslint-summary');
    const body = document.getElementById('code-eslint-body');
    const sum = result.summary || {};
    if (summary) {
      const parts = [];
      if (sum.errors > 0) parts.push(`<span class="es-badge errors"><i class="fa-solid fa-circle-xmark"></i> ${sum.errors} 错误</span>`);
      if (sum.warnings > 0) parts.push(`<span class="es-badge warnings"><i class="fa-solid fa-triangle-exclamation"></i> ${sum.warnings} 警告</span>`);
      if (sum.infos > 0) parts.push(`<span class="es-badge infos"><i class="fa-solid fa-circle-info"></i> ${sum.infos} 提示</span>`);
      if (parts.length === 0) {
        summary.innerHTML = '<span class="es-badge ok"><i class="fa-solid fa-circle-check"></i> 无问题</span>';
      } else {
        summary.innerHTML = parts.join('') + `<span style="color:var(--text-tertiary);font-size:0.92em;margin-left:4px">扫描 ${sum.scannedFiles || 0} 文件</span>`;
      }
    }
    if (body) {
      const items = result.results || [];
      if (items.length === 0) {
        body.innerHTML = '<div class="code-eslint-empty"><i class="fa-solid fa-circle-check" style="color:#198754"></i> 没有发现问题</div>';
        return;
      }
      body.innerHTML = '';
      for (const item of items) {
        const row = document.createElement('div');
        row.className = `code-eslint-item ${item.severity || 'info'}`;
        const sevLabel = item.severity === 'error' ? 'Error' : (item.severity === 'warning' ? 'Warn' : 'Info');
        const shortPath = makeRelPath(item.filePath, eslintCurrentWorkspace);
        row.innerHTML = `<span class="esev">${sevLabel}</span>` +
          `<span class="eloc" title="${escapeHtmlSimple(item.filePath)}">${escapeHtmlSimple(shortPath)}:${item.line}:${item.column}</span>` +
          `<span class="emsg">${escapeHtmlSimple(item.message || '')}</span>` +
          `<span class="erule">${item.ruleId ? escapeHtmlSimple(item.ruleId) : ''}<button class="code-eslint-add-btn" title="添加到 AI 上下文"><i class="fa-solid fa-comment-dots"></i></button></span>`;
        // 点击行 → 跳转到文件（在 Monaco 编辑器中打开并定位到问题行）
        row.addEventListener('click', (e) => {
          if (e.target.closest('.code-eslint-add-btn')) return;
          const fileName = item.file || (item.filePath || '').split(/[\\/]/).pop() || 'file';
          openFileInMonaco(item.filePath, fileName).then(() => {
            // 切换到该文件后，定位到指定行列
            if (monacoEditor && item.line) {
              try {
                monacoEditor.revealLineInCenter(item.line);
                monacoEditor.setPosition({ lineNumber: item.line, column: item.column || 1 });
                monacoEditor.focus();
              } catch { /* ignore */ }
            }
          }).catch(err => console.warn('[ESLint] openFileInMonaco failed:', err));
        });
        // 点击添加按钮 → 将此条意见作为代码上下文片段注入输入框（用户可编辑后发送）
        const addBtn = row.querySelector('.code-eslint-add-btn');
        if (addBtn) {
          addBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            // 同时将文件加入 Code 附件（便于 AI 读取上下文）
            await addFileToCodeContext({ path: item.filePath, name: item.file || 'lint-issue', type: 'file' });
            // 把意见本身作为提示文本注入输入框
            const inputEl = document.getElementById('code-chat-input');
            if (inputEl) {
              const note = `请修复以下 ESLint 问题：\n文件：${shortPath}:${item.line}:${item.column}\n严重性：${sevLabel}\n规则：${item.ruleId || '(无)'}\n消息：${item.message}`;
              const cur = inputEl.value || '';
              inputEl.value = cur ? (cur + '\n\n' + note) : note;
              inputEl.focus();
              inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
          });
        }
        body.appendChild(row);
      }
    }
  }

  function bindESLintEvents() {
    if (eslintEventsBound) return;
    eslintEventsBound = true;
    // 刷新
    document.getElementById('btn-eslint-refresh')?.addEventListener('click', () => {
      if (eslintCurrentWorkspace && !eslintRunning) {
        // 清缓存确保结果新鲜
        window.api.eslintClearCache(eslintCurrentWorkspace).finally(() => {
          runESLint(eslintCurrentWorkspace);
        });
      }
    });
    // 折叠/展开
    document.getElementById('btn-eslint-toggle')?.addEventListener('click', () => {
      const panel = document.getElementById('code-eslint-panel');
      const resizer = document.getElementById('code-eslint-resizer');
      if (!panel) return;
      panel.classList.toggle('collapsed');
      const collapsed = panel.classList.contains('collapsed');
      const icon = document.querySelector('#btn-eslint-toggle i');
      if (icon) icon.className = collapsed ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
      if (resizer) resizer.style.display = collapsed ? 'none' : '';
    });
    // 上下拖动调节高度
    initESLintResizer();
  }

  function initESLintResizer() {
    const resizer = document.getElementById('code-eslint-resizer');
    const panel = document.getElementById('code-eslint-panel');
    if (!resizer || !panel) return;
    let dragging = false;
    let startY = 0;
    let startPanelHeight = 0;
    let startTreeHeight = 0;
    const treeEl = document.getElementById('code-file-tree');
    resizer.addEventListener('mousedown', (e) => {
      if (panel.classList.contains('collapsed')) return;
      dragging = true;
      startY = e.clientY;
      startPanelHeight = panel.getBoundingClientRect().height;
      startTreeHeight = treeEl ? treeEl.getBoundingClientRect().height : 0;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      // 向上拖动 = panel 高度增加（dy 为负），向下拖动 = panel 高度减少
      const dy = e.clientY - startY;
      const maxPanelHeight = startPanelHeight + startTreeHeight - 60; // 留至少 60px 给文件树
      const newPanelHeight = Math.max(40, Math.min(maxPanelHeight, startPanelHeight - dy));
      panel.style.height = newPanelHeight + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // 格式化 Token 数量：≥1K 用 K，≥1M 用 M，≥1G 用 G，≥1T 用 T，≥1P 用 P
  function makeRelPath(fullPath, base) {
    if (!fullPath) return '';
    if (!base) return fullPath;
    // 规范化路径分隔符
    const norm = String(fullPath).replace(/\\/g, '/');
    const baseNorm = String(base).replace(/\\/g, '/').replace(/\/$/, '');
    if (norm.toLowerCase().startsWith(baseNorm.toLowerCase() + '/')) {
      return norm.slice(baseNorm.length + 1);
    }
    return fullPath;
  }

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

  // ---- File tree rendering (with collapsible dirs + context menu) ----
  function renderCodeFileTree(container, tree, basePath) {
    container.innerHTML = '';
    function buildNode(node, depth, holder) {
      const row = document.createElement('div');
      row.className = 'tree-node ' + (node.type === 'directory' ? 'dir' : 'file');
      row.style.paddingLeft = (depth * 12 + 8) + 'px';
      row.dataset.path = node.path;
      row.dataset.name = node.name;
      row.dataset.type = node.type;
      if (node.type === 'directory') {
        row.innerHTML = '<i class="fa-solid fa-chevron-right tree-toggle"></i><i class="fa-solid fa-folder"></i> <span>' + escapeHtml(node.name) + '</span>';
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          const toggle = row.querySelector('.tree-toggle');
          const folderIcon = row.querySelector('.fa-folder, .fa-folder-open');
          const childHolder = row.nextElementSibling;
          if (childHolder && childHolder.classList.contains('tree-children')) {
            const collapsed = childHolder.style.display === 'none';
            childHolder.style.display = collapsed ? 'block' : 'none';
            if (toggle) toggle.classList.toggle('fa-chevron-right', !collapsed);
            if (toggle) toggle.classList.toggle('fa-chevron-down', collapsed);
            if (folderIcon) folderIcon.className = collapsed ? 'fa-solid fa-folder-open' : 'fa-solid fa-folder';
          }
        });
      } else {
        row.innerHTML = '<span class="tree-toggle"></span><i class="fa-solid ' + fileIconClass(node.name) + '"></i> <span>' + escapeHtml(node.name) + '</span>';
        row.title = node.path;
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          openFileInMonaco(node.path, node.name);
        });
      }
      // Right-click context menu
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showCodeFileTreeContextMenu(e, node);
      });
      holder.appendChild(row);
      if (node.children && node.type === 'directory') {
        const childHolder = document.createElement('div');
        childHolder.className = 'tree-children';
        for (const child of node.children) buildNode(child, depth + 1, childHolder);
        holder.appendChild(childHolder);
      }
    }
    if (Array.isArray(tree)) {
      for (const node of tree) buildNode(node, 0, container);
    }
    // 增量推送：文件树渲染后同步到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-file-tree', html: container.innerHTML });
  }

  // ---- File tree context menu (Add to context / Rename / Delete) ----
  // 根据平台返回对应文案：macOS → "Finder"，Windows/Linux → "资源管理器"
  function _fileManagerName() {
    try {
      if (window.api?.platform === 'darwin') return 'Finder';
    } catch { /* ignore */ }
    return '资源管理器';
  }
  function showCodeFileTreeContextMenu(e, node) {
    // Remove any existing menu
    const existing = document.querySelector('.file-tree-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'file-tree-context-menu';
    menu.style.cssText = 'position:fixed;z-index:99999;background:var(--bg-secondary,#fff);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.15);padding:4px 0;min-width:180px;font-size:0.85em;left:' + e.clientX + 'px;top:' + e.clientY + 'px;';

    const fmName = _fileManagerName();
    const isFile = node.type === 'file';
    const items = [];
    if (isFile) {
      items.push({ icon: 'fa-comment-dots', label: '添加到上下文', action: () => addFileToCodeContext(node) });
      items.push({ icon: 'fa-copy', label: '复制路径', action: () => { navigator.clipboard.writeText(node.path).catch(() => {}); } });
      items.push({ icon: 'fa-folder-open', label: `在${fmName}中显示`, action: () => window.api.openFileExplorer?.(node.path) });
    } else {
      items.push({ icon: 'fa-folder-open', label: `在${fmName}中打开`, action: () => window.api.openFileExplorer?.(node.path) });
    }
    items.push({ icon: 'fa-pen', label: '重命名', action: () => renameTreeNode(node) });
    items.push({ icon: 'fa-trash', label: '删除', danger: true, action: () => deleteTreeNode(node) });

    for (const item of items) {
      const el = document.createElement('div');
      el.style.cssText = 'padding:6px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;white-space:nowrap;' + (item.danger ? 'color:#dc3545;' : '');
      el.innerHTML = '<i class="fa-solid ' + item.icon + '" style="width:14px;"></i><span>' + escapeHtml(item.label) + '</span>';
      el.addEventListener('mouseenter', () => { el.style.background = item.danger ? 'rgba(220,53,69,0.1)' : 'var(--bg-hover,rgba(0,0,0,0.05))'; });
      el.addEventListener('mouseleave', () => { el.style.background = 'transparent'; });
      el.addEventListener('click', () => { menu.remove(); item.action(); });
      menu.appendChild(el);
    }
    document.body.appendChild(menu);

    // Adjust position if out of viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

    // Close on outside click
    setTimeout(() => {
      const closer = (ev) => {
        if (!menu.contains(ev.target)) {
          menu.remove();
          document.removeEventListener('click', closer);
          document.removeEventListener('contextmenu', closer);
        }
      };
      document.addEventListener('click', closer);
      document.addEventListener('contextmenu', closer);
    }, 100);
  }

  async function addFileToCodeContext(node) {
    // 避免重复添加
    if (codeCurrentAttachments.some(a => a.path === node.path)) {
      window.showMessageModal?.('该文件已在上下文中', '提示', 'info');
      return;
    }
    const readRes = await window.api.readFile(node.path);
    if (!readRes.ok) {
      window.showMessageModal?.('无法读取文件: ' + (readRes.error || '未知错误'), '错误', 'error');
      return;
    }
    const ext = (node.name.split('.').pop() || '').toLowerCase();
    const isImage = /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(node.name);
    codeCurrentAttachments.push({
      name: node.name,
      path: node.path,
      isImage,
      content: readRes.content || '',
      ext
    });
    renderCodeAttachments();
  }

  function removeCodeAttachment(index) {
    codeCurrentAttachments.splice(index, 1);
    renderCodeAttachments();
  }

  function clearCodeAttachments() {
    codeCurrentAttachments = [];
    renderCodeAttachments();
  }

  function renderCodeAttachments() {
    const container = document.getElementById('code-attachments-preview');
    if (!container) return;
    if (codeCurrentAttachments.length === 0) {
      container.classList.add('hidden');
      container.innerHTML = '';
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-attachments-preview', attr: 'class', value: container.className });
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-attachments-preview', html: container.innerHTML });
      return;
    }
    container.classList.remove('hidden');
    container.innerHTML = codeCurrentAttachments.map((att, i) =>
      '<div class="attachment-item">' +
        '<i class="fa-solid ' + (att.isImage ? 'fa-image' : 'fa-file') + '"></i>' +
        '<span class="attachment-name">' + escapeHtml(att.name) + '</span>' +
        '<button class="btn-icon attachment-remove" data-index="' + i + '" title="从上下文移除"><i class="fa-solid fa-xmark"></i></button>' +
      '</div>'
    ).join('');
    container.querySelectorAll('.attachment-remove').forEach(btn => {
      btn.addEventListener('click', () => removeCodeAttachment(parseInt(btn.dataset.index)));
    });
    // 增量推送：附件列表更新后同步到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-attachments-preview', attr: 'class', value: container.className });
    WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-attachments-preview', html: container.innerHTML });
  }

  async function renameTreeNode(node) {
    // 使用自定义输入模态框替代 prompt()（prompt 在 Electron 中不受支持）
    const newName = await showInputModal('重命名', '输入新名称:', node.name);
    if (!newName || newName === node.name) return;
    const dir = node.path.substring(0, node.path.lastIndexOf(node.path.includes('\\') ? '\\' : '/'));
    const sep = node.path.includes('\\') ? '\\' : '/';
    const newPath = dir + sep + newName;
    const result = await window.api.moveFile(node.path, newPath);
    if (result && result.ok) {
      const tab = codeOpenTabs.find(t => t.path === node.path);
      if (tab) {
        tab.path = newPath;
        tab.name = newName;
        renderEditorTabs();
      }
      await loadCodeFileTree(codeWorkspacePath);
    } else {
      window.showMessageModal?.('重命名失败: ' + (result?.error || '未知错误'), '错误', 'error');
    }
  }

  async function deleteTreeNode(node) {
    const confirmed = await showConfirmModal('确认删除', '确定删除 ' + node.name + ' 吗？此操作不可恢复。');
    if (!confirmed) return;
    const result = node.type === 'directory'
      ? await window.api.deleteDirectory(node.path)
      : await window.api.deleteFile(node.path);
    if (result && result.ok) {
      // Close tab if open
      const idx = codeOpenTabs.findIndex(t => t.path === node.path);
      if (idx !== -1) closeTab(node.path);
      await loadCodeFileTree(codeWorkspacePath);
    } else {
      window.showMessageModal?.('删除失败: ' + (result?.error || '未知错误'), '错误', 'error');
    }
  }

  // 退订 agent 注册的 LLM 重试/流式事件监听器。
  // 旧监听器挂在 agent 实例上，若实例被置 null 后无法退订，
  // ipcRenderer 监听器会随每次新对话线性累积。
  function unsubscribeAgentStreams(ag) {
    if (!ag) return;
    if (typeof ag._llmRetryUnsub === 'function') { try { ag._llmRetryUnsub(); } catch { /* ignore */ } }
    if (typeof ag._streamChunkUnsub === 'function') { try { ag._streamChunkUnsub(); } catch { /* ignore */ } }
    if (typeof ag._streamEndUnsub === 'function') { try { ag._streamEndUnsub(); } catch { /* ignore */ } }
    ag._llmRetryUnsub = null;
    ag._streamChunkUnsub = null;
    ag._streamEndUnsub = null;
  }

  function setupAgentStreamSubscriptions(ag, mode) {
    if (!ag || !window.api) return;
    if (window.api.onLLMRetry && !ag._llmRetryUnsub) {
      ag._llmRetryUnsub = window.api.onLLMRetry((info) => {
        if (!info || !ag.onMessage) return;
        // 仅处理属于当前会话的重试事件，避免其他模式会话的重试气泡串进来
        if (info.sessionKey && info.sessionKey !== ag.sessionKey) return;
        const kind = info.kind || 'unknown';
        const delayTxt = info.delayMs ? `，${Math.round(info.delayMs / 100) / 10}s 后重试` : '';
        const reasonTxt = info.reason ? `（${info.reason}）` : '';
        ag.onMessage('system', `LLM 请求失败（${kind}），第 ${info.attempt || 1} 次重试${delayTxt}${reasonTxt}`);
      });
    }
    if (window.api.onStreamChunk && !ag._streamChunkUnsub) {
      ag._streamChunkUnsub = window.api.onStreamChunk((chunk) => {
        if (!chunk || chunk.requestId !== ag._activeStreamRequestId) return;
        if (ag.onMessage) ag.onMessage('stream-chunk', chunk);
        const session = sessionManager?.getByAgent(ag);
        if (window.VoiceUI && chunk.content && (!session || session.active)) {
          window.VoiceUI.feedStreamChunk(chunk.content);
        }
      });
    }
    if (window.api.onStreamEnd && !ag._streamEndUnsub) {
      ag._streamEndUnsub = window.api.onStreamEnd((data) => {
        if (!data || data.requestId !== ag._activeStreamRequestId) return;
        if (ag.onMessage) ag.onMessage('stream-end', data);
        const session = sessionManager?.getByAgent(ag);
        if (window.VoiceUI && (!session || session.active)) {
          window.VoiceUI.feedStreamEnd(data && data.content ? data.content : null);
        }
      });
    }
  }

  function wireCodeAgent(ag) {
    if (!ag) return;
    const isActive = () => {
      const session = sessionManager?.getByAgent(ag);
      return !session || session.active;
    };

    ag.onTitleChange = (title) => {
      if (isActive()) setTitlebarTitle(title);
      if (isActive()) window.api.webControlPushTitle(title);
    };

    ag.onMessage = (type, data) => {
      const msgsEl = document.getElementById('code-chat-messages');
      if (!msgsEl) return;
      if (!isActive()) {
        if (type === 'approval') {
          // SessionManager 已记录等待审批状态，这里只刷新 tab。
          if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
        }
        return;
      }
      switch (type) {
        case 'assistant':
          addCodeMessage('assistant', data);
          break;
        case 'system':
          addCodeMessage('system', data);
          break;
        case 'stream-chunk': {
          const bubble = codeStreamBubble;
          if (!bubble) return;
          if (data.content) {
            const dedup = dedupAppendChunk(bubble.rawContent, bubble._lastChunk, data.content);
            bubble.rawContent = dedup.raw;
            bubble._lastChunk = dedup.lastChunk;
            bubble.contentStarted = true;
            bubble.contentEl.innerHTML = renderMarkdown(bubble.rawContent) + '<span class="streaming-cursor">▋</span>';
            if (bubble.rawReasoning) bubble.reasoningEl.innerHTML = renderMarkdown(bubble.rawReasoning);
          }
          if (data.reasoning) {
            bubble.rawReasoning += data.reasoning;
            bubble.reasoningSection.style.display = 'block';
            const rCursor = bubble.contentStarted ? '' : '<span class="streaming-cursor">▋</span>';
            bubble.reasoningEl.innerHTML = renderMarkdown(bubble.rawReasoning) + rCursor;
            try { bubble.reasoningEl.scrollTop = bubble.reasoningEl.scrollHeight; } catch (_) {}
          }
          msgsEl.scrollTop = msgsEl.scrollHeight;
          if (!bubble.renderTimer) {
            bubble.renderTimer = setTimeout(() => {
              bubble.renderTimer = null;
              if (bubble.el.id) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + bubble.el.id, html: bubble.el.outerHTML });
            }, 120);
          }
          break;
        }
        case 'stream-end': {
          const isAuthoritativeFinal = !!(data && typeof data === 'object' && data.content !== undefined);
          const bubble = codeStreamBubble;
          if (!bubble) {
            if (isAuthoritativeFinal && data.requestId) {
              const target = msgsEl.querySelector(`[data-stream-request="${cssEscape(data.requestId)}"]`);
              if (target) {
                const body = target.querySelector('.message-content, .code-msg-content, .message-body');
                const clean = String(data.content || '').trimEnd();
                if (body && clean) body.innerHTML = renderMarkdown(clean);
              }
            }
            codeStreamBubble = null;
            return;
          }
          if (!isAuthoritativeFinal) return;
          if (bubble.renderTimer) { clearTimeout(bubble.renderTimer); bubble.renderTimer = null; }
          const hasReasoning = !!(data.reasoning || bubble.rawReasoning);
          const finalContent = String(data.content || bubble.rawContent).trimEnd();
          const hasContent = !!(finalContent && finalContent.trim());
          if (hasReasoning) {
            bubble.reasoningSection.classList.add('collapsed');
            bubble.reasoningSection.style.display = 'block';
            bubble.reasoningEl.innerHTML = renderMarkdown(data.reasoning || bubble.rawReasoning);
            try { bubble.reasoningEl.scrollTop = bubble.reasoningEl.scrollHeight; } catch (_) {}
          }
          if (hasContent) {
            bubble.contentEl.innerHTML = renderMarkdown(finalContent);
          } else if (hasReasoning) {
            bubble.contentEl.style.display = 'none';
            const timeEl = bubble.el.querySelector('.message-time');
            if (timeEl) timeEl.style.display = 'none';
          } else {
            bubble.el.remove();
            if (bubble.el.id) WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + bubble.el.id });
            codeStreamBubble = null;
            break;
          }
          bubble.el.classList.remove('streaming');
          if (bubble.el.id) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + bubble.el.id, html: bubble.el.outerHTML });
          codeStreamBubble = null;
          break;
        }
        case 'stream-start':
          codeStreamBubble = createCodeStreamBubble();
          if (codeStreamBubble?.el && data?.requestId) {
            codeStreamBubble.el.setAttribute('data-stream-request', String(data.requestId));
          }
          break;
        case 'tool_call':
          addCodeToolCall(data);
          break;
        case 'approval':
          showCodeApprovalPanel(data.toolName, data.args);
          break;
        case 'tool-auth-required':
          showToolAuthModal(data.toolName, data.category, ag);
          break;
        case 'tool-result':
          addCodeToolResult(data);
          if (data && _fileSystemTools.has(data.name) && codeWorkspacePath) loadCodeFileTree(codeWorkspacePath);
          break;
        case 'present-file':
          addFilePresentCard(data);
          sendAppNotification('present', 'Agent 向您呈递文件', data?.title || data?.filename || '请查看文件内容');
          break;
      }
    };
  }

  async function initCodeAgent() {
    // 先退订旧实例的监听器，避免 ipcRenderer 监听器累积
    unsubscribeAgentStreams(codeAgent);
    if (codeAgent && sessionManager) {
      const oldSession = sessionManager.getByAgent(codeAgent);
      if (oldSession) sessionManager.close(oldSession);
    }
    if (!codeWorkspacePath) {
      window.showMessageModal('请先打开工作区文件夹', '提示', 'warning');
      return false;
    }
    codeAgent = new Agent();
    codeAgent.mode = 'code';
    codeAgent.workspacePath = codeWorkspacePath;
    codeAgent.codeWorkspacePath = codeWorkspacePath; // 用于 saveToHistory 的 code 分支
    codeAgent.settings = await window.api.getSettings();
    if (!codeAgent.settings.tools || typeof codeAgent.settings.tools !== 'object') {
      codeAgent.settings.tools = {};
    }
    codeAgent.systemInfo = await window.api.getFullSystemInfo();
    codeAgent.contextManager = new ContextManager(codeAgent.settings.llm?.maxContextLength || 131072);
    codeAgent.contextManager.setMaxTokens(codeAgent.settings.llm?.maxContextLength || 131072);
    codeAgent.contextManager.setOutputReserve(codeAgent.settings.llm?.maxResponseTokens || 8192);
    codeAgent.conversationId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    await codeAgent.refreshSkillsCatalog();
    codeAgent.contextManager.setSystemPrompt(codeAgent.getSystemPrompt());
    setupAgentStreamSubscriptions(codeAgent, 'code');
    wireCodeAgent(codeAgent);

    if (sessionManager) {
      const codeSession = sessionManager.registerAgent('code', codeAgent, {
        title: codeAgent.conversationTitle || '未命名 Code 会话'
      });
      sessionManager.activate('code', codeSession.key);
    }
    return true;
  }

  async function createCodeSession() {
    if (!codeWorkspacePath) {
      window.showMessageModal('请先打开工作区文件夹', '提示', 'warning');
      return null;
    }
    const ag = new Agent();
    ag.mode = 'code';
    ag.workspacePath = codeWorkspacePath;
    ag.codeWorkspacePath = codeWorkspacePath;
    ag.settings = await window.api.getSettings();
    if (!ag.settings.tools || typeof ag.settings.tools !== 'object') ag.settings.tools = {};
    ag.systemInfo = await window.api.getFullSystemInfo();
    ag.contextManager = new ContextManager(ag.settings.llm?.maxContextLength || 131072);
    ag.contextManager.setMaxTokens(ag.settings.llm?.maxContextLength || 131072);
    ag.contextManager.setOutputReserve(ag.settings.llm?.maxResponseTokens || 8192);
    ag.conversationId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    await ag.refreshSkillsCatalog();
    ag.contextManager.setSystemPrompt(ag.getSystemPrompt());
    wireCodeAgent(ag);
    setupAgentStreamSubscriptions(ag, 'code');
    if (!sessionManager) return null;
    const session = sessionManager.registerAgent('code', ag, { title: '未命名 Code 会话' });
    activateSession('code', session.key);
    return session;
  }

  async function replayCodeSession(session) {
    const msgsEl = document.getElementById('code-chat-messages');
    if (!msgsEl || !session?.agent) return;
    codeStreamBubble = null;
    msgsEl.innerHTML = '';
    WebUIMirror.pushDomEvent({ type: 'dom_clear', container: '#code-chat-messages' });
    const messages = session.agent.contextManager?.getHistoryMessages() || [];
    const total = messages.length;
    const chunkSize = 40;
    const toolCallMap = {};
    if (total === 0) {
      msgsEl.innerHTML = `<div class="welcome-message"><div class="welcome-icon"><i class="fa-solid fa-code"></i></div><h2>Code 模式</h2><p>继续编程任务</p></div>`;
      return;
    }
    showHistoryProgress(total);
    try {
      for (let start = 0; start < total; start += chunkSize) {
        const end = Math.min(total, start + chunkSize);
        for (let i = start; i < end; i++) {
          const msg = messages[i];
          if (msg.role === 'user') {
            addCodeMessage('user', extractTextContent(msg.content), false);
          } else if (msg.role === 'assistant') {
            const textContent = extractTextContent(msg.content);
            if (textContent) addCodeMessage('assistant', textContent, false);
            if (msg.tool_calls && msg.tool_calls.length > 0) {
              for (const tc of msg.tool_calls) {
                const toolName = tc.function?.name || 'tool';
                let args = {};
                try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
                const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
                const displayName = toolDef?.desc || toolName;
                const card = addCodeToolCall({ name: displayName, args, callId: tc.id });
                if (tc.id && card) toolCallMap[tc.id] = { card, name: toolName };
              }
            }
          } else if (msg.role === 'tool') {
            const key = msg.tool_call_id;
            const entry = key ? toolCallMap[key] : null;
            let result = msg.content;
            if (Array.isArray(result)) result = extractTextContent(result);
            if (typeof result === 'string') { try { result = JSON.parse(result); } catch {} }
            if (entry) {
              addCodeToolResult({ result, name: entry.name, callId: key });
            } else {
              const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
              addCodeMessage('system', `[工具结果] ${msg.name || 'tool'}: ${resultStr.slice(0, 200)}`, false);
            }
          } else if (msg.role === 'system') {
            addCodeMessage('system', typeof msg.content === 'string' ? msg.content : String(msg.content || ''), false);
          }
        }
        updateHistoryProgress(end, total, end >= total ? '渲染完成，正在收尾…' : `已渲染 ${end}/${total} 条消息`);
        await yieldHistoryUI();
      }
    } finally {
      hideHistoryProgress();
    }
    requestAnimationFrame(() => {
      msgsEl.scrollTop = msgsEl.scrollHeight;
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-chat-messages', html: msgsEl.innerHTML });
    });
  }

  let codeStreamBubble = null;

  function createCodeStreamBubble() {
    const msgsEl = document.getElementById('code-chat-messages');
    if (!msgsEl) return null;
    // Remove welcome message
    const welcome = msgsEl.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = 'message assistant streaming';
    msg.id = 'code-stream-' + Date.now();
    msg.innerHTML = `
      <div class="message-avatar"><i class="fa-solid fa-robot"></i></div>
      <div class="message-body">
        <div class="reasoning-section" style="display:none;">
          <div class="reasoning-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <i class="fa-solid fa-brain"></i><span>推理过程</span>
            <i class="fa-solid fa-chevron-down reasoning-toggle-icon"></i>
          </div>
          <div class="reasoning-content markdown-body"></div>
        </div>
        <div class="message-content markdown-body"></div>
        <div class="message-time">${new Date().toLocaleTimeString('zh-CN', {hour12: false})}</div>
      </div>`;
    msgsEl.appendChild(msg);
    // 增量推送：流式气泡创建后追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#code-chat-messages', html: msg.outerHTML });
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return {
      el: msg,
      contentEl: msg.querySelector('.message-content'),
      reasoningEl: msg.querySelector('.reasoning-content'),
      reasoningSection: msg.querySelector('.reasoning-section'),
      rawContent: '',
      rawReasoning: '',
      contentStarted: false,
      renderTimer: null // 用于流式 chunk 推送节流
    };
  }

  function addCodeMessage(role, content, track = true) {
    const msgsEl = document.getElementById('code-chat-messages');
    if (!msgsEl) return;
    const welcome = msgsEl.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = 'message ' + role;
    const avatarIcon = role === 'assistant' ? 'fa-robot' : (role === 'system' ? 'fa-info-circle' : 'fa-user');
    const rendered = (role === 'assistant') ? renderMarkdown(content) : escapeHtml(content);
    // 懒渲染用：保留原始内容与角色，离屏折叠后滚回时重新渲染
    msg.dataset.lazyRaw = content;
    msg.dataset.lazyRole = (role === 'assistant') ? 'md' : 'text';
    msg.innerHTML = `
      <div class="message-avatar"><i class="fa-solid ${avatarIcon}"></i></div>
      <div class="message-body">
        <div class="message-content markdown-body">${rendered}</div>
        <div class="message-time">${new Date().toLocaleTimeString('zh-CN', {hour12: false})}</div>
      </div>`;
    msgsEl.appendChild(msg);
    // 增量推送：Code 消息追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#code-chat-messages', html: msg.outerHTML });
    msgsEl.scrollTop = msgsEl.scrollHeight;

    // Track for history
    if (track) codeMessages.push({ role, content });
  }

  function addCodeToolCall(data) {
    // 工具调用 UI（卡片式）— 显示工具名 + 参数
    const msgsEl = document.getElementById('code-chat-messages');
    if (!msgsEl) return;
    const div = document.createElement('div');
    div.className = 'tool-call-card';
    div.id = 'code-tool-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    if (data.callId) div.dataset.callId = data.callId;
    const argsStr = data.args ? JSON.stringify(data.args, null, 2).slice(0, 500) : '';
    div.innerHTML = `<div class="tool-call-header"><i class="fa-solid fa-wrench"></i> <span>${escapeHtml(data.name || 'tool')}</span></div>` +
      (argsStr ? `<pre class="tool-call-args">${escapeHtml(argsStr)}</pre>` : '') +
      `<div class="tool-call-status"><i class="fa-solid fa-spinner fa-spin"></i> 执行中...</div>`;
    msgsEl.appendChild(div);
    // 增量推送：工具调用卡片追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#code-chat-messages', html: div.outerHTML });
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return div;
  }

  function addCodeToolResult(data) {
    // 在 tool-call-card 中填充结果
    // 优先通过 callId 精确匹配（历史加载时多个工具调用可能连续出现）
    const msgsEl = document.getElementById('code-chat-messages');
    if (!msgsEl) return;
    let targetCard = null;
    if (data.callId) {
      targetCard = msgsEl.querySelector(`.tool-call-card[data-call-id="${cssEscape(data.callId)}"]`);
    }
    if (!targetCard) {
      // 回退：取最后一个未完成的 card（状态为"执行中"的）
      const cards = msgsEl.querySelectorAll('.tool-call-card');
      for (let i = cards.length - 1; i >= 0; i--) {
        const statusEl = cards[i].querySelector('.tool-call-status');
        if (statusEl && statusEl.innerHTML.includes('fa-spin')) { targetCard = cards[i]; break; }
      }
      // 最终回退：取最后一个 card
      if (!targetCard) targetCard = cards[cards.length - 1];
    }
    if (!targetCard) return;
    const statusEl = targetCard.querySelector('.tool-call-status');
    if (!statusEl) return;
    const resultStr = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    const ok = data.result?.ok !== false;
    statusEl.innerHTML = (ok ? '<i class="fa-solid fa-check"></i> 完成' : '<i class="fa-solid fa-xmark"></i> 失败') +
      (resultStr ? `<pre class="tool-call-result">${escapeHtml(resultStr.slice(0, 800))}</pre>` : '');
    // 增量推送：更新工具调用卡片结果到 WebUI
    if (targetCard.id) {
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + targetCard.id, html: targetCard.outerHTML });
    }
  }

  function showCodeApprovalPanel(toolName, args) {
    // Code 模式独立的 approval UI（在 code-chat-messages 区域内显示，不逃逸到 Chat 模式）
    const msgsEl = document.getElementById('code-chat-messages');
    if (!msgsEl) return;
    // 移除已存在的 approval 面板
    const existing = msgsEl.querySelector('.code-approval-panel');
    if (existing) {
      if (existing.id) WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + existing.id });
      existing.remove();
    }
    const div = document.createElement('div');
    div.className = 'code-approval-panel';
    div.id = 'code-approval-' + Date.now();
    const argsStr = args ? JSON.stringify(args, null, 2) : '';
    div.innerHTML = `<div class="approval-header"><i class="fa-solid fa-shield-halved"></i> 工具审批：${escapeHtml(toolName)}</div>` +
      (argsStr ? `<pre class="approval-args">${escapeHtml(argsStr)}</pre>` : '') +
      `<div class="approval-actions">
        <button class="btn-danger btn-approval-deny"><i class="fa-solid fa-xmark"></i> 拒绝</button>
        <button class="btn-primary btn-approval-approve"><i class="fa-solid fa-check"></i> 批准</button>
      </div>`;
    msgsEl.appendChild(div);
    // 增量推送：审批面板追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#code-chat-messages', html: div.outerHTML });
    msgsEl.scrollTop = msgsEl.scrollHeight;
    div.querySelector('.btn-approval-approve').addEventListener('click', () => {
      if (codeAgent) codeAgent.resolveApproval(true);
      div.remove();
      if (div.id) WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + div.id });
    });
    div.querySelector('.btn-approval-deny').addEventListener('click', () => {
      if (codeAgent) codeAgent.resolveApproval(false);
      div.remove();
      if (div.id) WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + div.id });
    });
  }

  async function sendCodeMessage() {
    const input = document.getElementById('code-chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text && codeCurrentAttachments.length === 0) return;
    if (!codeAgent) {
      const ok = await initCodeAgent();
      if (!ok) return;
    }
    if (codeAgent.running) return;
    const codeSession = sessionManager?.getByAgent(codeAgent);
    if (codeSession && !sessionManager.requestStart(codeSession)) {
      const queued = codeCurrentAttachments.map(att => ({
        name: att.name,
        path: att.path,
        isImage: att.isImage,
        extractedText: att.content || ''
      }));
      addCodeMessage('user', text);
      input.value = '';
      clearCodeAttachments();
      sessionManager.queue(codeSession, { text, attachments: queued });
      addCodeMessage('system', '当前并发会话较多，本消息已排队，有空闲槽位后会自动开始。', false);
      return;
    }

    // 与 Chat 模式一致：UI 与历史只记录 [附件: 文件名]，文件内容通过 attachments 参数交给 Agent 内部处理
    const attachments = codeCurrentAttachments.map(att => ({
      name: att.name,
      path: att.path,
      isImage: att.isImage,
      extractedText: att.content || ''
    }));

    let displayText = text;
    if (attachments.length > 0) {
      const names = attachments.map(a => a.name).join(', ');
      displayText += (displayText ? '\n' : '') + `[附件: ${names}]`;
    }

    addCodeMessage('user', displayText);
    input.value = '';
    input.style.height = 'auto';
    clearCodeAttachments();
    // 推送输入框清空到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_value', selector: '#code-chat-input', value: '' });

    // Toggle stop button
    const btnSend = document.getElementById('btn-code-send');
    const btnStop = document.getElementById('btn-code-stop');
    btnSend?.classList.add('hidden');
    btnStop?.classList.remove('hidden');
    // 推送按钮状态变化到 WebUI
    if (btnSend) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-code-send', attr: 'class', value: btnSend.className });
    if (btnStop) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-code-stop', attr: 'class', value: btnStop.className });

    try {
      // 与 Chat 模式一致：附件作为独立参数传入，sendMessage 内部负责构造 [附件: xxx] 摘要
      await codeAgent.sendMessage(text, attachments);
    } catch (e) {
      addCodeMessage('system', `错误: ${e.message}`);
    } finally {
      btnSend?.classList.remove('hidden');
      // 仅当 Code Agent 完成 且 语音播报也完成时才隐藏停止按钮
      try { refreshCodeStopButton(); } catch (_) {}
      // 推送按钮状态恢复到 WebUI
      if (btnSend) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-code-send', attr: 'class', value: btnSend.className });
      if (btnStop) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-code-stop', attr: 'class', value: btnStop.className });
      // Auto-save history
      await saveCodeHistory();
    }
  }

  async function saveCodeHistory() {
    if (!codeWorkspacePath || codeMessages.length === 0) return;
    // 同步 codeCurrentHistoryId 与 codeAgent.conversationId，避免双重保存产生重复历史条目。
    // 真正的历史持久化由 codeAgent.saveToHistory()（agent.js）负责，它保存完整的 contextManager.messages。
    if (codeAgent && codeAgent.conversationId) {
      codeCurrentHistoryId = codeAgent.conversationId;
      return;
    }
    // Agent 未初始化时的兜底：直接保存 codeMessages
    if (!codeCurrentHistoryId) {
      codeCurrentHistoryId = Date.now().toString(36);
    }
    const title = codeMessages.find(m => m.role === 'user')?.content?.slice(0, 30) || '未命名';
    await window.api.codeSaveHistory(codeWorkspacePath, codeCurrentHistoryId, {
      title,
      ts: Date.now(),
      schemaVersion: 2, // 与 agent.saveToHistory 保持统一的历史格式版本
      messages: codeMessages,
      workspace: codeWorkspacePath
    });
  }

  async function loadCodeHistoryPage() {
    const listEl = document.getElementById('code-history-list');
    const descEl = document.getElementById('code-history-desc');
    if (!listEl) return;
    if (!codeWorkspacePath) {
      listEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>暂无 Code 历史（需先打开工作区）</p></div>';
      if (descEl) descEl.textContent = '按工作区隔离的编程对话历史';
      return;
    }
    if (descEl) descEl.textContent = `工作区: ${codeWorkspacePath}`;
    if (typeof HistoryList !== 'undefined') {
      await loadCodeHistoryPageVirtual();
      return;
    }
    listEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>加载中...</p></div>';
    try {
      const result = await window.api.codeListHistory(codeWorkspacePath);
      if (result.ok && result.history && result.history.length > 0) {
        // 对齐 Chat 模式结构：history-info(标题+时间) / history-actions(按钮组)
        listEl.innerHTML = result.history.map(item => {
          const date = new Date(item.ts);
          const timeStr = date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          return `
          <div class="history-item" data-id="${item.id}">
            <div class="history-info">
              <div class="history-title">${escapeHtml(item.title || '未命名')} ${sessionStatusBadge(item.status, item.lastError)}</div>
              <div class="history-time">${timeStr} · ${item.messageCount || 0} 条消息</div>
            </div>
            <div class="history-actions">
              <button class="btn-icon history-continue" data-id="${item.id}" title="继续对话"><i class="fa-solid fa-play"></i></button>
              <button class="btn-icon history-delete" data-id="${item.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
            </div>
          </div>`;
        }).join('');
        listEl.querySelectorAll('.history-continue').forEach(btn => {
          btn.addEventListener('click', async () => {
            stopVoicePlayback(); // 切换会话前清空语音播放队列
            const id = btn.dataset.id;
            const loadRes = await window.api.codeLoadHistory(codeWorkspacePath, id);
            if (loadRes.ok && loadRes.data) {
              codeCurrentHistoryId = id;
              const conv = loadRes.data;
              let session = sessionManager ? sessionManager.list('code').find(s => String(s.id) === String(id)) : null;
              if (session) {
                codeAgent = session.agent;
                await codeAgent.loadFromHistory(conv);
                sessionManager.retag(session, id);
                activateSession('code', session.key);
              } else {
                session = await createCodeSession();
                if (!session) return;
                codeAgent = session.agent;
                await codeAgent.loadFromHistory(conv);
                sessionManager.retag(session, id);
              }
              codeMessages = codeAgent.contextManager.getHistoryMessages().slice();
              await replayCodeSession(session);
              document.querySelector('.nav-item[data-page="code"]')?.click();
            }
          });
        });
        listEl.querySelectorAll('.history-delete').forEach(btn => {
          btn.addEventListener('click', async () => {
            // 对齐 Babe 模式：删除 Code 历史记录前二次确认，防止误删
            const titleForConfirm = btn.closest('.history-item')?.querySelector('.history-title')?.textContent?.trim() || '此对话';
            const confirmed = await window.confirmDialog(`确定删除"${String(titleForConfirm).slice(0, 40)}"吗？此操作不可恢复。`, '删除确认');
            if (!confirmed) return;
            await window.api.codeDeleteHistory(codeWorkspacePath, btn.dataset.id);
            loadCodeHistoryPage();
          });
        });
      } else {
        listEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>暂无 Code 历史</p></div>';
      }
      // 推送历史列表到 WebUI/Remote
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-code-history', html: document.getElementById('page-code-history').innerHTML });
    } catch (e) {
      listEl.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>${e.message}</p></div>`;
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-code-history', html: document.getElementById('page-code-history').innerHTML });
    }
  }

  // ============ Code 历史虚拟滚动 + Ctrl/Cmd+F 搜索 ============
  let codeHistoryRawItems = [];
  let codeHistorySearch = null;

  function ensureCodeHistoryListAttached() {
    const listEl = document.getElementById('code-history-list');
    if (!listEl || typeof HistoryList === 'undefined') return false;
    if (!listEl.dataset.hlAttached) {
      listEl.dataset.hlAttached = '1';
      HistoryList.attach(listEl, {
        renderItem: renderCodeHistoryItem,
        onAction: handleCodeHistoryAction,
        renderEmpty: () => '<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>暂无 Code 历史</p></div>',
        stride: 78,
        overscan: 8
      });
      codeHistorySearch = (typeof window.makeHistorySearch === 'function') ? window.makeHistorySearch({
        key: 'code-history',
        inputId: 'code-history-search-input',
        countId: 'code-history-search-count',
        getRawItems: () => codeHistoryRawItems,
        getSearchText: (item) => `${item.title || ''} ${item.messageCount || ''}`,
        onFilterChange: (filtered) => HistoryList.setItems(listEl, filtered)
      }) : null;
    }
    return true;
  }

  function renderCodeHistoryItem(item) {
    const date = new Date(item.ts);
    const timeStr = date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `
      <div class="history-item" data-id="${item.id}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(item.title || '未命名')} ${sessionStatusBadge(item.status, item.lastError)}</div>
          <div class="history-time">${timeStr} · ${item.messageCount || 0} 条消息</div>
        </div>
        <div class="history-actions">
          <button class="btn-icon" data-action="continue" title="继续对话"><i class="fa-solid fa-play"></i></button>
          <button class="btn-icon" data-action="delete" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`;
  }

  async function handleCodeHistoryAction(action, item) {
    if (!item || !item.id) return;
    const id = item.id;
    if (action === 'continue') {
      stopVoicePlayback();
      const loadRes = await window.api.codeLoadHistory(codeWorkspacePath, id);
      if (loadRes.ok && loadRes.data) {
        codeCurrentHistoryId = id;
        const conv = loadRes.data;
        let session = sessionManager ? sessionManager.list('code').find(s => String(s.id) === String(id)) : null;
        if (session) {
          codeAgent = session.agent;
          await codeAgent.loadFromHistory(conv);
          sessionManager.retag(session, id);
          activateSession('code', session.key);
        } else {
          session = await createCodeSession();
          if (!session) return;
          codeAgent = session.agent;
          await codeAgent.loadFromHistory(conv);
          sessionManager.retag(session, id);
        }
        codeMessages = codeAgent.contextManager.getHistoryMessages().slice();
        await replayCodeSession(session);
        document.querySelector('.nav-item[data-page="code"]')?.click();
      }
    } else if (action === 'delete') {
      const titleForConfirm = item.title || '此对话';
      const confirmed = await window.confirmDialog(`确定删除"${String(titleForConfirm).slice(0, 40)}"吗？此操作不可恢复。`, '删除确认');
      if (!confirmed) return;
      await window.api.codeDeleteHistory(codeWorkspacePath, id);
      loadCodeHistoryPage();
    }
  }

  async function loadCodeHistoryPageVirtual() {
    const listEl = document.getElementById('code-history-list');
    if (!listEl) return;
    ensureCodeHistoryListAttached();
    HistoryList.showMessage(listEl, '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>加载中...</p></div>');
    try {
      const result = await window.api.codeListHistory(codeWorkspacePath);
      if (result.ok && Array.isArray(result.history)) {
        codeHistoryRawItems = result.history;
      } else {
        codeHistoryRawItems = [];
      }
      if (codeHistorySearch) codeHistorySearch.refresh();
      else HistoryList.setItems(listEl, codeHistoryRawItems);
      HistoryList.materializeAll();
      const pageHtml = document.getElementById('page-code-history')?.innerHTML || '';
      HistoryList.restoreAll();
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-code-history', html: pageHtml });
    } catch (e) {
      HistoryList.showMessage(listEl, `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>${escapeHtml(e.message)}</p></div>`);
    }
  }

  // Code mode event handlers
  document.getElementById('btn-code-open-workspace')?.addEventListener('click', async () => {
    const result = await window.api.codeOpenWorkspace();
    if (result.ok && result.path) {
      codeWorkspacePath = result.path;
      const wsPathEl = document.getElementById('code-workspace-path');
      if (wsPathEl) wsPathEl.textContent = result.path;
      await loadCodeFileTree(result.path);
      // Reset current conversation
      unsubscribeAgentStreams(codeAgent);
      codeAgent = null;
      codeCurrentHistoryId = null;
      codeMessages = [];
      const msgsEl = document.getElementById('code-chat-messages');
      if (msgsEl) {
        msgsEl.innerHTML = '<div class="welcome-message"><div class="welcome-icon"><i class="fa-solid fa-code"></i></div><h2>Code 模式</h2><p>工作区已打开，开始编程任务吧。历史记录按工作区隔离保存。</p></div>';
      }
    }
  });

  document.getElementById('btn-code-new-chat')?.addEventListener('click', () => {
    stopVoicePlayback(); // 清空语音播放队列
    if (!codeWorkspacePath) {
      window.showMessageModal('请先打开工作区', '提示', 'warning');
      return;
    }
    createCodeSession();
  });

  // 在系统文件管理器中打开当前工作区（Windows 资源管理器 / macOS Finder）
  // 启动时根据平台动态设置按钮 title（Finder / 资源管理器）
  (function _initCodeExplorerBtnTitle() {
    const btn = document.getElementById('btn-code-open-in-explorer');
    if (btn) {
      const fmName = _fileManagerName();
      btn.title = `在${fmName}中打开工作区`;
    }
  })();
  document.getElementById('btn-code-open-in-explorer')?.addEventListener('click', () => {
    if (!codeWorkspacePath) {
      window.showMessageModal('请先打开工作区', '提示', 'warning');
      return;
    }
    window.api.openFileExplorer?.(codeWorkspacePath);
  });

  // ---- 终端可见化：模态框 + Ctrl+T + xterm.js ----
  // 让所有 node-pty 终端可见（默认后台监听，Agent 也在操作）
  // 用户可通过 Ctrl+T 或 Code 工具栏的"显示终端"按钮打开终端模态框
  // 不同 terminalID 以标签页形式显示，用户可操作
  (function initTerminalModal() {
    const modal = document.getElementById('terminal-modal');
    const tabsEl = document.getElementById('terminal-tabs');
    const containerEl = document.getElementById('terminal-container');
    if (!modal || !tabsEl || !containerEl) return;
    if (typeof window.Terminal === 'undefined') {
      console.warn('[Terminal] xterm.js 未加载，跳过初始化');
      return;
    }

    // 终端实例缓存：id -> { term, fit, panel, exited }
    const instances = new Map();
    let activeId = null;
    let dataListenerBound = false;

    // 获取当前主题（强调色 + 深浅色）
    function getXtermTheme() {
      const isDark = document.documentElement.dataset.theme !== 'light';
      const accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim() || '#6366f1';
      return {
        background: isDark ? '#1e1e2e' : '#ffffff',
        foreground: isDark ? '#cdd6f4' : '#1e1e2e',
        cursor: accent,
        cursorAccent: isDark ? '#1e1e2e' : '#ffffff',
        selectionBackground: accent + '40',
        black: '#1e1e2e',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#cba6f7',
        cyan: '#94e2d5',
        white: isDark ? '#cdd6f4' : '#1e1e2e',
        brightBlack: isDark ? '#585b70' : '#a6adc8',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#cba6f7',
        brightCyan: '#94e2d5',
        brightWhite: isDark ? '#ffffff' : '#000000'
      };
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // 创建 xterm 实例并附加到指定面板
    function createTerminalPanel(id) {
      const panel = document.createElement('div');
      panel.className = 'terminal-panel';
      panel.dataset.terminalId = String(id);
      panel.style.display = 'none';
      containerEl.appendChild(panel);

      const term = new window.Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Consolas, "Courier New", Menlo, monospace',
        theme: getXtermTheme(),
        allowProposedApi: true,
        scrollback: 5000
      });

      let fit = null;
      const FitCtor = (window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon)) || null;
      if (FitCtor) {
        try {
          fit = new FitCtor();
          term.loadAddon(fit);
        } catch (e) { console.warn('[Terminal] FitAddon load failed:', e); }
      }

      term.open(panel);

      // 用户输入回写到 pty
      term.onData(data => {
        window.api.writeTerminal?.(id, data).catch(() => {});
      });
      // 调整大小时通知 pty
      term.onResize(({ cols, rows }) => {
        window.api.resizeTerminal?.(id, cols, rows).catch(() => {});
      });

      // 异步加载历史并 fit
      setTimeout(() => {
        if (fit) { try { fit.fit(); } catch {} }
        window.api.getTerminalHistory?.(id).then(result => {
          if (result && result.ok && result.history) {
            try { term.write(result.history); } catch {}
          }
        }).catch(() => {});
      }, 50);

      instances.set(id, { term, fit, panel, exited: false });
      return instances.get(id);
    }

    function createTabElement(meta) {
      const tab = document.createElement('div');
      tab.className = 'terminal-tab';
      tab.dataset.terminalId = String(meta.id);
      const label = meta.lastCommand || `终端 ${meta.id}`;
      const cwdName = meta.cwd ? meta.cwd.split(/[/\\]/).pop() : '';
      tab.innerHTML = `<i class="fa-solid fa-terminal"></i>
        <span class="terminal-tab-label">${escapeHtml(label)}</span>
        ${cwdName ? `<span class="terminal-tab-cwd" title="${escapeHtml(meta.cwd)}">${escapeHtml(cwdName)}</span>` : ''}
        <button class="terminal-tab-close" title="关闭此终端" type="button"><i class="fa-solid fa-xmark"></i></button>`;
      // 点击 tab 本身：切换终端
      tab.addEventListener('click', (e) => {
        if (e.target.closest('.terminal-tab-close')) return; // 关闭按钮单独处理
        switchToTerminal(meta.id);
      });
      // 关闭按钮：杀掉该终端，并阻止冒泡
      const closeBtn = tab.querySelector('.terminal-tab-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await window.api.killTerminal(meta.id);
          // onTerminalExit 会触发 refreshTerminalList
        });
      }
      return tab;
    }

    function switchToTerminal(id) {
      activeId = id;
      tabsEl.querySelectorAll('.terminal-tab').forEach(t => {
        t.classList.toggle('active', String(t.dataset.terminalId) === String(id));
      });
      containerEl.querySelectorAll('.terminal-panel').forEach(p => {
        p.style.display = String(p.dataset.terminalId) === String(id) ? 'block' : 'none';
      });
      const inst = instances.get(id);
      if (inst) {
        if (inst.fit) { try { inst.fit.fit(); } catch {} }
        try { inst.term.focus(); } catch {}
      }
    }

    function showEmptyState() {
      let empty = containerEl.querySelector('.terminal-empty');
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'terminal-empty';
        empty.innerHTML = `<i class="fa-solid fa-terminal"></i>
          <p class="terminal-empty-title">暂无终端</p>
          <p class="terminal-empty-hint">点击右上角 <i class="fa-solid fa-plus"></i> 新建终端，或 Agent 调用终端工具时会自动出现</p>`;
        containerEl.appendChild(empty);
      }
      empty.style.display = 'flex';
    }
    function hideEmptyState() {
      const empty = containerEl.querySelector('.terminal-empty');
      if (empty) empty.style.display = 'none';
    }

    async function refreshTerminalList() {
      if (typeof window.api.listTerminals !== 'function') return;
      const result = await window.api.listTerminals();
      if (!result || !result.ok) return;
      const existingTabs = new Set(Array.from(tabsEl.querySelectorAll('.terminal-tab')).map(t => t.dataset.terminalId));
      const currentIds = new Set(result.terminals.map(t => String(t.id)));

      // 添加新终端的 tab + panel
      for (const meta of result.terminals) {
        const sid = String(meta.id);
        if (!existingTabs.has(sid)) {
          tabsEl.appendChild(createTabElement(meta));
          createTerminalPanel(meta.id);
        } else {
          // 更新现有 tab 的标签
          const tab = tabsEl.querySelector(`.terminal-tab[data-terminal-id="${sid}"]`);
          if (tab) {
            const label = meta.lastCommand || `终端 ${meta.id}`;
            const labelEl = tab.querySelector('.terminal-tab-label');
            if (labelEl) labelEl.textContent = label;
          }
        }
      }

      // 移除已退出的 tab + panel
      for (const existingId of existingTabs) {
        if (!currentIds.has(existingId)) {
          const tab = tabsEl.querySelector(`.terminal-tab[data-terminal-id="${existingId}"]`);
          if (tab) tab.remove();
          const inst = instances.get(Number(existingId));
          if (inst) {
            try { inst.term.dispose(); } catch {}
            instances.delete(Number(existingId));
          }
          const panel = containerEl.querySelector(`.terminal-panel[data-terminal-id="${existingId}"]`);
          if (panel) panel.remove();
        }
      }

      // 若无激活终端，激活第一个；若激活的已退出，切换到第一个
      if (activeId === null || !currentIds.has(String(activeId))) {
        if (result.terminals.length > 0) {
          switchToTerminal(result.terminals[0].id);
          hideEmptyState();
        } else {
          activeId = null;
          showEmptyState();
        }
      } else {
        hideEmptyState();
      }
    }

    async function openTerminalModal() {
      modal.classList.remove('hidden');
      await refreshTerminalList();
      setTimeout(() => {
        const inst = instances.get(activeId);
        if (inst) {
          if (inst.fit) { try { inst.fit.fit(); } catch {} }
          try { inst.term.focus(); } catch {}
        }
      }, 100);
    }
    function closeTerminalModal() {
      modal.classList.add('hidden');
    }

    document.getElementById('btn-code-show-terminals')?.addEventListener('click', openTerminalModal);
    document.getElementById('btn-chat-show-terminals')?.addEventListener('click', openTerminalModal);
    document.getElementById('btn-close-terminal-modal')?.addEventListener('click', closeTerminalModal);

    document.getElementById('btn-terminal-new')?.addEventListener('click', async () => {
      // 优先使用 Code 模式工作区，其次 Chat 模式工作目录
      let cwd = codeWorkspacePath || null;
      if (!cwd && typeof agent !== 'undefined' && agent && agent.workspacePath) {
        cwd = agent.workspacePath;
      }
      const result = await window.api.makeTerminal(cwd);
      if (result && result.ok) {
        await refreshTerminalList();
        switchToTerminal(result.terminalId);
      } else {
        const msg = '创建终端失败：' + (result?.error || '未知错误');
        if (window.showMessageModal) window.showMessageModal(msg, '错误', 'error');
        else console.error('[Terminal]', msg);
      }
    });

    // 实时数据推送：仅当模态框打开时才写入 xterm（数据已在主进程的 fullHistory 中累积）
    function bindDataListener() {
      if (dataListenerBound) return;
      dataListenerBound = true;
      window.api.onTerminalData?.(({ id, data }) => {
        if (modal.classList.contains('hidden')) return; // 模态框关闭时不渲染（节省性能）
        const inst = instances.get(id);
        if (inst && inst.term) {
          try { inst.term.write(data); } catch {}
        }
      });
      window.api.onTerminalExit?.(({ id }) => {
        const inst = instances.get(id);
        if (inst) {
          inst.exited = true;
          try { inst.term.write('\r\n\x1b[33m[终端已退出]\x1b[0m\r\n'); } catch {}
          const tab = tabsEl.querySelector(`.terminal-tab[data-terminal-id="${id}"]`);
          if (tab) tab.classList.add('terminal-tab-exited');
        }
        setTimeout(refreshTerminalList, 200);
      });
    }
    bindDataListener();

    // Ctrl+T 快捷键：模态框关闭时打开，已打开时新建终端
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 't' || e.key === 'T')) {
        // 避免与输入框冲突
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        if (modal.classList.contains('hidden')) {
          openTerminalModal();
        } else {
          document.getElementById('btn-terminal-new')?.click();
        }
      }
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
        closeTerminalModal();
      }
    });

    // 主题切换时刷新所有 xterm 实例
    const themeObserver = new MutationObserver(() => {
      if (instances.size === 0) return;
      const theme = getXtermTheme();
      for (const { term } of instances.values()) {
        try { term.options.theme = theme; } catch {}
      }
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // 模态框尺寸变化时触发 fit
    const resizeObserver = new ResizeObserver(() => {
      const inst = instances.get(activeId);
      if (inst && inst.fit) { try { inst.fit.fit(); } catch {} }
    });
    resizeObserver.observe(containerEl);
  })();

  document.getElementById('btn-code-send')?.addEventListener('click', sendCodeMessage);
  document.getElementById('btn-code-stop')?.addEventListener('click', () => {
    stopVoicePlayback();
    const session = sessionManager?.getActive('code');
    if (session) sessionManager.stop(session);
  });
  document.getElementById('code-chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCodeMessage();
    }
  });
  document.getElementById('code-chat-input')?.addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  });

  // Code 模式面板折叠/恢复逻辑
  function updateCodePanelRestoreBar() {
    const fileTree = document.getElementById('code-file-tree-panel');
    const editor = document.getElementById('code-editor-panel');
    const chat = document.getElementById('code-chat');
    const r1 = document.getElementById('btn-restore-file-tree');
    const r2 = document.getElementById('btn-restore-editor');
    const r3 = document.getElementById('btn-restore-chat');
    const s1 = document.getElementById('code-resizer-1');
    const s2 = document.getElementById('code-resizer-2');
    r1?.classList.toggle('hidden', !fileTree?.classList.contains('collapsed'));
    r2?.classList.toggle('hidden', !editor?.classList.contains('collapsed'));
    r3?.classList.toggle('hidden', !chat?.classList.contains('collapsed'));
    // 隐藏相邻的分割器
    s1?.classList.toggle('hidden', fileTree?.classList.contains('collapsed'));
    s2?.classList.toggle('hidden', editor?.classList.contains('collapsed'));
    // 增量推送：面板折叠状态变更同步到 WebUI（推送相关元素的 class 属性）
    if (fileTree) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-file-tree-panel', attr: 'class', value: fileTree.className });
    if (editor) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-editor-panel', attr: 'class', value: editor.className });
    if (chat) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-chat', attr: 'class', value: chat.className });
    if (r1) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-restore-file-tree', attr: 'class', value: r1.className });
    if (r2) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-restore-editor', attr: 'class', value: r2.className });
    if (r3) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-restore-chat', attr: 'class', value: r3.className });
    if (s1) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-resizer-1', attr: 'class', value: s1.className });
    if (s2) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-resizer-2', attr: 'class', value: s2.className });
  }
  document.getElementById('btn-close-file-tree')?.addEventListener('click', () => {
    document.getElementById('code-file-tree-panel')?.classList.add('collapsed');
    updateCodePanelRestoreBar();
  });
  document.getElementById('btn-close-editor')?.addEventListener('click', () => {
    document.getElementById('code-editor-panel')?.classList.add('collapsed');
    updateCodePanelRestoreBar();
  });
  document.getElementById('btn-close-chat')?.addEventListener('click', () => {
    document.getElementById('code-chat')?.classList.add('collapsed');
    updateCodePanelRestoreBar();
  });
  // 恢复按钮
  document.getElementById('btn-restore-file-tree')?.addEventListener('click', () => {
    document.getElementById('code-file-tree-panel')?.classList.remove('collapsed');
    updateCodePanelRestoreBar();
  });
  document.getElementById('btn-restore-editor')?.addEventListener('click', () => {
    document.getElementById('code-editor-panel')?.classList.remove('collapsed');
    updateCodePanelRestoreBar();
  });
  document.getElementById('btn-restore-chat')?.addEventListener('click', () => {
    document.getElementById('code-chat')?.classList.remove('collapsed');
    updateCodePanelRestoreBar();
  });

  // ---- 可拖动分割器 ----
  function initCodeResizers() {
    document.querySelectorAll('.code-resizer').forEach(resizer => {
      let dragging = false;
      let startX = 0;
      let p1, p2, p1Width, p2Width, p2Flex = false, p1Flex = false;

      resizer.addEventListener('mousedown', (e) => {
        dragging = true;
        startX = e.clientX;
        p1 = document.getElementById(resizer.dataset.panel1);
        p2 = document.getElementById(resizer.dataset.panel2);
        if (!p1 || !p2) return;
        p1Width = p1.getBoundingClientRect().width;
        p2Width = p2.getBoundingClientRect().width;
        p1Flex = false;
        p2Flex = false;
        // 如果 p2 是 flex 布局中的弹性项，改为固定宽度
        if (getComputedStyle(p2).flexGrow !== '0') {
          p2Flex = true;
          p2.style.flex = 'none';
          p2.style.width = p2Width + 'px';
        }
        if (getComputedStyle(p1).flexGrow !== '0') {
          p1Flex = true;
          p1.style.flex = 'none';
          p1.style.width = p1Width + 'px';
        }
        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!dragging || !p1 || !p2) return;
        const dx = e.clientX - startX;
        let newP1Width = p1Width + dx;
        let newP2Width = p2Width - dx;
        // 限制最小宽度
        const p1Min = parseInt(getComputedStyle(p1).minWidth) || 100;
        const p2Min = parseInt(getComputedStyle(p2).minWidth) || 100;
        const p1Max = parseInt(getComputedStyle(p1).maxWidth) || 9999;
        const p2Max = parseInt(getComputedStyle(p2).maxWidth) || 9999;
        if (newP1Width < p1Min) { newP1Width = p1Min; newP2Width = p1Width + p2Width - p1Min; }
        if (newP2Width < p2Min) { newP2Width = p2Min; newP1Width = p1Width + p2Width - p2Min; }
        if (newP1Width > p1Max) { newP1Width = p1Max; newP2Width = p1Width + p2Width - p1Max; }
        if (newP2Width > p2Max) { newP2Width = p2Max; newP1Width = p1Width + p2Width - p2Max; }
        p1.style.width = newP1Width + 'px';
        p2.style.width = newP2Width + 'px';
      });

      document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // 还原原本是弹性项的面板：清除拖拽期间钉死的内联 flex/width，
        // 让布局重新吸收容器剩余宽度，实现窗口拉大/缩小时实时匹配
        if (p1Flex && p1) {
          p1.style.removeProperty('flex');
          p1.style.removeProperty('width');
        }
        if (p2Flex && p2) {
          p2.style.removeProperty('flex');
          p2.style.removeProperty('width');
        }
        p1 = null;
        p2 = null;
        p1Flex = false;
        p2Flex = false;
      });
    });
  }
  initCodeResizers();

  // ---- Code 模式文件选择按钮 ----
  document.getElementById('btn-code-attach-file')?.addEventListener('click', async () => {
    const result = await window.api.openFileDialog({ multiple: true, title: '添加文件到上下文' });
    if (result.ok && result.paths) {
      for (const p of result.paths) {
        const name = p.split(/[\\/]/).pop();
        await addFileToCodeContext({ path: p, name: name, type: 'file' });
      }
    }
  });

  // WebUI 上传文件后通知 Code 模式刷新附件（与 Chat 模式的 onWebControlFileUploaded 对齐）
  if (typeof window.api?.onWebControlFileUploaded === 'function') {
    window.api.onWebControlFileUploaded(async (data) => {
      if (data && data.path && document.getElementById('page-code')?.classList.contains('active')) {
        await addFileToCodeContext({ path: data.path, name: data.name, type: 'file' });
      }
    });
  }

  // ==================== 面板最小化/恢复（索引贴） ====================
  // 追踪当前被最小化的面板 id，避免重复创建索引贴
  const minimizedPanels = new Set();

  // 最小化面板：隐藏面板并在右侧边缘生成一个可点击的纵向索引贴
  window.minimizePanel = function(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel || minimizedPanels.has(panelId)) return;

    // 从面板头部提取图标与标题文本
    const header = panel.querySelector('.geogebra-header h3');
    const iconEl = header ? header.querySelector('i') : null;
    const iconClass = iconEl ? iconEl.className : '';
    const title = header ? header.textContent.trim() : panelId;

    // 隐藏面板并释放主内容区空间（与关闭行为一致）
    panel.classList.add('hidden');
    document.body.classList.remove('geogebra-open');
    minimizedPanels.add(panelId);

    // 在索引贴容器中创建对应 tab
    const container = document.getElementById('panel-tabs-container');
    if (!container) return;
    if (container.querySelector(`[data-panel-id="${panelId}"]`)) return;

    const tab = document.createElement('div');
    tab.className = 'panel-tab';
    tab.dataset.panelId = panelId;
    tab.title = `恢复 ${title}`;
    tab.innerHTML = (iconClass ? `<i class="${iconClass}"></i>` : '') + `<span>${title}</span>`;
    tab.addEventListener('click', () => {
      window.restorePanel(panelId);
    });
    container.appendChild(tab);
  };

  // 恢复面板：移除隐藏状态并删除对应索引贴
  window.restorePanel = function(panelId) {
    const panel = document.getElementById(panelId);
    if (panel) {
      panel.classList.remove('hidden');
      document.body.classList.add('geogebra-open');
    }
    minimizedPanels.delete(panelId);

    const container = document.getElementById('panel-tabs-container');
    if (container) {
      const tab = container.querySelector(`[data-panel-id="${panelId}"]`);
      if (tab) tab.remove();
    }
  };

  // 绑定所有最小化按钮：点击时找到所属面板并最小化
  document.querySelectorAll('.btn-minimize-panel').forEach((btn) => {
    btn.addEventListener('click', () => {
      const panel = btn.closest('.geogebra-panel');
      if (panel && panel.id) {
        window.minimizePanel(panel.id);
      }
    });
  });
