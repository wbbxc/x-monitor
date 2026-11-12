// Google 采集：CSE 优先，Google News RSS 默认，失败时回退 Bing News。
import { parseFeed, buildWebFeedUrls } from './web.js';
import { configOf, defaultMaxItems } from './rules.js';
import { extractPageContent } from './html.js';
import { canonicalizeUrl, cleanText } from './text.js';

const CSE_URL = 'https://www.googleapis.com/customsearch/v1';
const GOOGLE_NEWS = 'https://news.google.com/rss/search?q={query}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans';
const BING_NEWS = 'https://www.bing.com/news/search?q={query}&format=rss';

function maxItems(settings) {
  return defaultMaxItems(settings);
}

function queryOf(rule, settings) {
  const value = String(rule?.value || settings.query || '').trim();
  const site = String(settings.site || (rule?.kind === 'site' ? rule.value : '')).trim().replace(/^site:/i, '');
  if (!value && !site) return '';
  if (!site) return value;
  return `site:${site}${value ? ` ${value}` : ''}`;
}

export function buildGoogleNewsUrl(query, settings = {}) {
  const encoded = encodeURIComponent(query);
  return GOOGLE_NEWS
    .replace('{query}', encoded)
    .replace('hl=zh-CN', `hl=${encodeURIComponent(settings.hl || 'zh-CN')}`)
    .replace('gl=CN', `gl=${encodeURIComponent(settings.gl || 'CN')}`)
    .replace('ceid=CN:zh-Hans', `ceid=${encodeURIComponent(settings.ceid || 'CN:zh-Hans')}`);
}

export function buildBingNewsUrl(query) {
  return BING_NEWS.replace('{query}', encodeURIComponent(query));
}

function newsItems(feed, { provider, query, sourceUrl, settings }) {
  return feed.slice(0, maxItems(settings)).map((item) => ({
    platform: 'google',
    external_id: item.url,
    canonical_url: canonicalizeUrl(item.url),
    source_url: sourceUrl || item.source_url || '',
    title: item.title,
    content: item.summary,
    summary: item.summary,
    author: item.source_name || '',
    published_at: item.published_at,
    links: [item.url, item.source_url],
    raw_json: item,
    metadata: { provider, query, site: settings.site || '', degraded: provider !== 'google_news' },
  }));
}

async function fetchNews(ctx, query, provider) {
  const settings = { ...ctx.settings, ...(ctx.rule?.options || {}) };
  const url = provider === 'bing_news' ? buildBingNewsUrl(query) : buildGoogleNewsUrl(query, settings);
  const response = await ctx.fetch(url, {
    headers: { accept: 'application/rss+xml, application/xml, text/xml, */*;q=0.8' },
  });
  const feed = parseFeed(response.text, provider, { keepIncomplete: false });
  return { items: newsItems(feed, {
    provider, query, sourceUrl: ctx.source?.url || '', settings,
  }), meta: { provider, url, status: response.status, count: feed.length } };
}

function cseItems(payload, ctx, query) {
  const settings = { ...ctx.settings, ...(ctx.rule?.options || {}) };
  const values = Array.isArray(payload?.items) ? payload.items : [];
  return values.slice(0, maxItems(settings)).map((entry) => {
    const link = canonicalizeUrl(entry.link);
    const pagemap = entry.pagemap || {};
    const metatags = pagemap.metatags?.[0] || {};
    return {
      platform: 'google',
      external_id: link || entry.cacheId,
      canonical_url: link,
      source_url: ctx.source?.url || '',
      title: cleanText(entry.title),
      content: cleanText(entry.snippet),
      summary: cleanText(entry.snippet),
      author: cleanText(metatags['article:author'] || metatags.author || entry.displayLink || ''),
      published_at: metatags['article:published_time'] || null,
      links: [link, entry.formattedUrl],
      raw_json: entry,
      metadata: {
        provider: 'google_cse', query, site: settings.site || '',
        degraded: false, displayLink: entry.displayLink || '',
      },
    };
  }).filter((item) => item.canonical_url);
}

async function fetchCse(ctx, query) {
  const settings = { ...ctx.settings, ...(ctx.rule?.options || {}) };
  const apiKey = String(ctx.auth?.token || '').trim();
  const cx = String(settings.cx || process.env.GOOGLE_CSE_CX || '').trim();
  if (!apiKey || !cx) {
    const error = new Error('Google CSE 需要 api_key 认证和 config.cx');
    error.code = 'AUTH_REQUIRED';
    throw error;
  }
  const pageSize = 10;
  const maxPages = Math.max(1, Math.min(10, Number(settings.maxPages) || 1));
  const items = [];
  const pages = [];
  for (let page = 0; page < maxPages; page++) {
    const start = page * pageSize + 1;
    const url = new URL(CSE_URL);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('cx', cx);
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(pageSize));
    url.searchParams.set('start', String(start));
    if (settings.safe) url.searchParams.set('safe', String(settings.safe));
    if (settings.dateRestrict) url.searchParams.set('dateRestrict', String(settings.dateRestrict));
    const response = await ctx.fetch(url.href);
    let payload;
    try { payload = JSON.parse(response.text); } catch { throw new Error('Google CSE 返回不是有效 JSON'); }
    if (payload.error) {
      const error = new Error(`Google CSE: ${payload.error.message || '请求失败'}`);
      error.code = payload.error.code === 403 ? 'QUOTA_OR_FORBIDDEN' : 'PROVIDER_ERROR';
      throw error;
    }
    const pageItems = cseItems(payload, ctx, query);
    pages.push({ start, status: response.status, count: pageItems.length });
    items.push(...pageItems);
    if (pageItems.length < pageSize || items.length >= maxItems(settings)) break;
  }
  return { items, meta: { provider: 'google_cse', query, pages, count: items.length, degraded: false } };
}

