'use strict';

const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const appRoot = process.argv[2] ? path.resolve(process.argv[2]) : root;
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const quote = index => ({ text: `缓存测试的第 ${index} 句话，应当立即显示。`, source: `测试来源 ${index}`, url: `https://example.com/quote/${index}` });

async function run(cached, hidden = false) {
  fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.test-data', 'welcome-quotes-'));
  if (cached) fs.writeFileSync(path.join(dir, 'welcome-quotes.json'), JSON.stringify({ ready: Array.from({ length: 5 }, (_, i) => quote(i + 1)) }));
  const env = { ...process.env, MINIGPT_DATA_DIR: dir, MINIGPT_TEST_HEADLESS: '1', MINIGPT_TEST_APP_ROOT: appRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/welcome-quotes.cjs'), ...(hidden ? ['--hidden'] : [])], env, timeout: 30000 });
  try {
    const page = await electron.firstWindow();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const status = () => electron.evaluate(() => {
      const c = globalThis.__welcomeCheck;
      return { visible: c.visible, reads: c.reads.length, acknowledgements: c.acknowledgements.length, captures: c.captures.length,
        frames: c.frames, shows: c.shows, network: c.network.length, captureCalls: c.captureCalls, quoteCalls: c.quoteCalls };
    });
    async function waitFor(predicate) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const current = await status();
        if (predicate(current)) return current;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`Welcome check timed out: ${JSON.stringify(await status())}`);
    }
    const press = (key = 'Alt+Space') => electron.evaluate((_electron, key) => {
      const c = globalThis.__welcomeCheck;
      const before = { captureCalls: c.captureCalls, quoteCalls: c.quoteCalls };
      const started = performance.now();
      c.shortcuts.get(key)();
      return { visibleSynchronously: c.visible, elapsedMs: performance.now() - started,
        capturesStarted: c.captureCalls - before.captureCalls, quotesRequested: c.quoteCalls - before.quoteCalls };
    }, key);
    if (hidden) {
      await waitFor(s => s.frames.length === 1);
      assert.equal((await press()).visibleSynchronously, true, 'hidden startup prepares the first summon ahead of time');
    }
    const frameOffset = hidden ? 1 : 0;
    const first = await waitFor(s => Boolean(s.shows[0]?.text));
    assert.equal(first.shows[0].text, cached ? quote(1).text : '今天想聊些什么？');
    assert.equal(first.captureCalls, frameOffset, 'opening never starts a screenshot');

    if (!cached) {
      await electron.evaluate(async (_electron, quote) => {
        const c = globalThis.__welcomeCheck;
        const pending = c.service.fetchPending;
        c.network.shift()(quote);
        await pending;
      }, quote(1));
      assert.equal(await page.locator('#welcome-quote').textContent(), '今天想聊些什么？');
    }

    await page.locator('#prompt').fill('隐藏时保留的草稿');
    await press();
    const prepared = await waitFor(s => s.frames.length === frameOffset + 1);
    assert.equal(prepared.visible, false);
    const nextText = prepared.frames[frameOffset].text;
    assert.equal(nextText, cached ? quote(2).text : quote(1).text);
    await page.evaluate(() => {
      window.welcomeTextChanges = [];
      new MutationObserver(() => window.welcomeTextChanges.push(document.querySelector('#welcome-quote').textContent))
        .observe(document.querySelector('#welcome-quote'), { subtree: true, childList: true, characterData: true });
    });
    // A prepared normal summon must show in the callback itself, without
    // starting a quotation request, capture or renderer acknowledgement.
    const instant = await press();
    assert.equal(instant.visibleSynchronously, true);
    assert.equal(instant.capturesStarted, 0);
    assert.equal(instant.quotesRequested, 0);
    const reopened = await waitFor(s => Boolean(s.shows[1]?.text));
    assert.equal(reopened.shows[1].text, nextText);
    assert.equal(reopened.shows[1].draft, '');
    assert.deepEqual(await page.evaluate(() => window.welcomeTextChanges.filter(text => text !== document.querySelector('#welcome-quote').textContent)), []);

    if (cached) {
      // Switching to the resume key after an ordinary hide restores the draft
      // behind the prepared preview rather than discarding it early.
      await page.locator('#prompt').fill('继续原来的草稿');
      await press();
      await waitFor(s => s.frames.length === frameOffset + 2);
      await press('Ctrl+Alt+Space');
      const resumed = await waitFor(s => Boolean(s.shows[2]?.text));
      assert.equal(resumed.shows[2].text, nextText);
      assert.equal(resumed.shows[2].draft, '继续原来的草稿');
      await press('Ctrl+Alt+Space');
      assert.equal((await press()).visibleSynchronously, true, 'normal reopen after resume-hide also shows synchronously');
      await waitFor(s => Boolean(s.shows[3]?.text));

      // Hold background capture forever: rapid reopen must still complete.
      await electron.evaluate(() => { globalThis.__welcomeCheck.holdCaptures = true; });
      await press();
      const capturing = await waitFor(s => s.captures === 1);
      await press();
      const rapid = await waitFor(s => Boolean(s.shows[4]?.text));
      assert.equal(rapid.captures, 1, 'opening did not wait for the held background screenshot');
      assert.equal(rapid.captureCalls, capturing.captureCalls, 'opening started no new capture');
      const stableText = rapid.shows[4].text;
      await electron.evaluate(() => {
        const c = globalThis.__welcomeCheck;
        c.holdCaptures = false;
        c.captures.shift()();
      });
      await waitFor(s => s.frames.length === frameOffset + 3);
      assert.equal(await page.locator('#welcome-quote').textContent(), stableText);
    }
    assert.deepEqual(errors, []);
    console.log(`Prepared ${cached ? 'cached' : 'cold-start'} summon callback: ${instant.elapsedMs.toFixed(2)} ms; no IPC/paint/capture wait.`);
  } finally {
    await electron.evaluate(({ app }) => app.quit()).catch(() => {});
    await electron.close().catch(() => {});
  }
}

(async () => {
  await run(true);
  await run(false);
  await run(true, true);
  console.log('Welcome presentation passed: work moved to hidden time, synchronous warm summon, blocked capture cannot delay rapid reopen, stable quotes, resume draft and cold startup. No network or chat requests sent.');
})().catch(error => { console.error(error); process.exitCode = 1; });
