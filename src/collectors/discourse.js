// Discourse 通用采集器：linux.do、macos.do 等站点共用 latest/top/search/RSS/详情补全。
import { setTimeout as delay } from 'node:timers/promises';
import { fetchText } from './http.js';
import { parseFeed } from './web.js';
import { canonicalizeUrl, cleanText } from './text.js';
import { buildAuthHeaders } from './auth.js';

export const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'accept-encoding': 'gzip, deflate, br',
  'sec-ch-ua': '"Chromium";v="155", "Not:A-Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'upgrade-insecure-requests': '1',
};

export const DISCOURSE_DEFAULTS = {
  'linux.do': { origin: 'https://linux.do', defaultUrl: 'https://linux.do/latest.json', label: 'linux.do' },
  'macos.do': { origin: 'https://macos.do', defaultUrl: 'https://macos.do/latest.json', label: 'macos.do' },
};

function configOf(source) {
  if (!source?.config) return {};
  if (typeof source.config === 'object') return source.config;
  try { return JSON.parse(source.config); } catch { return {}; }
}

function siteLabel(origin) {
  try { return new URL(origin).hostname; } catch { return 'Discourse'; }
}

function describeFetchError(error, origin) {
  const site = siteLabel(origin);
  if (error?.status === 403) {
    let detail = '';
    try {
      const payload = JSON.parse(error.body);
      detail = payload?.errors?.[0] || payload?.error_type || '';
    } catch {}
    return new Error(detail
      ? `${site} 需要登录：${detail}（请在采集配置中填写 Cookie）`
      : `${site} 拒绝访问（HTTP 403），请检查 Cookie 或代理`);
  }
  if (error?.status === 429) return new Error(`${site} 触发限流（HTTP 429），请稍后重试`);
  return error;
}

function matchItem(item, rule) {
  const value = String(rule?.value || '').trim().toLocaleLowerCase();
  if (!value) return true;
  const kind = String(rule?.kind || 'keyword').toLowerCase();
  if (kind === 'account' || kind === 'author' || kind === 'user') {
    return String(item.author || '').toLocaleLowerCase().includes(value.replace(/^@+/, ''));
  }
  const haystack = [item.title, item.content, item.summary, item.author, item.metadata?.category, ...(item.metadata?.tags || [])]
    .join('\n').toLocaleLowerCase();
  return haystack.includes(value);
}

export function buildDiscourseUrl(source, rule = {}, origin = 'https://linux.do') {
  const configured = String(source?.url || '').trim();
  let base = origin;
  try { base = new URL(configured || `${origin}/latest.json`).origin; } catch {}
  const keyword = String(rule?.value || '').trim();
  const kind = String(rule?.kind || '').toLowerCase();
  if (keyword && (kind === 'keyword' || kind === 'search')) {
    return `${base}/search.json?q=${encodeURIComponent(keyword)}`;
  }
  return configured || `${origin}/latest.json`;
}

function topicList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.topic_list?.topics)) return payload.topic_list.topics;
  if (Array.isArray(payload?.topics)) return payload.topics;
  return [];
}

function topicUrl(topic, origin) {
  const raw = topic.url || topic.topic_url || (topic.slug && topic.id ? `/t/${topic.slug}/${topic.id}` : '');
  if (!raw) return '';
  try { return new URL(raw, origin).href; } catch { return ''; }
}

export function normalizeDiscourseTopic(topic, {
  sourceUrl = '', users = [], origin = 'https://linux.do', platform = 'linux.do',
} = {}) {
  const url = topicUrl(topic, origin);
  const title = cleanText(topic.title || topic.fancy_title || '');
  const content = cleanText(topic.excerpt || topic.content || topic.cooked || '');
  const userMap = new Map((Array.isArray(users) ? users : []).map((user) => [user.id, user.username]));
  const posters = Array.isArray(topic.posters) ? topic.posters : [];
  const authorPoster = posters.find((poster) => /原始发帖人|Original Poster/i.test(String(poster.description || ''))) || posters[0];
  const tags = Array.isArray(topic.tags)
    ? topic.tags.map((tag) => (typeof tag === 'string' ? tag : tag?.name)).filter(Boolean)
    : [];
  return {
    platform,
    external_id: String(topic.id ?? topic.topic_id ?? url),
    canonical_url: canonicalizeUrl(url),
    source_url: sourceUrl || `${origin}/latest.json`,
    title,
    content,
    summary: content,
    author: topic.author?.username
      || authorPoster?.user?.username
      || userMap.get(authorPoster?.user_id)
      || topic.last_poster_username
      || topic.username
      || '',
    published_at: topic.created_at || topic.last_posted_at || topic.createdAt || null,
    links: [url],
    raw_json: topic,
    metadata: {
      category: topic.category_name || topic.category?.name || '',
      category_id: topic.category_id ?? null,
      tags,
      replies: Number(topic.reply_count ?? topic.replies ?? topic.posts_count ?? 0),
      views: topic.views ?? null,
      pinned: !!topic.pinned,
      provider: 'discourse',
      notification: {
        event: 'topic',
        title: title.slice(0, 200),
        body: content.slice(0, 500),
      },
    },
  };
}

