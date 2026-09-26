'use strict';

// Run the real main process and renderer with offline chat and shortcut input.
const { app, globalShortcut } = require('electron');
const { ChatService } = require('../../src/chat-service.cjs');
const { QuoteService } = require('../../src/quote-service.cjs');
const check = globalThis.__resumeCheck = {
  shortcuts: new Map(), events: [], sends: [], stops: [], visible: false, hides: 0,
};
globalShortcut.register = (key, callback) => {
  if (key === process.env.MINIGPT_TEST_CONFLICT) return false;
  check.shortcuts.set(key, callback);
  return true;
};
globalShortcut.isRegistered = key => check.shortcuts.has(key);
globalShortcut.unregister = key => check.shortcuts.delete(key);
globalShortcut.unregisterAll = () => check.shortcuts.clear();
app.on('browser-window-created', (_event, win) => {
  // Native windows stay hidden; model visibility so both shortcut branches run.
  const hide = win.hide.bind(win), send = win.webContents.send.bind(win.webContents);
  check.nativeVisible = win.isVisible.bind(win);
  win.isVisible = () => check.visible;
  win.hide = () => { check.visible = false; check.hides++; hide(); };
  win.webContents.send = (channel, event) => {
    if (channel === 'mini:event') {
      check.events.push(event.type);
      if (event.type === 'focus') check.visible = true;
    }
    return send(channel, event);
  };
});
QuoteService.prototype.warmup = async () => {};
QuoteService.prototype.next = async () => ({ text: 'Offline shortcut test', category: '原创' });
ChatService.prototype.connect = async function () {
  check.chat = this;
  return {
    status: 'connected',
    account: { type: 'chatgpt', email: 'test@example.invalid' },
    models: [{ id: 'test-model', model: 'test-model', displayName: 'Test model', isDefault: true,
      defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], inputModalities: ['text'] }],
  };
};
ChatService.prototype.send = async function (payload) {
  check.sends.push(payload);
  if (check.delaySend) await new Promise(resolve => { check.releaseSend = resolve; });
  const conversation = check.conversation = {
    id: payload.conversationId || 'test-conversation', title: payload.text, status: 'generating',
    model: 'test-model', effort: 'low', updatedAt: new Date().toISOString(),
    messages: [
      { id: 'user', role: 'user', content: payload.text, status: 'complete' },
      { id: 'assistant', role: 'assistant', content: '', status: 'streaming' },
    ],
  };
  this.emit('event', { type: 'conversation', conversation });
  return { conversationId: conversation.id };
};
ChatService.prototype.stop = async id => { check.stops.push(id); return { stopped: true }; };
ChatService.prototype.listConversations = async () => check.conversation ? [check.conversation] : [];
ChatService.prototype.getConversation = async () => check.conversation;
ChatService.prototype.close = async () => {};
check.delta = text => {
  check.conversation.messages[1].content += text;
  check.chat.emit('event', { type: 'delta', conversationId: check.conversation.id, messageId: 'assistant', delta: text });
};
check.finish = () => {
  check.conversation.status = 'idle';
  check.conversation.messages[1].status = 'complete';
  check.chat.emit('event', { type: 'complete', conversation: check.conversation });
};
require('../../src/main.cjs');
