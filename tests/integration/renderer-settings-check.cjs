/* Real settings navigation, search, validation, persistence and model allocation. */
module.exports = async function checkSettings(webContents) {
  return webContents.executeJavaScript(`(async () => {
    const check = (value, message) => { if (!value) throw new Error(message); };
    const pause = () => new Promise(resolve => setTimeout(resolve, 30));
    async function until(predicate, label) {
      const deadline = Date.now() + 4000;
      while (!(await predicate()) && Date.now() < deadline) await pause();
      check(await predicate(), label);
    }
    const field = id => document.getElementById(id);
    const change = (id, value) => {
      field(id).value = value;
      field(id).dispatchEvent(new Event('change', { bubbles: true }));
    };
    await window.navigatePage('settings');
    await until(() => field('settings-overview-cards').children.length === 6, 'overview did not load');
    const dismiss = document.querySelector('#page-settings .page-dismiss');
    check(getComputedStyle(dismiss).position === 'absolute', 'return button is stretched into the settings layout');
    const invalidDefaults = [...document.querySelectorAll('#page-settings input[type="number"]')]
      .filter(input => input.value !== '' && !input.disabled && !input.checkValidity()).map(input => input.id);
    check(!invalidDefaults.length, 'invalid default settings: ' + invalidDefaults.join(', '));
    const allTabs = [...document.querySelectorAll('.settings-tab')];
    check(allTabs.length === 35, 'settings category missing');
    let visited = 0, labelled = 0;
    for (const tab of allTabs.filter(tab => !tab.hidden && tab.style.display !== 'none')) {
      check(window.activateSettingsTab(tab.dataset.tab), 'cannot open ' + tab.dataset.tab);
      const panel = document.querySelector('.settings-panel.active');
      check(panel?.dataset.tab === tab.dataset.tab && !panel.inert, 'wrong active panel');
      check(document.querySelectorAll('.settings-panel.active').length === 1, 'multiple active panels');
      check(tab.getAttribute('aria-selected') === 'true', 'tab selection not accessible');
      check([...document.querySelectorAll('.settings-panel:not(.active)')].every(p => p.inert), 'hidden panels are focusable');
      check(panel.querySelector('.settings-section-intro') || tab.dataset.tab === 'overview', 'category has no guidance');
      for (const control of panel.querySelectorAll('input[id], select[id], textarea[id]')) {
        if (control.type === 'hidden' || control.type === 'file') continue;
        check(control.labels?.length || control.getAttribute('aria-label'), 'control has no accessible label: ' + control.id);
        labelled++;
      }
      visited++;
    }
    window.activateSettingsTab('overview');
    const first = allTabs.find(tab => tab.dataset.tab === 'overview');
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    check(document.activeElement.classList.contains('settings-tab') && document.activeElement !== first, 'keyboard navigation failed');

    window.activateSettingsTab('context');
    check(field('setting-llm-ctx').closest('.settings-panel').dataset.tab === 'context', 'capacity is not in context');
    change('setting-llm-max-response', '4096');
    change('tool-schema-budget', '2000');
    await until(async () => { const s = await window.api.getSettings(); return s.llm.maxResponseTokens === 4096 && s.toolExposure.budgetTokens === 2000; }, 'concurrent Token edits lost');
    change('setting-context-retries', '0');
    await until(async () => (await window.api.getSettings()).contextCompaction.compactionRetries === 0, 'zero retries not saved');
    change('setting-llm-max-response', '-1');
    await pause();
    check(field('setting-llm-max-response').getAttribute('aria-invalid') === 'true', 'invalid value not marked');
    check((await window.api.getSettings()).llm.maxResponseTokens === 4096, 'invalid output was persisted');
    change('setting-llm-max-response', '4096');
    await until(() => field('settings-save-status').dataset.state === 'saved', 'save confirmation missing');

    const search = field('settings-search-input');
    search.value = '摘要'; search.dispatchEvent(new Event('input', { bubbles: true }));
    const summary = [...field('settings-search-results').querySelectorAll('button')].find(button => button.textContent.includes('摘要'));
    check(summary, 'advanced summary setting not searchable');
    summary.click();
    check(field('setting-context-max-tokens').closest('details').open, 'search did not expand advanced settings');
    check(document.querySelector('.settings-search-match'), 'search target not highlighted');
    field('setting-llm-key').value = 'secret-probe-do-not-index';
    search.value = 'secret-probe-do-not-index'; search.dispatchEvent(new Event('input', { bubbles: true }));
    check(!field('settings-search-results').querySelector('button'), 'search indexed a credential');
    search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));

    for (let i = 0; i < 3; i++) window.activateSettingsTab('budget');
    await pause(); await pause();
    check(field('setting-llm-daily-limit').closest('.settings-panel').dataset.tab === 'budget', 'daily Token limit still split across panels');
    check(field('setting-img-daily-limit').closest('.settings-panel').dataset.tab === 'budget', 'image limit still split across panels');
    check(field('setting-decision-limit').closest('.settings-panel').dataset.tab === 'budget', 'Jev daily limit still split across panels');
    check(![...field('setting-budget-action').options].some(option => option.value === 'fallback'), 'unimplemented fallback action exposed');
    change('setting-llm-daily-limit', '1200');
    change('setting-decision-limit', '25');
    change('setting-budget-weekly-cap', '12.5');
    change('setting-budget-timezone', 'UTC');
    change('setting-budget-week-mode', 'rolling');
    change('setting-budget-peak-input-mul', '0');
    await until(async () => { const s = await window.api.getSettings(); return s.budget.dailyTokenLimit === 1200 && s.decision.dailyMaxCalls === 25 && s.budget.peakHours.inputMul === 0 && s.budget.weeklyLimitUSD === 12.5 && s.budget.timezone === 'UTC' && s.budget.weekMode === 'rolling'; }, 'budget fields did not save');
    check(!('dailyMaxTokens' in (await window.api.getSettings()).llm), 'legacy daily limit survived migration');
    const pricing = field('budget-pricing-list');
    const row = pricing.firstElementChild;
    row.querySelector('.budget-model-id').value = 'test-model-price';
    row.querySelector('.budget-input-perm').value = '1';
    row.querySelector('.budget-input-perm').dispatchEvent(new Event('change', { bubbles: true }));
    await until(async () => !!(await window.api.getSettings()).budget.models['test-model-price'], 'price row did not save');
    row.querySelector('button').click();
    await until(async () => !('test-model-price' in (await window.api.getSettings()).budget.models), 'deleted price persisted in backend');
    const probe = new Agent();
    probe.settings = await window.api.getSettings();
    probe.settings.llm.pool = [{ id: 'large', model: 'large', contextLength: 131072 }, { id: 'small', model: 'small', contextLength: 8192 }];
    probe.llmOverride = { poolEntryId: 'small', model: 'small' };
    const limits = probe.syncTokenLimits();
    check(limits.contextTokens === 8192 && probe.contextManager.maxTokens === 8192, 'session model uses global capacity');
    check(probe._llmOptions().contextLength === 8192 && probe._llmOptions().poolEntryId === 'small', 'request lost model allocation');
    window.activateSettingsTab('overview');
    return { categories: allTabs.length, visited, labelled, search: 'advanced and credential-safe', persistence: 'Token, weekly, timezone, zero retries and price deletion' };
  })()`);
};
