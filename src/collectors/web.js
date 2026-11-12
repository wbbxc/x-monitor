// 通用 Web 采集：RSS/Atom/JSON、站点搜索、列表全量、sitemap 与详情补全。
import { fetchText } from './http.js';
import { buildAuthHeaders } from './auth.js';
import { configOf, defaultMaxItems } from './rules.js';
import { config as appConfig } from '../config.js';
import {
  extractLinks, extractPageContent, parseSitemap, parseRobots, isPathAllowed,
} from './html.js';

const GOOGLE_NEWS = 'https://news.google.com/rss/search?q={query}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans';
const BING_NEWS = 'https://www.bing.com/news/search?q={query}&format=rss';

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decodeEntities(value) {
  return String(value ?? '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (full, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    return ENTITY_MAP[lower] ?? full;
  });
}

function cleanText(value) {
  let text = String(value ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // RSS 描述经常是双重编码的 HTML，解码两轮后再去标签。
  for (let i = 0; i < 2; i++) text = decodeEntities(text);
  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ');
  for (let i = 0; i < 2; i++) text = decodeEntities(text);
  return text.replace(/\s+/g, ' ').trim();
}

function attr(attrs, name) {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i');
  return attrs?.match(re)?.[1] || '';
}

function tagValue(block, names) {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i');
    const hit = block.match(re)?.[1];
    if (hit != null && cleanText(hit)) return cleanText(hit);
  }
  return '';
}

function linkValue(block) {
  const textLink = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i)?.[1];
  if (textLink && cleanText(textLink)) return cleanText(textLink);
  const href = block.match(/<link\b([^>]*)\/?\s*>/i)?.[1];
  return cleanText(attr(href, 'href'));
}

function sourceValue(block) {
  const match = block.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/i);
  if (!match) return { name: '', url: '' };
  return { name: cleanText(match[2]), url: cleanText(attr(match[1], 'url')) };
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function canonicalizeUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$|mc_)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.href;
  } catch {
    return String(value || '').trim();
  }
}

function itemBlocks(xml) {
  const rss = [...String(xml || '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  if (rss.length) return rss;
  return [...String(xml || '').matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]);
}

/** 将 RSS/Atom 文本解析为统一文章记录。 */
export function parseFeed(xml, provider = 'rss', { keepIncomplete = false } = {}) {
  return itemBlocks(xml).map((block) => {
    const source = sourceValue(block);
    const title = tagValue(block, ['title']);
    const url = canonicalizeUrl(linkValue(block));
    const summary = tagValue(block, ['description', 'content:encoded', 'summary', 'content']);
    return {
      provider,
      source_name: source.name || provider,
      source_url: source.url,
      title,
      summary,
      url,
      published_at: parseDate(tagValue(block, ['pubDate', 'published', 'updated', 'dc:date'])),
    };
  }).filter((item) => keepIncomplete || (item.title && item.url));
}

function normalizeTitle(value) {
  return cleanText(value).toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

/**
 * 构造默认搜索源。templates 可传入 {provider, url}，url 使用 {query} 占位符。
 */
export function buildWebFeedUrls(keyword, templates = []) {
  const query = encodeURIComponent(String(keyword || '').trim());
  const definitions = templates.length ? templates : [
    { provider: 'google_news', label: 'Google News', url: GOOGLE_NEWS },
    { provider: 'bing_news', label: 'Bing News', url: BING_NEWS },
  ];
  return definitions.map((item) => ({
    provider: item.provider,
    label: item.label || item.provider,
    url: String(item.url).replaceAll('{query}', query),
  }));
}

/** 聚合关键词来源，单个来源失败不会丢弃其它来源的结果。 */
export async function fetchKeywordArticles(keyword, {
  fetch,
  fetchImpl,
  proxy = '',
  templates = [],
  maxItems = 100,
  timeoutMs = 30_000,
  retries = 2,
  headers = {},
} = {}) {
  const normalizedKeyword = String(keyword || '').trim();
  if (!normalizedKeyword) throw new Error('关键词不能为空');
  const request = typeof fetch === 'function'
    ? fetch
    : (url, opts = {}) => fetchText(url, { ...opts, fetchImpl, proxy, timeoutMs, retries });
  const feeds = buildWebFeedUrls(normalizedKeyword, templates);
  const providers = await Promise.all(feeds.map(async (feed) => {
    try {
      const response = await request(feed.url, { headers });
      const items = parseFeed(response.text, feed.provider).slice(0, Math.max(1, Number(maxItems) || 100));
      return { ...feed, status: 'ok', count: items.length, items };
    } catch (error) {
      return { ...feed, status: 'error', count: 0, items: [], error: error.message };
    }
  }));

  const seen = new Set();
  const items = [];
  for (const provider of providers) {
    for (const item of provider.items) {
      const day = item.published_at?.slice(0, 10) || '';
      const titleKey = normalizeTitle(item.title);
      const keys = [`url:${item.url}`];
      if (titleKey) keys.push(`title:${titleKey}:${day}`);
      if (keys.some((key) => seen.has(key))) continue;
      keys.forEach((key) => seen.add(key));
      items.push(item);
    }
  }
  items.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));
  return {
    keyword: normalizedKeyword,
    items,
    providers: providers.map(({ items: _items, ...summary }) => summary),
    fetched_at: new Date().toISOString(),
  };
}

