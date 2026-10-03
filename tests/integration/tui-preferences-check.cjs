/* SPDX-License-Identifier: GPL-3.0-or-later */
const assert = require('node:assert/strict');

module.exports = async function checkTuiPreferences(renderer) {
  const result = await renderer.executeJavaScript(`(async () => {
    const wait = async (check) => {
      for (let i = 0; i < 150; i++) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('TUI preferences did not update');
    };
    document.querySelector('.nav-item[data-page="settings"]').click();
    await wait(() => document.getElementById('setting-tui-follow-theme').dataset.bound);
    document.querySelector('.settings-tab[data-tab="tui"]').click();
    const panel = document.querySelector('.settings-panel[data-tab="tui"]');
    await wait(() => getComputedStyle(panel).display !== 'none');
    const inputs = [...panel.querySelectorAll('[data-tui-preference]')];
    for (const input of inputs) {
      input.checked = false;
      input.dispatchEvent(new Event('change', {bubbles:true}));
    }
    await wait(async () => {
      const settings = await window.api.getSettings();
      return settings.tui.followGuiTheme === false && settings.tui.thinkingExpanded === false;
    });
    const off = (await window.api.getSettings()).tui;
    for (const input of inputs) {
      input.checked = true;
      input.dispatchEvent(new Event('change', {bubbles:true}));
    }
    await wait(async () => {
      const settings = await window.api.getSettings();
      return settings.tui.followGuiTheme === true && settings.tui.thinkingExpanded === true;
    });
    return {count: inputs.length, off, on: (await window.api.getSettings()).tui};
  })()`);
  assert.equal(result.count, 2);
  assert.deepEqual(result.off, { followGuiTheme: false, thinkingExpanded: false });
  assert.deepEqual(result.on, { followGuiTheme: true, thinkingExpanded: true });
  console.log('[desktop-smoke] TUI preference category opens and saves both shared preferences.');
};
