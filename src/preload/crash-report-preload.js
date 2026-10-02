const { contextBridge, ipcRenderer } = require('electron');
const { createChannelSubscriptions } = require('./channel-subscriptions');
const events = createChannelSubscriptions(ipcRenderer);
window.addEventListener('unload', () => events.dispose());

contextBridge.exposeInMainWorld('crashReportAPI', {
  getInfo: () => ipcRenderer.invoke('crash:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  onThemeApply: (cb) => events.subscribe('theme:apply', cb),
  onThemeChanged: (cb) => events.subscribe('theme:changed', cb),
  onSettingsChanged: (cb) => events.subscribe('settings:changed', cb),
  copyReport: () => ipcRenderer.invoke('crash:copy'),
  openLogsDir: () => ipcRenderer.invoke('crash:openLogsDir'),
  exportBundle: () => ipcRenderer.invoke('crash:exportBundle'),
  heapSnapshot: () => ipcRenderer.invoke('crash:heapSnapshot'),
  openDumpsDir: () => ipcRenderer.invoke('crash:openDumpsDir'),
  dismiss: () => ipcRenderer.invoke('crash:dismiss'),
  close: () => ipcRenderer.invoke('crash:close'),
});
