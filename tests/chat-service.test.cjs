'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ChatService } = require('../src/chat-service.cjs');
const { SAFE_CONFIG } = require('../src/codex-client.cjs');

const MODEL = { id: 'model-id', model: 'test-model', displayName: 'Test model', description: '', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'normal' }, { reasoningEffort: 'high', description: 'deep' }], inputModalities: ['text', 'image'] };
class MockClient extends EventEmitter {
  constructor() { super(); this.calls = []; this.seq = 0; this.accountType = 'chatgpt'; }
  async connect() { this.ready = true; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (this.override) { const result = await this.override(method, params); if (result !== undefined) return result; }
    if (method === 'config/read') return { config: { ...SAFE_CONFIG, mcp_servers: { 'existing.server': { command: 'do-not-launch' } } } };
    if (method === 'account/read') return { account: { type: this.accountType, email: 'test@example.test', planType: 'pro', accessToken: 'never-expose' } };
    if (method === 'model/list') return { data: [MODEL], nextCursor: null };
    if (method === 'account/rateLimits/read') return { rateLimits: null };
    if (method === 'thread/start') return { thread: { id: `remote-${++this.seq}`, ephemeral: true, environments: [] }, sandbox: { type: 'readOnly', networkAccess: false } };
    if (method === 'turn/start') return { turn: { id: `turn-${++this.seq}`, status: 'inProgress' } };
    if (method === 'turn/interrupt') return {};
    if (method === 'account/login/start') return { type: 'chatgpt', loginId: 'login', authUrl: 'https://auth.openai.com/authorize?test=true' };
    throw new Error(`Unexpected request ${method}`);
  }
  close() { if (this.ready) { this.ready = false; this.emit('disconnect'); } }
}

function setup(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minigpt-test-'));
  const client = new MockClient();
  const service = new ChatService({ dataDir, clientFactory: () => client, ...options });
  const events = [];
  service.on('event', (event) => events.push(event));
  t.after(() => { service.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { service, client, dataDir, events };
}

function finish(client, service, id, content = '你好') {
  const active = service.active.get(id);
  client.emit('notification', 'item/agentMessage/delta', { threadId: active.threadId, turnId: active.turnId, itemId: 'answer', delta: content });
  client.emit('notification', 'turn/completed', { threadId: active.threadId, turn: { id: active.turnId, status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: content }] } });
}

test('connect projects only account metadata and dynamically discovers models', async (t) => {
  const { service, client, events } = setup(t);
  const result = await service.connect();
  assert.equal(result.account.type, 'chatgpt');
  assert.equal(result.models[0].model, MODEL.model);
  assert.equal(result.account.accessToken, undefined);
  assert.deepEqual(service.threadConfig.mcp_servers['existing.server'], { enabled: false });
  assert.equal(Object.keys(service.threadConfig).some(key => key.startsWith('mcp_servers.')), false);
  assert.ok(events.some((e) => e.type === 'connection' && e.connection.status === 'connected'));
  assert.equal(client.calls.some((c) => c.method === 'thread/list'), false);
});

test('text chat streams, persists, and resumes only its own ephemeral conversation', async (t) => {
  const { service, client, dataDir, events } = setup(t);
  const { conversationId } = await service.send({ text: '你好', effort: 'high' });
  const start = client.calls.find((c) => c.method === 'thread/start').params;
  const turn = client.calls.find((c) => c.method === 'turn/start').params;
  assert.deepEqual(start.environments, []);
  assert.deepEqual(turn.environments, []);
  assert.equal(start.ephemeral, true);
  assert.equal(start.config['features.shell_tool'], false);
  assert.equal(start.config['features.hooks'], false);
  assert.equal(turn.effort, 'high');
  finish(client, service, conversationId);
  assert.equal(service.getConversation(conversationId).messages[1].content, '你好');
  assert.ok(events.some((e) => e.type === 'delta' && e.delta === '你好'));
  assert.ok(events.some((e) => e.type === 'complete'));
  await service.send({ conversationId, text: '继续' });
  assert.equal(client.calls.filter((c) => c.method === 'thread/start').length, 1);
  finish(client, service, conversationId, '继续回答');
  service.close();
  const secondClient = new MockClient();
  const restored = new ChatService({ dataDir, clientFactory: () => secondClient });
  await restored.send({ conversationId, text: '再继续' });
  const replay = secondClient.calls.find((c) => c.method === 'turn/start').params.input;
  assert.match(replay[0].text, /previous_conversation/);
  assert.match(replay[0].text, /继续回答/);
  assert.equal(secondClient.calls.some((c) => c.method === 'thread/resume' || c.method === 'thread/read'), false);
  restored.close();
  assert.doesNotMatch(fs.readFileSync(path.join(dataDir, 'conversations.json'), 'utf8'), /never-expose|remote-/);
});

