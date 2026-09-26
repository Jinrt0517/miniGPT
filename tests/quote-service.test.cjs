const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { QuoteService, extractQuotes, CATEGORIES } = require('../src/quote-service.cjs');

function temporaryDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minigpt-quotes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function response(data) { return { ok: true, json: async () => data }; }

function onlineQuote(url, index, text = `提前取得的第 ${index} 句语录，每次内容都不同。`) {
  return response({ type: new URL(url).searchParams.get('c'),
    uuid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    hitokoto: text, from: '测试作品', from_who: '测试作者' });
}

// A cached read must settle even while the mocked network remains blocked.
function immediately(promise) {
  return Promise.race([promise, new Promise((_, reject) => {
    setImmediate(() => reject(new Error('A cached read waited for the network')));
  })]);
}

test('requests all seven online categories, keeps attribution, and persists recent history', async t => {
  const dir = temporaryDir(t);
  const types = [];
  const fetcher = async url => {
    const type = new URL(url).searchParams.get('c');
    types.push(type);
    return onlineQuote(url, types.length);
  };
  const service = new QuoteService(dir, { fetcher, random: () => 0, minIntervalMs: 0 });
  await service.warmup();
  assert.equal(types.length, 5);
  assert.equal(service.state.ready.length, 5);
  assert.equal(service.state.recent.length, 0, 'prefetching does not mark quotes as used');
  const quotes = [];
  for (let i = 0; i < CATEGORIES.length; i++) {
    quotes.push(await service.next());
    await service.warmup();
    assert.equal(types.length, 5 + quotes.length, 'one replacement per consumed quote');
    assert.equal(service.state.ready.length, 5);
  }
  assert.deepEqual(new Set(types.slice(0, CATEGORIES.length)), new Set(CATEGORIES.map(item => item.type)));
  assert.equal(new Set(quotes.map(item => item.text)).size, CATEGORIES.length);
  assert.match(quotes[0].source, /测试作品 · 测试作者 · 一言/);
  assert.match(quotes[0].url, /^https:\/\/hitokoto\.cn\/\?uuid=/);
  const saved = new QuoteService(dir, { fetcher, random: () => 0, minIntervalMs: 0 });
  assert.equal(saved.state.recent.length, CATEGORIES.length);
  assert.equal(saved.state.cache.length, CATEGORIES.length);
  assert.deepEqual(saved.state.ready, service.state.ready);
  await saved.warmup();
  assert.equal(types.length, 5 + CATEGORIES.length, 'a full persisted buffer needs no requests');
});

test('uses Wikiquote for duplicates and excludes both buffered and previously displayed quotes', async t => {
  const dir = temporaryDir(t);
  let categoryCalls = 0;
  const fetcher = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'v1.hitokoto.cn') return response({ type: 'k', uuid: '00000000-0000-4000-8000-000000000001', hitokoto: '这个句子会重复出现，所以需要切换来源。', from: '测试' });
    assert.equal(options.headers['User-Agent'], `miniGPT/${require('../package.json').version} (desktop welcome quotation reader)`);
    if (parsed.searchParams.get('list') === 'categorymembers') {
      categoryCalls++;
      return response({ query: { categorymembers: [{ ns: 0, title: '测试哲人' }] } });
    }
    return response({ query: { pages: [{ title: '测试哲人', revisions: [{ slots: { main: { content: '== 语录 ==\n* [[世界|人生]] 如同一条河流，始终向前。\n** 出处：测试书\n== 参考 ==\n* 这不是一句应该显示的语录。' } } }] }] } });
  };
  const service = new QuoteService(dir, { fetcher, random: () => 0, minIntervalMs: 0 });
  service.state.order = [0, 0, 0];
  await service.warmup();
  assert.equal(service.state.ready.length, 2);
  assert.equal(categoryCalls, 2, 'duplicate buffered quotes are rejected by both sources');
  const first = await service.next();
  assert.match(first.url, /^https:\/\/hitokoto\.cn/);
  const second = await service.next();
  await service.warmup();
  assert.equal(second.text, '人生 如同一条河流，始终向前。');
  assert.equal(second.url, 'https://zh.wikiquote.org/wiki/%E6%B5%8B%E8%AF%95%E5%93%B2%E4%BA%BA');
  assert.equal(service.state.ready.length, 0, 'displayed quotes cannot be buffered again');
});

