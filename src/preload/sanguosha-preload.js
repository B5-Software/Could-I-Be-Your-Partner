const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sanguoshaAPI', {
  getGameConfig: () => ipcRenderer.invoke('sanguosha:getConfig'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  aiDecision: (gameState, playerInfo) => ipcRenderer.invoke('sanguosha:aiDecision', gameState, playerInfo),
  chatLLM: (messages, options) => ipcRenderer.invoke('llm:chat', messages, options),
  onClose: (cb) => ipcRenderer.on('sanguosha:close', cb),
  closeWindow: () => ipcRenderer.invoke('sanguosha:close'),
  reportResult: (result) => ipcRenderer.send('game:result', { game: 'sanguosha', result }),
});