test('thread configuration disables inherited MCP servers without changing literal names or transports', async (t) => {
  const { service, client } = setup(t);
  const servers = {
    node_repl: { command: 'never-launch', args: ['--stdio'], enabled: true, tool_timeout_sec: null },
    'server.with.dots': { url: 'https://example.invalid/mcp', enabled: true },
    'server"with"quotes': { command: 'never-launch-either', enabled: false },
  };
  client.override = async (method, params) => {
    if (method === 'config/read') return { config: { ...SAFE_CONFIG, mcp_servers: servers } };
    if (method === 'thread/start') {
      assert.equal(Object.keys(params.config).some(key => key.startsWith('mcp_servers.')), false);
      assert.deepEqual(Object.keys(params.config.mcp_servers), Object.keys(servers));
      for (const [name, server] of Object.entries(servers)) {
        assert.deepEqual(params.config.mcp_servers[name], { enabled: false });
        assert.deepEqual({ ...server, ...params.config.mcp_servers[name] }, { ...server, enabled: false });
      }
    }
  };
  const { conversationId } = await service.send({ text: 'hello' });
  finish(client, service, conversationId);
  assert.equal(servers.node_repl.enabled, true, 'user configuration must not be mutated');
});

test('unknown conversations, invalid models and efforts, and file paths are rejected', async (t) => {
  const { service, client } = setup(t);
  await service.connect();
  await assert.rejects(service.send({ conversationId: '../other', text: 'test' }), /找不到/);
  await assert.rejects(service.send({ text: 'test', model: 'invented' }), /模型/);
  await assert.rejects(service.send({ text: 'test', effort: 'invented' }), /思考强度/);
  await assert.rejects(service.send({ text: '', attachments: [{ type: 'localImage', name: 'secret', path: '/secret' }] }), /仅支持/);
  assert.equal(client.calls.some((c) => c.method.startsWith('thread/')), false);
  assert.throws(() => service.getConversation('someone-elses-thread'), /找不到/);
  await assert.rejects(service.deleteConversation('someone-elses-thread'), /找不到/);
});

test('API-key accounts cannot silently switch to separately billed usage', async (t) => {
  const { service, client } = setup(t);
  client.accountType = 'apiKey';
  await assert.rejects(service.send({ text: 'test' }), /ChatGPT/);
  assert.equal(client.calls.some((c) => c.method === 'turn/start'), false);
});

