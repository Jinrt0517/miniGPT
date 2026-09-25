const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
const testDir = fs.mkdtempSync(path.join(root, '.test-data', 'window-state-'));
fs.writeFileSync(path.join(testDir, 'settings.json'), JSON.stringify({ followCursor: true, codexPath: path.join(testDir, 'unavailable-codex.exe') }));
const env = { ...process.env, MINIGPT_DATA_DIR: testDir, MINIGPT_TEST_HEADLESS: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.MINIGPT_TEST_EXECUTABLE || require('electron');

async function launch(args = []) {
  const app = await _electron.launch({ executablePath, args: process.env.MINIGPT_TEST_EXECUTABLE ? args : [root, ...args], env, timeout: 30000 });
  try {
    const page = await app.firstWindow({ timeout: 30000 });
    await page.waitForURL(url => url.protocol === 'file:' && url.pathname.endsWith('/index.html'));
    await page.waitForLoadState('load');
    await page.waitForFunction(() => document.getElementById('setting-follow-mouse').checked);
    await app.evaluate(() => new Promise(resolve => setImmediate(resolve)));
    return app;
  } catch (error) {
    app.process().kill();
    await app.close().catch(() => {});
    throw error;
  }
}

const getBounds = app => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
const position = ({ x, y }) => ({ x, y });
const savedBounds = () => JSON.parse(fs.readFileSync(path.join(testDir, 'window-state.json'), 'utf8')).bounds;

async function quit(app, fromSettings = false) {
  const page = await app.firstWindow();
  const closed = app.waitForEvent('close', { timeout: 10000 });
  // The real quit action saves bounds in before-quit; closing a window only hides it.
  const action = fromSettings ? page.locator('#quit-app').click() : page.evaluate(() => window.mini.invoke('app:quit'));
  await action.catch(error => {
    if (!/Target.*closed|has been closed/i.test(error.message)) throw error;
  });
  await closed;
}

async function openSettings(app, expectedPosition) {
  const page = await app.firstWindow();
  await page.locator('#settings-toggle').click();
  await page.locator('#settings-panel').waitFor({ state: 'visible' });
  const bounds = await getBounds(app);
  assert.deepEqual(position(bounds), expectedPosition, 'Opening settings must keep the current position.');
  return bounds;
}

async function setCompact(app, compact, expectedPosition) {
  const page = await app.firstWindow();
  await page.locator('#expand-window').click();
  await page.waitForFunction(value => document.getElementById('app').classList.contains('compact') === value, compact);
  const bounds = await getBounds(app);
  assert.deepEqual(position(bounds), expectedPosition, 'Toggling compact mode must keep the current position.');
  const targetHeight = compact ? 260 : 680;
  assert.ok(bounds.height >= targetHeight && bounds.height <= targetHeight + 10,
    `Expected ${compact ? 'compact' : 'expanded'} height near ${targetHeight} DIP, received ${bounds.height}.`);
  return bounds;
}

(async () => {
  let app;
  try {
    app = await launch();
    const bounds = await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      if (area.width < 800 || area.height < 750) throw new Error('Window persistence UI checks need a work area of at least 800 x 750 DIP.');
      // Leave room for the settings panel's 680-DIP height at a clearly noncentral location.
      window.setBounds({ x: area.x + 37, y: area.y + 53, width: 710, height: 530 });
      return window.getBounds();
    });
    const expectedPosition = position(bounds);
    assert.deepEqual(await openSettings(app, expectedPosition), bounds, 'Opening settings in an expanded window must preserve its custom size as well as position.');
    await quit(app, true); app = null;
    assert.deepEqual(savedBounds(), bounds, 'Quitting from settings should save the position and size actually shown.');

    app = await launch();
    assert.deepEqual(await getBounds(app), bounds, 'Saved custom bounds should survive startup even when followCursor is enabled.');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    await setCompact(app, true, expectedPosition);
    await setCompact(app, false, expectedPosition);
    const compactBounds = await setCompact(app, true, expectedPosition);
    await quit(app); app = null;
    assert.deepEqual(savedBounds(), compactBounds);

    app = await launch(['--hidden']);
    assert.deepEqual(await getBounds(app), compactBounds, 'Hidden startup should restore compact bounds exactly.');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.getElementById('app').classList.contains('compact'));
    for (let summon = 1; summon <= 3; summon++) {
      await page.evaluate(() => window.mini.invoke('window:hide'));
      await app.evaluate(({ app }) => app.emit('second-instance'));
      assert.deepEqual(await getBounds(app), compactBounds, `Same-display summon ${summon} must preserve saved position and size.`);
    }
    const quitBounds = await openSettings(app, expectedPosition);
    await quit(app, true); app = null;
    assert.deepEqual(savedBounds(), quitBounds);
    console.log('Window persistence passed: settings/compact actions, actual settings quit/relaunch, exact bounds, hidden compact startup and repeated same-display summons.');
  } finally {
    if (app) await quit(app).catch(() => app.close());
    const resolved = fs.realpathSync(testDir);
    if (path.dirname(resolved) !== fs.realpathSync(path.join(root, '.test-data'))) throw new Error('Unexpected test directory.');
    try { fs.rmSync(resolved, { recursive: true, force: true }); }
    catch { console.warn(`Test artifacts retained at ${testDir}`); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
