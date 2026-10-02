/* Native context menus belong to the visible host; menubar menus remain visible. */
const assert = require('node:assert/strict');
module.exports = async function checkMenus(service, waitFor) {
  const contents = service.view.webContents;
  await waitFor(() => service.visible);
  service.embeddedWindow.focus();
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (process.platform !== 'darwin') {
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Alt' });
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'f', modifiers: ['alt'] });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'f', modifiers: ['alt'] });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Alt' });
    await waitFor(
      () =>
        contents.executeJavaScript(
          `!![...document.querySelectorAll('.monaco-menu-container, .menubar-menu-items-holder')].find(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')`,
        ),
      5000,
    );
    const menu = await contents.executeJavaScript(`(() => {
      const element = [...document.querySelectorAll('.monaco-menu-container, .menubar-menu-items-holder')].find(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + 12, rect.top + 12);
      return {text: element.innerText, topmost: element.contains(hit), width: rect.width, height: rect.height};
    })()`);
    assert(menu.width > 80 && menu.height > 100);
    assert(menu.topmost, 'Alt+F menu must be above the workbench content');
    assert.match(menu.text, /New|Open|新建|打开/);
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  }
  const original = service.popupMenu;
  let popup;
  service.popupMenu = function (nativeMenu, sender, options) {
    const popupOriginal = nativeMenu.popup;
    nativeMenu.popup = function (actual) {
      popup = { actual, options, sender };
      nativeMenu.once('menu-will-show', () =>
        setTimeout(() => nativeMenu.closePopup(actual.window), 100),
      );
      return popupOriginal.call(nativeMenu, actual);
    };
    return original.call(this, nativeMenu, sender, options);
  };
  try {
    const point = await contents.executeJavaScript(`(() => {
      const element = document.querySelector('.monaco-editor .view-lines') || document.querySelector('.explorer-viewlet');
      const rect = element.getBoundingClientRect();
      return {x: Math.round(rect.left + 25), y: Math.round(rect.top + 20)};
    })()`);
    contents.sendInputEvent({ type: 'mouseDown', button: 'right', ...point, clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', button: 'right', ...point, clickCount: 1 });
    // Custom titlebars use a DOM context menu on Windows/Linux. Exercise the
    // native menu IPC separately, including the real upstream patched handler.
    if (process.platform !== 'darwin') {
      await waitFor(() =>
        contents.executeJavaScript(`!!document.querySelector('.monaco-menu-container')`),
      );
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await contents.executeJavaScript(
        `window.vscode.ipcRenderer.send('vscode:contextmenu', 19027, [{id:0, label:'Native menu fixture', enabled:true}], 'vscode:fixture-action', ${JSON.stringify(point)})`,
      );
    }
    await waitFor(() => popup, 5000);
    assert.equal(popup.actual.window, service.getMainWindow());
    assert.equal(popup.sender, contents);
    assert.equal(popup.actual.x, service.view.getBounds().x + popup.options.x);
    assert.equal(popup.actual.y, service.view.getBounds().y + popup.options.y);
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    service.popupMenu = original;
  }
  console.log('[codeoss-desktop] Alt+F menu and native right-click ownership/coordinates passed.');
};
