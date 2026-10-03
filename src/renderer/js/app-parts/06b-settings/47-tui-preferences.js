/* SPDX-License-Identifier: GPL-3.0-or-later */
function loadTuiPreferences(settings) {
  document.querySelectorAll('[data-tui-preference]').forEach(input => {
    const field = input.dataset.tuiPreference;
    input.checked = settings.tui?.[field] !== false;
    if (input.dataset.bound) return;
    input.dataset.bound = '1';
    input.addEventListener('change', () => saveSettings({ tui: { [field]: input.checked } }));
  });
}
