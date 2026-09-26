'use strict';

// Explicit opt-in performs one real image generation using the existing Codex
// login. Tests use a hidden window and an isolated history; no clipboard access.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

async function main() {
  const replayDir = process.env.MINIGPT_IMAGE_REPLAY;
  if (!replayDir && process.env.MINIGPT_LIVE_TEST !== '1') throw new Error('Set MINIGPT_LIVE_TEST=1 to run one real image generation.');
  const root = path.join(__dirname, '..');
  const testRoot = path.join(root, '.test-data', 'image-generation');
  fs.mkdirSync(testRoot, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(testRoot, 'run-'));
  if (replayDir) {
    fs.mkdirSync(path.join(dataDir, 'conversations'));
    fs.copyFileSync(path.join(replayDir, 'conversations', 'conversations.json'), path.join(dataDir, 'conversations', 'conversations.json'));
  }
  const env = { ...process.env, MINIGPT_DATA_DIR: dataDir, MINIGPT_TEST_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.env.MINIGPT_TEST_EXECUTABLE;
  const launch = () => _electron.launch({ executablePath: packaged || require('electron'), args: packaged ? [] : [root], env, timeout: 30000 });
  let app;
  const pageErrors = [];
  try {
    app = await launch();
    let page = await app.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#model-select').options.length && !document.querySelector('#model-select').disabled, null, { timeout: 90000 });
    const bootstrap = await page.evaluate(() => window.mini.invoke('bootstrap'));
    assert.equal(bootstrap.connection.account.type, 'chatgpt');
    if (replayDir) {
      await page.locator('#history-toggle').click();
      await page.locator('.history-item').first().click();
    } else {
      const model = bootstrap.connection.models.find(item => /luna/i.test(item.model)) || bootstrap.connection.models.find(item => item.isDefault);
      await page.selectOption('#model-select', model.model, { force: true });
      if (model.supportedReasoningEfforts.some(item => item.reasoningEffort === 'low')) await page.selectOption('#effort-select', 'low', { force: true });
      await page.locator('#prompt').fill('$imagegen 请生成一张白色背景上的橘猫插画，不要文字。');
      await page.locator('#send-message').click();
    }
    await page.waitForFunction(() => {
      const image = document.querySelector('.generated-image img');
      return image?.complete && image.naturalWidth > 0;
    }, null, { timeout: 600000 });
    await page.waitForFunction(() => document.querySelector('#send-message use').getAttribute('href') === '#i-arrow', null, { timeout: 90000 });
    const conversations = await page.evaluate(() => window.mini.invoke('conversations:list'));
    const conversation = await page.evaluate(id => window.mini.invoke('conversations:get', { id }), conversations[0].id);
    const assistant = conversation.messages.find(message => message.role === 'assistant' && message.images?.length);
    assert.ok(assistant);
    assert.equal(assistant.status, 'complete');
    console.log(replayDir ? 'Existing image displayed:' : 'Live image generated and displayed:', JSON.stringify(await page.locator('.generated-image img').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }))));
    const savedFile = path.join(dataDir, 'saved-image.png');
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, savedFile);
    await page.getByRole('button', { name: '保存图片', exact: true }).click();
    await page.waitForFunction(() => document.body.innerText.includes('图片已保存'));
    assert.deepEqual(fs.readFileSync(savedFile), Buffer.from(assistant.images[0].dataUrl.split(',')[1], 'base64'));
    await page.screenshot({ path: path.join(dataDir, 'generated-image.png') });
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.waitForFunction(() => !document.querySelector('#model-select').disabled, null, { timeout: 90000 });
    await page.locator('#history-toggle').click();
    await page.locator('.history-item').first().click();
    await page.waitForFunction(() => document.querySelector('.generated-image img')?.naturalWidth > 0);
    assert.equal(await page.locator('.generated-image img').count(), assistant.images.length);
    assert.deepEqual(pageErrors, []);
    console.log('Image save, persisted history and restart rendering passed. Evidence:', dataDir);
  } finally { if (app) await app.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
