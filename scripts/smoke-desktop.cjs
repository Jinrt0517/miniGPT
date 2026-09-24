const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
// CI and desktop tool hosts may close output pipes before the child exits.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const root = path.join(__dirname, '..');
const testDir = path.join(root, '.test-data', 'integration');
fs.mkdirSync(testDir, { recursive: true });
(async () => {
  const env = { ...process.env, MINIGPT_DATA_DIR: testDir, MINIGPT_TEST_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = await _electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 30000 });
  try {
    const page = await electron.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.getElementById('model-select').options.length > 1, null, { timeout: 60000 });
    const bootstrap = await page.evaluate(() => window.mini.invoke('bootstrap'));
    assert.equal(bootstrap.connection.account.type, 'chatgpt');
    assert.ok(bootstrap.connection.models.length > 0);
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    console.log(`Connected to subscription; ${bootstrap.connection.models.length} models; shortcut registered: ${bootstrap.hotkeyStatus.registered}`);
    await page.locator('#pin-toggle').click();
    await page.waitForFunction(expected => document.getElementById('pin-toggle').getAttribute('aria-pressed') === String(expected), !bootstrap.settings.alwaysOnTop);
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), !bootstrap.settings.alwaysOnTop);
    await page.evaluate(() => window.mini.invoke('settings:update', { theme: 'light', alwaysOnTop: false }));
    await page.screenshot({ path: path.join(testDir, 'light.png') });
    await page.evaluate(() => window.mini.invoke('settings:update', { theme: 'dark' }));
    await page.screenshot({ path: path.join(testDir, 'dark.png') });
    await page.locator('#settings-toggle').click();
    assert.ok(await page.locator('#settings-panel').isVisible());
    await page.locator('#settings-panel .panel-close').click();
    await page.locator('#expand-window').click();
    const compactHeight = (await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize()))[1];
    assert.ok(compactHeight >= 260 && compactHeight <= 270, `Compact height: ${compactHeight}`);
    await page.locator('#expand-window').click();
    await page.locator('#prompt').fill('中文输入法检查');
    await page.locator('#prompt').dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    assert.equal(await page.locator('#prompt').inputValue(), '中文输入法检查');
    await page.locator('#prompt').fill('');
    if (process.env.MINIGPT_LIVE_TEST === '1') {
      const model = bootstrap.connection.models.find(m => /luna/i.test(m.model)) || bootstrap.connection.models.find(m=>m.isDefault) || bootstrap.connection.models[0];
      await page.locator('#model-select').selectOption(model.model);
      await page.locator('#effort-select').selectOption(model.supportedReasoningEfforts[0].reasoningEffort);
      await page.locator('#prompt').fill('请记住测试编号是 826，只回复：已记住。');
      await page.locator('#send-message').click();
      await page.waitForFunction(() => document.querySelectorAll('.message-assistant').length > 0 && !document.querySelector('.message.streaming') && document.getElementById('send-message').getAttribute('aria-label') === '发送消息', null, { timeout: 90000 });
      const conversations = await page.evaluate(() => window.mini.invoke('conversations:list'));
      const id = conversations[0].id;
      await page.locator('#new-chat').click();
      assert.ok(await page.locator('#welcome').isVisible());
      await page.locator('#history-toggle').click();
      await page.locator('.history-open').first().click();
      await page.locator('#prompt').fill('刚才的测试编号是什么？只回复数字。');
      await page.locator('#send-message').click();
      await page.waitForFunction(() => document.getElementById('send-message').getAttribute('aria-label') === '发送消息' && document.querySelectorAll('.message-assistant').length >= 2, null, { timeout: 90000 });
      const conversation = await page.evaluate(id => window.mini.invoke('conversations:get', { id }), id);
      assert.match(conversation.messages.at(-1).content, /826/);
      console.log('Live UI streaming + history continuation passed.');
      await page.locator('#new-chat').click();
    }
    assert.deepEqual(errors, []);
    console.log('Desktop integration passed: account, models, pin, themes, settings, compact size, Chinese IME.');
  } finally { await electron.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
