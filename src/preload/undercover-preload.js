const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gameAPI', {
  getGameConfig: () => ipcRenderer.invoke('undercover:getConfig'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  chatLLM: (messages, options) => ipcRenderer.invoke('llm:chat', messages, options),
  closeWindow: () => ipcRenderer.invoke('undercover:close'),
  reportResult: (result) => ipcRenderer.send('game:result', { game: 'undercover', result }),
});
