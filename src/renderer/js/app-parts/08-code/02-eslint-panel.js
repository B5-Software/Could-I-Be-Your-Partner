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
