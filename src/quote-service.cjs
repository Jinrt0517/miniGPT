const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { version } = require('../package.json');
const PREFETCH_COUNT = 5;

// Categories are entry points, not a fixed list of quotations. Hitokoto is the
// primary, curated Chinese quote database; Wikiquote is a second online source.
const CATEGORIES = [
  { kind: '哲思', type: 'k', wiki: 'zh', title: 'Category:哲学家' },
  { kind: '文学', type: 'd', wiki: 'zh', title: 'Category:中國小說' },
  { kind: '影视', type: 'h', wiki: 'zh', title: 'Category:中國電影' },
  { kind: '游戏', type: 'c', wiki: 'zh', title: 'Category:电子游戏' },
  { kind: '动画', type: 'a', wiki: 'zh', title: 'Category:動畫' },
  { kind: '原创', type: 'e', wiki: 'zh', title: 'Category:文学家' },
  { kind: '诗词', type: 'i', wiki: 'zh', title: 'Category:诗人' },
];

function cleanWikitext(value) {
  let text = value.replace(/<!--[\s\S]*?-->/g, '').replace(/<ref\b[^>]*>[\s\S]*?<\/ref>|<ref\b[^>]*\/>/gi, '');
  for (let i = 0; i < 6; i++) text = text.replace(/\{\{[^{}]*\}\}/g, '');
  text = text.replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1')
    .replace(/<[^>]*>/g, '').replace(/''+/g, '')
    .replace(/&(?:nbsp|#160);/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ').trim();
  return text;
}

function extractQuotes(wikitext) {
  const quotes = [];
  let excluded = false;
  for (const line of wikitext.split(/\r?\n/)) {
    const heading = line.match(/^\s*={2,}\s*(.*?)\s*={2,}\s*$/);
    if (heading) {
      excluded = /参考|来源|注释|链接|外部|延伸|误传|伪托|争议|参见|关于|生平|註釋|误引|脚注|References|Sources|External|Misattributed|Disputed|About /i.test(heading[1]);
      continue;
    }
    if (excluded || !/^\s*\*(?!\*)\s*\S/.test(line)) continue;
    const text = cleanWikitext(line.replace(/^\s*\*\s*/, ''));
    if (text.length < 10 || text.length > 140 || /[=\[\]{}|]/.test(text) || /[:：]$/.test(text)) continue;
    if (/^(?:Category|File|Image|分类|参考|出处|来源|译文|注释)\s*[:：]/i.test(text)) continue;
    quotes.push(text);
  }
  return [...new Set(quotes)];
}

function quoteId(quote) {
  return crypto.createHash('sha256').update(quote.text.normalize('NFKC').replace(/\s+/g, '').toLowerCase()).digest('hex');
}

function isCachedQuote(quote) {
  return typeof quote?.text === 'string' && quote.text.trim().length > 0
    && typeof quote.source === 'string' && typeof quote.url === 'string' && /^https?:\/\//.test(quote.url);
}

class QuoteService {
  constructor(dataDir, { fetcher = fetch, random = Math.random, minIntervalMs = 550 } = {}) {
    this.file = path.join(dataDir, 'welcome-quotes.json');
    this.fetcher = fetcher;
    this.random = random;
    this.minIntervalMs = minIntervalMs;
    this.lastHitokotoAt = 0;
    this.refilling = null;
    this.fetchPending = null;
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.state = {}; }
    if (!this.state || typeof this.state !== 'object' || Array.isArray(this.state)) this.state = {};
    if (!Array.isArray(this.state.recent)) this.state.recent = [];
    if (!Array.isArray(this.state.cache)) this.state.cache = [];
    this.state.cache = this.state.cache.filter(isCachedQuote).slice(0, 250);
    const seen = new Set(this.state.recent);
    this.state.ready = (Array.isArray(this.state.ready) ? this.state.ready : []).filter(quote => {
      if (!isCachedQuote(quote) || seen.has(quoteId(quote))) return false;
      seen.add(quoteId(quote));
      return true;
    }).slice(0, PREFETCH_COUNT);
    if (!Array.isArray(this.state.order)) this.state.order = [];
    if (!this.state.cursors || typeof this.state.cursors !== 'object') this.state.cursors = {};
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state));
    fs.renameSync(temporary, this.file);
  }

  async request(wiki, params) {
    const url = new URL(`https://${wiki}.wikiquote.org/w/api.php`);
    for (const [key, value] of Object.entries({ action: 'query', format: 'json', formatversion: '2', ...params })) url.searchParams.set(key, value);
    const response = await this.fetcher(url.href, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': `miniGPT/${version} (desktop welcome quotation reader)`, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Wikiquote HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error.info || 'Wikiquote API error');
    return data;
  }

  async fetchHitokoto(category) {
    // The public service asks clients to stay below two requests per second.
    const delay = this.lastHitokotoAt + this.minIntervalMs - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    this.lastHitokotoAt = Date.now();
    const url = new URL('https://v1.hitokoto.cn/');
    url.searchParams.set('c', category.type);
    url.searchParams.set('max_length', '100');
    const response = await this.fetcher(url.href, { signal: AbortSignal.timeout(6000), headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Hitokoto HTTP ${response.status}`);
    const data = await response.json();
    const text = typeof data.hitokoto === 'string' ? data.hitokoto.trim() : '';
    if (text.length < 8 || text.length > 140 || !/^[a-k]$/.test(data.type) || data.type !== category.type || !/^[a-f\d-]{36}$/i.test(data.uuid || '')) return null;
    const from = typeof data.from === 'string' && data.from.trim() ? data.from.trim().slice(0, 80) : '出处未注明';
    const author = typeof data.from_who === 'string' && data.from_who.trim() ? ` · ${data.from_who.trim().slice(0, 60)}` : '';
    return { text, source: `${category.kind} · ${from}${author} · 一言`, url: `https://hitokoto.cn/?uuid=${data.uuid}` };
  }

  async pickPage(category) {
    let title = category.title;
    for (let depth = 0; depth < 3; depth++) {
      const cursorKey = `${category.wiki}:${title}`;
      const params = { list: 'categorymembers', cmtitle: title, cmtype: 'page|subcat', cmlimit: '100' };
      if (this.state.cursors[cursorKey]) params.cmcontinue = this.state.cursors[cursorKey];
      const data = await this.request(category.wiki, params);
      this.state.cursors[cursorKey] = data.continue?.cmcontinue || null;
      const members = data.query?.categorymembers || [];
      const pages = members.filter(item => item.ns === 0);
      const subcategories = members.filter(item => item.ns === 14);
      if (subcategories.length && (pages.length === 0 || this.random() < 0.45) && depth < 2) {
        title = subcategories[Math.floor(this.random() * subcategories.length)].title;
        continue;
      }
      if (pages.length) return pages[Math.floor(this.random() * pages.length)].title;
      if (subcategories.length && depth < 2) {
        title = subcategories[Math.floor(this.random() * subcategories.length)].title;
        continue;
      }
      return null;
    }
    return null;
  }

  async fetchQuote(category) {
    const title = await this.pickPage(category);
    if (!title) return null;
    const data = await this.request(category.wiki, { prop: 'revisions', titles: title, rvprop: 'content', rvslots: 'main' });
    const page = data.query?.pages?.[0];
    const content = page?.revisions?.[0]?.slots?.main?.content;
    if (typeof content !== 'string') return null;
    const candidates = extractQuotes(content).map(text => ({
      text, source: `${category.kind} · ${page.title || title} · 维基语录`,
      url: `https://${category.wiki}.wikiquote.org/wiki/${encodeURIComponent((page.title || title).replace(/ /g, '_'))}`,
    })).filter(item => this.isUnseen(item));
    return candidates.length ? candidates[Math.floor(this.random() * candidates.length)] : null;
  }

  nextCategory() {
    if (!this.state.order.length) {
      this.state.order = CATEGORIES.map((_, i) => i);
      for (let i = this.state.order.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [this.state.order[i], this.state.order[j]] = [this.state.order[j], this.state.order[i]];
      }
    }
    return CATEGORIES[this.state.order.pop()];
  }

  remember(quote) {
    this.state.recent.push(quoteId(quote));
    this.state.recent = this.state.recent.slice(-500);
    this.state.cache = [quote, ...this.state.cache.filter(item => quoteId(item) !== quoteId(quote))].slice(0, 250);
    this.save();
    return quote;
  }

  fallback() {
    const cached = this.state.cache.filter(item => item?.text && item?.url && !this.state.recent.slice(-20).includes(quoteId(item)));
    if (cached.length) return this.remember(cached[Math.floor(this.random() * cached.length)]);
    if (this.state.cache.length) return this.remember(this.state.cache[Math.floor(this.random() * this.state.cache.length)]);
    return { text: '暂时无法取得在线语录。连接网络后，新聊天会继续更新。', source: '离线提示', url: '' };
  }

  isUnseen(quote) {
    const id = quoteId(quote);
    return !this.state.recent.includes(id) && !this.state.ready.some(item => quoteId(item) === id);
  }

  async fetchFresh() {
    const category = this.nextCategory();
    try {
      const quote = await this.fetchHitokoto(category);
      if (quote && this.isUnseen(quote)) return quote;
    } catch {}
    // A duplicate or unavailable primary service can still yield an unseen
    // quotation from a current Wikiquote page without hammering either API.
    try {
      const quote = await this.fetchQuote(category);
      if (quote && this.isUnseen(quote)) return quote;
    } catch {}
    return null;
  }

  warmup() {
    if (this.refilling) return this.refilling;
    if (this.state.ready.length >= PREFETCH_COUNT) return Promise.resolve();
    this.refilling = (async () => {
      try {
        while (this.state.ready.length < PREFETCH_COUNT) {
          // Publish each result immediately so a cold start only waits for the
          // first quote, never for the whole buffer or its slower replacements.
          this.fetchPending = this.fetchFresh().then(quote => {
            if (quote) this.state.ready.push(quote);
            this.save();
            return quote;
          });
          if (!await this.fetchPending) break;
        }
      } catch (error) {
        console.warn('miniGPT could not refill welcome quotations:', error.message);
      } finally {
        this.refilling = null;
        this.fetchPending = null;
      }
    })();
    return this.refilling;
  }

  async next({ waitForNetwork = true } = {}) {
    const needsInitialQuote = waitForNetwork && !this.state.ready.length && !this.state.cache.length;
    if (needsInitialQuote) {
      this.warmup();
      await this.fetchPending?.catch(() => null);
    }
    const quote = this.state.ready.shift();
    const result = quote ? this.remember(quote) : this.fallback();
    // Cached quotes are returned without waiting for any network request.
    if (quote || !needsInitialQuote) this.warmup();
    return result;
  }
}

module.exports = { QuoteService, extractQuotes, cleanWikitext, CATEGORIES };
