/* SPDX-License-Identifier: GPL-3.0-or-later */
const fs = require('node:fs');
const { startDesktopHost } = require('../../src/tui/vm-desktop-entry');
startDesktopHost({
  onWindow(win) {
    process.on('message', async (message) => {
      if (message?.type !== 'fixture') return;
      try {
        let result;
        if (message.command === 'snapshot') {
          result = {
            visible: win.isVisible(),
            title: win.getTitle(),
            page: await win.webContents.executeJavaScript(
              `({ status: document.getElementById('status').textContent, connected: document.getElementById('status').classList.contains('ok'), accent: getComputedStyle(document.documentElement).getPropertyValue('--vm-accent'), canvas: !!document.querySelector('canvas') })`,
            ),
          };
        } else if (message.command === 'stop') {
          await win.webContents.executeJavaScript(`document.getElementById('btn-stop').click()`);
          result = true;
        } else if (message.command === 'chromium') {
          await win.webContents.executeJavaScript(
            `document.getElementById('btn-chromium').click()`,
          );
          result = true;
        } else if (message.command === 'capture') {
          fs.writeFileSync(message.path, (await win.webContents.capturePage()).toPNG());
          result = true;
        } else if (message.command === 'close') {
          process.send({ type: 'fixture-result', id: message.id, result: true });
          win.close();
          return;
        }
        process.send({ type: 'fixture-result', id: message.id, result });
      } catch (error) {
        process.send({ type: 'fixture-result', id: message.id, error: error.message });
      }
    });
  },
});
