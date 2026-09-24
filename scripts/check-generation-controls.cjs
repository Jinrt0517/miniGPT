'use strict';

// Exercise the real renderer and SVG rendering with controlled IPC timing.
// No chat request is sent, and the user's history and clipboard are untouched.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

async function main() {
  const root = path.join(__dirname, '..');
  const testRoot = path.join(root, '.test-data', 'generation-controls');
  fs.mkdirSync(testRoot, { recursive: true });
  const testDir = fs.mkdtempSync(path.join(testRoot, 'run-'));
  const env = { ...process.env, MINIGPT_DATA_DIR: testDir, MINIGPT_TEST_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = await _electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 30000 });
  const pageErrors = [];
  try {
    const page = await electron.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.waitForFunction(() => Boolean(window.mini));
    await electron.evaluate(({ ipcMain, BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const originalSend = contents.send.bind(contents);
      // The app's initial account connection may finish after the mock is
      // installed. Its notifications must not alter this controlled fixture.
      contents.send = (channel, ...args) => {
        if (channel === 'mini:event' && args[0]?.type === 'connection') return;
        return originalSend(channel, ...args);
      };
      globalThis.__miniGenerationCheck = { calls: [], holds: {}, mode: 'expand', conversation: null };
      const connection = {
        status: 'connected', account: { type: 'chatgpt', email: 'renderer-test@example.invalid', planType: 'test' },
        models: [{ id: 'test-model', model: 'test-model', displayName: 'Renderer test', isDefault: true,
          defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], inputModalities: ['text'] }],
      };
      const makeConversation = () => ({
        id: 'test-conversation', title: 'Generation control test', status: 'generating',
        model: 'test-model', effort: 'low', updatedAt: new Date().toISOString(),
        messages: [
          { id: 'test-user', role: 'user', content: 'Generation control test', status: 'complete' },
          { id: 'test-assistant', role: 'assistant', content: '', status: 'streaming' },
        ],
      });
      globalThis.__emitMiniGenerationConversation = () => {
        const check = globalThis.__miniGenerationCheck;
        check.conversation = makeConversation();
        contents.send('mini:event', { type: 'conversation', conversation: check.conversation });
      };
      ipcMain.removeHandler('mini:invoke');
      ipcMain.handle('mini:invoke', async (_event, action, payload) => {
        const check = globalThis.__miniGenerationCheck;
        const hold = name => new Promise(resolve => { check.holds[name] = resolve; });
        if (action === 'test:status') return { ok: true, data: { calls: check.calls, holds: Object.keys(check.holds) } };
        check.calls.push({ action, payload });
        let data;
        if (action === 'bootstrap') data = { settings: { theme: 'light' }, connection, conversations: [], hotkeyStatus: true };
        else if (action === 'window:expand') data = check.mode === 'expand' ? await hold('expand') : { expanded: true };
        else if (action === 'chat:send') {
          if (check.mode === 'delayed') data = await hold('send');
          else { globalThis.__emitMiniGenerationConversation(); data = { conversationId: check.conversation.id }; }
        } else if (action === 'chat:stop') data = await hold('stop');
        else if (action === 'conversations:get') data = check.conversation;
        else if (action === 'conversations:list') data = check.conversation ? [check.conversation] : [];
        else throw new Error(`Unexpected test IPC action: ${action}`);
        return { ok: true, data };
      });
    });

    async function reset(mode) {
      await electron.evaluate((_electron, value) => {
        globalThis.__miniGenerationCheck = { calls: [], holds: {}, mode: value, conversation: null };
      }, mode);
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#model-select').value === 'test-model' && !document.querySelector('#model-select').disabled);
      await page.locator('#prompt').fill('Generation control test');
      await assertIcon('arrow', false);
    }
    async function assertIcon(name, disabled) {
      await page.waitForFunction(({ name, disabled }) => {
        const button = document.querySelector('#send-message');
        return button.querySelector('use').getAttribute('href') === `#i-${name}` && button.disabled === disabled;
      }, { name, disabled });
      const appearance = await page.locator('#send-message').evaluate(button => {
        const svg = button.querySelector('svg');
        const style = getComputedStyle(svg);
        const bounds = svg.getBoundingClientRect();
        const drawing = svg.getBBox();
        return {
          svgCount: button.querySelectorAll('svg').length,
          references: [...button.querySelectorAll('use')].map(use => use.getAttribute('href')),
          visible: style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0,
          width: bounds.width, height: bounds.height, drawingWidth: drawing.width, drawingHeight: drawing.height,
          label: button.getAttribute('aria-label'),
        };
      });
      assert.equal(appearance.svgCount, 1, 'Exactly one SVG must render inside the control');
      assert.deepEqual(appearance.references, [`#i-${name}`], 'Pause and arrow must never overlap');
      assert.equal(appearance.visible, true);
      assert.ok(appearance.width > 0 && appearance.height > 0 && appearance.drawingWidth > 0 && appearance.drawingHeight > 0, 'The selected SVG must have a visible drawing');
      assert.equal(appearance.label, name === 'pause' ? '停止生成' : '发送消息');
    }
    async function waitForCalls(action, count) {
      await page.waitForFunction(async ({ action, count }) => {
        const status = await window.mini.invoke('test:status');
        return status.calls.filter(call => call.action === action).length === count;
      }, { action, count });
    }
    async function calls(action) {
      const status = await page.evaluate(() => window.mini.invoke('test:status'));
      return status.calls.filter(call => call.action === action);
    }
    async function release(name, data) {
      await electron.evaluate((_electron, { name, data }) => {
        const check = globalThis.__miniGenerationCheck;
        const resolve = check.holds[name];
        if (!resolve) throw new Error(`Missing deferred test action: ${name}`);
        delete check.holds[name];
        resolve(data);
      }, { name, data });
    }
    async function finish(status) {
      await electron.evaluate(({ BrowserWindow }, status) => {
        const check = globalThis.__miniGenerationCheck;
        check.conversation.status = status;
        const message = check.conversation.messages.at(-1);
        message.status = status;
        message.content = status === 'complete' ? 'Test response complete' : 'Test response interrupted';
        BrowserWindow.getAllWindows()[0].webContents.send('mini:event', { type: 'complete', conversation: check.conversation });
      }, status);
    }

    // A click during window expansion must cancel before any chat submission.
    await reset('expand');
    await page.locator('#send-message').click();
    await waitForCalls('window:expand', 1);
    await assertIcon('pause', false);
    await page.locator('#send-message').click();
    await assertIcon('pause', true);
    await release('expand', { expanded: true });
    await assertIcon('arrow', false);
    assert.equal((await calls('chat:send')).length, 0);
    assert.equal((await calls('chat:stop')).length, 0);
    assert.equal(await page.locator('#prompt').inputValue(), 'Generation control test');

    // Stop requested before the conversation ID arrives must be remembered.
    await reset('delayed');
    await page.locator('#send-message').click();
    await waitForCalls('chat:send', 1);
    await assertIcon('pause', false);
    await page.locator('#send-message').click();
    await assertIcon('pause', true);
    assert.equal((await calls('chat:stop')).length, 0);
    await electron.evaluate(() => globalThis.__emitMiniGenerationConversation());
    await waitForCalls('chat:stop', 1);
    assert.equal((await calls('chat:stop'))[0].payload.conversationId, 'test-conversation');
    await release('send', { conversationId: 'test-conversation' });
    await page.waitForFunction(() => document.querySelector('#prompt').value === '');
    await finish('interrupted');
    await release('stop', { stopped: true });
    await assertIcon('arrow', true);

    // During streaming the control must remain clickable, then block repeats.
    await reset('active');
    await page.locator('#send-message').click();
    await page.waitForFunction(() => document.querySelector('#prompt').value === '');
    await assertIcon('pause', false);
    await page.locator('#send-message').click();
    await waitForCalls('chat:stop', 1);
    await assertIcon('pause', true);
    await page.locator('#send-message').evaluate(button => { button.click(); button.click(); });
    assert.equal((await calls('chat:stop')).length, 1, 'Disabled control must not send repeated interrupts');
    await finish('interrupted');
    await release('stop', { stopped: true });
    await assertIcon('arrow', true);

    // A normal completion must restore sending without a stop click.
    await reset('active');
    await page.locator('#send-message').click();
    await page.waitForFunction(() => document.querySelector('#prompt').value === '');
    await assertIcon('pause', false);
    await finish('complete');
    await assertIcon('arrow', true);
    assert.equal((await calls('chat:stop')).length, 0);
    assert.deepEqual(pageErrors, []);
    assert.equal(await page.locator('#error-bar').isVisible(), false);
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    console.log('Generation controls passed: visible pause icon, queued cancellation, interruption, duplicate-click protection, and completion. No chat requests sent.');
  } finally {
    await electron.evaluate(({ app }) => app.quit()).catch(() => {});
    await electron.close().catch(() => {});
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
