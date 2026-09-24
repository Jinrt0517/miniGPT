const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, screen, ipcMain,
  dialog, clipboard, shell, nativeTheme, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { SettingsStore, validateSettings } = require('./settings.cjs');
const { ChatService } = require('./chat-service.cjs');

app.setName('miniGPT');
// The text-first window also runs on Windows systems without a working GPU driver.
app.disableHardwareAcceleration();
const dataDir = process.env.MINIGPT_DATA_DIR || (app.isPackaged ? path.join(app.getPath('appData'), 'miniGPT') : path.join(__dirname, '..', '.local-data'));
fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);
app.setPath('sessionData', path.join(dataDir, 'chromium'));
const settings = new SettingsStore(dataDir);
const automatedTest = process.env.MINIGPT_TEST_HEADLESS === '1';
let win, tray, chat, connecting, quitting = false;
let connection = { account: null, models: [], error: null };
let hotkeyStatus = { registered: false, accelerator: settings.value.hotkey };
const attachments = new Map();
const pageURL = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
const sendEvent = data => { if (win && !win.isDestroyed()) win.webContents.send('mini:event', data); };

function locateCodex() {
  if (settings.value.codexPath) return settings.value.codexPath;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, 'codex.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  const base = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  try {
    const candidates = fs.readdirSync(base).map(dir => path.join(base, dir, 'codex.exe'))
      .filter(file => fs.existsSync(file)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (candidates.length) return candidates[0];
  } catch {}
  return 'codex';
}

function installShortcut(accelerator) {
  if (globalShortcut.isRegistered(accelerator)) return { registered: true, accelerator };
  const old = hotkeyStatus;
  let registered = false;
  try { registered = globalShortcut.register(accelerator, toggleWindow); } catch {}
  if (!registered) return { registered: false, accelerator, message: `${accelerator} 已被其他程序占用。请关闭占用它的豆包、ChatGPT 或 PowerToys 快捷键，或改用其他组合。` };
  if (old.registered && old.accelerator !== accelerator) globalShortcut.unregister(old.accelerator);
  return { registered: true, accelerator };
}

function showWindow(fresh = false) {
  if (!win || win.isDestroyed()) return;
  const display = settings.value.followCursor ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) : screen.getDisplayMatching(win.getBounds());
  const area = display.workArea;
  const [width, height] = win.getSize();
  const bounds = win.getBounds();
  const w = Math.min(width, area.width), h = Math.min(height, area.height);
  const x = settings.value.followCursor ? Math.round(area.x + (area.width - w) / 2) : Math.max(area.x, Math.min(bounds.x, area.x + area.width - w));
  const y = settings.value.followCursor ? Math.round(area.y + (area.height - h) * 0.34) : Math.max(area.y, Math.min(bounds.y, area.y + area.height - h));
  win.setBounds({ x, y, width: w, height: h });
  if (win.isMinimized()) win.restore();
  if (!automatedTest) { win.show(); win.focus(); }
  if (fresh === true) sendEvent({ type: 'new-conversation' });
  sendEvent({ type: 'focus' });
}
function toggleWindow() { if (win?.isVisible() && !win.isMinimized()) win.hide(); else showWindow(true); }

function updateTray() {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: `打开 miniGPT   ${settings.value.hotkey}`, click: () => showWindow(!win?.isVisible()) },
    { label: '窗口置顶', type: 'checkbox', checked: settings.value.alwaysOnTop, click: item => updateSettings({ alwaysOnTop: item.checked }) },
    { type: 'separator' }, { label: '退出 miniGPT', click: () => { quitting = true; app.quit(); } }
  ]));
}

function updateSettings(patch) {
  validateSettings(patch);
  if (patch.codexPath && !fs.existsSync(patch.codexPath)) throw new Error('找不到这个 Codex 可执行文件');
  if (patch.hotkey && patch.hotkey !== settings.value.hotkey) {
    const candidate = installShortcut(patch.hotkey);
    if (!candidate.registered) throw new Error(candidate.message);
    hotkeyStatus = candidate;
  }
  if (patch.launchAtLogin !== undefined && patch.launchAtLogin !== settings.value.launchAtLogin) {
    if (!app.isPackaged && patch.launchAtLogin) throw new Error('请先使用打包版 miniGPT.exe，再开启开机启动');
    app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin, path: process.execPath, args: ['--hidden'] });
  }
  const value = settings.save(patch);
  nativeTheme.themeSource = value.theme;
  win?.setAlwaysOnTop(value.alwaysOnTop);
  updateTray();
  sendEvent({ type: 'settings', settings: value, hotkeyStatus });
  return { settings: value, hotkeyStatus };
}

async function connect() {
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      if (chat) await chat.close();
      chat = new ChatService({ dataDir: path.join(dataDir, 'conversations'), codexPath: locateCodex(), persistHistory: true });
      chat.on('event', event => {
        if (event.type === 'connection' && event.connection) connection = event.connection;
        if (event.type === 'account') { connection = { ...connection, account: event.account }; sendEvent({ type: 'connection', connection }); }
        sendEvent(event);
      });
      connection = await chat.connect();
    }
    catch (error) { connection = { account: null, models: [], error: error.message }; }
    sendEvent({ type: 'connection', connection });
    return connection;
  })().finally(() => { connecting = null; });
  return connecting;
}

