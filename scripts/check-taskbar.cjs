const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// This is deliberately headful: Explorer's real taskbar and foreground policy
// are the behavior under test. Run it on an unlocked Windows desktop in isolation.
if (process.platform !== 'win32') {
  console.log('SKIP: taskbar integration requires a Windows desktop.');
  process.exit(0);
}

const root = path.resolve(__dirname, '..');
const testRoot = path.join(root, '.test-data');
fs.mkdirSync(testRoot, { recursive: true });
const testDir = fs.mkdtempSync(path.join(testRoot, 'taskbar-'));
fs.writeFileSync(path.join(testDir, 'settings.json'), JSON.stringify({
  hotkey: 'Ctrl+Alt+Shift+F11', followCursor: false, hideOnBlur: false,
  alwaysOnTop: false, codexPath: path.join(testDir, 'unavailable-codex.exe')
}));
const env = { ...process.env, MINIGPT_DATA_DIR: testDir };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MINIGPT_TEST_HEADLESS;
const executablePath = process.env.MINIGPT_TEST_EXECUTABLE || require('electron');
const fixtureShortcut = 'Ctrl+Alt+Shift+F10';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const WS_EX_TOPMOST = 0x8;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_APPWINDOW = 0x40000;

function nativeState(handles, focus = false) {
  // Never inject a shortcut unless this process successfully registered it.
  if (focus) assert.equal(handles.shortcutRegistered, true, 'Fixture shortcut must be registered before focus injection.');
  return JSON.parse(execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'taskbar-probe.ps1'),
    '-MainHandle', String(handles.main), '-FullscreenHandle', String(handles.full || 0),
    ...(focus ? ['-FocusFullscreen'] : [])
  ], { encoding: 'utf8', windowsHide: true, timeout: 15000 }));
}

function assertExcluded(state, handle) {
  const main = state.windows.find(window => window.handle === handle);
  assert.ok(main, 'The main native window must exist.');
  assert.ok(main.style & WS_EX_TOOLWINDOW, 'WS_EX_TOOLWINDOW must exclude miniGPT from taskbar and Alt+Tab.');
  assert.equal(main.style & WS_EX_APPWINDOW, 0, 'WS_EX_APPWINDOW must be absent.');
  return main;
}

function taskbarForFixture(state, handles) {
  const fixture = state.windows.find(window => window.handle === handles.full);
  assert.ok(fixture?.visible, 'The fixture must be visible.');
  const taskbar = state.windows.find(window => /^(Shell_TrayWnd|Shell_SecondaryTrayWnd)$/.test(window.class) && window.monitor === fixture.monitor);
  assert.ok(taskbar, 'Explorer must provide a taskbar on the fixture display.');
  return { fixture, taskbar };
}

function assertFullscreenState(state, handles, foreground) {
  assertExcluded(state, handles.main);
  assert.equal(state.foreground, foreground, 'The expected window must have native keyboard focus.');
  const { fixture, taskbar } = taskbarForFixture(state, handles);
  assert.ok(taskbar.z > fixture.z, `Taskbar must remain behind fullscreen content: ${JSON.stringify(state)}`);
}

async function launch(hidden) {
  const args = hidden ? ['--hidden'] : [];
  const electron = await _electron.launch({
    executablePath, args: process.env.MINIGPT_TEST_EXECUTABLE ? args : [root, ...args], env, timeout: 30000
  });
  try {
    const page = await electron.firstWindow({ timeout: 30000 });
    await page.waitForURL(url => url.protocol === 'file:' && url.pathname.endsWith('/index.html'));
    await page.waitForFunction(() => typeof window.mini?.invoke === 'function');
    await page.waitForFunction(() => document.getElementById('setting-follow-mouse').checked === false);
    const main = await electron.evaluate(({ BrowserWindow }) => {
      global.taskbarCheckMain = BrowserWindow.getAllWindows()[0];
      const handle = global.taskbarCheckMain.getNativeWindowHandle();
      return Number(handle.length === 8 ? handle.readBigUInt64LE() : handle.readUInt32LE());
    });
    await pause(300);
    const window = assertExcluded(nativeState({ main }), main);
    assert.equal(window.visible, !hidden, `${hidden ? 'Hidden' : 'Regular'} startup visibility must be preserved.`);
    assert.deepEqual((await page.evaluate(() => window.mini.invoke('bootstrap'))).conversations, [], 'The test must not use real chats.');
    return { electron, page, main };
  } catch (error) {
    await electron.close().catch(() => {});
    throw error;
  }
}

async function destroyFixture(electron) {
  await electron.evaluate(({ globalShortcut }, shortcut) => {
    globalShortcut.unregister(shortcut);
    global.taskbarCheckFixture?.destroy();
    global.taskbarCheckFixture = null;
  }, fixtureShortcut);
}

