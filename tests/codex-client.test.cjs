'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { CodexClient } = require('../src/codex-client.cjs');

function transport({ timeout = 1000 } = {}) {
  const messages = [];
  let spawnArgs;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const message = JSON.parse(String(chunk));
    messages.push(message);
    if (message.method === 'initialize') queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`));
    done();
  } });
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  const client = new CodexClient({ cwd: process.cwd(), requestTimeoutMs: timeout, spawnFn(executable, args, options) { spawnArgs = { executable, args, options }; return child; } });
  return { client, child, messages, get spawnArgs() { return spawnArgs; } };
}

test('stdio handshake, fragmented messages, concurrent request matching and notifications', async () => {
  const fixture = transport();
  const { client, child, messages } = fixture;
  await client.connect();
  assert.equal(messages[0].method, 'initialize');
  assert.equal(messages[1].method, 'initialized');
  assert.equal(messages[0].params.capabilities.experimentalApi, true);
  assert.equal(fixture.spawnArgs.options.shell, false);
  assert.equal(fixture.spawnArgs.options.windowsHide, true);
  assert.ok(fixture.spawnArgs.args.includes('features.shell_tool=false'));
  assert.ok(fixture.spawnArgs.args.includes('features.image_generation=true'));
  assert.ok(fixture.spawnArgs.args.includes('features.code_mode_host=true'));
  assert.ok(fixture.spawnArgs.args.includes('features.apps=true'));
  assert.ok(fixture.spawnArgs.args.includes('features.plugins=true'));
  const notification = new Promise((resolve) => client.once('notification', (...args) => resolve(args)));
  const one = client.request('one');
  const two = client.request('two');
  const id1 = messages.find((m) => m.method === 'one').id;
  const id2 = messages.find((m) => m.method === 'two').id;
  const payload = `${JSON.stringify({ id: id2, result: 2 })}\n${JSON.stringify({ method: 'hello', params: { value: '中文' } })}\n${JSON.stringify({ id: id1, result: 1 })}\n`;
  child.stdout.write(payload.slice(0, 7));
  child.stdout.write(payload.slice(7));
  assert.deepEqual(await Promise.all([one, two]), [1, 2]);
  assert.deepEqual(await notification, ['hello', { value: '中文' }]);
  client.close();
});

test('all server-initiated tool and approval requests fail closed', async () => {
  const { client, child, messages } = transport();
  await client.connect();
  for (const method of ['item/commandExecution/requestApproval', 'item/tool/call', 'account/chatgptAuthTokens/refresh']) {
    child.stdout.write(`${JSON.stringify({ id: method, method, params: { private: 'do not forward' } })}\n`);
    const response = messages.find((m) => m.id === method);
    assert.equal(response.error.code, -32601);
    assert.equal(response.result, undefined);
    assert.doesNotMatch(JSON.stringify(response), /do not forward/);
  }
  client.close();
});

test('timeouts, disconnects, and RPC failures never leak raw diagnostics', async () => {
  const { client, child, messages } = transport({ timeout: 20 });
  await client.connect();
  await assert.rejects(client.request('slow'), /超时/);
  assert.equal(client.pending.size, 0);
  const failed = client.request('failed');
  const id = messages.find((m) => m.method === 'failed').id;
  child.stdout.write(`${JSON.stringify({ id, error: { message: 'secret API token = sk-DO-NOT-LEAK' } })}\n`);
  await assert.rejects(failed, (error) => !error.message.includes('sk-'));
  const pending = client.request('pending');
  child.emit('exit', 1);
  await assert.rejects(pending, /断开/);
  assert.equal(client.pending.size, 0);
  assert.equal(client.ready, false);
});

test('configuration and unknown RPC failures identify the failing stage without exposing diagnostics', async () => {
  const { client, child, messages } = transport();
  await client.connect();
  const configuration = client.request('thread/start');
  child.stdout.write(`${JSON.stringify({ id: messages.at(-1).id, error: { code: -32600, message: 'failed to load configuration: invalid transport in mcp_servers.private_server' } })}\n`);
  await assert.rejects(configuration, error => /配置加载失败/.test(error.message) && !/private_server|账户/.test(error.message));
  const unknown = client.request('turn/start');
  child.stdout.write(`${JSON.stringify({ id: messages.at(-1).id, error: { code: -32000, message: 'internal diagnostic sk-SECRET' } })}\n`);
  await assert.rejects(unknown, error => /发送消息失败.*-32000/.test(error.message) && !/sk-SECRET/.test(error.message));
  client.close();
});