test('offline uses cached online quotes and never falls back to a hardcoded poetry list', async t => {
  const dir = temporaryDir(t);
  let calls = 0;
  const failing = async () => { calls++; throw new Error('offline'); };
  const service = new QuoteService(dir, { fetcher: failing, random: () => 0, minIntervalMs: 0 });
  assert.match((await service.next()).text, /暂时无法取得在线语录/);
  await service.refilling;
  assert.equal(calls, 2, 'one failed cold read does not immediately retry the same sources');
  service.state.cache.push({ text: '先前保存的一句电影台词。', source: '影视 · 某电影 · 一言', url: 'https://hitokoto.cn/?uuid=00000000-0000-4000-8000-000000000002' });
  assert.equal((await service.next()).text, '先前保存的一句电影台词。');
  await service.refilling;
});

test('invalid JSON and non-object caches recover offline and persist new quotes across restarts', async t => {
  const dir = temporaryDir(t);
  const file = path.join(dir, 'welcome-quotes.json');
  const failing = async () => { throw new Error('offline'); };
  const quoteText = '损坏缓存恢复后，仍然可以保存新的在线语录。';
  for (const invalid of ['{ invalid json', 'null', '42', 'true', '"cached text"', '[]']) {
    fs.writeFileSync(file, invalid);
    const service = new QuoteService(dir, { fetcher: failing, random: () => 0, minIntervalMs: 0 });
    assert.match((await service.next()).text, /暂时无法取得在线语录/, invalid);
    await service.refilling;
    service.fetcher = async url => response({
      type: new URL(url).searchParams.get('c'), uuid: '00000000-0000-4000-8000-000000000003',
      hitokoto: quoteText, from: '恢复测试',
    });
    assert.equal((await service.next()).text, quoteText, invalid);
    await service.refilling;
    const restarted = new QuoteService(dir, { fetcher: failing, random: () => 0, minIntervalMs: 0 });
    assert.equal((await restarted.next()).text, quoteText, invalid);
    await restarted.refilling;
  }
});

test('cached and concurrent reads return immediately while a single refill keeps the buffer full', async t => {
  const gate = Promise.withResolvers();
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const service = new QuoteService(temporaryDir(t), { minIntervalMs: 0, fetcher: async url => {
    const index = ++calls;
    maxActive = Math.max(maxActive, ++active);
    if (index === 6) await gate.promise;
    active--;
    return onlineQuote(url, index);
  } });
  await service.warmup();
  try {
    const first = await immediately(service.next());
    assert.equal(calls, 6);
    assert.equal(service.state.ready.length, 4);
    const more = await immediately(Promise.all([service.next(), service.next()]));
    assert.equal(new Set([first, ...more].map(quote => quote.text)).size, 3);
    assert.equal(service.state.ready.length, 2);
    assert.equal(calls, 6, 'concurrent consumers share the existing refill');
  } finally {
    gate.resolve();
    await service.refilling;
  }
  assert.equal(calls, 8);
  assert.equal(maxActive, 1);
  assert.equal(service.state.ready.length, 5);
});

test('cold startup shares the warmup request and returns the first quote before the batch completes', async t => {
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  let calls = 0;
  const service = new QuoteService(temporaryDir(t), { minIntervalMs: 0, fetcher: async url => {
    const index = ++calls;
    if (index === 1) await first.promise;
    if (index === 2) await second.promise;
    return onlineQuote(url, index);
  } });
  const warming = service.warmup();
  assert.equal(service.warmup(), warming);
  const next = service.next();
  try {
    assert.equal(calls, 1);
    first.resolve();
    assert.match((await immediately(next)).text, /第 1 句/);
    assert.equal(calls, 2);
    assert.equal(service.state.recent.length, 1);
  } finally {
    first.resolve();
    second.resolve();
    await warming;
  }
  assert.equal(calls, 6);
  assert.equal(service.state.ready.length, 5);
});

