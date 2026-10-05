  let currentOnboardingStep = 1;
  const ONBOARDING_TOTAL_STEPS = 3;
  let obModels = [];
  let obModelsGeneration = 0;
  let obPreferredModel = '';
  let obSaving = false;

  document.getElementById('onboarding-modal')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const nodes = [...event.currentTarget.querySelectorAll('button, a, input, textarea, select, summary')]
      .filter((node) => !node.disabled && node.getClientRects().length && node.tabIndex >= 0);
    const first = nodes[0], last = nodes.at(-1);
    if (!first) return;
    if (event.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !nodes.includes(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  });

  function showOnboardingStep(step) {
    currentOnboardingStep = Math.max(1, Math.min(ONBOARDING_TOTAL_STEPS, step));
    const modal = document.getElementById('onboarding-modal');
    modal?.querySelectorAll('.ob-page').forEach((page) => page.classList.toggle('active', Number(page.dataset.step) === currentOnboardingStep));
    modal?.querySelectorAll('.ob-step-item').forEach((item) => {
      item.classList.toggle('active', Number(item.dataset.step) === currentOnboardingStep);
      item.classList.toggle('done', Number(item.dataset.step) < currentOnboardingStep);
      if (Number(item.dataset.step) === currentOnboardingStep) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    document.getElementById('ob-progress-bar').style.width = (currentOnboardingStep / 3 * 100) + '%';
    document.getElementById('ob-step-text').textContent = '0' + currentOnboardingStep + ' / 03';
    document.getElementById('ob-btn-prev').hidden = currentOnboardingStep === 1;
    document.getElementById('ob-btn-next').style.display = currentOnboardingStep === 3 ? 'none' : '';
    document.getElementById('ob-btn-finish').style.display = currentOnboardingStep === 3 ? '' : 'none';
    const content = modal?.querySelector('.ob-content');
    if (content) content.scrollTop = 0;
    modal?.querySelector('.ob-page.active .ob-page-title')?.focus({ preventScroll: true });
  }
  document.getElementById('ob-btn-next')?.addEventListener('click', () => showOnboardingStep(currentOnboardingStep + 1));
  document.getElementById('ob-btn-prev')?.addEventListener('click', () => showOnboardingStep(currentOnboardingStep - 1));
  document.querySelectorAll('#onboarding-modal .ob-step-item').forEach((item) => item.addEventListener('click', () => showOnboardingStep(Number(item.dataset.step))));
  document.getElementById('ob-btn-skip')?.addEventListener('click', async () => {
    if (obSaving) return;
    obSaving = true;
    try {
      await window.api.setSettings({ onboardingCompleted: true });
      agent.settings.onboardingCompleted = true;
      fadeOutHide(document.getElementById('onboarding-modal'));
    } catch (error) { window.showToast('保存失败：' + error.message, 'error'); }
    finally { obSaving = false; }
  });

  function updateObProviderFields(provider) {
    const zen = provider === 'opencode-zen' || provider === 'opencode-go';
    const chatgpt = provider === 'chatgpt-codex';
    document.getElementById('ob-chatgpt-field')?.classList.toggle('hidden', !chatgpt);
    document.getElementById('ob-zen-key-field')?.classList.toggle('hidden', !zen);
    document.getElementById('ob-openai-fields')?.classList.toggle('hidden', zen || chatgpt);
    document.getElementById('ob-openai-key-field')?.classList.toggle('hidden', zen || chatgpt);
    document.getElementById('ob-free-filter-field')?.classList.toggle('hidden', provider !== 'opencode-zen');
    document.getElementById('ob-free-notice')?.classList.toggle('hidden', !zen);
  }

  function obConfig() {
    const value = (id) => document.getElementById(id).value.trim();
    const provider = value('ob-llm-provider');
    const zen = provider === 'opencode-zen' || provider === 'opencode-go';
    const key = zen ? value('ob-llm-zen-key') || 'public' : value('ob-llm-key');
    return { provider, model: value('ob-llm-model'), apiKey: key, zenApiKey: key, autoOpencodeHeaders: true,
      apiUrl: provider === 'chatgpt-codex' ? 'https://api.openai.com/v1/responses' : zen ? 'https://opencode.ai/zen/' + (provider === 'opencode-go' ? 'go/' : '') + 'v1/chat/completions' : value('ob-llm-url') };
  }

  function renderObModels(preferred = '') {
    const select = document.getElementById('ob-llm-model');
    const freeOnly = document.getElementById('ob-free-only').checked && document.getElementById('ob-llm-provider').value === 'opencode-zen';
    const models = obModels.filter((model) => !freeOnly || model.free);
    const options = models.map((model) => new Option((model.free ? '免费 · ' : '') + (model.name || model.id), model.id));
    select.replaceChildren(...(options.length ? options : [new Option(freeOnly ? '暂无免费模型，可关闭筛选' : '未发现模型，可手动输入 ID', '')]));
    const chosen = models.find((model) => model.id === preferred) || models.find((model) => model.verified) || models.find((model) => model.id === 'big-pickle') || models.find((model) => model.free) || models[0];
    select.value = chosen?.id || '';
    select.disabled = !models.length;
    document.getElementById('ob-model-hint').textContent = `识别到 ${obModels.length} 个模型 · ${obModels.filter((model) => model.free).length} 个免费模型`;
    updateObFreeNotice();
  }

  async function refreshObModels() {
    const generation = ++obModelsGeneration;
    const provider = document.getElementById('ob-llm-provider').value;
    const config = obConfig();
    const previous = obPreferredModel || config.model;
    const hint = document.getElementById('ob-model-hint');
    const select = document.getElementById('ob-llm-model');
    const refresh = document.getElementById('ob-btn-refresh-models');
    refresh.disabled = true;
    select.disabled = true;
    document.getElementById('ob-btn-finish').disabled = true;
    hint.textContent = '正在识别可用模型…';
    document.getElementById('ob-connection-status').textContent = '';
    try {
      if (provider !== 'chatgpt-codex' && !provider.startsWith('opencode') && !config.apiUrl) throw new Error('填写 API 地址后会自动识别模型');
      const response = provider.startsWith('opencode')
        ? await window.api.zenFetchModels(provider === 'opencode-go' ? 'go' : 'zen', { apiKey: config.apiKey, verifyFree: true })
        : await window.api.llmFetchModels(provider, config.apiUrl, config.apiKey);
      if (generation !== obModelsGeneration) return;
      if (!response?.ok || !Array.isArray(response.models)) throw new Error(response?.error || '模型列表格式无效');
      obModels = response.models;
      renderObModels(previous);
      obPreferredModel = '';
    } catch (error) {
      if (generation !== obModelsGeneration) return;
      obModels = [];
      select.replaceChildren(new Option('自动识别暂不可用', ''));
      hint.textContent = error.message + '；可重试或手动输入模型 ID。';
      document.getElementById('ob-model-manual').open = true;
    } finally { if (generation === obModelsGeneration) { refresh.disabled = false; document.getElementById('ob-btn-finish').disabled = obSaving; } }
  }