test('attachments use explicit content, and returned snapshots cannot mutate state', async (t) => {
  const { service, client } = setup(t);
  const { conversationId } = await service.send({ text: '看附件', attachments: [{ type: 'text', name: 'note.txt', text: 'a note' }, { type: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,YQ==' }] });
  const input = client.calls.find((c) => c.method === 'turn/start').params.input;
  assert.deepEqual(input.map((i) => i.type), ['text', 'text', 'image']);
  assert.match(input[1].text, /a note/);
  const snapshot = service.getConversation(conversationId);
  snapshot.messages[0].content = 'mutated';
  assert.equal(service.getConversation(conversationId).messages[0].content, '看附件');
  finish(client, service, conversationId);
});

test('restarting restores original image and text attachment content for conversation context', async (t) => {
  const { service, client, dataDir } = setup(t);
  const dataUrl = 'data:image/png;base64,YWJjZA==';
  const { conversationId } = await service.send({ text: '记住附件', attachments: [
    { type: 'image', name: 'capture.png', dataUrl },
    { type: 'text', name: 'note.txt', text: 'Remember this attachment text.' },
  ] });
  finish(client, service, conversationId);
  service.close();
  const nextClient = new MockClient();
  const restored = new ChatService({ dataDir, clientFactory: () => nextClient });
  await restored.send({ conversationId, text: '图片里是什么？' });
  const inputs = nextClient.calls.find((c) => c.method === 'turn/start').params.input;
  assert.ok(inputs.some((input) => input.type === 'image' && input.url === dataUrl));
  assert.ok(inputs.some((input) => input.type === 'text' && input.text.includes('Remember this attachment text.')));
  assert.equal(restored.getConversation(conversationId).messages[0].attachments[0].dataUrl, undefined);
  await restored.stop(conversationId);
  await restored.deleteConversation(conversationId);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'conversations.json'), 'utf8')).attachments, {});
  restored.close();
});

test('optional nonpersistent mode writes no message history', async (t) => {
  const { service, client, dataDir } = setup(t, { persistHistory: false });
  const { conversationId } = await service.send({ text: 'private session' });
  finish(client, service, conversationId);
  assert.equal(fs.existsSync(path.join(dataDir, 'conversations.json')), false);
});

test('cancelling during thread creation prevents the turn from ever starting', async (t) => {
  const { service, client } = setup(t);
  await service.connect();
  let resolveThread;
  client.override = async (method) => method === 'thread/start' ? new Promise((resolve) => { resolveThread = resolve; }) : undefined;
  const pending = service.send({ text: 'cancel before generation' });
  const id = service.listConversations()[0].id;
  await service.stop(id);
  resolveThread({ thread: { id: 'delayed', ephemeral: true, environments: [] }, sandbox: { type: 'readOnly', networkAccess: false } });
  await pending;
  assert.equal(client.calls.some((c) => c.method === 'turn/start'), false);
  assert.equal(service.getConversation(id).messages.at(-1).status, 'interrupted');
});

test('cancel interrupts only an owned turn and late notifications cannot corrupt the next turn', async (t) => {
  const { service, client } = setup(t);
  const { conversationId } = await service.send({ text: 'test' });
  const previous = { ...service.active.get(conversationId) };
  await service.stop(conversationId);
  assert.equal(client.calls.at(-1).method, 'turn/interrupt');
  assert.equal(service.getConversation(conversationId).messages.at(-1).status, 'interrupted');
  await service.send({ conversationId, text: 'again' });
  client.emit('notification', 'item/agentMessage/delta', { threadId: previous.threadId, turnId: previous.turnId, itemId: 'answer', delta: 'LATE' });
  assert.equal(service.getConversation(conversationId).messages.at(-1).content, '');
  finish(client, service, conversationId, 'fresh');
  await service.deleteConversation(conversationId);
  assert.deepEqual(service.listConversations(), []);
  assert.equal(client.calls.some((c) => c.method === 'thread/archive' || c.method === 'account/logout'), false);
});