test('window presentation takes an immediate snapshot even when cold-start fetching is blocked', async t => {
  const gate = Promise.withResolvers();
  let calls = 0;
  const service = new QuoteService(temporaryDir(t), { minIntervalMs: 0, fetcher: async url => {
    const index = ++calls;
    await gate.promise;
    return onlineQuote(url, index);
  } });
  service.warmup();
  let initial;
  try {
    initial = await immediately(service.next({ waitForNetwork: false }));
    assert.equal(initial.url, '');
    assert.equal(calls, 1, 'presentation shares the background refill');
  } finally {
    gate.resolve();
    await service.refilling;
  }
  assert.equal(initial.url, '', 'the returned presentation does not change when fetching finishes');
  assert.equal(service.state.ready.length, 5);
  assert.equal(service.state.recent.length, 0);
  const later = await immediately(service.next({ waitForNetwork: false }));
  await service.refilling;
  assert.match(later.text, /第 1 句/);
});

test('persisted unused quotes survive restart and work offline without waiting for refill', async t => {
  const dir = temporaryDir(t);
  let calls = 0;
  const original = new QuoteService(dir, { minIntervalMs: 0, fetcher: async url => onlineQuote(url, ++calls) });
  await original.warmup();
  const unused = [...original.state.ready];
  const gate = Promise.withResolvers();
  let offlineCalls = 0;
  const restarted = new QuoteService(dir, { minIntervalMs: 0, fetcher: async () => {
    offlineCalls++;
    await gate.promise;
    throw new Error('offline');
  } });
  try {
    await restarted.warmup();
    assert.equal(offlineCalls, 0);
    const displayed = await immediately(Promise.all(Array.from({ length: 5 }, () => restarted.next())));
    assert.deepEqual(displayed, unused);
    assert.equal(restarted.state.ready.length, 0);
    assert.ok(unused.some(quote => quote.text === restarted.state.cache[0].text));
    const fallback = await immediately(restarted.next());
    assert.ok(unused.some(quote => quote.text === fallback.text), 'exhaustion uses history immediately');
    assert.equal(offlineCalls, 1);
  } finally {
    gate.resolve();
    await restarted.refilling;
  }
  assert.equal(offlineCalls, 2, 'failed primary and secondary end the refill without spinning');
  const saved = new QuoteService(dir);
  assert.equal(saved.state.ready.length, 0, 'consumed quotes are removed on disk');
});

test('a failed warmup stops, and a later request retries after connectivity returns', async t => {
  let calls = 0;
  const service = new QuoteService(temporaryDir(t), { minIntervalMs: 0, fetcher: async () => {
    calls++;
    throw new Error('offline');
  } });
  await service.warmup();
  assert.equal(calls, 2);
  assert.equal(service.refilling, null);
  assert.equal(service.state.ready.length, 0);
  service.fetcher = async url => onlineQuote(url, ++calls);
  const quote = await service.next();
  await service.refilling;
  assert.match(quote.text, /第 3 句/);
  assert.equal(service.state.ready.length, 5);
});

test('old cache files and invalid buffer entries recover without breaking cached reads', async t => {
  const dir = temporaryDir(t);
  const quote = { text: '旧版本中保存的一句话，升级后仍然能使用。', source: '测试来源', url: 'https://hitokoto.cn/' };
  const fetcher = async () => { throw new Error('offline'); };
  fs.writeFileSync(path.join(dir, 'welcome-quotes.json'), JSON.stringify({ cache: [quote] }));
  const legacy = new QuoteService(dir, { fetcher, minIntervalMs: 0 });
  assert.deepEqual(await immediately(legacy.next()), quote);
  await legacy.refilling;
  const malformed = { cache: [null, { text: 42 }], ready: [null, { text: 42, url: 'https://example.com' }, quote, quote] };
  fs.writeFileSync(legacy.file, JSON.stringify(malformed));
  const service = new QuoteService(dir, { fetcher, minIntervalMs: 0 });
  assert.deepEqual(service.state.ready, [quote]);
  assert.deepEqual(await immediately(service.next()), quote);
  await service.refilling;
});

test('extracts only concise top-level quotes, not citations or reference sections', () => {
  const text = "== 语录 ==\n* '''抬头可以看见很远的星星。'''\n** 某作品\n* 太短\n== 参考 ==\n* 一句不应显示在欢迎页的参考内容。";
  assert.deepEqual(extractQuotes(text), ['抬头可以看见很远的星星。']);
});
