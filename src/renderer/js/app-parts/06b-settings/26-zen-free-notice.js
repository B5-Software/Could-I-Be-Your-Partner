  async function updateZenFreeNotice() {
    const notice = document.getElementById('zen-free-notice');
    if (!notice) return;
    notice.classList.toggle('hidden', !['opencode-zen', 'opencode-go'].includes(document.getElementById('setting-llm-provider')?.value));
    const status = document.getElementById('zen-ua-status');
    const s = await readSettings();
    if (status) status.textContent = s.llm.autoOpencodeHeaders === false ? '自动配置已关闭，可在下方开启' : 'SessionID 与 OpenCode UA 已自动配置';
  }

  // LLM settings
  ['setting-llm-url', 'setting-llm-key', 'setting-llm-model', 'setting-llm-ctx', 'setting-llm-daily-limit', 'setting-llm-max-response'].forEach(id => {
    document.getElementById(id).addEventListener('change', async (e) => {
      const key = { 'setting-llm-url': 'apiUrl', 'setting-llm-key': 'apiKey', 'setting-llm-model': 'model', 'setting-llm-ctx': 'maxContextLength', 'setting-llm-daily-limit': 'dailyTokenLimit', 'setting-llm-max-response': 'maxResponseTokens' }[id];
      const val = (id === 'setting-llm-ctx' || id === 'setting-llm-daily-limit' || id === 'setting-llm-max-response') ? parseInt(e.target.value) : e.target.value;
      const s = await readSettings();
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
      if (key === 'dailyTokenLimit') {
        await saveSettings({ budget: { dailyTokenLimit: Number.isFinite(val) ? val : 0 } });
        return;
      }
      s.llm[key] = val;
      await saveSettings(s);
      if (key === 'model' || key === 'apiUrl') refreshReasoningVariants();
    });
  });
