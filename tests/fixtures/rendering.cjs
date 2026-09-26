'use strict';

// Offline fixture for the production HTML, scripts, CSP, and preload bridge.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const root = process.env.MINIGPT_RENDERING_APP_ROOT || path.resolve(__dirname, '../..');
app.setPath('userData', process.env.MINIGPT_DATA_DIR);
const check = globalThis.__renderCheck = { conversation: null, copied: null, settings: { theme: 'light' } };
const connection = {
  status: 'connected', account: { type: 'chatgpt', email: 'test@example.invalid' },
  models: [{ id: 'test-model', model: 'test-model', displayName: 'Test model', isDefault: true,
    defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], inputModalities: ['text'] }],
};
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 600, height: 780, show: false,
    webPreferences: { preload: path.join(root, 'src/preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false, spellcheck: false } });
  check.emit = event => win.webContents.send('mini:event', event);
  ipcMain.handle('mini:invoke', (_event, action, payload) => {
    let data;
    if (action === 'bootstrap') data = { settings: check.settings, connection, conversations: check.conversation ? [check.conversation] : [], hotkeyStatus: true };
    else if (action === 'quotes:next') data = null;
    else if (action === 'conversations:list') data = check.conversation ? [check.conversation] : [];
    else if (action === 'conversations:get') data = check.conversation;
    else if (action === 'clipboard:write') { check.copied = payload.text; data = {}; }
    else if (action === 'window:expand') data = { expanded: true };
    else if (action === 'settings:update') {
      Object.assign(check.settings, payload); data = { settings: check.settings };
      check.emit({ type: 'settings', settings: check.settings });
    } else return { ok: false, error: `Unexpected fixture action: ${action}` };
    return { ok: true, data };
  });
  await win.loadFile(path.join(root, 'src/renderer/index.html'));
});
