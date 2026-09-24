// Explicit read-only check of the user's current image clipboard.
// Never writes the clipboard, saves image data, or sends a chat message.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
(async () => {
  const root = path.join(__dirname, '..');
  const packaged = process.env.MINIGPT_VERIFY_PACKAGE === '1';
  const env = { ...process.env, MINIGPT_DATA_DIR: path.join(root, '.test-data', 'clipboard'), MINIGPT_TEST_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = await _electron.launch({
    executablePath: packaged ? path.join(root, 'dist', 'miniGPT-win32-x64', 'miniGPT.exe') : require('electron'),
    args: packaged ? [] : [root], env, timeout: 30000
  });
  try {
    const page = await electron.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => Boolean(window.mini));
    const items = await page.evaluate(() => window.mini.invoke('attachments:clipboard'));
    if (!items.length) throw new Error('剪贴板当前没有图片；请复制一张图片后运行此项检查。');
    assert.ok(items.every(item => item.kind === 'image' && item.id));
    await page.locator('#attach-clipboard').click();
    await page.waitForFunction(count => document.querySelectorAll('#attachments .attachment-chip').length === count, items.length);
    await page.locator('#prompt').focus();
    // Invoke Chromium's real paste command without injecting desktop keyboard input.
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste());
    await page.waitForFunction(count => document.querySelectorAll('#attachments .attachment-chip').length > count, items.length);
    assert.equal(await page.locator('#error-bar').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('Native image clipboard, paste button and actual paste event passed. No clipboard writes, image files or chat requests.');
  } finally { await electron.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
