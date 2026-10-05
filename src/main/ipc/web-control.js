/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
module.exports = function registerWebControlIpc({
  webControlService,
  ipcMain,
  getSettings,
  getMainWindow,
  beforeStop = () => {},
}) {
  const broadcastWebControlRunning = () =>
    getMainWindow()?.webContents?.send('webControl:running', false);
  ipcMain.handle('webControl:start', async () => {
    try {
      webControlService.configure(getSettings().webControl);
      return await webControlService.start();
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('webControl:stop', async () => {
    await beforeStop();
    return webControlService.stop();
  });
  ipcMain.handle('webControl:getStatus', () => webControlService.status());
  ipcMain.handle('webControl:reconfigure', async () => {
    try {
      return await webControlService.reconfigure(getSettings().webControl);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('webControl:hashPassword', async (_, password) => ({
    ok: true,
    hash: await webControlService.hashPassword(password),
  }));
  ipcMain.handle('webControl:generateTOTP', async () => ({
    ok: true,
    ...(await webControlService.generateTOTPSecret()),
  }));
  ipcMain.handle('webControl:verifyTOTP', (_, code) => {
    webControlService.configure(getSettings().webControl);
    return { ok: true, valid: webControlService.verifyTOTP(code) };
  });
  return { broadcastWebControlRunning };
};
