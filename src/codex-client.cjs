'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { version } = require('../package.json');

// These overrides apply only to this child process. The user's Codex settings and
// official credential store are never opened or modified by miniGPT.
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'shell_snapshot', 'shell_snapshot_v2', 'code_mode',
  'code_mode_only', 'hooks',
  'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external',
  'computer_use', 'view_image', 'workspace_dependencies',
  'skill_mcp_dependency_install', 'memories', 'goals',
  'tool_suggest', 'realtime_conversation', 'in_app_local_automation',
];
// ImageGen and connector tools run through the code-mode host even when the
// conversation has no local execution environment. Disabling it strands tools.
const ENABLED_FEATURES = ['code_mode_host', 'image_generation', 'apps', 'plugins', 'remote_plugin', 'skill_search'];
const SAFE_CONFIG = Object.freeze({
  approval_policy: 'never', approvals_reviewer: 'user', sandbox_mode: 'read-only',
  web_search: 'disabled', mcp_servers: {},
  features: Object.fromEntries([...DISABLED_FEATURES.map((name) => [name, false]), ...ENABLED_FEATURES.map((name) => [name, true])]),
  project_doc_max_bytes: 0, project_doc_fallback_filenames: [],
});

function safeError(error, fallback = 'Codex 连接发生错误，请重试。') {
  const source = typeof error === 'string' ? error : error?.message || '';
  if (/ENOENT/.test(source)) return '没有找到 Codex CLI。请在设置中指定 codex.exe 路径。';
  if (/failed to load configuration|invalid transport|error loading config/i.test(source)) return 'Codex 配置加载失败，请更新 miniGPT 后重新连接。';
  if (/timeout|timed out|超时/i.test(source)) return 'Codex 请求超时，请检查网络后重试。';
  if (/usage.limit|rate.limit|quota|limit reached/i.test(source)) return '当前账户已达到使用限制，请稍后再试。';
  if (/unauthoriz|authentication|not logged|401/i.test(source)) return '登录已失效，请重新使用 ChatGPT 登录。';
  return fallback;
}

class CodexClient extends EventEmitter {
  constructor({ executable = 'codex', cwd, requestTimeoutMs = 45000, spawnFn = spawn } = {}) {
    super();
    this.executable = executable;
    this.cwd = cwd;
    this.requestTimeoutMs = requestTimeoutMs;
    this.spawnFn = spawnFn;
    this.pending = new Map();
    this.sequence = 0;
    this.child = null;
    this.connecting = null;
  }

  async connect() {
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    this.connecting = this._connect();
    try { await this.connecting; } finally { this.connecting = null; }
  }

  async _connect() {
    const args = ['app-server', '--listen', 'stdio://'];
    // JSON string and boolean syntax is also valid TOML for these scalar values.
    for (const [key, value] of Object.entries(SAFE_CONFIG)) {
      if (key === 'features') {
        for (const [name, enabled] of Object.entries(value)) args.push('-c', `features.${name}=${enabled}`);
      } else if (key === 'mcp_servers') args.push('-c', 'mcp_servers={}');
      else args.push('-c', `${key}=${JSON.stringify(value)}`);
    }
    const child = this.spawnFn(this.executable, args, {
      cwd: this.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 32 * 1024 * 1024) {
        this._disconnect(child, new Error('Codex 协议数据超过限制。'));
        child.kill();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try { this._receive(JSON.parse(line)); }
        catch { /* Non-JSON diagnostics are never forwarded to the UI or logs. */ }
      }
    });
    // Drain diagnostics without recording them: CLI stderr can contain paths or account data.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => this._disconnect(child, new Error('Codex 连接已断开。')));
    child.once('error', (error) => this._disconnect(child, new Error(safeError(error))));
    child.once('exit', () => this._disconnect(child, new Error('Codex 连接已断开，请重新连接。')));
    try {
      await this.request('initialize', {
        clientInfo: { name: 'miniGPT', title: 'miniGPT', version },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized', {});
      this.ready = true;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  request(method, params = {}) {
    if (!this.child || this.child.killed) return Promise.reject(new Error('Codex 尚未连接。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex 请求超时，请检查网络后重试。'));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this._write({ id, method, params }, (error) => {
        if (!error) return;
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        reject(new Error('无法发送 Codex 请求。'));
      });
    });
  }

  notify(method, params = {}) { this._write({ method, params }); }

  _write(message, callback = () => {}) {
    if (!this.child?.stdin?.writable) return callback(new Error('Disconnected'));
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`, callback); }
    catch (error) { callback(error); }
  }

  _receive(message) {
    if (!message || typeof message !== 'object') return;
    if (message.method && message.id !== undefined) {
      // Built-in and connected tools execute inside App Server. Requests that
      // require a client-side executor or approval UI are not implemented here.
      this._write({ id: message.id, error: { code: -32601, message: 'This client-side tool or approval request is not supported by miniGPT.' } });
      this.emit('blockedRequest', message.method);
      return;
    }
    if (message.method) {
      this.emit('notification', message.method, message.params || {});
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      const stages = { 'thread/start': '创建对话', 'turn/start': '发送消息' };
      const stage = stages[entry.method] || '请求';
      const code = Number.isSafeInteger(message.error.code) ? `（错误码 ${message.error.code}）` : '';
      entry.reject(new Error(safeError(message.error, `Codex ${stage}失败${code}，请重新连接后重试。`)));
    }
    else entry.resolve(message.result);
  }

  _disconnect(child, error) {
    if (this.child !== child) return;
    this.child = null;
    this.ready = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.emit('disconnect', error);
  }

  close() {
    const child = this.child;
    if (!child) return;
    this._disconnect(child, new Error('Codex 连接已关闭。'));
    child.stdin.end();
    child.kill();
  }
}

module.exports = { CodexClient, SAFE_CONFIG, DISABLED_FEATURES, ENABLED_FEATURES, safeError };
