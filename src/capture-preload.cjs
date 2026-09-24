const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('capture', {
  onImage: callback => ipcRenderer.once('mini:capture-image', (_event, data) => callback(data)),
  finish: rect => ipcRenderer.send('mini:capture-result', rect)
});