function feedTopic(item) {
  return {
    id: item.url,
    title: item.title,
    url: item.url,
    excerpt: item.summary,
    created_at: item.published_at,
    author: item.source_name,
    raw: item,
  };
}

function makeRequest({ fetch, fetchImpl, proxy, timeoutMs, retries }) {
  if (typeof fetch === 'function') return fetch;
  return (url, opts = {}) => fetchText(url, {
    ...opts,
    fetchImpl,
    proxy,
    timeoutMs: opts.timeoutMs ?? timeoutMs,
    retries: opts.retries ?? retries,
  });
}

async function fillDetails(items, { request, auth, timeoutMs, retries, origin, platform, sourceUrl }) {
  const detailed = [];
  for (const item of items) {
    if (item.content || !item.canonical_url) { detailed.push(item); continue; }
    try {
      const detailUrl = `${item.canonical_url.replace(/\/$/, '')}.json`;
      const response = await request(detailUrl, {
        timeoutMs, retries, http2: true,
        headers: { ...BROWSER_HEADERS, ...buildAuthHeaders(auth) },
      });
      const payload = JSON.parse(response.text);
      const post = payload?.post_stream?.posts?.[0];
      const content = cleanText(post?.cooked || post?.raw || '');
      detailed.push({
        ...item,
        platform,
        source_url: item.source_url || sourceUrl,
        content: content || item.content,
        summary: item.summary || content,
        raw_json: { topic: item.raw_json, detail: payload },
      });
    } catch {
      detailed.push(item);
    }
  }
  return detailed;
}

async function fetchTopics(url, { request, sourceUrl, origin, platform, users = [], auth = { type: 'none' } }) {
  let response;
  try {
    response = await request(url, { http2: true, headers: { ...BROWSER_HEADERS, ...buildAuthHeaders(auth) } });
  } catch (error) {
    throw describeFetchError(error, origin);
  }
  const text = String(response.text || '').trim();
  let topics = [];
  let payloadUsers = [];
  let format = 'json';
  if (text) {
    try {
      const payload = JSON.parse(text);
      topics = topicList(payload);
      payloadUsers = Array.isArray(payload?.users) ? payload.users : [];
    } catch {
      format = 'rss';
      topics = parseFeed(text, platform, { keepIncomplete: true }).map(feedTopic);
    }
  }
  return {
    response,
    format,
    items: topics.map((topic) => normalizeDiscourseTopic(topic, {
      sourceUrl: sourceUrl || `${origin}/latest.json`,
      users: payloadUsers.length ? payloadUsers : users,
      origin,
      platform,
    })),
  };
}

export function buildDiscoursePublicFeeds(source, settings = {}, origin = 'https://linux.do') {
  const configured = String(source?.url || '').trim();
  let base = origin;
  try { base = new URL(configured || `${origin}/latest.json`).origin; } catch {}
  const raw = Array.isArray(settings.publicFeeds)
    ? settings.publicFeeds
    : String(settings.publicFeeds || '').split('\n');
  const feeds = [];
  for (const entry of raw) {
    const value = String(entry || '').trim();
    if (!value) continue;
    try { feeds.push(new URL(value, base).href); } catch {}
  }
  for (const fallback of ['/latest.json', '/top.json?period=weekly']) {
    const url = new URL(fallback, base).href;
    if (!feeds.includes(url)) feeds.push(url);
  }
  return [...new Set(feeds)];
}

