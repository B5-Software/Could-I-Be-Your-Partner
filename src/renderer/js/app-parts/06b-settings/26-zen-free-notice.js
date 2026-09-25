  // ---- 免费模型官方方案警示（不自动伪装 UA，由用户决定并自行承担风险）----
  // 官方将限时免费模型容量保留给官方客户端（User-Agent: opencode/* 门控）；
  // 本应用不代填 UA，仅在用户选中免费模型时展示说明，由用户主动添加。
  const ZEN_FREE_MODEL_RE = /-free$|big-pickle|north-mini|nemotron|hy3/;
  const OPENCODE_UA_FALLBACK = '1.18.31';

  function isOpenCodeUaHeader(name) {
    return String(name || '').trim().toLowerCase() === 'user-agent';
  }

  function findOpenCodeUaHeader(list) {
    for (const item of (list || [])) {
      if (isOpenCodeUaHeader(item?.name)) return item;
    }
    return null;
  }

  function opencodeUaVersionFromSettings(s) {
    const v = s?.llm?.opencodeVersion;
    return (v && typeof v.version === 'string' && v.version.trim()) ? v.version.trim() : OPENCODE_UA_FALLBACK;
  }

  async function updateZenFreeNotice() {
    const notice = document.getElementById('zen-free-notice');
    if (!notice) return;
    const provider = document.getElementById('setting-llm-provider')?.value || 'openai-compat';
    const key = (document.getElementById('setting-llm-zen-key')?.value || '').trim();
    const modelSel = document.getElementById('setting-llm-zen-model');
    let model = modelSel?.value || '';
    if (!model) {
      const s = await window.api.getSettings();
      model = s?.llm?.model || '';
    }
    const isFree = provider === 'opencode-zen' && (key === 'public' || ZEN_FREE_MODEL_RE.test(model));
    notice.classList.toggle('hidden', !isFree);
    if (!isFree) return;
    // 已添加官方 UA 时给出状态提示
    const s = await window.api.getSettings();
    const ua = findOpenCodeUaHeader(s?.llm?.customHeaders);
    const status = document.getElementById('zen-ua-status');
    if (status) status.textContent = ua ? `已添加: User-Agent: ${ua.value || '(空)'}` : '';
  }

  // 按钮把官方 UA 写入自定义请求头（用户主动点击 = 用户自己的决定）
  const zenAddUaBtn = document.getElementById('btn-zen-add-ua');
  if (zenAddUaBtn) {
    zenAddUaBtn.addEventListener('click', async () => {
      const s = await window.api.getSettings();
      s.llm.customHeaders = Array.isArray(s.llm.customHeaders) ? s.llm.customHeaders : [];
      const version = opencodeUaVersionFromSettings(s);
      const existing = findOpenCodeUaHeader(s.llm.customHeaders);
      if (existing) {
        existing.value = `opencode/${version}`;
        existing.enabled = true;
      } else {
        s.llm.customHeaders.push({ name: 'User-Agent', value: `opencode/${version}` });
      }
      await saveSettings(s);
      if (llmHeaderEditor) llmHeaderEditor.render(s.llm.customHeaders);
      await updateZenFreeNotice();
      window.showToast(`已添加 User-Agent: opencode/${version}（风险自负，可随时在自定义请求头中删除）`, 'success');
    });
  }

  // LLM settings
  ['setting-llm-url', 'setting-llm-key', 'setting-llm-model', 'setting-llm-ctx', 'setting-llm-daily-limit', 'setting-llm-max-response'].forEach(id => {
    document.getElementById(id).addEventListener('change', async (e) => {
      const key = { 'setting-llm-url': 'apiUrl', 'setting-llm-key': 'apiKey', 'setting-llm-model': 'model', 'setting-llm-ctx': 'maxContextLength', 'setting-llm-daily-limit': 'dailyMaxTokens', 'setting-llm-max-response': 'maxResponseTokens' }[id];
      const val = (id === 'setting-llm-ctx' || id === 'setting-llm-daily-limit' || id === 'setting-llm-max-response') ? parseInt(e.target.value) : e.target.value;
      const s = await window.api.getSettings();
      if (key === 'maxContextLength') {
        // 模型上下文长度：用户填写了就按填写的值，不再自动拉取覆盖；
        // 清空则取消显式标记，允许下一次自动获取（只有没填时才拉）。
        if (Number.isFinite(val) && val > 0) {
          s.llm.maxContextLength = val;
          s.llm.maxContextLengthExplicit = true;
          const pool = Array.isArray(s.llm.pool) ? s.llm.pool : [];
          const active = pool.find(en => en && en.id === s.llm.activeEntryId) || pool[0];
          if (active) active.contextLength = val;
          await saveSettings(s);
          agent.contextManager.setMaxTokens(val);
        } else {
          s.llm.maxContextLengthExplicit = false;
          await saveSettings(s);
          refreshReasoningVariants();
        }
        return;
      }
      s.llm[key] = val;
      await saveSettings(s);
      if (key === 'model' || key === 'apiUrl') refreshReasoningVariants();
    });
  });
