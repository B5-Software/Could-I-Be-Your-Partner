/* Verify native stacking, actual hover events, live contents and appearance. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function checkOverlay(renderer, service, preview, waitFor) {
  await renderer.executeJavaScript(`document.querySelector('.mode-btn[data-mode="code"]').click()`);
  await waitFor(
    () =>
      renderer.executeJavaScript(
        `window.getCurrentMode() === 'code' && !!document.querySelector('#code-session-tabs .session-tab')`,
      ),
    10000,
  );
  console.log('[codeoss-desktop] Testing host hover above native IDE.');
  const move = async (selector) => {
    const point = await renderer.executeJavaScript(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
    })()`);
    renderer.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) });
  };
  const shown = () => service.overlay.view?.getVisible();
  {
    await move('#code-session-tabs .session-tab');
    await waitFor(shown, 10000);
    const parent = service.getMainWindow();
    assert.equal(
      parent.contentView.children.at(-1),
      service.overlay.view,
      'card must be above the native IDE',
    );
    assert.equal(service.view.getVisible(), true, 'hover must preserve the live IDE');
    const source = await renderer.executeJavaScript(`(() => {
      const pop = document.getElementById('session-tab-popover');
      return {text: pop.innerText, width: pop.offsetWidth};
    })()`);
    const mirrored = await service.overlay.view.webContents.executeJavaScript(
      `({text: document.querySelector('.session-tab-popover').innerText, width: document.querySelector('.session-tab-popover').offsetWidth, bridge: typeof window.api, node: typeof process})`,
    );
    assert.equal(mirrored.text, source.text);
    assert.equal(mirrored.width, source.width);
    assert.equal(mirrored.bridge, 'undefined');
    assert.equal(mirrored.node, 'undefined');
    assert(
      service.overlay.view.getBounds().y >= service.view.getBounds().y,
      'overlay must not cover the hovered tab',
    );
    console.log('[codeoss-desktop] Native hover stacking and sandbox passed.');
    service.embeddedWindow.focus();
    service.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    service.view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitFor(() => !shown(), 5000);
    assert.equal(
      await renderer.executeJavaScript("document.body.classList.contains('codeoss-interacting')"),
      true,
      'IDE keyboard input must dismiss host hover cards',
    );
    await move('.mode-btn[data-mode="chat"]');
    await move('#code-session-tabs .session-tab');
    await waitFor(shown, 5000);
    for (const mode of ['dark', 'light']) {
      await renderer.executeJavaScript(`(async () => {
        const settings = await window.api.getSettings();
        const theme = {...settings.theme, mode: '${mode}', accentColor: '#916ad5', backgroundColor: '${mode === 'dark' ? '#202536' : '#faf7ed'}'};
        await window.api.setSettings({theme});
        ThemeManager.apply(theme);
      })()`);
      await waitFor(
        async () =>
          shown() &&
          (await service.overlay.view.webContents.executeJavaScript(
            'document.documentElement.dataset.theme',
          )) === mode,
        5000,
      );
      const colors = await service.overlay.view.webContents.executeJavaScript(
        `({accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), background: getComputedStyle(document.querySelector('.session-tab-popover')).backgroundColor})`,
      );
      const expected = await renderer.executeJavaScript(
        `({accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), background: getComputedStyle(document.getElementById('session-tab-popover')).backgroundColor})`,
      );
      assert.deepEqual(colors, expected, 'card must follow the host theme in real time');
      // Native setVisible and Chromium's visibility event are asynchronous.
      await waitFor(
        async () => !(await service.overlay.view.webContents.executeJavaScript('document.hidden')),
        5000,
      );
      fs.writeFileSync(
        path.join(preview, 'popover-' + mode + '.png'),
        (
          await service.overlay.view.webContents.capturePage(undefined, {
            stayHidden: true,
            stayAwake: true,
          })
        ).toPNG(),
      );
    }
    await renderer.executeJavaScript(
      `document.getElementById('stp-elapsed').textContent = '00:12:34'`,
    );
    await waitFor(
      () =>
        service.overlay.view.webContents.executeJavaScript(
          `document.getElementById('stp-elapsed').textContent === '00:12:34'`,
        ),
      2000,
    );
    await move('.mode-btn[data-mode="chat"]');
    await waitFor(() => !shown(), 5000);
    // Dismiss while an overlay paint is pending; it must not reappear later.
    await move('#code-session-tabs .session-tab');
    await renderer.executeJavaScript("window.navigatePage('settings')");
    await waitFor(() => !shown() && !service.visible, 5000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(shown(), false);
    await renderer.executeJavaScript("window.navigatePage('code')");
    await waitFor(() => service.visible, 10000);
    console.log(
      '[codeoss-desktop] Hover overlay stacking, live updates, theme and dismissal passed.',
    );
  }
};
