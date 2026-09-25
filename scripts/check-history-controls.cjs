'use strict';

// Exercise the real renderer with isolated history and controlled IPC timing.
// The Electron window stays hidden; no chat request or user-data mutation occurs.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const trace = message => { if (process.env.MINIGPT_TEST_TRACE === '1') console.log(message); };

async function main() {
  const root = path.join(__dirname, '..');
  const testRoot = path.join(root, '.test-data', 'history-controls');
  fs.mkdirSync(testRoot, { recursive: true });
  const testDir = fs.mkdtempSync(path.join(testRoot, 'run-'));
  const env = { ...process.env, MINIGPT_DATA_DIR: testDir, MINIGPT_TEST_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = await _electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 30000 });
  const pageErrors = [];
  let page;
  try {
    page = await electron.firstWindow();
    page.setDefaultTimeout(10000);
    // Hidden Windows compositors can pause slide-in animations between frames,
    // including after a fixture reload. Keep real clicks and visibility checks
    // while using the renderer's reduced-motion mode throughout the suite.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => trace(`Renderer ${message.type()}: ${message.text()}`));
    await page.waitForFunction(() => Boolean(window.mini));
    await electron.evaluate(({ ipcMain, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const contents = win.webContents;
      contents.setBackgroundThrottling(false);
      const originalSend = contents.send.bind(contents);
      // Initial account notifications must not overwrite the controlled fixture.
      contents.send = (channel, ...args) => {
        if (channel === 'mini:event' && args[0]?.type === 'connection') return;
        return originalSend(channel, ...args);
      };
      const connection = {
        status: 'connected', account: { type: 'chatgpt', email: 'renderer-test@example.invalid', planType: 'test' },
        models: [{ id: 'test-model', model: 'test-model', displayName: 'Renderer test', isDefault: true,
          defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], inputModalities: ['text'] }],
      };
      const fixture = ['Alpha', 'Beta', 'Gamma'].map((name, index) => ({
        id: `history-${name.toLowerCase()}`, title: `${name} history`, status: 'complete', model: 'test-model', effort: 'low',
        updatedAt: new Date(Date.now() - index * 60000).toISOString(),
        messages: [{ id: `${name}-user`, role: 'user', content: `${name} question`, status: 'complete' },
          { id: `${name}-answer`, role: 'assistant', content: `${name} answer`, status: 'complete' }],
      }));
      globalThis.__miniHistoryCheck = {
        calls: [], holds: {}, fixture, records: structuredClone(fixture), settings: { theme: 'light' },
        emit: event => originalSend('mini:event', event),
      };
      ipcMain.removeHandler('mini:invoke');
      ipcMain.handle('mini:invoke', async (_event, action, payload) => {
        const check = globalThis.__miniHistoryCheck;
        if (action === 'test:status') return { ok: true, data: { calls: check.calls, holds: Object.keys(check.holds) } };
        check.calls.push({ action, payload });
        let data;
        if (action === 'bootstrap') data = { settings: check.settings, connection, conversations: check.records, hotkeyStatus: true };
        else if (action === 'conversations:list') data = structuredClone(check.records);
        else if (action === 'conversations:get') data = structuredClone(check.records.find(item => item.id === payload.id));
        else if (action === 'conversations:delete' || action === 'conversations:clear') {
          const name = action === 'conversations:delete' ? 'delete' : 'clear';
          const result = await new Promise(resolve => { check.holds[name] = resolve; });
          if (!result.ok) return result;
          const deletedIds = check.records.filter(item => name === 'clear' || item.id === payload.id).map(item => item.id);
          check.records = check.records.filter(item => !deletedIds.includes(item.id));
          data = name === 'clear' ? { deleted: true, count: deletedIds.length, deletedIds } : { deleted: true, id: payload.id };
        } else if (action === 'settings:update') {
          check.settings = { ...check.settings, ...payload };
          data = { settings: check.settings };
          check.emit({ type: 'settings', settings: check.settings });
        } else if (action === 'window:expand') data = { expanded: payload.expanded };
        else if (action === 'window:hide') data = {};
        else throw new Error(`Unexpected test IPC action: ${action}`);
        return { ok: true, data };
      });
      win.setSize(600, 480);
    });

    async function reset(empty = false) {
      await electron.evaluate(({ BrowserWindow }, empty) => {
        const check = globalThis.__miniHistoryCheck;
        if (Object.keys(check.holds).length) throw new Error('A deferred action was not released before reset');
        check.calls = [];
        check.records = empty ? [] : structuredClone(check.fixture);
        check.settings = { theme: 'light' };
        BrowserWindow.getAllWindows()[0].setSize(600, 480);
      }, empty);
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#model-select').value === 'test-model' && !document.querySelector('#model-select').disabled);
    }
    async function openHistory() {
      if (await page.locator('#history-panel').isHidden()) await page.locator('#history-toggle').click();
      await page.locator('#history-panel').waitFor({ state: 'visible' });
    }
    const row = name => page.locator('.history-item').filter({ has: page.locator('.history-title', { hasText: `${name} history` }) });
    async function openCurrent(name = 'Alpha') {
      await openHistory();
      await row(name).locator('.history-open').click();
      await page.locator('#history-panel').waitFor({ state: 'hidden' });
      await page.waitForFunction(name => document.querySelector('#messages').textContent.includes(`${name} answer`), name);
    }
    async function calls(action) {
      return electron.evaluate((_electron, action) => globalThis.__miniHistoryCheck.calls.filter(call => call.action === action), action);
    }
    async function waitForCalls(action, count) {
      await page.waitForFunction(async ({ action, count }) => {
        const status = await window.mini.invoke('test:status');
        return status.calls.filter(call => call.action === action).length === count;
      }, { action, count });
    }
    async function release(name, error) {
      await electron.evaluate((_electron, { name, error }) => {
        const check = globalThis.__miniHistoryCheck;
        const resolve = check.holds[name];
        if (!resolve) throw new Error(`Missing deferred action: ${name}`);
        delete check.holds[name];
        resolve(error ? { ok: false, error } : { ok: true });
      }, { name, error });
    }
    async function emitConversation(type, name = 'Alpha', status = 'complete') {
      await electron.evaluate((_electron, { type, name, status }) => {
        const check = globalThis.__miniHistoryCheck;
        const conversation = structuredClone(check.fixture.find(item => item.title === `${name} history`));
        conversation.status = status;
        check.emit({ type, conversation });
      }, { type, name, status });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    async function openClear() {
      await page.locator('#history-clear').click();
      await page.locator('#history-clear-dialog').waitFor({ state: 'visible' });
    }
    async function assertDialogBounds() {
      const bounds = await page.locator('#history-clear-dialog').evaluate(dialog => {
        const rect = dialog.getBoundingClientRect();
        const confirm = document.querySelector('#history-clear-confirm').getBoundingClientRect();
        return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
          viewportWidth: innerWidth, viewportHeight: innerHeight, confirmBottom: confirm.bottom };
      });
      assert.ok(bounds.width > 150 && bounds.height > 80, 'The confirmation dialog must be usable');
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.right <= bounds.viewportWidth + 1 && bounds.bottom <= bounds.viewportHeight + 1,
        `The confirmation dialog must fit the window: ${JSON.stringify(bounds)}`);
      assert.ok(bounds.confirmBottom <= bounds.viewportHeight + 1, 'The confirmation button must be visible');
    }
    async function captureDialog(name) {
      // Waking a hidden compositor can return the previous frame once. Prime it,
      // then allow the modal/backdrop to paint before saving the actual capture.
      await electron.evaluate(async ({ BrowserWindow }) => {
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const png = await electron.evaluate(async ({ BrowserWindow }) => {
        const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        return image.toPNG().toString('base64');
      });
      assert.ok(png.length > 100, 'The hidden window capture must contain an image');
      fs.writeFileSync(path.join(testDir, name), Buffer.from(png, 'base64'));
    }

    // One click starts deletion. In-flight controls reject repeated activations,
    // and the active conversation is cleared only after confirmed IPC success.
    await reset();
    await openCurrent();
    await page.locator('#prompt').fill('Unsent draft survives deletion');
    await openHistory();
    await row('Alpha').locator('.history-delete').click();
    await waitForCalls('conversations:delete', 1);
    assert.equal((await calls('conversations:delete'))[0].payload.id, 'history-alpha');
    assert.equal(await row('Alpha').count(), 1, 'History remains visible until deletion succeeds');
    assert.equal(await page.locator('#history-clear').isDisabled(), true);
    assert.equal(await page.locator('.history-delete').evaluateAll(buttons => buttons.every(button => button.disabled)), true);
    await row('Alpha').locator('.history-delete').evaluate(button => { button.click(); button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.equal((await calls('conversations:delete')).length, 1);
    await release('delete');
    await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 2 && !document.querySelector('#history-clear').disabled);
    assert.equal(await row('Alpha').count(), 0);
    assert.equal(await page.locator('#messages').innerText(), '');
    assert.equal(await page.locator('#prompt').inputValue(), 'Unsent draft survives deletion');
    assert.equal(await page.locator('#toast').isHidden(), true, 'Deleting a conversation must not show a toast');
    await emitConversation('conversation');
    await emitConversation('complete');
    assert.equal(await row('Alpha').count(), 0, 'Late events must not resurrect a deleted row');
    assert.equal(await page.locator('#messages').innerText(), '');
    trace('Single deletion and delayed event checks passed');

    // Failure retains the record and allows an explicit retry.
    await row('Beta').locator('.history-delete').click();
    await waitForCalls('conversations:delete', 2);
    await release('delete', 'Simulated delete write failure');
    await page.locator('#error-bar').waitFor({ state: 'visible' });
    assert.match(await page.locator('#error-text').innerText(), /Simulated delete write failure/);
    assert.equal(await page.locator('#history-error').isVisible(), true, 'The deletion error must remain visible inside the open history panel');
    assert.match(await page.locator('#history-error').innerText(), /Simulated delete write failure/);
    assert.equal(await row('Beta').count(), 1);
    assert.equal(await row('Beta').locator('.history-delete').isDisabled(), false);
    await row('Beta').locator('.history-delete').click();
    await waitForCalls('conversations:delete', 3);
    await release('delete');
    await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 1);
    assert.equal(await row('Beta').count(), 0);
    trace('Single deletion failure and retry passed');

    // The confirmation describes every saved record, even with a search filter.
    // Cancel and Escape have no destructive side effect and Escape keeps the app.
    await reset();
    await openCurrent();
    await page.locator('#prompt').fill('Unsent draft survives clearing');
    await openHistory();
    await page.locator('#history-search').fill('Alpha');
    assert.equal(await page.locator('.history-item').count(), 1);
    await openClear();
    assert.match(await page.locator('#history-clear-description').innerText(), /3/);
    await page.locator('#history-clear-cancel').click();
    await page.locator('#history-clear-dialog').waitFor({ state: 'hidden' });
    assert.equal((await calls('conversations:clear')).length, 0);
    const hideCount = (await calls('window:hide')).length;
    await openClear();
    await page.keyboard.press('Escape');
    await page.locator('#history-clear-dialog').waitFor({ state: 'hidden' });
    assert.equal((await calls('conversations:clear')).length, 0);
    assert.equal((await calls('window:hide')).length, hideCount, 'Dialog Escape must not hide the application');

    // Capture both themes and verify containment at the minimum window size.
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => window.mini.invoke('settings:update', { theme }), theme);
      await page.waitForFunction(theme => document.body.dataset.theme === theme, theme);
      await openClear();
      await assertDialogBounds();
      await captureDialog(`${theme}-clear-dialog.png`);
      await page.locator('#history-clear-cancel').click();
    }
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(480, 260));
    await page.waitForFunction(() => innerWidth >= 480 && innerWidth <= 484 && innerHeight >= 260 && innerHeight <= 264);
    await openClear();
    await assertDialogBounds();
    await captureDialog('compact-dark-clear-dialog.png');
    await page.locator('#history-clear-cancel').click();
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(600, 480));
    await page.waitForFunction(() => innerWidth >= 600 && innerHeight >= 480);
    trace('Confirmation cancellation, themes and compact layout passed');

    // A failed bulk write stays in the dialog with a retryable error. The retry
    // clears all records, including records excluded by the active search.
    await openClear();
    await page.locator('#history-clear-confirm').click();
    await waitForCalls('conversations:clear', 1);
    assert.equal(await page.locator('#history-clear-confirm').isDisabled(), true);
    assert.equal(await page.locator('#history-clear-cancel').isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#history-clear-dialog').isVisible(), true, 'Escape cannot dismiss an in-flight deletion');
    await page.locator('#history-clear-confirm').evaluate(button => { button.click(); button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.equal((await calls('conversations:clear')).length, 1);
    assert.equal(await row('Alpha').count(), 1);
    await release('clear', 'Simulated clear write failure');
    await page.locator('#history-clear-error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#history-clear-error').innerText(), /Simulated clear write failure/);
    assert.equal(await page.locator('#history-clear-dialog').isVisible(), true);
    assert.equal(await page.locator('#history-clear-confirm').isDisabled(), false);
    assert.equal(await row('Alpha').count(), 1);
    await page.locator('#history-clear-confirm').click();
    await waitForCalls('conversations:clear', 2);
    await release('clear');
    await page.locator('#history-clear-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 0);
    assert.equal(await page.locator('#history-clear').isDisabled(), true);
    assert.equal(await page.locator('#messages').innerText(), '');
    assert.equal(await page.locator('#prompt').inputValue(), 'Unsent draft survives clearing');
    assert.equal(await page.locator('#toast').isHidden(), true, 'Clearing history must not show a toast');
    await page.locator('#history-search').fill('');
    assert.equal(await page.locator('.history-item').count(), 0);
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      await emitConversation('conversation', name);
      await emitConversation('complete', name);
    }
    assert.equal(await page.locator('.history-item').count(), 0, 'Late events must not resurrect any cleared record');
    assert.equal(await page.locator('#messages').innerText(), '');
    trace('Bulk deletion failure, retry, filtered scope and late events passed');

    // Empty history and active generation must guard both mouse and direct
    // event activation. A nonmatching search must still allow clearing history.
    await reset(true);
    await openHistory();
    assert.equal(await page.locator('#history-clear').isDisabled(), true);
    await page.locator('#history-clear').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal(await page.locator('#history-clear-dialog').isVisible(), false);
    assert.equal((await calls('conversations:clear')).length, 0);
    await reset();
    await openHistory();
    await page.locator('#history-search').fill('No matching conversation');
    assert.equal(await page.locator('.history-item').count(), 0);
    assert.equal(await page.locator('#history-clear').isDisabled(), false);
    await page.locator('#history-search').fill('');
    await emitConversation('conversation', 'Alpha', 'generating');
    assert.equal(await page.locator('#history-clear').isDisabled(), true);
    await page.locator('#history-clear').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal(await page.locator('#history-clear-dialog').isVisible(), false);
    assert.equal((await calls('conversations:clear')).length, 0);
    await row('Alpha').locator('.history-delete').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal((await calls('conversations:delete')).length, 0, 'Active generation cannot be deleted');
    await emitConversation('complete');
    await page.waitForFunction(() => !document.querySelector('#history-clear').disabled);
    await openClear();
    await emitConversation('conversation', 'Alpha', 'generating');
    await page.locator('#history-clear-confirm').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal((await calls('conversations:clear')).length, 0, 'Generation starting after the dialog opens must also block clearing');
    await emitConversation('complete');
    assert.equal((await calls('chat:send')).length, 0);
    assert.deepEqual(pageErrors, []);
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    console.log(`History controls passed: direct deletion, delayed writes, duplicate protection, failure retries, filtered clear-all, cancellation, generation guards and late events. Screenshots: ${testDir}`);
  } catch (error) {
    if (page) console.error('Renderer diagnostics:', await page.evaluate(() => ({ url: location.href, title: document.title,
      bridge: typeof window.mini, error: document.querySelector('#error-text')?.textContent })).catch(() => ({})));
    console.error(error.stack || error.message);
    throw error;
  } finally {
    await electron.evaluate(({ app }) => app.quit()).catch(() => {});
    await electron.close().catch(() => {});
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
