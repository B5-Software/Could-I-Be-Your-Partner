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
      if (field(id).type === 'checkbox') field(id).checked = !!value;
      else field(id).value = value;
      field(id).dispatchEvent(new Event('change', { bubbles: true }));
    };
    await window.navigatePage('settings');
    await until(() => field('settings-overview-cards').children.length === 6, 'overview did not load');
    check(!document.querySelector('#page-settings .page-dismiss'), 'settings has a redundant close button');
    const invalidDefaults = [...document.querySelectorAll('#page-settings input[type="number"]')]
      .filter(input => input.value !== '' && !input.disabled && !input.checkValidity()).map(input => input.id);
    check(!invalidDefaults.length, 'invalid default settings: ' + invalidDefaults.join(', '));
    const allTabs = [...document.querySelectorAll('.settings-tab')];
    check(allTabs.length === 36, 'settings category missing: ' + allTabs.length);
    let visited = 0, labelled = 0, spaced = 0;
    for (const tab of allTabs.filter(tab => !tab.hidden && tab.style.display !== 'none')) {
      check(window.activateSettingsTab(tab.dataset.tab), 'cannot open ' + tab.dataset.tab);
      const panel = document.querySelector('.settings-panel.active');
      const advanced = [...panel.querySelectorAll('.settings-advanced')].map(details => [details, details.open]);
      advanced.forEach(([details]) => details.open = true);
      check(panel?.dataset.tab === tab.dataset.tab && !panel.inert, 'wrong active panel');
      check(panel.parentElement.classList.contains('settings-panels'), 'nested settings category: ' + tab.dataset.tab);
      check(panel.getBoundingClientRect().width > 0 && panel.getBoundingClientRect().height > 0, 'blank settings category: ' + tab.dataset.tab);
      check(getComputedStyle(panel).overflowY === 'auto', 'category has no independent scroller: ' + tab.dataset.tab);
      check(panel.scrollTop === 0, 'category retained scroll: ' + tab.dataset.tab);
      check(panel.clientHeight <= panel.parentElement.clientHeight, 'category scroller exceeds its viewport: ' + tab.dataset.tab);
      check([...panel.querySelectorAll('.settings-group')].some(group => group.getBoundingClientRect().height > 0) || tab.dataset.tab === 'overview', 'category cards are hidden: ' + tab.dataset.tab);
      for (const parent of [panel, ...panel.querySelectorAll('div, details')]) {
        const cards = [...parent.children].filter(child => child.matches('.settings-group, .settings-advanced, .llm-pool-card, .res-model-card, .mcp-server-card, .plugin-card, .tool-auth-item') && child.getBoundingClientRect().height > 0);
        for (let index = 1; index < cards.length; index++) {
          const gap = cards[index].getBoundingClientRect().top - cards[index - 1].getBoundingClientRect().bottom;
          check(gap >= 11, 'settings cards touch in ' + tab.dataset.tab + ': ' + gap);
          spaced++;
        }
      }
      check(document.querySelectorAll('.settings-panel.active').length === 1, 'multiple active panels');
      check(tab.getAttribute('aria-selected') === 'true', 'tab selection not accessible');
      check([...document.querySelectorAll('.settings-panel:not(.active)')].every(p => p.inert), 'hidden panels are focusable');
      check(panel.querySelector('.settings-section-intro') || tab.dataset.tab === 'overview', 'category has no guidance');
      for (const control of panel.querySelectorAll('input[id], select[id], textarea[id]')) {
        if (control.type === 'hidden' || control.type === 'file') continue;
        check(control.labels?.length || control.getAttribute('aria-label'), 'control has no accessible label: ' + control.id);
        labelled++;
      }
      advanced.forEach(([details, open]) => details.open = open);
      visited++;
    }
    window.activateSettingsTab('overview');
    window.activateSettingsTab('theme');
    check(field('setting-focus-outlines').checked, 'focus outlines must default to enabled');
    field('setting-focus-outlines').checked = false;
    field('setting-focus-outlines').dispatchEvent(new Event('change', { bubbles: true }));
    await until(async () => (await window.api.getSettings()).theme.focusOutlines === false && document.documentElement.dataset.focusOutlines === 'off', 'focus preference not saved/applied');
    const focusButton = document.querySelector('.theme-mode-btn');
    focusButton.focus();
    check(getComputedStyle(focusButton).outlineStyle === 'none', 'disabled focus outline is still painted');
    field('setting-focus-outlines').checked = true;
    field('setting-focus-outlines').dispatchEvent(new Event('change', { bubbles: true }));
    await until(async () => (await window.api.getSettings()).theme.focusOutlines === true && document.documentElement.dataset.focusOutlines === 'on', 'focus outlines did not re-enable');
    focusButton.focus();
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const accentRGB = 'rgb(' + [1,3,5].map(offset => parseInt(accent.slice(offset,offset+2),16)).join(', ') + ')';
    check(getComputedStyle(focusButton).outlineColor === accentRGB, 'focus accent mismatch');
    await window.navigatePage('chat');
    field('chat-input').focus();
    check(getComputedStyle(field('chat-input')).outlineStyle === 'none', 'chat input has an inner outline');
    await until(() => getComputedStyle(field('chat-input').closest('.input-wrapper')).borderColor === accentRGB, 'chat focus belongs on the outside wrapper');
    await window.navigatePage('settings');
    window.activateSettingsTab('overview');
    const first = allTabs.find(tab => tab.dataset.tab === 'overview');
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    check(document.activeElement.classList.contains('settings-tab') && document.activeElement !== first, 'keyboard navigation failed');

    window.activateSettingsTab('context');
    const contextPanel = field('setting-llm-ctx').closest('.settings-panel');
    contextPanel.scrollTop = 140;
    check(contextPanel.scrollTop > 0, 'long category cannot scroll');
    const shared = contextPanel.parentElement;
    check(getComputedStyle(shared).overflowY === 'hidden' && shared.scrollTop === 0, 'categories share an outer scroller');
    check(document.getElementById('page-settings').scrollTop === 0, 'settings page steals category scrolling');
    window.activateSettingsTab('security');
    const securityPanel = document.querySelector('.settings-panel.active');
    check(securityPanel.scrollTop === 0, 'security inherited the previous category position');
    securityPanel.scrollTop = 140;
    check(securityPanel.scrollTop > 0, 'security content cannot scroll independently');
    window.activateSettingsTab('context');
    check(contextPanel.scrollTop === 0, 'reopening a category did not reset scrolling');
    contextPanel.scrollTop = 140;
    window.navigatePage('about');
    window.navigatePage('settings');
    check(contextPanel.scrollTop === 0, 'reopening settings retained category scrolling');
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
    const summary = [...field('settings-search-results').querySelectorAll('button')].find(button => button.textContent.includes('单次压缩摘要上限'));
    check(summary, 'advanced summary setting not searchable');
    summary.click();
    check(field('setting-context-max-tokens').closest('details').open, 'search did not expand advanced settings');
    check(document.querySelector('.settings-search-match'), 'search target not highlighted');
    field('setting-llm-key').value = 'secret-probe-do-not-index';
    search.value = 'secret-probe-do-not-index'; search.dispatchEvent(new Event('input', { bubbles: true }));
    check(!field('settings-search-results').querySelector('button'), 'search indexed a credential');
    search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));

    window.activateSettingsTab('webcontrol');
    field('btn-tor-meek').click();
    await until(async () => {
      const tor = (await window.api.getSettings()).remote?.tor;
      return tor?.useBridges && tor.bridges.startsWith('meek_lite ') && !field('btn-tor-meek').disabled;
    }, 'built-in meek bridge was not applied');
    check(field('setting-tor-bridges-enabled').checked && field('setting-tor-bridges').value.includes('utls=HelloRandomizedALPN'), 'meek fronting parameters missing from the form');
    change('setting-tor-bridges-enabled', false);
    await until(async () => !(await window.api.getSettings()).remote.tor.useBridges, 'bridge toggle was not saved');

    for (let i = 0; i < 3; i++) window.activateSettingsTab('budget');
    await pause(); await pause();
    check(field('setting-llm-daily-limit').closest('.settings-panel').dataset.tab === 'budget', 'daily Token limit still split across panels');
    check(field('setting-img-daily-limit').closest('.settings-panel').dataset.tab === 'budget', 'image limit still split across panels');
    check(field('setting-decision-limit').closest('.settings-panel').dataset.tab === 'budget', 'System One daily limit still split across panels');
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
    return { categories: allTabs.length, visible: visited, cardGaps: spaced, labelled, scrolling: 'independent categories, reset on every switch', search: 'advanced and credential-safe', persistence: 'Token, weekly, timezone, zero retries and price deletion' };
  })()`);
};
