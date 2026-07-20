const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gameAPI', {
  getGameConfig: () => ipcRenderer.invoke('guesscharacter:getConfig'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  chatLLM: (messages, options) => ipcRenderer.invoke('llm:chat', messages, options),
  closeWindow: () => ipcRenderer.invoke('guesscharacter:close'),
  reportResult: (result) => ipcRenderer.send('game:result', { game: 'guessCharacter', result }),
  trngGetSeed: () => ipcRenderer.invoke('game:trngGetSeed'),
});