test('deleting history commits to disk before removing in-memory history and attachments', async (t) => {
  const { service, client, dataDir } = setup(t);
  const { conversationId } = await service.send({ text: 'keep until saved', attachments: [{ type: 'text', name: 'note.txt', text: 'saved attachment' }] });
  finish(client, service, conversationId);
  const before = service.getConversation(conversationId);
  const threadId = service.remoteThreads.get(conversationId);
  const stored = fs.readFileSync(service.storePath, 'utf8');
  const save = service._save;
  service._save = () => { throw new Error('disk unavailable'); };
  await assert.rejects(service.deleteConversation(conversationId), /disk unavailable/);
  assert.deepEqual(service.getConversation(conversationId), before);
  assert.equal(service.savedAttachments.size, 1);
  assert.equal(service.remoteThreads.get(conversationId), threadId);
  assert.equal(service.threadOwners.get(threadId), conversationId);
  assert.equal(fs.readFileSync(service.storePath, 'utf8'), stored);
  service._save = save;
  assert.deepEqual(await service.deleteConversation(conversationId), { deleted: true });
  assert.deepEqual(service.listConversations(), []);
  assert.equal(service.savedAttachments.size, 0);
  assert.equal(service.remoteThreads.size, 0);
  assert.equal(service.threadOwners.size, 0);
  const restored = new ChatService({ dataDir, clientFactory: () => new MockClient() });
  assert.deepEqual(restored.listConversations(), []);
  assert.equal(restored.savedAttachments.size, 0);
  restored.close();
});

test('deleting during thread creation cannot restore ownership or emit deleted history', async (t) => {
  const { service, client, events } = setup(t);
  await service.connect();
  let resolveThread;
  client.override = async (method) => method === 'thread/start' ? new Promise((resolve) => { resolveThread = resolve; }) : undefined;
  const pending = service.send({ text: 'delete while opening thread' });
  const id = service.listConversations()[0].id;
  assert.deepEqual(await service.deleteConversation(id), { deleted: true });
  const eventCount = events.length;
  resolveThread({ thread: { id: 'deleted-thread', ephemeral: true, environments: [] }, sandbox: { type: 'readOnly', networkAccess: false } });
  await pending;
  assert.equal(client.calls.some((call) => call.method === 'turn/start'), false);
  assert.deepEqual(events.slice(eventCount), []);
  assert.deepEqual(service.listConversations(), []);
  assert.equal(service.active.size, 0);
  assert.equal(service.remoteThreads.size, 0);
  assert.equal(service.threadOwners.size, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(service.storePath, 'utf8')).conversations, []);
});