async function scanPublicFeeds({
  source, rule, settings, request, fetchImpl, origin, platform, reason, auth,
}) {
  const maxItems = Math.max(1, Number(settings.maxItems) || 500);
  const feeds = buildDiscoursePublicFeeds(source, settings, origin);
  const seen = new Set();
  const matched = [];
  const attempts = [];
  let success = 0;
  for (const feedUrl of feeds) {
    if (matched.length >= maxItems) break;
    try {
      const result = await fetchTopics(feedUrl, { request, sourceUrl: source?.url || `${origin}/latest.json`, origin, platform, auth });
      success++;
      let added = 0;
      for (const item of result.items) {
        const key = item.external_id || item.canonical_url;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (!matchItem(item, rule)) continue;
        matched.push(item);
        added++;
      }
      attempts.push({ url: feedUrl, status: result.response.status, format: result.format, topics: result.items.length, matched: added });
    } catch (error) {
      attempts.push({ url: feedUrl, status: error.status || 0, error: String(error.message || '').slice(0, 160) });
    }
    if (!fetchImpl) await delay(400);
  }
  if (!success) {
    const detail = attempts.map((attempt) => attempt.error || `HTTP ${attempt.status}`).join('；');
    throw new Error(`公开话题扫描失败：${detail || '没有可用地址'}`);
  }
  const items = matched.slice(0, maxItems);
  return {
    items,
    meta: {
      mode: 'public-scan',
      keyword: rule?.value || '',
      feeds: attempts,
      count: items.length,
      search: false,
      reason: reason || 'anonymous',
      platform,
    },
  };
}

export async function collectDiscourse({
  source, rule, auth, fetch, fetchImpl, proxy = '', timeoutMs, retries,
  origin = 'https://linux.do', platform = 'linux.do',
} = {}) {
  const settings = configOf(source);
  const request = makeRequest({ fetch, fetchImpl, proxy, timeoutMs, retries });
  const kind = String(rule?.kind || '').toLowerCase();
  const keyword = String(rule?.value || '').trim();
  const wantsSearch = !!keyword && (kind === 'keyword' || kind === 'search');
  const hasAuth = !!auth && String(auth.type || 'none') !== 'none';
  const fallbackEnabled = settings.keywordFallback !== false;
  const sourceUrl = source?.url || `${origin}/latest.json`;
  const maxItems = Math.max(1, Number(settings.maxItems) || 500);
  const base = { origin, platform };

  if (kind === 'category' || kind === 'tag' || kind === 'node') {
    const configured = String(source?.url || '').trim();
    let url = configured || `${origin}/latest.json`;
    if (kind === 'category') {
      const value = String(rule.value || '').trim();
      if (value) {
        try {
          const originUrl = new URL(url).origin;
          url = /^\d+$/.test(value)
            ? `${originUrl}/c/${value}.json`
            : `${originUrl}/c/${encodeURIComponent(value)}.json`;
        } catch {}
      }
    }
    if (kind === 'tag') {
      const value = String(rule.value || '').trim();
      if (value) {
        try {
          const originUrl = new URL(url).origin;
          url = `${originUrl}/tag/${encodeURIComponent(value)}.json`;
        } catch {}
      }
    }
    const result = await fetchTopics(url, { request, sourceUrl, auth, ...base });
    let items = result.items.slice(0, maxItems);
    if (settings.fetchDetails) items = await fillDetails(items, { request, auth, timeoutMs, retries, ...base, sourceUrl });
    return {
      items,
      meta: { mode: kind, url, format: result.format, status: result.response.status, count: items.length, search: false, platform },
    };
  }

  if (wantsSearch && (hasAuth || !fallbackEnabled)) {
    let searchError = null;
    try {
      const result = await fetchTopics(buildDiscourseUrl(source, rule, origin), { request, sourceUrl, auth, ...base });
      let items = result.items.slice(0, maxItems);
      if (settings.fetchDetails) {
        items = await fillDetails(items, { request, auth, timeoutMs, retries, ...base, sourceUrl });
      }
      return {
        items,
        meta: {
          mode: 'search',
          url: buildDiscourseUrl(source, rule, origin),
          format: result.format,
          status: result.response.status,
          count: items.length,
          search: true,
          platform,
        },
      };
    } catch (error) {
      if (!fallbackEnabled) throw error;
      searchError = error.message;
    }
    const result = await scanPublicFeeds({
      source, rule, settings, request, fetchImpl, auth, ...base,
      reason: `search-error: ${String(searchError || '').slice(0, 120)}`,
    });
    if (settings.fetchDetails) {
      result.items = await fillDetails(result.items, { request, auth, timeoutMs, retries, ...base, sourceUrl });
      result.meta.count = result.items.length;
    }
    return result;
  }

  if (wantsSearch) {
    const result = await scanPublicFeeds({
      source, rule, settings, request, fetchImpl, auth, ...base, reason: 'anonymous',
    });
    if (settings.fetchDetails) {
      result.items = await fillDetails(result.items, { request, auth, timeoutMs, retries, ...base, sourceUrl });
      result.meta.count = result.items.length;
    }
    return result;
  }

  const result = await fetchTopics(buildDiscourseUrl(source, rule, origin), { request, sourceUrl, auth, ...base });
  let items = result.items.filter((item) => matchItem(item, rule)).slice(0, maxItems);
  if (settings.fetchDetails) {
    items = await fillDetails(items, { request, auth, timeoutMs, retries, ...base, sourceUrl });
  }
  return {
    items,
    meta: {
      mode: 'feed', url: buildDiscourseUrl(source, rule, origin),
      format: result.format, status: result.response.status,
      count: items.length, search: false, platform,
    },
  };
}

