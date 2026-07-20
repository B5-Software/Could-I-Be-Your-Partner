const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cadAPI', {
  // Settings + theme
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getTheme: () => ipcRenderer.invoke('theme:get'),

  // File dialogs (return chosen file path or null)
  saveProjectDialog: () => ipcRenderer.invoke('cipypcad:saveProjectDialog'),
  loadProjectDialog: () => ipcRenderer.invoke('cipypcad:loadProjectDialog'),
  saveImageDialog: (defaultName, filter) => ipcRenderer.invoke('cipypcad:saveImageDialog', defaultName, filter),

  // File operations
  saveProject: (path) => ipcRenderer.invoke('cipypcad:saveProject', path),
  loadProject: (path) => ipcRenderer.invoke('cipypcad:loadProject', path),
  exportDxf: (path) => ipcRenderer.invoke('cipypcad:exportDxf', path),
  exportImage: (path, format) => ipcRenderer.invoke('cipypcad:exportImage', path, format),
  writeFile: (path, content) => ipcRenderer.invoke('cipypcad:writeFile', path, content),

  // Close window (triggers save prompt via close-requested)
  closeWindow: () => ipcRenderer.invoke('cipypcad:close'),
  // Confirm close after save prompt: action = 'close'
  confirmClose: (action) => ipcRenderer.invoke('cipypcad:confirmClose', action),

  // Window controls (custom titlebar buttons)
  minimize: () => ipcRenderer.invoke('cipypcad:minimize'),
  maximizeToggle: () => ipcRenderer.invoke('cipypcad:maximizeToggle'),
  isMaximized: () => ipcRenderer.invoke('cipypcad:isMaximized'),
  onMaximizeChange: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('cipypcad:maximizeChanged', listener);
    return () => ipcRenderer.removeListener('cipypcad:maximizeChanged', listener);
  },

  // Receive close-requested event from main process (user clicked window X button)
  onCloseRequested: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('cipypcad:close-requested', listener);
    return () => ipcRenderer.removeListener('cipypcad:close-requested', listener);
  },

  // Receive a single command from main process (push model for interactive tools)
  onCommand: (cb) => {
    const listener = (_, cmd) => cb(cmd);
    ipcRenderer.on('cipypcad:command', listener);
    return () => ipcRenderer.removeListener('cipypcad:command', listener);
  }
});
