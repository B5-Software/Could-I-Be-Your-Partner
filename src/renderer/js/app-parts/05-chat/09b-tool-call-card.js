  const toolGroupSummaries = new WeakMap();
  const updateToolGroup = new WeakMap();
  const toolCardSelector = '.tool-call, .tool-call-card';

  function renderToolGroups(transcript) {
    const children = [...transcript.children];
    const summaries = new Set(children.filter(node => node.classList.contains('tool-call-group')));
    let consecutive = [];
    function finish() {
      const [first, second] = consecutive;
      if (!second) {
        if (first) delete first.dataset.toolGroup;
        consecutive = [];
        return;
      }
      let group = toolGroupSummaries.get(first);
      if (!group) {
        const summary = document.createElement('button');
        summary.className = 'tool-call-group';
        summary.type = 'button';
        summary.setAttribute('aria-expanded', 'false');
        summary.innerHTML = '<i class="fa-solid fa-layer-group" aria-hidden="true"></i><span></span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i>';
        group = { summary, cards: [] };
        summary.addEventListener('click', () => {
          const expanded = summary.getAttribute('aria-expanded') !== 'true';
          summary.setAttribute('aria-expanded', String(expanded));
          for (const card of group.cards) card.dataset.toolGroup = expanded ? 'expanded' : 'collapsed';
        });
        toolGroupSummaries.set(first, group);
      }
      const { summary } = group;
      group.cards = consecutive;
      const expanded = summary.getAttribute('aria-expanded') === 'true';
      let success = 0, failed = 0;
      for (const card of consecutive) {
        card.dataset.toolGroup = expanded ? 'expanded' : 'collapsed';
        if (card.dataset.toolState === 'complete') success++;
        if (card.dataset.toolState === 'failed') failed++;
      }
      const count = consecutive.length;
      const pending = count - success - failed;
      const label = t('ui.tools.group', '调用了 {total} 个工具，{success} 个成功，{failed} 个失败', { total: count, success, failed }) +
        (pending ? t('ui.tools.groupPending', '，{count} 个执行中', { count: pending }) : '');
      const caption = summary.querySelector('span');
      if (caption.textContent !== label) caption.textContent = label;
      if (summary.nextElementSibling !== first) transcript.insertBefore(summary, first);
      summaries.delete(summary);
      consecutive = [];
    }
    for (const node of children) {
      if (node.classList.contains('tool-call-group')) continue;
      if (node.matches(toolCardSelector) && node.querySelector('.tool-call-disclosure')) consecutive.push(node);
      else finish();
    }
    finish();
    for (const obsolete of summaries) obsolete.remove();
  }

  for (const { id } of SCROLL_BTN_TARGETS) {
    const transcript = document.getElementById(id);
    if (!transcript) continue;
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (document.documentElement.dataset.frontend === 'v2') renderToolGroups(transcript);
      });
    };
    updateToolGroup.set(transcript, schedule);
    new MutationObserver(schedule).observe(transcript, { childList: true });
    new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['data-frontend'] });
    window.addEventListener('languagechange', schedule);
  }

  function markToolCard(card, failed) {
    card.dataset.toolState = failed ? 'failed' : 'complete';
    const icon = card.querySelector('.tool-call-header > i');
    if (icon) icon.className = 'fa-solid ' + (failed ? 'fa-xmark' : 'fa-check');
    updateToolGroup.get(card.parentElement)?.();
  }

  function wireToolDisclosure(card) {
    const header = card.querySelector('.tool-call-header');
    if (!header) return;
    const description = header.querySelector('span')?.textContent || '';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tool-call-disclosure';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', t('ui.toolDetails', '工具调用详情') + ' · ' + description);
    button.innerHTML = '<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>';
    header.append(button);
  }

  document.addEventListener('click', event => {
    const button = event.target.closest?.('.tool-call-disclosure');
    if (!button || document.documentElement.dataset.frontend !== 'v2') return;
    const card = button.closest('.tool-call, .tool-call-card');
    const expanded = card.classList.toggle('tool-call-expanded');
    button.setAttribute('aria-expanded', String(expanded));
  });

  function addToolCallToChat(displayName, toolName, args, callId) {
    // runSubAgent 工具调用不在此显示卡片 — 子代理有独立的卡片和详情模态框
    // 避免 args 中过长的任务描述和 result 撑爆聊天页面
    if (toolName === 'runSubAgent') return;
    displayName = i18nGetToolDesc(toolName, displayName);

    const el = document.createElement('div');
    el.className = 'tool-call';
    el.id = `tool-${toolName}-${Date.now()}`;
    el.dataset.toolName = toolName;
    if (callId) el.dataset.toolCallId = callId;
    // 截断 args：字符串值限制 200 字符，对象 JSON 限制 500 字符
    const argsStr = Object.entries(args || {})
      .map(([k, v]) => {
        if (typeof v === 'string') return `${k}: ${v.substring(0, 200)}${v.length > 200 ? '…' : ''}`;
        const json = JSON.stringify(v);
        return `${k}: ${json.length > 500 ? json.substring(0, 500) + '…' : json}`;
      })
      .join('\n');
    el.innerHTML = `
      <div class="tool-call-header">
        <i class="fa-solid fa-gear fa-spin"></i>
        <span>${escapeHtml(t('ui.tools.call', '调用工具 · {name}', { name: displayName }))}</span>
        <span class="trng-badge" style="display:none"><i class="fa-solid fa-satellite-dish"></i> TRNG</span>
      </div>
      ${argsStr ? `<div class="tool-call-args">${escapeHtml(argsStr)}</div>` : ''}
      <div class="tool-call-result" style="display:none"></div>`;
    wireToolDisclosure(el);
    rememberInteractiveData(el, args);
    appendChatElement(el);
    // Ensure complete scroll to bottom
    scrollElementIntoView(el);
  }

  function updateToolCallResult(toolName, result, isError = false, callId = null) {
    let el = null;
    if (callId) {
      // 同一轮多个同名工具调用时，必须按 callId 精确匹配，
      // 否则多个结果会全部覆盖到最后一个卡片上。
      el = chatMessages.querySelector(`[data-tool-call-id="${cssEscape(callId)}"]`);
    }
    if (!el) {
      const els = chatMessages.querySelectorAll(`[data-tool-name="${toolName}"]`);
      el = els[els.length - 1];
    }
    if (!el) return;
    const isFailure = isError || result?.ok === false;
    markToolCard(el, isFailure);
    // Show TRNG badge if applicable
    if (result?.entropySource && result.entropySource.startsWith('TRNG')) {
      const badge = el.querySelector('.trng-badge');
      if (badge) badge.style.display = 'inline-flex';
    }
    const resultEl = el.querySelector('.tool-call-result');
    if (resultEl) {
      resultEl.style.display = 'block';
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      resultEl.textContent = text.substring(0, 500);
      if (isFailure) resultEl.classList.add('error');
    }
    // 增量推送：更新工具调用卡片的完整 outerHTML
    if (el.id) {
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + el.id, html: el.outerHTML });
    }
    renderInteractiveResult(el, result);
  }
