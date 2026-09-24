const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mini', {
  async invoke(action, payload) {
    const result = await ipcRenderer.invoke('mini:invoke', action, payload);
    if (!result.ok) throw new Error(result.error || '操作失败，请重试');
    return result.data;
  },
  onEvent(callback) {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('mini:event', listener);
    return () => ipcRenderer.removeListener('mini:event', listener);
  }
});
