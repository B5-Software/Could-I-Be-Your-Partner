  const _subAgentCards = new Map(); // id → { el, logEl, startTime, timer }

  function addSubAgentCard({ id, title, task, startTime, status }) {
    const el = document.createElement('div');
    el.className = 'sub-agent-card';
    el.dataset.subAgentId = id;
    el.dataset.status = status || 'running';
    const fmtDur = (ms) => {
      const s = Math.floor((ms || 0) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      return `${mm}:${ss}`;
    };
    el.innerHTML = `
      <div class="sub-agent-card-header" title="点击查看完整记录">
        <div class="sub-agent-card-icon"><i class="fa-solid fa-robot"></i></div>
        <div class="sub-agent-card-meta">
          <div class="sub-agent-card-title">${escapeHtml(title)}</div>
          <div class="sub-agent-card-task">${escapeHtml(task || '').slice(0, 120)}${(task || '').length > 120 ? '…' : ''}</div>
        </div>
        <div class="sub-agent-card-stats">
          <span class="sub-agent-stat sub-agent-status"><i class="fa-solid fa-circle-notch fa-spin"></i> 运行中</span>
          <span class="sub-agent-stat sub-agent-duration"><i class="fa-regular fa-clock"></i> <span class="dur-text">00:00</span></span>
          <span class="sub-agent-stat sub-agent-tools hidden"><i class="fa-solid fa-wrench"></i> <span class="tools-text">0</span></span>
          <span class="sub-agent-stat sub-agent-tokens hidden"><i class="fa-solid fa-coins"></i> <span class="tokens-text">0</span></span>
        </div>
        <button class="btn-icon sub-agent-card-expand" title="查看完整对话"><i class="fa-solid fa-window-maximize"></i></button>
      </div>
      <div class="sub-agent-card-log"></div>`;
    appendChatElement(el);
    const logEl = el.querySelector('.sub-agent-card-log');
    const record = { el, logEl, startTime: startTime || Date.now(), timer: null };
    _subAgentCards.set(id, record);
    // 用时计时器
    const durText = el.querySelector('.dur-text');
    record.timer = setInterval(() => {
      if (durText) durText.textContent = fmtDur(Date.now() - record.startTime);
    }, 1000);
    // 整个卡片头部点击 → 打开详情模态框（参考 claude-code-ref：子代理记录在卡片后台）
    const openDetail = (e) => {
      // 避免点击 stats 区域误触发
      if (e.target.closest('.sub-agent-card-stats')) return;
      showSubAgentDetailModal(id);
    };
    el.querySelector('.sub-agent-card-header').addEventListener('click', openDetail);
    el.querySelector('.sub-agent-card-expand').addEventListener('click', (e) => {
      e.stopPropagation();
      showSubAgentDetailModal(id);
    });
    scrollElementIntoView(el);
  }

  function updateSubAgentCard(id, updates) {
    const rec = _subAgentCards.get(id);
    if (!rec) return;
    const { el, timer } = rec;
    if (updates.status === 'done') {
      el.dataset.status = 'done';
      if (timer) { clearInterval(timer); rec.timer = null; }
      const statusEl = el.querySelector('.sub-agent-status');
      if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-circle-check" style="color:var(--success, #4caf50)"></i> 完成';
      // 最终用时
      const durText = el.querySelector('.dur-text');
      if (durText && updates.duration != null) {
        const s = Math.floor(updates.duration / 1000);
        durText.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      }
      // 工具调用次数
      if (updates.toolUseCount != null) {
        const toolsEl = el.querySelector('.sub-agent-tools');
        if (toolsEl) {
          toolsEl.classList.remove('hidden');
          el.querySelector('.tools-text').textContent = updates.toolUseCount;
        }
      }
      // Token 数
      if (updates.usage && updates.usage.total != null) {
        const tokEl = el.querySelector('.sub-agent-tokens');
        if (tokEl) {
          tokEl.classList.remove('hidden');
          el.querySelector('.tokens-text').textContent = fmtTokenCount(updates.usage.total);
        }
      }
      // 结果摘要（默认折叠，避免长结果撑高卡片影响阅读）
      if (updates.result) {
        const resultEl = document.createElement('div');
        resultEl.className = 'sub-agent-card-result collapsed';
        const previewText = updates.result.length > 100
          ? updates.result.substring(0, 100) + '...'
          : updates.result;
        resultEl.innerHTML = `
          <div class="sub-agent-card-result-header">
            <span class="sub-agent-card-result-label">最终结果</span>
            <button class="btn-icon btn-xs sub-agent-result-toggle" title="展开/折叠">
              <i class="fa-solid fa-chevron-down"></i>
            </button>
          </div>
          <div class="sub-agent-card-result-preview">${escapeHtml(previewText)}</div>
          <div class="sub-agent-card-result-full markdown-body" style="display:none">${renderMarkdown(updates.result)}</div>`;
        // 绑定展开/折叠按钮
        const toggleBtn = resultEl.querySelector('.sub-agent-result-toggle');
        const fullEl = resultEl.querySelector('.sub-agent-card-result-full');
        const previewEl = resultEl.querySelector('.sub-agent-card-result-preview');
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const collapsed = resultEl.classList.toggle('collapsed');
          fullEl.style.display = collapsed ? 'none' : '';
          previewEl.style.display = collapsed ? '' : 'none';
          toggleBtn.querySelector('i').className = collapsed
            ? 'fa-solid fa-chevron-down'
            : 'fa-solid fa-chevron-up';
        });
        el.appendChild(resultEl);
      }
      // 达到迭代上限提示
      if (updates.hitMaxIter) {
        const warnEl = document.createElement('div');
        warnEl.className = 'sub-agent-card-warn';
        warnEl.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> 已达迭代上限，结果为完整报告';
        el.appendChild(warnEl);
      }
    }
    scrollElementIntoView(el);
  }

  function appendSubAgentLog(id, content) {
    const rec = _subAgentCards.get(id);
    if (!rec) return;
    const line = document.createElement('div');
    line.className = 'sub-agent-log-line';
    line.innerHTML = `<div class="markdown-body">${renderMarkdown(content)}</div>`;
    rec.logEl.appendChild(line);
    scrollElementIntoView(rec.el);
  }

  // 子代理详情模态框：显示完整对话历史、上下文窗口、token 用量
  // 当前打开的子代理模态框 ID（用于实时刷新）
  let _openSubAgentModalId = null;
  let _subAgentModalRefreshTimer = null;
  // 当前打开的模态框的 render 函数引用（供 sub-agent-message 事件触发立即刷新）
  let _subAgentModalRender = null;
