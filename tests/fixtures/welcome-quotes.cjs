'use strict';

// Exercise the actual application with controllable quote timing and no account
// access, external requests or global shortcut registration.
const path = require('node:path');
const { app, globalShortcut, ipcMain } = require('electron');
const root = process.env.MINIGPT_TEST_APP_ROOT || path.join(__dirname, '..', '..');
if (path.resolve(root) !== path.resolve(__dirname, '..', '..')) Object.defineProperty(app, 'isPackaged', { value: true });
const { QuoteService } = require(path.join(root, 'src/quote-service.cjs'));
const { ChatService } = require(path.join(root, 'src/chat-service.cjs'));
const check = globalThis.__welcomeCheck = { network: [], reads: [], holdReads: false, shortcuts: new Map(),
  visible: false, frames: [], shows: [], acknowledgements: [], holdAcknowledgements: false,
  captureCalls: 0, quoteCalls: 0, captures: [], holdCaptures: false };
globalShortcut.register = (key, callback) => { check.shortcuts.set(key, callback); return true; };
globalShortcut.isRegistered = key => check.shortcuts.has(key);
globalShortcut.unregister = key => check.shortcuts.delete(key);
globalShortcut.unregisterAll = () => check.shortcuts.clear();
app.on('browser-window-created', (_event, win) => {
  const hide = win.hide.bind(win), send = win.webContents.send.bind(win.webContents);
  const capture = win.webContents.capturePage.bind(win.webContents);
  win.isVisible = () => check.visible;
  win.hide = () => { check.visible = false; hide(); };
  win.webContents.capturePage = async (...args) => {
    check.captureCalls++;
    if (check.holdCaptures) await new Promise(resolve => check.captures.push(resolve));
    const frame = await win.webContents.executeJavaScript(`({
      text: document.querySelector('#welcome-quote').textContent,
      source: document.querySelector('#welcome-source').textContent,
      view: document.querySelector('#app').dataset.view,
      draft: document.querySelector('#prompt').value
    })`);
    const image = await capture(...args);
    check.frames.push(frame);
    return image;
  };
  win.webContents.send = (channel, event) => {
    if (channel === 'mini:event' && event.type === 'focus') {
      check.visible = true;
      const shown = { captureCalls: check.captureCalls, quoteCalls: check.quoteCalls };
      check.shows.push(shown);
      void win.webContents.executeJavaScript(`({
        text: document.querySelector('#welcome-quote').textContent,
        source: document.querySelector('#welcome-source').textContent,
        view: document.querySelector('#app').dataset.view,
        draft: document.querySelector('#prompt').value
      })`).then(frame => Object.assign(shown, frame));
    }
    return send(channel, event);
  };
});
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => handle(channel, async (...args) => {
  if (args[1] === 'window:prepared' && args[2]?.background && check.holdAcknowledgements) {
    await new Promise(resolve => check.acknowledgements.push(resolve));
  }
  return handler(...args);
});
QuoteService.prototype.fetchHitokoto = function () {
  check.service = this;
  return new Promise(resolve => check.network.push(resolve));
};
QuoteService.prototype.fetchQuote = async () => null;
const next = QuoteService.prototype.next;
QuoteService.prototype.next = async function (options) {
  check.quoteCalls++;
  if (check.holdReads) {
    await new Promise((resolve, reject) => {
      check.reads.push({ resolve, reject });
      check.onRead?.();
    });
  }
  return next.call(this, options);
};
ChatService.prototype.connect = async () => ({ status: 'connected', account: null, models: [] });
ChatService.prototype.listConversations = async () => [];
ChatService.prototype.close = async () => {};
require(path.join(root, 'src/main.cjs'));
