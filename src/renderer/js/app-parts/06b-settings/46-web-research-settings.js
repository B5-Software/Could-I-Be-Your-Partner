/* SPDX-License-Identifier: GPL-3.0-or-later */
function loadWebResearchSettings(settings) {
  const root = document.getElementById('web-research-settings');
  if (!root) return;
  const config = settings.webResearch || {};
  const engine = root.querySelector('[data-search-engine]');
  engine.value = config.engine || 'fusion';
  if (!engine.dataset.bound) {
    engine.dataset.bound = '1';
    engine.addEventListener('change', () => saveSettings({ webResearch: { engine: engine.value } }));
  }
  root.querySelectorAll('[data-provider-slot]').forEach(row => {
    const slot = row.dataset.providerSlot, defaults = slot === 'bing' ? 'bing' : 'mcp';
    row.querySelectorAll('[data-search-field]').forEach(input => {
      const field = input.dataset.searchField;
      input.value = config.providers?.[slot]?.[field] || (field === 'provider' ? defaults : '');
      if (input.dataset.bound) return;
      input.dataset.bound = '1';
      input.addEventListener('change', () => saveSettings({ webResearch: { providers: { [slot]: { [field]: input.value.trim() } } } }));
    });
  });
}
