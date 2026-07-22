const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sanguoshaAPI', {
  getGameConfig: () => ipcRenderer.invoke('sanguosha:getConfig'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  onThemeChanged: (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('theme:changed', l); return () => ipcRenderer.removeListener('theme:changed', l); },
  onThemeApply: (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('theme:apply', l); return () => ipcRenderer.removeListener('theme:apply', l); },
  onSettingsChanged: (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('settings:changed', l); return () => ipcRenderer.removeListener('settings:changed', l); },
  aiDecision: (gameState, playerInfo) => ipcRenderer.invoke('sanguosha:aiDecision', gameState, playerInfo),
  chatLLM: (messages, options) => ipcRenderer.invoke('llm:chat', messages, options),
  onClose: (cb) => ipcRenderer.on('sanguosha:close', cb),
  closeWindow: () => ipcRenderer.invoke('sanguosha:close'),
  reportResult: (result) => ipcRenderer.send('game:result', { game: 'sanguosha', result }),
  trngGetSeed: () => ipcRenderer.invoke('game:trngGetSeed'),
});
