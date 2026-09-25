  // ---- 步骤向导导航 ----
  const ONBOARDING_TOTAL_STEPS = 3;
  let currentOnboardingStep = 1;
  function showOnboardingStep(n) {
    if (n < 1) n = 1;
    if (n > ONBOARDING_TOTAL_STEPS) n = ONBOARDING_TOTAL_STEPS;
    currentOnboardingStep = n;
    // 切换步骤页面显示
    document.querySelectorAll('.ob-page').forEach(s => {
      if (parseInt(s.dataset.step) === n) s.classList.add('active');
      else s.classList.remove('active');
    });
    // 更新步骤指示器（active + done 状态）
    document.querySelectorAll('.ob-step-item').forEach(d => {
      const step = parseInt(d.dataset.step);
      d.classList.toggle('active', step === n);
      d.classList.toggle('done', step < n);
    });
    // 更新进度条
    const bar = document.getElementById('ob-progress-bar');
    if (bar) bar.style.width = `${((n - 1) / (ONBOARDING_TOTAL_STEPS - 1)) * 100}%`;
    // 更新步骤文本
    const text = document.getElementById('ob-step-text');
    if (text) text.textContent = `${n} / ${ONBOARDING_TOTAL_STEPS}`;
    // 上一步按钮：第一步隐藏
    const prevBtn = document.getElementById('ob-btn-prev');
    if (prevBtn) prevBtn.classList.toggle('hidden', n === 1);
    // 下一步 / 完成按钮：最后一步切换为"完成"
    const nextBtn = document.getElementById('ob-btn-next');
    const finishBtn = document.getElementById('ob-btn-finish');
    if (n === ONBOARDING_TOTAL_STEPS) {
      if (nextBtn) nextBtn.style.display = 'none';
      if (finishBtn) finishBtn.style.display = '';
    } else {
      if (nextBtn) {
        nextBtn.style.display = '';
        nextBtn.innerHTML = '下一步 <i class="fa-solid fa-arrow-right"></i>';
      }
      if (finishBtn) finishBtn.style.display = 'none';
    }
    // 推送 onboarding 步骤切换到 WebUI（整个模态框内容替换，确保所有子元素状态同步）
    const obModal = document.getElementById('onboarding-modal');
    if (obModal) {
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#onboarding-modal', html: obModal.innerHTML });
    }
  }
  // 下一步
  document.getElementById('ob-btn-next')?.addEventListener('click', () => {
    if (currentOnboardingStep < ONBOARDING_TOTAL_STEPS) showOnboardingStep(currentOnboardingStep + 1);
  });
  // 上一步
  document.getElementById('ob-btn-prev')?.addEventListener('click', () => {
    if (currentOnboardingStep > 1) showOnboardingStep(currentOnboardingStep - 1);
  });
  // 跳过引导：直接完成，标记 onboardingCompleted 并关闭
  document.getElementById('ob-btn-skip')?.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    s.onboardingCompleted = true;
    await window.api.setSettings(s);
    if (typeof agent.applySettings === 'function') agent.applySettings(s);
    else agent.settings = s;
    fadeOutHide(document.getElementById('onboarding-modal'));
  });
  function updateObProviderFields(provider) {
    const zenFields = document.getElementById('ob-zen-key-field');
    const openaiFields = document.getElementById('ob-openai-fields');
    const openaiKeyField = document.getElementById('ob-openai-key-field');
    if (provider === 'opencode-zen' || provider === 'opencode-go') {
      zenFields?.classList.remove('hidden');
      openaiFields?.classList.add('hidden');
      openaiKeyField?.classList.add('hidden');
    } else {
      zenFields?.classList.add('hidden');
      openaiFields?.classList.remove('hidden');
      openaiKeyField?.classList.remove('hidden');
    }
  }
  async function refreshObModels() {
    const provider = document.getElementById('ob-llm-provider')?.value || 'opencode-zen';
    const sel = document.getElementById('ob-llm-model');
    const hint = document.getElementById('ob-model-hint');
    if (!sel) return;
    sel.innerHTML = '<option value="">加载中...</option>';
    if (hint) hint.textContent = '正在获取模型列表...';
    try {
      if (provider === 'opencode-zen' || provider === 'opencode-go') {
        const isGo = provider === 'opencode-go';
        const res = await window.api.zenFetchModels(isGo ? 'go' : 'zen');
        if (!res?.ok || !Array.isArray(res.models)) {
          sel.innerHTML = '<option value="">(获取失败)</option>';
          if (hint) hint.textContent = res?.error || '获取失败';
          return;
        }
        const FREE = /free|big-pickle|mimo|north-mini|nemotron|hy3/;
        // Zen：public key 仅免费模型；Go：订阅制展示全部
        const isPub = !isGo && (document.getElementById('ob-llm-zen-key')?.value || '').trim() === 'public';
        let models = res.models.slice();
        if (isPub) models = models.filter(m => FREE.test(m.id));
        models.sort((a,b) => (a.id||'').localeCompare(b.id||''));
        sel.innerHTML = '';
        for (const m of models) {
          const opt = document.createElement('option');
          opt.value = m.id;
          const isFree = !isGo && FREE.test(m.id);
          opt.textContent = (isFree ? '[免费] ' : '') + (m.name || m.id);
          sel.appendChild(opt);
        }
        if (hint) hint.textContent = `共 ${models.length} 个可用模型`;
        updateObFreeNotice().catch(() => {});
      } else {
        const url = document.getElementById('ob-llm-url')?.value || '';
        const key = document.getElementById('ob-llm-key')?.value || '';
        if (!url || !key) {
          sel.innerHTML = '<option value="">请先填写 URL 和 Key</option>';
          if (hint) hint.textContent = '请先填写 API URL 和 Key';
          updateObFreeNotice().catch(() => {});
          return;
        }
        const res = await window.api.llmFetchModels(provider, url, key);
        if (!res?.ok || !Array.isArray(res.models)) {
          sel.innerHTML = '<option value="">(获取失败)</option>';
          if (hint) hint.textContent = res?.error || '获取失败';
          return;
        }
        sel.innerHTML = '';
        for (const m of res.models) {
          const opt = document.createElement('option');
          opt.value = m.id || m.name || '';
          opt.textContent = m.id || m.name || '';
          sel.appendChild(opt);
        }
        if (hint) hint.textContent = `共 ${res.models.length} 个可用模型`;
      }
    } catch (e) {
      sel.innerHTML = '<option value="">(获取失败)</option>';
      if (hint) hint.textContent = '错误: ' + (e?.message || e);
    }
  }
  function autoSelectDeepSeek() {
    const sel = document.getElementById('ob-llm-model');
    if (!sel) return;
    // 优先选含 deepseek 的模型
    for (const opt of sel.options) {
      if (/deepseek/i.test(opt.value)) { opt.selected = true; return; }
    }
    // 次选 free 模型
    for (const opt of sel.options) {
      if (/free|big-pickle/i.test(opt.value)) { opt.selected = true; return; }
    }
  }