test('deleting during turn creation interrupts the late turn without restoring history', async (t) => {
  const { service, client, events } = setup(t);
  await service.connect();
  let resolveTurn;
  let announceTurn;
  const turnStarted = new Promise((resolve) => { announceTurn = resolve; });
  client.override = async (method) => {
    if (method !== 'turn/start') return undefined;
    return new Promise((resolve) => { resolveTurn = resolve; announceTurn(); });
  };
  const pending = service.send({ text: 'delete while starting turn' });
  await turnStarted;
  const id = service.listConversations()[0].id;
  const threadId = service.remoteThreads.get(id);
  assert.deepEqual(await service.deleteConversation(id), { deleted: true });
  const eventCount = events.length;
  resolveTurn({ turn: { id: 'late-turn' } });
  await pending;
  assert.deepEqual(client.calls.at(-1), { method: 'turn/interrupt', params: { threadId, turnId: 'late-turn' } });
  client.emit('notification', 'turn/completed', { threadId, turn: { id: 'late-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'late answer' }] } });
  assert.deepEqual(events.slice(eventCount), []);
  assert.deepEqual(service.listConversations(), []);
  assert.equal(service.active.size, 0);
  assert.equal(service.remoteThreads.size, 0);
  assert.equal(service.threadOwners.size, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(service.storePath, 'utf8')).conversations, []);
});

test('clear history removes every conversation, saved attachment, and ephemeral ownership across restarts', async (t) => {
  const { service, client, dataDir } = setup(t);
  for (const attachment of [
    { type: 'text', name: 'note.txt', text: 'private attachment' },
    { type: 'image', name: 'capture.png', dataUrl: 'data:image/png;base64,YQ==' },
  ]) {
    const { conversationId } = await service.send({ text: 'saved history', attachments: [attachment] });
    finish(client, service, conversationId);
  }
  assert.equal(service.savedAttachments.size, 2);
  assert.equal(service.remoteThreads.size, 2);
  assert.deepEqual(await service.clearConversations(), { deleted: true, count: 2 });
  assert.deepEqual(service.listConversations(), []);
  assert.equal(service.savedAttachments.size, 0);
  assert.equal(service.remoteThreads.size, 0);
  assert.equal(service.threadOwners.size, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(service.storePath, 'utf8')), { version: 1, conversations: [], attachments: {} });
  const restored = new ChatService({ dataDir, clientFactory: () => new MockClient() });
  assert.deepEqual(restored.listConversations(), []);
  assert.equal(restored.savedAttachments.size, 0);
  restored.close();
  assert.deepEqual(await service.clearConversations(), { deleted: true, count: 0 });
  assert.equal(client.calls.some((call) => call.method === 'thread/archive' || call.method === 'account/logout'), false);
});

test('clear history retains history, attachments, and ownership if persistence fails', async (t) => {
  const { service, client } = setup(t);
  const { conversationId } = await service.send({ text: 'retain on failure', attachments: [{ type: 'text', name: 'note.txt', text: 'retain content' }] });
  finish(client, service, conversationId);
  const stored = fs.readFileSync(service.storePath, 'utf8');
  const save = service._save;
  service._save = () => { throw new Error('disk unavailable'); };
  await assert.rejects(service.clearConversations(), /disk unavailable/);
  assert.equal(service.listConversations().length, 1);
  assert.equal(service.savedAttachments.size, 1);
  assert.equal(service.remoteThreads.size, 1);
  assert.equal(service.threadOwners.size, 1);
  assert.equal(fs.readFileSync(service.storePath, 'utf8'), stored);
  service._save = save;
});

test('clear history rejects during generation and while a send is connecting', async (t) => {
  const { service, client } = setup(t);
  let resolveConnection;
  client.connect = () => new Promise((resolve) => { resolveConnection = () => { client.ready = true; resolve(); }; });
  const pending = service.send({ text: 'still sending' });
  assert.equal(service.active.size, 0);
  await assert.rejects(service.clearConversations(), /停止生成或等待发送完成/);
  resolveConnection();
  const { conversationId } = await pending;
  await assert.rejects(service.clearConversations(), /停止生成或等待发送完成/);
  assert.equal(service.listConversations().length, 1);
  await service.stop(conversationId);
  assert.deepEqual(await service.clearConversations(), { deleted: true, count: 1 });
});

test('clear history in nonpersistent mode removes memory without writing a history file', async (t) => {
  const { service, client } = setup(t, { persistHistory: false });
  const { conversationId } = await service.send({ text: 'session history' });
  finish(client, service, conversationId);
  assert.deepEqual(await service.clearConversations(), { deleted: true, count: 1 });
  assert.deepEqual(service.listConversations(), []);
  assert.equal(fs.existsSync(service.storePath), false);
});

test('refuses a CLI that does not enforce the safe configuration or no-environment thread', async (t) => {
  const { service, client } = setup(t);
  client.override = async (method) => method === 'config/read' ? { config: { ...SAFE_CONFIG, features: { ...SAFE_CONFIG.features, shell_tool: true } } } : undefined;
  await assert.rejects(service.connect(), /隔离/);
  client.override = async (method) => method === 'thread/start' ? { thread: { id: 'bad', ephemeral: true, environments: [{ id: 'local' }] }, sandbox: { type: 'readOnly', networkAccess: false } } : undefined;
  await assert.rejects(service.send({ text: 'test' }), /隔离/);
  assert.equal(client.calls.some((c) => c.method === 'turn/start'), false);
});

test('disconnect and idle timeout terminate partial replies and allow reconnection', async (t) => {
  const { service, client } = setup(t, { turnTimeoutMs: 20 });
  const { conversationId } = await service.send({ text: 'test' });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(service.getConversation(conversationId).messages.at(-1).status, 'failed');
  assert.equal(service.connected, false);
  await service.send({ conversationId, text: 'retry' });
  client.close();
  assert.equal(service.getConversation(conversationId).messages.at(-1).status, 'interrupted');
});