async function createFixture(electron, kind) {
  const nextWindow = electron.waitForEvent('window');
  const handles = await electron.evaluate(async ({ BrowserWindow, screen, session, globalShortcut }, { kind, shortcut }) => {
    const main = global.taskbarCheckMain;
    const display = screen.getDisplayMatching(main.getBounds());
    const bounds = kind === 'native' ? display.bounds : {
      x: display.workArea.x + 20, y: display.workArea.y + 20,
      width: Math.min(900, display.workArea.width - 40), height: Math.min(600, display.workArea.height - 40)
    };
    // An isolated fixture session leaves miniGPT's permission policy unchanged.
    const fixtureSession = session.fromPartition('taskbar-regression-fixture');
    fixtureSession.setPermissionCheckHandler((_contents, permission) => permission === 'fullscreen');
    fixtureSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'fullscreen'));
    const fixture = new BrowserWindow({
      ...bounds, fullscreen: kind === 'native', frame: kind !== 'native', show: false,
      backgroundColor: '#182637', title: `miniGPT ${kind} fullscreen test`,
      webPreferences: { sandbox: true, session: fixtureSession }
    });
    global.taskbarCheckFixture = fixture;
    const html = `<html><body style="margin:30px;color:white;background:#182637;font:24px sans-serif">
      <p>miniGPT ${kind} fullscreen regression fixture</p>
      <button id="fullscreen" style="padding:20px" onclick="document.documentElement.requestFullscreen()">Enter webpage fullscreen</button>
      </body></html>`;
    await fixture.loadURL(`data:text/html,${encodeURIComponent(html)}`);
    const shortcutRegistered = globalShortcut.register(shortcut, () => { fixture.show(); fixture.focus(); });
    if (!shortcutRegistered) throw new Error(`Fixture shortcut ${shortcut} is unavailable; no keys were injected.`);
    fixture.show();
    const handle = window => {
      const buffer = window.getNativeWindowHandle();
      return Number(buffer.length === 8 ? buffer.readBigUInt64LE() : buffer.readUInt32LE());
    };
    return { main: handle(main), full: handle(fixture), shortcutRegistered };
  }, { kind, shortcut: fixtureShortcut });
  const fixturePage = await nextWindow;
  nativeState(handles, true);
  if (kind === 'html') {
    // Playwright's trusted input supplies the activation required by the Web API.
    await fixturePage.locator('#fullscreen').click();
    await fixturePage.waitForFunction(() => Boolean(document.fullscreenElement));
  }
  await pause(700);
  return handles;
}

async function checkFullscreen({ electron, page }, kind) {
  const handles = await createFixture(electron, kind);
  assertFullscreenState(nativeState(handles, true), handles, handles.full);
  for (const pinned of [false, true]) {
    await page.evaluate(pinned => window.mini.invoke('settings:update', { alwaysOnTop: pinned }), pinned);
    for (let repeat = 0; repeat < 2; repeat++) {
      await page.evaluate(() => window.mini.invoke('window:hide'));
      assertFullscreenState(nativeState(handles, true), handles, handles.full);
      // Exercise the app's actual show path without replacing native behavior.
      await electron.evaluate(({ app }) => app.emit('second-instance'));
      await pause(400);
      const summoned = nativeState(handles);
      assertFullscreenState(summoned, handles, handles.main);
      assert.equal(Boolean(assertExcluded(summoned, handles.main).style & WS_EX_TOPMOST), pinned,
        'Summoning over fullscreen must preserve the native pin state.');
      await page.waitForFunction(() => document.activeElement?.id === 'prompt');
      await page.keyboard.type('keyboard focus check');
      assert.equal(await page.locator('#prompt').inputValue(), 'keyboard focus check');
      await page.locator('#prompt').fill('');

      if (!(await page.locator('#app').evaluate(element => element.classList.contains('compact')))) {
        await page.locator('#expand-window').click();
        await page.waitForFunction(() => document.getElementById('app').classList.contains('compact'));
      }
      await page.locator('#settings-toggle').click();
      await page.locator('#settings-panel').waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.getElementById('app').classList.contains('compact'));
      await pause(250);
      const expanded = nativeState(handles);
      assertFullscreenState(expanded, handles, handles.main);
      assert.equal(Boolean(assertExcluded(expanded, handles.main).style & WS_EX_TOPMOST), pinned,
        'Expanding settings over fullscreen must preserve the native pin state.');
      await page.locator('#settings-panel .panel-close').click();
      console.log(`PASS: ${kind} fullscreen, pinned=${pinned}, summon=${repeat + 1}, input and settings.`);
    }
  }
  await page.evaluate(() => window.mini.invoke('window:hide'));
  await destroyFixture(electron);
}

async function checkOrdinary({ electron, page }) {
  await page.evaluate(() => window.mini.invoke('settings:update', { alwaysOnTop: false }));
  const handles = await createFixture(electron, 'ordinary');
  const assertNormalTaskbar = state => {
    const { taskbar } = taskbarForFixture(state, handles);
    assert.ok(taskbar.style & WS_EX_TOPMOST, 'Ordinary windows must leave the taskbar in its normal topmost band.');
  };
  const baseline = nativeState(handles, true);
  assert.equal(baseline.foreground, handles.full);
  assertNormalTaskbar(baseline);
  await electron.evaluate(({ app }) => app.emit('second-instance'));
  await pause(500);
  const shown = nativeState(handles);
  assert.equal(shown.foreground, handles.main, 'Ordinary summon must focus miniGPT.');
  assertExcluded(shown, handles.main);
  assertNormalTaskbar(shown);
  await page.evaluate(() => window.mini.invoke('window:hide'));
  assertNormalTaskbar(nativeState(handles, true));
  await destroyFixture(electron);
  console.log('PASS: ordinary-window summon restores normal taskbar behavior.');
}

(async () => {
  let app;
  try {
    app = await launch(false);
    await app.electron.close(); app = null;
    app = await launch(true);
    console.log('PASS: regular and hidden startup exclude miniGPT from the taskbar.');
    await checkFullscreen(app, 'native');
    await checkFullscreen(app, 'html');
    await checkOrdinary(app);
    console.log('Windows taskbar integration passed.');
  } finally {
    try {
      if (app) {
        await destroyFixture(app.electron).catch(() => {});
        await app.electron.close();
      }
    } finally {
      const resolved = fs.realpathSync(testDir);
      if (path.dirname(resolved) !== fs.realpathSync(testRoot)) throw new Error('Unexpected test directory; refusing cleanup.');
      try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch { console.warn(`Test artifacts retained at ${testDir}`); }
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