export { canonicalizeUrl, cleanText };


function itemPlatform(source) {
  return source?.platform === 'google' ? 'google' : 'web';
}

function maxItemsOf(settings) {
  return defaultMaxItems(settings);
}

function maxPagesOf(settings, fallback = 1) {
  return Math.max(1, Math.min(100, Number(settings.maxPages) || fallback));
}

function templateUrl(template, { query = '', page = 1, offset = 0 } = {}) {
  let value = String(template || '');
  value = value.replaceAll('{query}', encodeURIComponent(query));
  value = value.replaceAll('{page}', String(page));
  value = value.replaceAll('{offset}', String(offset));
  return value;
}

function webItems(items, source, rule, extra = {}) {
  const platform = itemPlatform(source);
  return (items || []).map((item) => ({
    platform,
    source_url: source?.url || item.source_url || '',
    external_id: item.external_id || item.url || item.id,
    canonical_url: canonicalizeUrl(item.url || ''),
    title: item.title,
    content: item.content || item.summary || '',
    summary: item.summary || item.content || '',
    author: item.author || item.source_name || '',
    published_at: item.published_at || null,
    links: [...new Set([item.url, item.source_url, ...(item.links || [])].filter(Boolean))],
    raw_json: item.raw_json || item,
    metadata: {
      provider: item.provider || 'web',
      keyword: rule?.value || '',
      ...extra,
      ...(item.metadata || {}),
    },
  }));
}

