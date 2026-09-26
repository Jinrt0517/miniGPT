'use strict';

// Invoke the registered callbacks with controlled visibility; no OS keystrokes,
// network requests, real conversations or clipboard changes are involved.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

async function run(conflict = '') {
  fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
  const testDir = fs.mkdtempSync(path.join(root, '.test-data', 'resume-shortcut-'));
  const env = { ...process.env, MINIGPT_DATA_DIR: testDir, MINIGPT_TEST_HEADLESS: '1', MINIGPT_TEST_CONFLICT: conflict };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/resume-shortcut.cjs')], env, timeout: 30000 });
  try {
    const page = await electron.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#model-select').value === 'test-model');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const bootstrap = await page.evaluate(() => window.mini.invoke('bootstrap'));
    assert.equal(bootstrap.hotkeyStatus.registered, true);
    assert.equal(bootstrap.hotkeyStatus.resumeShortcut.registered, !conflict);
    if (conflict) {
      assert.match(await page.locator('#resume-hotkey-status').textContent(), /未注册成功/);
      return;
    }
    const status = () => electron.evaluate(() => {
      const c = globalThis.__resumeCheck;
      return { visible: c.visible, hides: c.hides, stops: c.stops, sends: c.sends,
        fresh: c.events.filter(type => type === 'new-conversation').length };
    });
    const press = key => electron.evaluate((_electron, key) => {
      const callback = globalThis.__resumeCheck.shortcuts.get(key);
      if (!callback) throw new Error(`Shortcut not registered: ${key}`);
      return callback();
    }, key);
    const resume = 'Ctrl+Alt+Space';
    await page.locator('#prompt').fill('Keep this draft');
    await press(resume);
    assert.equal((await status()).visible, false);
    assert.equal((await status()).hides, 1);
    await press('Alt+Space');
    assert.equal((await status()).visible, true);
    assert.equal((await status()).fresh, 0);
    assert.equal(await page.locator('#prompt').inputValue(), 'Keep this draft');

    // Hide while waiting for a send result, then return with the new shortcut.
    await electron.evaluate(() => { globalThis.__resumeCheck.delaySend = true; });
    await page.locator('#send-message').click();
    await page.waitForFunction(() => document.querySelector('#send-message').getAttribute('aria-label') === '停止生成');
    await electron.evaluate(() => {
      if (!globalThis.__resumeCheck.releaseSend) throw new Error('Expected a pending send');
    });
    await press(resume);
    await press(resume);
    await electron.evaluate(() => globalThis.__resumeCheck.releaseSend());
    await page.waitForFunction(() => document.querySelector('#prompt').value === '');
    assert.deepEqual((await status()).stops, []);

    // Streaming continues while hidden, including after reopening with Alt+Space.
    await page.locator('#prompt').fill('Next question draft');
    await press(resume);
    await electron.evaluate(() => globalThis.__resumeCheck.delta('Still generating'));
    await press('Alt+Space');
    await page.waitForFunction(() => document.querySelector('.message-assistant')?.textContent.includes('Still generating'));
    assert.equal(await page.locator('#prompt').inputValue(), 'Next question draft');
    assert.equal((await status()).fresh, 0);
    assert.deepEqual((await status()).stops, []);
    // An ordinary hide may paint a fresh welcome preview, but it must keep
    // the underlying streaming conversation and draft available for resume.
    await press('Alt+Space');
    await page.waitForFunction(() => document.querySelector('#app').hasAttribute('data-welcome-preview'));
    await electron.evaluate(() => globalThis.__resumeCheck.delta('Updated behind the preview'));
    assert.deepEqual((await status()).stops, []);
    await press(resume);
    await page.waitForFunction(() => document.querySelector('.message-assistant')?.textContent.includes('Updated behind the preview'));
    assert.equal(await page.locator('#prompt').inputValue(), 'Next question draft');
    assert.deepEqual((await status()).stops, []);
    await press(resume);
    await electron.evaluate(() => globalThis.__resumeCheck.finish());
    await press(resume);
    await page.waitForFunction(() => document.querySelector('#send-message').getAttribute('aria-label') === '发送消息');
    await electron.evaluate(() => { globalThis.__resumeCheck.delaySend = false; });
    await page.locator('#send-message').click();
    await page.waitForFunction(() => document.querySelector('#prompt').value === '');
    assert.equal((await status()).sends[1].conversationId, 'test-conversation', 'Follow-up must use the same conversation ID');

    // Changing the normal key must leave the fixed resume key installed.
    await page.evaluate(() => window.mini.invoke('settings:update', { hotkey: 'Ctrl+Shift+Space' }));
    await press(resume);
    await press('Ctrl+Shift+Space');
    assert.equal((await status()).fresh, 0);
    assert.deepEqual((await status()).stops, []);
    await press(resume);
    await electron.evaluate(async ({ app }) => {
      app.emit('second-instance');
      while (!globalThis.__resumeCheck.visible) await new Promise(resolve => setTimeout(resolve, 10));
    });
    assert.equal((await status()).fresh, 0);

    // The preserve flag is consumed; ordinary hide/reopen still starts fresh.
    await press('Ctrl+Shift+Space');
    await press('Ctrl+Shift+Space');
    await page.waitForFunction(() => !document.querySelector('#welcome').hidden);
    assert.equal((await status()).fresh, 1);
    assert.deepEqual((await status()).stops, ['test-conversation']);
    assert.deepEqual(errors, []);
    assert.equal(await electron.evaluate(() => globalThis.__resumeCheck.nativeVisible()), false);
  } finally {
    await electron.evaluate(({ app }) => app.quit()).catch(() => {});
    await electron.close().catch(() => {});
  }
}

(async () => {
  await run();
  await run('Ctrl+Alt+Space');
  console.log('Resume shortcut passed: drafts, pending sends, hidden streaming, same-conversation follow-up, both shortcuts, custom shortcut, second-instance, normal reset, and conflict notice. No chat requests sent.');
})().catch(error => { console.error(error); process.exitCode = 1; });
