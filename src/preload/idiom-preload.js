const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gameAPI', {
  getGameConfig: () => ipcRenderer.invoke('idiom:getConfig'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  onThemeChanged: (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('theme:changed', l); return () => ipcRenderer.removeListener('theme:changed', l); },
  onThemeApply: (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('theme:apply', l); return () => ipcRenderer.removeListener('theme:apply', l); },
  onSettingsChanged: (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('settings:changed', l); return () => ipcRenderer.removeListener('settings:changed', l); },
  chatLLM: (messages, options) => ipcRenderer.invoke('llm:chat', messages, options),
  closeWindow: () => ipcRenderer.invoke('idiom:close'),
  reportResult: (result) => ipcRenderer.send('game:result', { game: 'idiom', result }),
  trngGetSeed: () => ipcRenderer.invoke('game:trngGetSeed'),
});
