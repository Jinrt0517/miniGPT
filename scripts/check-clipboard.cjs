// Explicit read-only check of the user's current image clipboard, or an isolated
// renderer regression using --synthetic without accessing the OS clipboard.
// Never writes the clipboard, saves image data, or sends a chat message.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
(async () => {
  const root = path.join(__dirname, '..');
  const packaged = process.env.MINIGPT_VERIFY_PACKAGE === '1' || Boolean(process.env.MINIGPT_TEST_EXECUTABLE);
  const synthetic = process.argv.includes('--synthetic');
  const testRoot = path.join(root, '.test-data', 'clipboard');
  fs.mkdirSync(testRoot, { recursive: true });
  const testDir = fs.mkdtempSync(path.join(testRoot, 'run-'));
  const env = { ...process.env, MINIGPT_DATA_DIR: testDir, MINIGPT_TEST_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = await _electron.launch({
    executablePath: process.env.MINIGPT_TEST_EXECUTABLE || (packaged ? path.join(root, 'dist', 'miniGPT-win32-x64', 'miniGPT.exe') : require('electron')),
    args: packaged ? [] : [root], env, timeout: 30000
  });
  let clipboardOverridden = false;
  try {
    const page = await electron.firstWindow();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => Boolean(window.mini));
    assert.equal(await page.locator('#attach-clipboard').count(), 0);
    await page.locator('#prompt').focus();
    let resultMessage;
    if (synthetic) {
      const dataUrl = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 2; canvas.height = 2;
        canvas.getContext('2d').fillRect(0, 0, 2, 2);
        return canvas.toDataURL('image/png');
      });
      await electron.evaluate(({ clipboard }, image) => {
        const bytes = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
        globalThis.__miniOriginalClipboardRead = clipboard.read;
        globalThis.__miniClipboardReadCount = 0;
        clipboard.read = async () => {
          globalThis.__miniClipboardReadCount += 1;
          return [{ types: ['image/png'], getType: async () => ({ size: bytes.length, arrayBuffer: async () => bytes }) }];
        };
      }, dataUrl);
      clipboardOverridden = true;
      const canceled = await page.evaluate(image => {
        const bytes = Uint8Array.from(atob(image.slice(image.indexOf(',') + 1)), character => character.charCodeAt(0));
        const clipboardData = new DataTransfer();
        clipboardData.items.add(new File([bytes], 'synthetic.png', { type: 'image/png' }));
        return !document.getElementById('prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      }, dataUrl);
      assert.equal(canceled, true, 'Image paste must use the attachment handler');
      await page.waitForFunction(() => document.querySelectorAll('#attachments .attachment-chip').length === 1);
      const textCanceled = await page.evaluate(() => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', 'ordinary text');
        return !document.getElementById('prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      });
      assert.equal(textCanceled, false, 'Ordinary text paste must retain the browser default');
      assert.equal(await electron.evaluate(() => globalThis.__miniClipboardReadCount), 1);
      assert.equal(await page.locator('#attachments .attachment-chip').count(), 1);
      resultMessage = 'Synthetic image paste passed: button absent, image attached, text paste preserved. No OS clipboard access or chat requests.';
    } else {
      const items = await page.evaluate(() => window.mini.invoke('attachments:clipboard'));
      if (!items.length) throw new Error('剪贴板当前没有图片；请复制一张图片后运行此项检查。');
      assert.ok(items.every(item => item.kind === 'image' && item.id));
      // Invoke Chromium's real paste command without injecting desktop keyboard input.
      await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste());
      await page.waitForFunction(count => document.querySelectorAll('#attachments .attachment-chip').length === count, items.length);
      resultMessage = 'Native image clipboard and actual paste event passed. No clipboard writes, image files or chat requests.';
    }
    assert.equal(await page.locator('#error-bar').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log(resultMessage);
  } finally {
    if (clipboardOverridden) await electron.evaluate(({ clipboard }) => {
      clipboard.read = globalThis.__miniOriginalClipboardRead;
      delete globalThis.__miniOriginalClipboardRead;
      delete globalThis.__miniClipboardReadCount;
    }).catch(() => {});
    await electron.evaluate(({ app }) => app.quit()).catch(() => {});
    await electron.close().catch(() => {});
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