function addAttachment(item) {
  // Drafts are held only in memory until the user presses Send.
  if (attachments.size >= 50) attachments.delete(attachments.keys().next().value);
  const id = crypto.randomUUID();
  attachments.set(id, item);
  return { id, name: item.name, kind: item.type };
}
async function pickAttachments() {
  const result = await dialog.showOpenDialog(win, { title: '添加图片或文本', properties: ['openFile', 'multiSelections'], filters: [
    { name: '图片和文本', extensions: ['png', 'jpg', 'jpeg', 'webp', 'txt', 'md', 'csv', 'json', 'log', 'js', 'ts', 'py', 'html', 'css'] }
  ] });
  if (result.canceled) return [];
  if (result.filePaths.length > 8) throw new Error('每次最多添加 8 个附件');
  const prepared = [];
  for (const file of result.filePaths) {
    const ext = path.extname(file).toLowerCase();
    const image = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > (image ? 15 * 1024 * 1024 : 512 * 1024)) throw new Error('图片最大 15 MB，文本最大 512 KB');
    const bytes = await fs.promises.readFile(file);
    if (image) {
      const picture = nativeImage.createFromBuffer(bytes);
      if (picture.isEmpty()) throw new Error('无法读取这张图片');
      prepared.push({ type: 'image', name: path.basename(file), dataUrl: picture.toDataURL() });
    } else {
      const text = bytes.toString('utf8');
      if (text.includes('\0')) throw new Error('请选择 UTF-8 编码的文本文件');
      prepared.push({ type: 'text', name: path.basename(file), text });
    }
  }
  return prepared.map(addAttachment);
}

function safeExternal(url, auth = false) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('只允许打开网页链接');
  if (auth && (parsed.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com', 'auth0.openai.com'].includes(parsed.hostname))) throw new Error('登录地址不是受支持的官方地址');
  return shell.openExternal(parsed.href);
}

const actions = {
  bootstrap: async () => ({ settings: settings.value, connection, conversations: chat ? await chat.listConversations() : [], hotkeyStatus }),
  connect,
  login: async () => { if (!chat) await connect(); const result = await chat.login(); if (result.authUrl) await safeExternal(result.authUrl, true); return result; },
  'conversations:list': () => chat.listConversations(),
  'conversations:get': ({ id }) => chat.getConversation(id),
  'conversations:delete': ({ id }) => chat.deleteConversation(id),
  'chat:send': async payload => {
    if (connection.account?.type !== 'chatgpt') throw new Error('请先使用 ChatGPT 账号登录');
    if (!payload || typeof payload.text !== 'string' || payload.text.length > 100000) throw new Error('消息为空或过长');
    if (!Array.isArray(payload.attachments || []) || (payload.attachments || []).length > 8) throw new Error('每条消息最多 8 个附件');
    const ids = (payload.attachments || []).map(item => item.id);
    const files = ids.map(id => { if (!attachments.has(id)) throw new Error('附件已过期，请重新添加'); return attachments.get(id); });
    if (win.isVisible()) { const [width, height] = win.getSize(); if (height < 600) win.setSize(width, 680); }
    const result = await chat.send({ conversationId: payload.conversationId, text: payload.text, model: payload.model, effort: payload.effort, attachments: files });
    ids.forEach(id => attachments.delete(id));
    return result;
  },
  'chat:stop': ({ conversationId }) => chat.stop(conversationId),
  'attachments:pick': pickAttachments,
  'attachments:clipboard': () => { const image = clipboard.readImage(); return image.isEmpty() ? [] : [addAttachment({ type: 'image', name: '粘贴的图片.png', dataUrl: image.toDataURL() })]; },
  'settings:update': updateSettings,
  'window:hide': () => win.hide(),
  'window:expand': ({ expanded }) => { const [width] = win.getSize(); win.setSize(width, expanded ? 680 : 260); showWindow(); },
  'window:pin': ({ pinned }) => updateSettings({ alwaysOnTop: pinned }),
  'app:quit': () => { quitting = true; app.quit(); },
  'clipboard:write': ({ text }) => { if (typeof text !== 'string' || text.length > 2000000) throw new Error('复制内容无效'); clipboard.writeText(text); },
  'link:open': ({ url }) => safeExternal(url)
};

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showWindow(!win?.isVisible()));
  app.whenReady().then(async () => {
    nativeTheme.themeSource = settings.value.theme;
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    win = new BrowserWindow({ width: 600, height: 480, minWidth: 480, minHeight: 260,
      title: 'miniGPT', frame: false, show: false, backgroundColor: '#f8f9fb',
      alwaysOnTop: settings.value.alwaysOnTop, autoHideMenuBar: true,
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
    win.on('blur', () => { if (settings.value.hideOnBlur && !settings.value.alwaysOnTop) win.hide(); });
    ipcMain.handle('mini:invoke', async (event, action, payload) => {
      try {
        if (event.sender !== win.webContents || event.senderFrame?.url !== pageURL || !Object.hasOwn(actions, action)) throw new Error('不允许的请求');
        return { ok: true, data: await actions[action](payload) };
      } catch (error) { return { ok: false, error: error.message || '操作失败，请重试' }; }
    });
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')));
    tray.setToolTip('miniGPT · 随时聊聊'); tray.on('click', () => showWindow(!win?.isVisible()));
    hotkeyStatus = installShortcut(settings.value.hotkey); updateTray();
    await win.loadURL(pageURL);
    if (!process.argv.includes('--hidden')) showWindow();
    connect();
  }).catch(error => { dialog.showErrorBox('miniGPT 启动失败', error.message); quitting = true; app.quit(); });
}
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; chat?.close(); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); tray?.destroy(); });
