'use strict';

// Exercise the real renderer with controlled subscription data. The window stays
// hidden, and no chat request is sent or user's history/clipboard modified.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const trace = message => { if (process.env.MINIGPT_TEST_TRACE === '1') console.log(message); };

async function main() {
  const root = path.join(__dirname, '..');
  const testRoot = path.join(root, '.test-data', 'selection-controls');
  fs.mkdirSync(testRoot, { recursive: true });
  const testDir = fs.mkdtempSync(path.join(testRoot, 'run-'));
  const env = { ...process.env, MINIGPT_DATA_DIR: testDir, MINIGPT_TEST_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = await _electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 30000 });
  trace('Electron launched');
  const pageErrors = [];
  try {
    const page = await electron.firstWindow();
    trace('Renderer found');
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.waitForFunction(() => Boolean(window.mini));
    await electron.evaluate(({ ipcMain, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const contents = win.webContents;
      contents.setBackgroundThrottling(false);
      const originalSend = contents.send.bind(contents);
      // Ignore the app's initial account refresh after installing our fixture.
      contents.send = (channel, ...args) => {
        if (channel === 'mini:event' && args[0]?.type === 'connection') return;
        return originalSend(channel, ...args);
      };
      const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
      const names = ['GPT-6-Astra', 'GPT-6-Sol', 'GPT-6-Luna', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna', 'GPT-5.5'];
      const ids = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];
      const connection = {
        status: 'connected', account: { type: 'chatgpt', email: 'renderer-test@example.invalid', planType: 'test' },
        models: names.map((name, index) => ({
          id: ids[index], model: ids[index], displayName: name, isDefault: index === 0,
          defaultReasoningEffort: index === 1 ? 'high' : 'low',
          supportedReasoningEfforts: (index === 1 ? ['high', 'xhigh'] : index === 2 ? [] : efforts)
            .map(reasoningEffort => ({ reasoningEffort })),
          inputModalities: ['text'],
        })),
      };
      globalThis.__miniSelectionCheck = {
        calls: [], connection, settings: { theme: 'light', alwaysOnTop: false },
        emit: event => originalSend('mini:event', event),
      };
      ipcMain.removeHandler('mini:invoke');
      ipcMain.handle('mini:invoke', async (_event, action, payload) => {
        const check = globalThis.__miniSelectionCheck;
        check.calls.push({ action, payload });
        let data;
        if (action === 'bootstrap') data = { settings: check.settings, connection, conversations: [], hotkeyStatus: true };
        else if (action === 'window:pin') {
          check.settings = { ...check.settings, alwaysOnTop: payload.pinned };
          data = { settings: check.settings };
        } else if (action === 'settings:update') {
          check.settings = { ...check.settings, ...payload };
          data = { settings: check.settings };
          check.emit({ type: 'settings', settings: check.settings });
        } else if (action === 'window:expand') {
          win.setSize(payload.expanded ? 600 : 480, payload.expanded ? 480 : 260);
          data = { expanded: payload.expanded };
        } else if (action === 'window:hide') data = {};
        else if (action === 'conversations:list') data = [];
        else throw new Error(`Unexpected test IPC action: ${action}`);
        return { ok: true, data };
      });
      win.setSize(600, 480);
    });
    await page.reload();
    // Hidden compositors can pause an opacity animation mid-frame; use the app's
    // reduced-motion mode so captures are readable without showing the window.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    trace('Renderer fixture installed');
    await page.waitForFunction(() => document.querySelector('#model-select').value === 'gpt-6-astra' && !document.querySelector('#model-select-trigger').disabled);

    const trigger = kind => page.locator(`#${kind}-select-trigger`);
    const popover = kind => page.locator(`#${kind}-select-popover`);
    const source = kind => page.locator(`#${kind}-select`);
    const option = (kind, value) => page.locator(`#${kind}-select-listbox [role="option"][data-value="${value}"]`);
    async function open(kind) {
      await trigger(kind).click();
      await popover(kind).waitFor({ state: 'visible' });
      assert.equal(await trigger(kind).getAttribute('aria-expanded'), 'true');
    }
    async function closed(kind) {
      await popover(kind).waitFor({ state: 'hidden' });
      assert.equal(await trigger(kind).getAttribute('aria-expanded'), 'false');
    }
    async function select(kind, value) {
      await open(kind);
      await option(kind, value).click();
      await closed(kind);
      assert.equal(await source(kind).inputValue(), value);
    }
    async function calls(action) {
      return electron.evaluate((_electron, action) => globalThis.__miniSelectionCheck.calls.filter(call => call.action === action), action);
    }
    async function emit(event) {
      await electron.evaluate((_electron, event) => globalThis.__miniSelectionCheck.emit(event), event);
    }
    async function captureMenu(name) {
      // A hidden compositor may return the previous frame once. Prime it before
      // capturing and keep the isolated test window hidden throughout the run.
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
    async function assertPin(pinned) {
      await page.waitForFunction(pinned => document.querySelector('#pin-toggle').getAttribute('aria-pressed') === String(pinned), pinned);
      const appearance = await page.locator('#pin-toggle').evaluate(button => {
        const svg = button.querySelector('svg');
        const use = svg.querySelector('use');
        const target = document.querySelector(use.getAttribute('href'));
        const drawing = svg.getBBox();
        return {
          href: use.getAttribute('href'), label: button.getAttribute('aria-label'), title: button.title,
          count: button.querySelectorAll('svg').length, width: drawing.width, height: drawing.height,
          filled: [...target.querySelectorAll('path')].some(path => path.getAttribute('fill') === 'currentColor'),
        };
      });
      assert.equal(appearance.href, pinned ? '#i-pin-filled' : '#i-pin');
      assert.equal(appearance.label, pinned ? '取消窗口置顶' : '置顶窗口');
      assert.equal(appearance.title, appearance.label);
      assert.equal(appearance.count, 1);
      assert.ok(appearance.width > 0 && appearance.height > 0, 'Pin must have a visible SVG drawing');
      assert.equal(appearance.filled, pinned, 'Only the pinned icon must have a filled drawing');
    }
    async function assertMenuBounds(kind, scrollable = false) {
      const bounds = await popover(kind).evaluate((element, kind) => {
        const rect = element.getBoundingClientRect();
        const list = document.querySelector(`#${kind}-select-listbox`);
        let scroll = list;
        while (scroll !== element && !/auto|scroll/.test(getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement;
        return {
          x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
          viewportWidth: innerWidth, viewportHeight: innerHeight,
          clientHeight: scroll.clientHeight, scrollHeight: scroll.scrollHeight,
        };
      }, kind);
      assert.ok(bounds.width > 100 && bounds.height > 40, `${kind} menu must be usable`);
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.right <= bounds.viewportWidth + 1 && bounds.bottom <= bounds.viewportHeight + 1,
        `${kind} menu must stay in the window: ${JSON.stringify(bounds)}`);
      if (scrollable) assert.ok(bounds.scrollHeight > bounds.clientHeight, `${kind} compact menu must scroll`);
    }
    async function assertReadable(element, message) {
      await element.evaluate(element => element.scrollIntoView({ block: 'nearest' }));
      const bounds = await element.evaluate(element => {
        let scroll = element.parentElement;
        while (scroll && !/auto|scroll/.test(getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement;
        const viewport = (scroll || document.documentElement).getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        const labels = [...element.querySelectorAll('.selection-option-name')];
        return {
          top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
          viewportTop: Math.max(0, viewport.top), viewportBottom: Math.min(innerHeight, viewport.bottom),
          viewportLeft: Math.max(0, viewport.left), viewportRight: Math.min(innerWidth, viewport.right),
          textClipped: labels.filter(label => label.scrollWidth > label.clientWidth + 1).map(label => label.textContent),
        };
      });
      assert.ok(bounds.top >= bounds.viewportTop - 1 && bounds.bottom <= bounds.viewportBottom + 1 &&
        bounds.left >= bounds.viewportLeft - 1 && bounds.right <= bounds.viewportRight + 1,
      `${message} must scroll fully into view: ${JSON.stringify(bounds)}`);
      assert.deepEqual(bounds.textClipped, [], `${message} must show full labels`);
    }
    async function assertContentReachable(kind) {
      for (const row of await page.locator(`#${kind}-select-listbox [role="option"]`).all()) {
        await assertReadable(row, `${kind} option`);
      }
    }
    async function assertPlainMenu(kind, expectedLabels) {
      const rows = page.locator(`#${kind}-select-listbox [role="option"]`);
      assert.deepEqual(await rows.allTextContents(), expectedLabels);
      assert.equal(await popover(kind).locator('.selection-option-detail, .selection-option-description, .selection-caption, .selection-note, .text-button, [title]').count(), 0);
      assert.equal(await source(kind).locator('option[title]').count(), 0);
    }

    // Both pin paths must be actual SVG drawings, including settings updates.
    await assertPin(false);
    await page.locator('#pin-toggle').click();
    await assertPin(true);

    trace('Pin appearance passed');
    await page.locator('#pin-toggle').click();
    await assertPin(false);
    await page.evaluate(() => window.mini.invoke('settings:update', { alwaysOnTop: true }));
    await assertPin(true);

    // Hidden native controls keep existing data access, without duplicate tab stops.
    for (const kind of ['model', 'effort']) {
      assert.equal(await source(kind).isVisible(), false);
      assert.equal(await source(kind).getAttribute('aria-hidden'), 'true');
      assert.equal(await source(kind).getAttribute('tabindex'), '-1');
      assert.equal(await trigger(kind).getAttribute('aria-haspopup'), 'listbox');
    }

    // Menus contain only option names and selection marks, without explanations.
    await open('model');
    await assertPlainMenu('model', ['GPT-6-Astra', 'GPT-6-Sol', 'GPT-6-Luna', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna', 'GPT-5.5']);
    await page.keyboard.press('Escape');

    await open('effort');
    await assertPlainMenu('effort', ['不思考', '极低', '低', '中等', '高', '超高', '最高', '极致']);
    await page.keyboard.press('Escape');

    await select('model', 'gpt-6-sol');
    assert.match(await trigger('model').innerText(), /GPT-6-Sol/);
    assert.deepEqual(await source('effort').evaluate(select => [...select.options].map(option => option.value)), ['high', 'xhigh']);
    assert.equal(await source('effort').inputValue(), 'high');
    await open('effort');
    await assertPlainMenu('effort', ['高', '超高']);
    await page.keyboard.press('Escape');
    await select('effort', 'xhigh');
    await select('model', 'gpt-6-luna');
    assert.equal(await trigger('effort').isDisabled(), true);
    await select('model', 'gpt-6-astra');
    assert.equal(await trigger('effort').isDisabled(), false);

    // Keyboard movement commits only on Enter; Home/End work on a long menu.
    await trigger('model').focus();
    await page.keyboard.press('ArrowDown');
    await popover('model').waitFor({ state: 'visible' });
    await page.keyboard.press('End');
    assert.equal(await source('model').inputValue(), 'gpt-6-astra');
    await page.keyboard.press('Enter');
    await closed('model');
    assert.equal(await source('model').inputValue(), 'gpt-5.5');
    await trigger('model').press('ArrowUp');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await source('model').inputValue(), 'gpt-6-sol');
    await trigger('effort').press('Enter');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    assert.equal(await source('effort').inputValue(), 'high');

    // Closing a picker must not invoke the application's Escape-to-hide action.
    const hideCount = (await calls('window:hide')).length;
    await open('model');
    await page.keyboard.press('Escape');

    trace('Picker selection and dismissal passed');
    await closed('model');
    assert.equal(await trigger('model').evaluate(button => button === document.activeElement), true);
    assert.equal((await calls('window:hide')).length, hideCount);
    await open('effort');
    await page.keyboard.press('Tab');
    await closed('effort');
    await open('model');
    await page.mouse.click(2, 2);
    await closed('model');
    await open('model');
    await trigger('effort').click();
    await closed('model');
    await popover('effort').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');

    // Losing connection or beginning generation disables and closes pickers.
    await open('model');
    await emit({ type: 'connection', connection: { status: 'disconnected' } });
    await closed('model');
    assert.equal(await trigger('model').isDisabled(), true);
    assert.equal(await trigger('effort').isDisabled(), true);
    await electron.evaluate(() => {
      const check = globalThis.__miniSelectionCheck;
      check.emit({ type: 'connection', connection: check.connection });
    });
    await page.waitForFunction(() => !document.querySelector('#model-select-trigger').disabled);
    await open('model');
    const conversation = { id: 'selection-check', model: 'gpt-6-astra', effort: 'low', title: 'Selection control test', status: 'generating', messages: [] };
    await emit({ type: 'conversation', conversation });
    await closed('model');
    assert.equal(await trigger('model').isDisabled(), true);
    assert.equal(await trigger('effort').isDisabled(), true);
    await emit({ type: 'complete', conversation: { ...conversation, status: 'complete' } });
    await page.waitForFunction(() => !document.querySelector('#model-select-trigger').disabled);

    // Capture both themes and inspect viewport containment in the minimum size.
    trace('Picker disabled states passed');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => window.mini.invoke('settings:update', { theme }), theme);
      for (const kind of ['model', 'effort']) {
        await open(kind);
        await assertMenuBounds(kind);
        await assertContentReachable(kind);
        await page.keyboard.press('Home');
        await captureMenu(`${theme}-${kind}.png`);
        await page.keyboard.press('Escape');
      }
    }
    await page.locator('#expand-window').click();
    trace(`Compact viewport: ${JSON.stringify(await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))}`);
    // Windows can round the minimum window bounds by a few DIP at 125% scaling.
    await page.waitForFunction(() => innerWidth >= 480 && innerWidth <= 484 && innerHeight >= 260 && innerHeight <= 264);
    for (const kind of ['model', 'effort']) {
      await open(kind);
      await assertMenuBounds(kind, true);
      await assertContentReachable(kind);
      await page.keyboard.press('End');
      const last = page.locator(`#${kind}-select-listbox [role="option"]`).last();
      const lastBounds = await last.boundingBox();
      const menuBounds = await popover(kind).boundingBox();
      assert.ok(lastBounds.y >= menuBounds.y && lastBounds.y + lastBounds.height <= menuBounds.y + menuBounds.height + 1,
        'Keyboard navigation must scroll the last option into view');
      await captureMenu(`compact-dark-${kind}.png`);
      await page.keyboard.press('Escape');
    }
    assert.equal((await calls('chat:send')).length, 0);
    assert.deepEqual(pageErrors, []);
    assert.equal(await page.locator('#error-bar').isVisible(), false);
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    console.log(`Selection controls passed: plain option labels, pin fill, mouse/keyboard choice, dismissal, disabled states, themes and compact content scrolling. Screenshots: ${testDir}`);
  } catch (error) {
    console.error(error.stack || error.message);
    throw error;
  } finally {
    await electron.evaluate(({ app }) => app.quit()).catch(() => {});
    await electron.close().catch(() => {});
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