async function fillDetails(ctx, items) {
  const settings = { ...ctx.settings, ...(ctx.rule?.options || {}) };
  if (!settings.fetchDetails) return items;
  const out = [];
  for (const item of items) {
    if (!item.canonical_url) { out.push(item); continue; }
    try {
      const response = await ctx.fetch(item.canonical_url, { timeoutMs: 20_000 });
      const page = extractPageContent(response.text, item.canonical_url);
      out.push({
        ...item,
        title: page.title || item.title,
        content: page.content || item.content,
        summary: page.summary || item.summary,
        author: page.author || item.author,
        published_at: item.published_at || page.published_at,
        links: [...new Set([...(item.links || []), ...(item.canonical_url ? [item.canonical_url] : [])])],
        raw_json: [item.raw_json, { html: response.text }],
        metadata: { ...item.metadata, detail: page.format },
      });
    } catch {
      out.push(item);
    }
  }
  return out;
}

export async function collectGoogle(ctx) {
  const settings = { ...ctx.settings, ...(ctx.rule?.options || {}) };
  const query = queryOf(ctx.rule, settings);
  if (!query) throw new Error('Google 采集需要关键词或站点限定');
  const attempts = [];
  const hasCse = !!String(ctx.auth?.token || '').trim() && !!String(settings.cx || process.env.GOOGLE_CSE_CX || '').trim();
  if (hasCse) {
    try {
      const result = await fetchCse(ctx, query);
      result.items = await fillDetails(ctx, result.items);
      return { items: result.items, meta: result.meta };
    } catch (error) {
      attempts.push({ provider: 'google_cse', error: error.message });
      if (settings.fallback === false) throw error;
      ctx.logger?.warn?.(`Google CSE 失败，尝试新闻 RSS：${error.message}`);
    }
  }
  try {
    const result = await fetchNews(ctx, query, 'google_news');
    result.items = await fillDetails(ctx, result.items);
    return {
      items: result.items,
      meta: { ...result.meta, degraded: attempts.length > 0, attempts },
    };
  } catch (error) {
    attempts.push({ provider: 'google_news', error: error.message });
    if (settings.fallback === false) throw error;
  }
  try {
    const result = await fetchNews(ctx, query, 'bing_news');
    result.items = await fillDetails(ctx, result.items);
    return {
      items: result.items,
      meta: { ...result.meta, degraded: true, attempts },
    };
  } catch (error) {
    attempts.push({ provider: 'bing_news', error: error.message });
  }
  const detail = attempts.map((item) => `${item.provider}: ${item.error}`).join('；');
  throw new Error(`Google 所有提供方都失败：${detail}`);
}

export function googleDetect(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'google.com' && !host.endsWith('.google.com')) return null;
  const query = parsed.searchParams.get('q') || '';
  return {
    platform: 'google',
    kind: 'keyword',
    value: query,
    config: { maxItems: 100, maxPages: 1 },
    name: 'Google',
    url: `${parsed.origin}/`,
    confidence: 0.95,
    warnings: query ? [] : ['未从链接中识别到查询词，请补充关键词规则'],
  };
}

export const googleAdapter = {
  id: 'google', version: 2, label: 'Google 搜索 / News',
  capabilities: ['keyword', 'web-search', 'news', 'cse', 'pagination'],
  auth: { types: ['none', 'api_key', 'headers'] },
  authHints: { api_key: 'Google Custom Search API Key；搜索引擎 ID 放在 config.cx' },
  publicFallback: 'Google News / Bing News RSS',
  rateLimit: { scope: 'host', requests: 2, perMs: 1000, burst: 2 },
  configExample: { maxItems: 100, maxPages: 1, cx: '', site: '', dateRestrict: 'm1', fetchDetails: false },
  ruleKinds: [
    { kind: 'keyword', label: '关键词', requiresValue: true, valuePlaceholder: 'AI agent' },
    { kind: 'site', label: '站点搜索', requiresValue: true, valuePlaceholder: 'example.com', optionsExample: { site: 'example.com', maxPages: 5 } },
    { kind: 'full', label: '全量/固定查询', requiresValue: false, valuePlaceholder: '可选查询词' },
  ],
  detect: googleDetect,
  validateRule(rule) {
    if (['keyword', 'site'].includes(String(rule?.kind || '')) && !String(rule?.value || '').trim()) {
      throw new Error('Google 关键词/站点规则需要 value');
    }
  },
  async probe(ctx) {
    const query = queryOf(ctx.rule, ctx.settings) || 'AI';
    const response = await ctx.fetch(buildGoogleNewsUrl(query, ctx.settings), {
      headers: { accept: 'application/rss+xml, application/xml, text/xml, */*;q=0.8' },
      timeoutMs: 10_000,
      noRetry: true,
    });
    return { ok: response.status >= 200 && response.status < 300, message: `HTTP ${response.status}` };
  },
  collect: collectGoogle,
};

export { GOOGLE_NEWS, BING_NEWS };
