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

test('requests all seven online categories, keeps attribution, and persists recent history', async t => {
  const dir = temporaryDir(t);
  const types = [];
  const fetcher = async url => {
    const type = new URL(url).searchParams.get('c');
    types.push(type);
    return response({ type, uuid: `00000000-0000-4000-8000-${String(types.length).padStart(12, '0')}`,
      hitokoto: `来自${type}类别的全新句子，且每次都不同。`, from: '测试作品', from_who: '测试作者' });
  };
  const service = new QuoteService(dir, { fetcher, random: () => 0, minIntervalMs: 0 });
  const quotes = [];
  for (let i = 0; i < CATEGORIES.length; i++) quotes.push(await service.next());
  assert.deepEqual(new Set(types), new Set(CATEGORIES.map(item => item.type)));
  assert.equal(new Set(quotes.map(item => item.text)).size, CATEGORIES.length);
  assert.match(quotes[0].source, /测试作品 · 测试作者 · 一言/);
  assert.match(quotes[0].url, /^https:\/\/hitokoto\.cn\/\?uuid=/);
  const saved = new QuoteService(dir, { fetcher, random: () => 0, minIntervalMs: 0 });
  assert.equal(saved.state.recent.length, CATEGORIES.length);
  assert.equal(saved.state.cache.length, CATEGORIES.length);
});

test('uses current Wikiquote page when primary returns a duplicate', async t => {
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
  const first = await service.next();
  assert.match(first.url, /^https:\/\/hitokoto\.cn/);
  // Force the next category to be the same one so the primary result duplicates.
  service.state.order = [0];
  const second = await service.next();
  assert.equal(second.text, '人生 如同一条河流，始终向前。');
  assert.equal(second.url, 'https://zh.wikiquote.org/wiki/%E6%B5%8B%E8%AF%95%E5%93%B2%E4%BA%BA');
  assert.equal(categoryCalls, 1);
});

test('offline uses cached online quotes and never falls back to a hardcoded poetry list', async t => {
  const dir = temporaryDir(t);
  const failing = async () => { throw new Error('offline'); };
  const service = new QuoteService(dir, { fetcher: failing, random: () => 0, minIntervalMs: 0 });
  assert.match((await service.next()).text, /暂时无法取得在线语录/);
  service.state.cache.push({ text: '先前保存的一句电影台词。', source: '影视 · 某电影 · 一言', url: 'https://hitokoto.cn/?uuid=00000000-0000-4000-8000-000000000002' });
  assert.equal((await service.next()).text, '先前保存的一句电影台词。');
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
    service.fetcher = async url => response({
      type: new URL(url).searchParams.get('c'), uuid: '00000000-0000-4000-8000-000000000003',
      hitokoto: quoteText, from: '恢复测试',
    });
    assert.equal((await service.next()).text, quoteText, invalid);
    const restarted = new QuoteService(dir, { fetcher: failing, random: () => 0, minIntervalMs: 0 });
    assert.equal((await restarted.next()).text, quoteText, invalid);
  }
});

test('extracts only concise top-level quotes, not citations or reference sections', () => {
  const text = "== 语录 ==\n* '''抬头可以看见很远的星星。'''\n** 某作品\n* 太短\n== 参考 ==\n* 一句不应显示在欢迎页的参考内容。";
  assert.deepEqual(extractQuotes(text), ['抬头可以看见很远的星星。']);
});
