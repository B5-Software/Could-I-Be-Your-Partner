const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('crashReportAPI', {
  getInfo: () => ipcRenderer.invoke('crash:info'),
  exportBundle: () => ipcRenderer.invoke('crash:exportBundle'),
  heapSnapshot: () => ipcRenderer.invoke('crash:heapSnapshot'),
  openDumpsDir: () => ipcRenderer.invoke('crash:openDumpsDir'),
  dismiss: () => ipcRenderer.invoke('crash:dismiss'),
  close: () => ipcRenderer.invoke('crash:close'),
});
