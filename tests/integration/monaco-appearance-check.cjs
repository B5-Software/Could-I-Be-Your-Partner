/* Real editor pages and Monaco's parsed selection colors, including live updates. */
const assert = require('node:assert/strict');
module.exports = async function checkEditors(renderer, BrowserWindow) {
  const waitFor = async (check) => {
    for (let i = 0; i < 150; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error('Monaco editor did not initialize');
  };
  const windows = [];
  for (const [api, page] of [
    ['openSkillEditor', 'skill-editor.html'],
    ['openAutomationEditor', 'automation-editor.html'],
  ]) {
    await renderer.executeJavaScript(`window.api.${api}()`);
    let window;
    await waitFor(() => {
      window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(page));
      return window;
    });
    await waitFor(() =>
      window.webContents.executeJavaScript(`!!window.monaco?.editor.getEditors().length`),
    );
    windows.push(window);
    await window.webContents.executeJavaScript(
      `(() => { const e=monaco.editor.getEditors()[0];e.getModel().setValue('selection fixture');e.setSelection(new monaco.Range(1,1,1,10));e.focus();e.layout();})()`,
    );
  }
  for (const mode of ['light', 'dark']) {
    const accent = mode === 'light' ? '#725ce7' : '#e3a3d4';
    await renderer.executeJavaScript(
      `window.api.setSettings({theme:{mode:${JSON.stringify(mode)},accentColor:${JSON.stringify(accent)}}})`,
    );
    for (const window of windows) {
      let color;
      await waitFor(async () => {
        color = await window.webContents.executeJavaScript(
          `(() => {const e=monaco.editor.getEditors()[0];e.focus();const selection=e.getDomNode().querySelector('.selected-text');return selection && getComputedStyle(selection).backgroundColor;})()`,
        );
        const channels = color?.match(/[\d.]+/g)?.map(Number);
        return (
          channels &&
          channels[0] === parseInt(accent.slice(1, 3), 16) &&
          channels[1] === parseInt(accent.slice(3, 5), 16) &&
          channels[2] === parseInt(accent.slice(5, 7), 16)
        );
      });
      assert(
        !color.startsWith('rgb(255, 0, 0'),
        'Monaco must never fall back to an invalid-color red selection',
      );
      const alpha = Number(color.match(/[\d.]+/g)[3]);
      assert(alpha > 0 && alpha <= 0.31, 'Selections use a soft translucent accent');
    }
  }
  for (const focusOutlines of [false, true]) {
    await renderer.executeJavaScript(
      `window.api.setSettings({theme:{focusOutlines:${focusOutlines}}})`,
    );
    for (const window of windows)
      await waitFor(() =>
        window.webContents.executeJavaScript(
          `document.documentElement.dataset.focusOutlines === '${focusOutlines ? 'on' : 'off'}'`,
        ),
      );
  }
  for (const window of windows) window.destroy();
  console.log(
    '[desktop-smoke] Skill and Automation: real Monaco selections follow light/dark/accent changes.',
  );
};