export async function fetchDiscourseCategories({ origin = 'https://linux.do', fetch, fetchImpl, proxy = '', timeoutMs, retries } = {}) {
  const request = makeRequest({ fetch, fetchImpl, proxy, timeoutMs, retries });
  const response = await request(`${origin}/categories.json`, { http2: true, headers: BROWSER_HEADERS });
  const payload = JSON.parse(response.text);
  return (payload?.category_list?.categories || []).map((category) => ({
    id: Number(category.id),
    name: String(category.name || ''),
    slug: String(category.slug || ''),
  }));
}

export function createDiscourseAdapter({ id, label, origin, defaultUrl }) {
  return {
    id, version: 2, label,
    capabilities: ['discourse-json', 'rss', 'cookie', 'token', 'search', 'category', 'tag'],
    auth: { types: ['none', 'cookie', 'bearer', 'token', 'api_key', 'basic', 'headers'] },
    authHints: { cookie: 'Cloudflare/登录站点需要浏览器 Cookie；匿名只能扫描公开话题' },
    publicFallback: '公开 latest/top 扫描 + 本地匹配',
    rateLimit: { scope: 'host', requests: 1, perMs: 5000, burst: 1 },
    http2Default: true,
    configExample: { maxItems: 500, keywordFallback: true, fetchDetails: false },
    ruleKinds: [
      { kind: 'full', label: '最新/全量', requiresValue: false, valuePlaceholder: '' },
      { kind: 'keyword', label: '关键词搜索', requiresValue: true, valuePlaceholder: 'AI' },
      { kind: 'category', label: '分类', requiresValue: true, valuePlaceholder: 'develop' },
      { kind: 'tag', label: '标签', requiresValue: true, valuePlaceholder: 'ai' },
    ],
    detect(url) {
      let parsed;
      try { parsed = new URL(url); } catch { return null; }
      const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
      const expected = new URL(origin).hostname.toLowerCase();
      if (host !== expected) return null;
      return {
        platform: id,
        kind: 'full',
        value: '',
        config: { maxItems: 500 },
        name: label,
        url: `${origin}/latest.json`,
        confidence: 0.96,
        warnings: ['公开扫描可能触发 Cloudflare 登录/限流；需要完整搜索时请配置 Cookie'],
      };
    },
    validateSource() {},
    validateRule(rule) {
      const kind = String(rule?.kind || 'full').toLowerCase();
      if (!['full', 'keyword', 'search', 'category', 'tag', 'account'].includes(kind)) {
        throw new Error(`${label} 不支持规则类型: ${kind}`);
      }
      if (['keyword', 'search', 'category', 'tag'].includes(kind) && !String(rule?.value || '').trim()) {
        throw new Error(`${label} 的 ${kind} 规则需要 value`);
      }
    },
    async probe(ctx) {
      const response = await ctx.fetch(ctx.source?.url || defaultUrl, {
        headers: BROWSER_HEADERS,
        timeoutMs: 10_000,
        noRetry: true,
      });
      return { ok: response.status >= 200 && response.status < 300, message: `HTTP ${response.status}` };
    },
    async collect(ctx) {
      return collectDiscourse({
        source: ctx.source,
        rule: ctx.rule,
        auth: ctx.auth,
        fetch: ctx.fetch,
        timeoutMs: ctx.timeoutMs,
        retries: 0,
        origin,
        platform: id,
      });
    },
  };
}

export { configOf };
