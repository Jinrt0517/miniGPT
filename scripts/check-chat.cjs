'use strict';

// Real subscription requests against the packaged application. All prompts,
// history and image content belong to this test; the OS clipboard is untouched.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomInt } = require('node:crypto');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

async function main() {
  const root = path.join(__dirname, '..');
  const testRoot = path.join(root, '.test-data', 'check-chat');
  fs.mkdirSync(testRoot, { recursive: true });
  const testDir = fs.mkdtempSync(path.join(testRoot, 'run-'));
  const env = { ...process.env, MINIGPT_DATA_DIR: testDir, MINIGPT_TEST_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = await _electron.launch({
    executablePath: path.join(root, 'dist', 'miniGPT-win32-x64', 'miniGPT.exe'),
    args: [], env, timeout: 30000,
  });
  let page;
  let clipboardOverridden = false;
  const pageErrors = [];
  const results = [];
  try {
    page = await electron.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.waitForFunction(() => Boolean(window.mini), null, { timeout: 30000 });
    await page.evaluate(() => {
      window.__miniChatCheck = { active: null, events: [] };
      window.mini.onEvent(event => {
        const check = window.__miniChatCheck;
        if (!check.active) return;
        if (event.type === 'delta') check.active.deltaCount += 1;
        else if (event.type === 'complete') check.active.completed = event.conversation;
        else if (event.type === 'error') check.active.error = event.message;
        else if (event.type === 'connection' && event.connection?.status === 'disconnected') {
          check.active.error = event.connection.error || 'Connection closed during the response';
        }
        if (event.type !== 'delta') check.events.push({
          type: event.type,
          status: event.conversation?.status || event.connection?.status,
          messageStatus: event.conversation?.messages?.at(-1)?.status,
          error: event.type === 'error' ? event.message : undefined,
        });
      });
    });
    await page.waitForFunction(() => {
      const select = document.getElementById('model-select');
      return select?.options.length && select.options[0].value && !select.disabled;
    }, null, { timeout: 60000 });
    const models = await page.evaluate(async () => {
      const bootstrap = await window.mini.invoke('bootstrap');
      if (bootstrap.connection.account?.type !== 'chatgpt') throw new Error('A ChatGPT subscription login is required');
      return bootstrap.connection.models;
    });
    assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);

    async function selectModel(model, preferLow = false) {
      assert.ok(model, 'An appropriate model must be available');
      const efforts = model.supportedReasoningEfforts.map(item => item.reasoningEffort);
      const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
      const effort = preferLow && efforts.includes('low') ? 'low' : order.find(value => efforts.includes(value)) || efforts[0];
      assert.ok(effort, 'The model must advertise a reasoning effort');
      await page.locator('#model-select').selectOption(model.model);
      await page.locator('#effort-select').selectOption(effort);
      return { model: model.model, effort };
    }

    async function sendAndCheck(label, prompt, expected) {
      await page.evaluate(() => {
        window.__miniChatCheck.active = { completed: null, deltaCount: 0, error: null };
      });
      await page.locator('#prompt').fill(prompt);
      await page.locator('#send-message').click();
      await page.waitForFunction(() => {
        const active = window.__miniChatCheck.active;
        return active.completed || active.error || !document.getElementById('error-bar').hidden;
      }, null, { timeout: 120000 });
      const response = await page.evaluate(() => {
        const active = window.__miniChatCheck.active;
        const conversation = active.completed;
        const answer = conversation?.messages?.at(-1);
        return {
          conversationId: conversation?.id, messageCount: conversation?.messages?.length,
          status: answer?.status, content: answer?.content || '', deltaCount: active.deltaCount,
          error: active.error || answer?.error || (!document.getElementById('error-bar').hidden ? document.getElementById('error-text').textContent : null),
        };
      });
      results.push({ label, ...response });
      assert.equal(response.error, null, `${label}: ${response.error || 'Unexpected error'}`);
      assert.equal(response.status, 'complete', `${label}: response must complete successfully`);
      assert.match(response.content, expected, `${label}: unexpected model answer`);
      await page.waitForFunction(() => !document.getElementById('model-select').disabled, null, { timeout: 10000 });
      await page.evaluate(() => { window.__miniChatCheck.active = null; });
      console.log(`${label}: complete (${response.deltaCount} streamed updates)`);
      return response;
    }

    const textModel = models.find(model => /luna/i.test(model.model)) || models.find(model => model.isDefault) || models[0];
    const selection = await selectModel(textModel, true);
    console.log(`Live text model: ${selection.model}; effort: ${selection.effort}`);
    const token = String(randomInt(100000, 1000000));
    const first = await sendAndCheck('Text conversation', `请记住测试编号 ${token}，只回复“已记住”。`, /已记住/);
    assert.equal(first.messageCount, 2);
    await page.locator('#new-chat').click();
    assert.ok(await page.locator('#welcome').isVisible());
    await page.locator('#history-toggle').click();
    assert.equal(await page.locator('.history-open').count(), 1);
    await page.locator('.history-open').first().click();
    const followup = await sendAndCheck('History continuation', '刚才的测试编号是什么？只回复数字。', new RegExp(token));
    assert.equal(followup.conversationId, first.conversationId);
    assert.equal(followup.messageCount, 4);

    await page.locator('#new-chat').click();
    const imageModels = models.filter(model => model.inputModalities?.includes('image'));
    const imageModel = imageModels.find(model => /luna/i.test(model.model)) || imageModels[0];
    const imageSelection = await selectModel(imageModel);
    console.log(`Live image model: ${imageSelection.model}; effort: ${imageSelection.effort}`);
    const dataUrl = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 128;
      const context = canvas.getContext('2d');
      context.fillStyle = '#ff0000';
      context.fillRect(0, 0, 128, 128);
      return canvas.toDataURL('image/png');
    });
    await electron.evaluate(({ clipboard }, image) => {
      const bytes = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
      globalThis.__miniChatOriginalClipboardRead = clipboard.read;
      clipboard.read = async () => [{
        types: ['image/png'],
        getType: async type => {
          if (type !== 'image/png') throw new Error('Unexpected fixture image format');
          return { size: bytes.length, arrayBuffer: async () => bytes };
        },
      }];
    }, dataUrl);
    clipboardOverridden = true;
    await page.locator('#attach-clipboard').click();
    await page.waitForFunction(() => document.querySelectorAll('#attachments .attachment-chip').length === 1, null, { timeout: 10000 });
    const imageReply = await sendAndCheck('Pasted image conversation', '这张图片的主要颜色是什么？用中文只回答颜色。', /红/);
    assert.notEqual(imageReply.conversationId, first.conversationId);
    assert.equal(imageReply.messageCount, 2);
    assert.deepEqual(pageErrors, []);
    console.log('Packaged live chat passed: text, history continuation and pasted synthetic image. The OS clipboard was not modified.');
  } catch (error) {
    if (page && !page.isClosed()) {
      const diagnostic = await page.evaluate(() => ({
        events: window.__miniChatCheck?.events || [],
        error: document.getElementById('error-text')?.textContent,
        model: document.getElementById('model-select')?.value,
        effort: document.getElementById('effort-select')?.value,
      })).catch(() => null);
      fs.writeFileSync(path.join(testDir, 'failure.json'), JSON.stringify({ message: error.message, pageErrors, results, diagnostic }, null, 2));
      console.error(`Failure details: ${path.join(testDir, 'failure.json')}`);
    }
    throw error;
  } finally {
    if (clipboardOverridden) await electron.evaluate(({ clipboard }) => {
      clipboard.read = globalThis.__miniChatOriginalClipboardRead;
      delete globalThis.__miniChatOriginalClipboardRead;
    }).catch(() => {});
    // Closing miniGPT's window hides it. Explicitly quit before Playwright closes
    // the process so teardown cannot wait on an application remaining in its tray.
    if (page && !page.isClosed()) await page.evaluate(() => window.mini.invoke('app:quit')).catch(() => {});
    await electron.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