function findNextLink(html, baseUrl, pattern = '') {
  if (pattern) {
    const hit = extractLinks(html, { pattern, baseUrl, maxLinks: 1 })[0];
    if (hit) return hit.url;
  }
  const relNext = html.match(/<link\b[^>]*rel=["']next["'][^>]*>/i)?.[0];
  if (relNext) {
    const href = relNext.match(/href\s*=\s*["']([^"']*)["']/i)?.[1];
    if (href) {
      try { return new URL(href, baseUrl).href; } catch {}
    }
  }
  const anchor = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .find((match) => /^(?:下一页|下頁|next|older|more)\b/i.test(cleanText(match[2] || '')));
  if (anchor) {
    const href = anchor[1].match(/href\s*=\s*["']([^"']*)["']/i)?.[1];
    if (href) {
      try { return new URL(href, baseUrl).href; } catch {}
    }
  }
  return '';
}

async function robotsFor(ctx, targetUrl) {
  let origin;
  try { origin = new URL(targetUrl).origin; } catch { return { disallow: [], allow: [], crawlDelay: null }; }
  ctx.__robots = ctx.__robots || {};
  if (ctx.__robots[origin]) return ctx.__robots[origin];
  let robots = { disallow: [], allow: [], crawlDelay: null };
  try {
    const response = await ctx.fetch(`${origin}/robots.txt`, { timeoutMs: 8_000, noRetry: true });
    if (response.status >= 200 && response.status < 300) {
      robots = parseRobots(response.text, 'x-monitor');
    }
  } catch {}
  ctx.__robots[origin] = robots;
  return robots;
}

async function assertAllowed(ctx, url) {
  const robots = await robotsFor(ctx, url);
  let pathname = '/';
  try { pathname = new URL(url).pathname || '/'; } catch {}
  if (!isPathAllowed(pathname, robots)) {
    const error = new Error(`robots.txt 禁止采集：${pathname}`);
    error.code = 'ROBOTS_DISALLOWED';
    throw error;
  }
}

async function enrichItem(ctx, item, settings) {
  if (!settings.fetchDetails || !item.canonical_url) return item;
  try {
    await assertAllowed(ctx, item.canonical_url);
    const response = await ctx.fetch(item.canonical_url, { timeoutMs: 20_000 });
    const page = extractPageContent(response.text, item.canonical_url);
    return {
      ...item,
      title: page.title || item.title,
      content: page.content || item.content || item.summary || '',
      summary: page.summary || item.summary || '',
      author: page.author || item.author || '',
      published_at: item.published_at || page.published_at,
      links: [...new Set([...(item.links || []), item.canonical_url, page.image].filter(Boolean))],
      raw_json: [item.raw_json || item, { html: response.text }],
      metadata: { ...(item.metadata || {}), detail: page.format },
    };
  } catch (error) {
    return {
      ...item,
      metadata: { ...(item.metadata || {}), detailError: error.message },
    };
  }
}

async function collectListing(ctx, settings, kind) {
  const sourceUrl = String(ctx.source?.url || settings.url || '').trim();
  const template = String(settings.listUrlTemplate || sourceUrl || '').trim();
  if (!template) throw new Error('全量列表采集需要 listUrlTemplate 或来源 URL');
  const pageStart = Math.max(1, Number(settings.pageStart) || 1);
  const maxPages = maxPagesOf(settings, kind === 'sitemap' ? 5 : 10);
  const limit = maxItemsOf(settings);
  const stopAfterSeenPages = Math.max(1, Number(settings.stopAfterSeenPages) || 1);
  const delayMs = Math.max(0, Number(settings.crawlDelayMs ?? appConfig.collector.webCrawlDelayMs) || 0);
  const seen = new Set();
  const items = [];
  const attempts = [];
  let seenPages = 0;
  let url = templateUrl(template, { page: pageStart });

  for (let page = 0; page < maxPages && items.length < limit && url; page++) {
    try {
      await assertAllowed(ctx, url);
      const response = await ctx.fetch(url, {
        headers: { accept: 'text/html,application/xhtml+xml,application/xml,application/json,*/*;q=0.8' },
      });
      const html = String(response.text || '');
      const links = extractLinks(html, {
        pattern: settings.itemLinkPattern || settings.resultLinkPattern || '',
        include: settings.itemLinkIncludes || settings.includeLinks || [],
        exclude: settings.itemLinkExcludes || settings.excludeLinks || [],
        baseUrl: url,
        maxLinks: limit - items.length,
      });
      attempts.push({ url, status: response.status, links: links.length });
      let added = 0;
      for (const link of links) {
        if (seen.has(link.url) || items.length >= limit) continue;
        seen.add(link.url);
        const base = {
          provider: kind === 'sitemap' ? 'sitemap' : 'site_listing',
          url: link.url,
          title: link.title || link.url,
          content: link.text || '',
          summary: link.text || '',
          source_url: url,
          raw_json: { link, html: settings.keepListingHtml ? html : undefined },
          metadata: { mode: kind, page: page + 1, listingUrl: url },
        };
        items.push(await enrichItem(ctx, base, settings));
        added++;
      }
      if (!added) {
        seenPages++;
        if (seenPages >= stopAfterSeenPages) break;
      } else {
        seenPages = 0;
      }
      url = findNextLink(html, url, settings.nextLinkPattern || '');
      if (!url && template.includes('{page}')) {
        url = page + 2 <= maxPages ? templateUrl(template, { page: pageStart + page + 1 }) : '';
      }
      if (delayMs > 0 && url) await ctx.sleep(delayMs);
    } catch (error) {
      attempts.push({ url, status: error.status || 0, error: error.message });
      if (error.code === 'ROBOTS_DISALLOWED') break;
      if (!attempts.some((item) => item.status >= 200 && item.status < 300)) throw error;
      break;
    }
  }
  return { items, meta: { mode: kind, attempts, count: items.length, degraded: attempts.some((item) => item.error) } };
}

async function collectSitemap(ctx, settings) {
  const sourceUrl = String(ctx.source?.url || '').trim();
  const sitemapUrl = String(settings.sitemapUrl || (sourceUrl && /sitemap/i.test(sourceUrl) ? sourceUrl : '') || '').trim();
  if (!sitemapUrl) throw new Error('sitemap 模式需要 sitemapUrl');
  const limit = maxItemsOf(settings);
  const maxSitemaps = Math.max(1, Math.min(20, Number(settings.maxSitemaps) || 5));
  const seen = new Set();
  const items = [];
  const attempts = [];
  const queue = [sitemapUrl];
  let fetched = 0;
  while (queue.length && fetched < maxSitemaps && items.length < limit) {
    const url = queue.shift();
    try {
      await assertAllowed(ctx, url);
      const response = await ctx.fetch(url, {
        headers: { accept: 'application/xml,text/xml,text/plain,*/*;q=0.8' },
      });
      const sitemap = parseSitemap(response.text);
      attempts.push({ url, status: response.status, type: sitemap.type, urls: sitemap.urls.length });
      fetched++;
      if (sitemap.type === 'index') {
        for (const child of sitemap.urls.slice(0, maxSitemaps - queue.length)) queue.push(child);
        continue;
      }
      for (const loc of sitemap.urls) {
        if (seen.has(loc) || items.length >= limit) continue;
        seen.add(loc);
        const base = {
          provider: 'sitemap',
          url: loc,
          title: loc,
          content: '',
          summary: '',
          source_url: url,
          raw_json: { loc },
          metadata: { mode: 'sitemap', sitemapUrl: url },
        };
        items.push(await enrichItem(ctx, base, settings));
      }
    } catch (error) {
      attempts.push({ url, status: error.status || 0, error: error.message });
      if (!attempts.some((item) => item.status >= 200 && item.status < 300)) throw error;
      break;
    }
  }
  return { items, meta: { mode: 'sitemap', attempts, count: items.length, degraded: attempts.some((item) => item.error) } };
}

async function collectSiteSearch(ctx, settings, query) {
  const sourceUrl = String(ctx.source?.url || '').trim();
  const template = String(settings.searchUrlTemplate || '').trim();
  if (!template) {
    // 没有站点搜索模板：回退 Google/Bing 的 site: 搜索。
    if (!sourceUrl) throw new Error('站点搜索需要 searchUrlTemplate 或来源 URL');
    let host = '';
    try { host = new URL(sourceUrl).hostname; } catch {}
    const siteQuery = `site:${host}${query ? ` ${query}` : ''}`.trim();
    const result = await fetchKeywordArticles(siteQuery, {
      fetch: ctx.fetch,
      templates: settings.templates || [],
      maxItems: maxItemsOf(settings),
    });
    return {
      items: webItems(result.items, ctx.source, ctx.rule, {
        mode: 'site_search', query, site: host, degraded: true,
      }),
      meta: { ...result, mode: 'site_search', query, site: host, degraded: true },
    };
  }
  const pageStart = Math.max(1, Number(settings.pageStart) || 1);
  const maxPages = maxPagesOf(settings, 5);
  const limit = maxItemsOf(settings);
  const delayMs = Math.max(0, Number(settings.crawlDelayMs ?? appConfig.collector.webCrawlDelayMs) || 0);
  const seen = new Set();
  const items = [];
  const attempts = [];
  for (let page = 0; page < maxPages && items.length < limit; page++) {
    const url = templateUrl(template, { page: pageStart + page, query });
    try {
      await assertAllowed(ctx, url);
      const response = await ctx.fetch(url, {
        headers: { accept: 'text/html,application/xhtml+xml,application/json,*/*;q=0.8' },
      });
      const html = String(response.text || '');
      const links = extractLinks(html, {
        pattern: settings.resultLinkPattern || settings.itemLinkPattern || '',
        include: settings.resultLinkIncludes || settings.itemLinkIncludes || [],
        exclude: settings.resultLinkExcludes || settings.itemLinkExcludes || [],
        baseUrl: url,
        maxLinks: limit - items.length,
      });
      attempts.push({ url, status: response.status, links: links.length });
      let added = 0;
      for (const link of links) {
        if (seen.has(link.url) || items.length >= limit) continue;
        seen.add(link.url);
        const base = {
          provider: 'site_search',
          url: link.url,
          title: link.title || link.url,
          content: link.text || '',
          summary: link.text || '',
          source_url: url,
          raw_json: { link },
          metadata: { mode: 'search', query, page: page + 1, searchUrl: url },
        };
        items.push(await enrichItem(ctx, base, settings));
        added++;
      }
      if (!added) break;
      if (!template.includes('{page}')) break;
      if (delayMs > 0) await ctx.sleep(delayMs);
    } catch (error) {
      attempts.push({ url, status: error.status || 0, error: error.message });
      if (!attempts.some((item) => item.status >= 200 && item.status < 300)) throw error;
      break;
    }
  }
  return {
    items,
    meta: { mode: 'search', query, attempts, count: items.length, degraded: attempts.some((item) => item.error) },
  };
}

async function collectFeed(ctx) {
  const settings = { ...configOf(ctx.source), ...(ctx.rule?.options || {}) };
  const headers = buildAuthHeaders(ctx.auth);
  if (!ctx.source?.url) throw new Error('feed 采集需要来源 URL');
  const response = await ctx.fetch(ctx.source.url, {
    headers: { ...headers, accept: 'application/rss+xml, application/atom+xml, application/json, text/xml, text/html, */*;q=0.8' },
  });
  const text = String(response.text || '').trim();
  if (text) {
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    if (Array.isArray(payload)) {
      const items = payload.map((entry) => ({
        title: entry.title || entry.name || '',
        content: entry.content || entry.summary || entry.description || entry.text || '',
        summary: entry.summary || entry.description || entry.content || entry.text || '',
        url: entry.url || entry.link || entry.canonical_url || '',
        author: entry.author || entry.username || '',
        published_at: entry.published_at || entry.created_at,
        source_name: entry.source_name || entry.author || '',
        source_url: entry.source_url || ctx.source.url,
        provider: 'json',
        raw_json: entry,
      }));
      return { items: webItems(items, ctx.source, ctx.rule), meta: { status: response.status, format: 'json' } };
    }
    const feed = parseFeed(text, 'feed', { keepIncomplete: true });
    if (feed.length) {
      const items = feed.slice(0, maxItemsOf(settings));
      const normalized = items.map((item) => ({
        ...item,
        canonical_url: item.url,
        content: item.summary,
        provider: 'feed',
        raw_json: item,
      }));
      const enriched = settings.fetchDetails
        ? await Promise.all(normalized.map((item) => enrichItem(ctx, item, settings)))
        : normalized;
      return { items: webItems(enriched, ctx.source, ctx.rule), meta: { status: response.status, format: 'feed' } };
    }
  }
  const page = extractPageContent(text, ctx.source.url);
  const canonical = canonicalizeUrl(page.canonical_url || ctx.source.url);
  return {
    items: [{
      platform: itemPlatform(ctx.source), source_url: ctx.source.url,
      external_id: canonical || (page.title + page.content).slice(0, 120), canonical_url: canonical,
      title: page.title || ctx.source.name || ctx.source.url,
      content: page.content, summary: page.summary || page.content.slice(0, 4000), author: page.author,
      published_at: page.published_at, links: [canonical],
      raw_json: { html: text }, metadata: { format: page.format, mode: 'page' },
    }],
    meta: { status: response.status, format: page.format, mode: 'page' },
  };
}

async function collectWeb(ctx) {
  const settings = { ...configOf(ctx.source), ...(ctx.rule?.options || {}) };
  const mode = String(settings.mode || '').toLowerCase();
  const keyword = String(ctx.rule?.value || settings.keyword || '').trim();
  if (mode === 'sitemap') return collectSitemap(ctx, settings);
  if (mode === 'full') return collectListing(ctx, settings, 'full');
  if (mode === 'search') return collectSiteSearch(ctx, settings, keyword);
  if (mode === 'feed') return collectFeed(ctx);
  if (ctx.rule?.kind === 'sitemap') return collectSitemap(ctx, settings);
  if (ctx.rule?.kind === 'full') {
    if (settings.listUrlTemplate || settings.sitemapUrl) return collectListing(ctx, settings, 'full');
    return collectFeed(ctx);
  }
  if (ctx.rule?.kind === 'keyword' || ctx.rule?.kind === 'search') {
    if (settings.searchUrlTemplate) return collectSiteSearch(ctx, settings, keyword);
    if (!keyword) throw new Error('web 关键词规则需要 value');
    if (ctx.source?.url) return collectSiteSearch(ctx, settings, keyword);
    const result = await fetchKeywordArticles(keyword, {
      fetch: ctx.fetch,
      templates: settings.templates || [],
      maxItems: maxItemsOf(settings),
    });
    return {
      items: webItems(result.items, ctx.source, ctx.rule, { mode: 'keyword' }),
      meta: { ...result, mode: 'keyword' },
    };
  }
  return collectFeed(ctx);
}

export const webAdapter = {
  id: 'web', version: 2, label: '通用 Web / RSS / 站点搜索',
  capabilities: ['keyword', 'rss', 'json', 'search', 'full', 'sitemap', 'html'],
  auth: { types: ['none', 'cookie', 'bearer', 'token', 'api_key', 'basic', 'headers'] },
  authHints: { cookie: '需要登录的站点才填写；匿名采集只访问公开页面' },
  publicFallback: true,
  rateLimit: { scope: 'host', requests: 1, perMs: 1000, burst: 2 },
  configExample: {
    maxItems: 100,
    mode: 'search',
    searchUrlTemplate: 'https://example.com/search?q={query}&page={page}',
    resultLinkPattern: 'href="(/article/[^"]+)"',
    itemLinkIncludes: ['/article/'],
    maxPages: 5,
    fetchDetails: false,
  },
  ruleKinds: [
    { kind: 'keyword', label: '关键词', requiresValue: true, valuePlaceholder: 'AI agent' },
    { kind: 'search', label: '站点搜索', requiresValue: true, valuePlaceholder: '关键词', optionsExample: { searchUrlTemplate: 'https://example.com/search?q={query}&page={page}' } },
    { kind: 'full', label: '全量列表', requiresValue: false, valuePlaceholder: '', optionsExample: { listUrlTemplate: 'https://example.com/news?page={page}', maxPages: 20 } },
    { kind: 'sitemap', label: 'Sitemap', requiresValue: false, valuePlaceholder: '', optionsExample: { sitemapUrl: 'https://example.com/sitemap.xml' } },
  ],
  validateSource(source) {
    const config = configOf(source);
    if (!source?.url && !config.keyword && !config.searchUrlTemplate && !config.listUrlTemplate && !config.sitemapUrl) {
      throw new Error('web 采集源需要 URL、关键词或站点搜索/列表/sitemap 模板');
    }
  },
  validateRule(rule) {
    const kind = String(rule?.kind || 'keyword').toLowerCase();
    if (!['keyword', 'search', 'full', 'sitemap', 'account'].includes(kind)) {
      throw new Error(`web 不支持规则类型: ${kind}`);
    }
    if (['keyword', 'search', 'account'].includes(kind) && !String(rule?.value || '').trim()) {
      throw new Error('web 关键词规则需要 value');
    }
  },
  detect(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return {
      platform: 'web',
      kind: 'full',
      value: '',
      config: { mode: 'full', listUrlTemplate: parsed.href, maxPages: 1 },
      name: host,
      url: parsed.href,
      confidence: 0.3,
      warnings: ['通用 web 采集：建议根据站点结构调整列表/搜索模板'],
    };
  },
  async probe(ctx) {
    const url = ctx.source?.url || configOf(ctx.source).searchUrlTemplate?.replace(/\{query\}/, 'test');
    if (!url) return { ok: false, message: '没有可探测的链接' };
    const response = await ctx.fetch(url, { timeoutMs: 10_000, noRetry: true });
    return { ok: response.status >= 200 && response.status < 300, message: `HTTP ${response.status}` };
  },
  collect: collectWeb,
};
