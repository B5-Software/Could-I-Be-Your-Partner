/* SPDX-License-Identifier: GPL-3.0-or-later */
const path = require('node:path');
module.exports = function registerClaude({ ipcMain, dataDir, publishEvent }) {
  const accounts = new (require('../services/claude-accounts').ClaudeAccounts)({
    root: path.join(dataDir, 'claude-accounts'),
    publish: publishEvent,
  });
  const handlers = {
    status: () => accounts.status(),
    login: (id) => accounts.login(id),
    cancel: () => accounts.cancel(),
    switch: (id) => accounts.switchAccount(id),
    logout: (id) => accounts.logout(id),
    models: () => accounts.models(),
    code: (code) => accounts.submitCode(code),
  };
  for (const [name, handler] of Object.entries(handlers))
    ipcMain.handle('claude:' + name, async (_event, arg) => {
      try {
        return await handler(arg);
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
  return accounts;
};
