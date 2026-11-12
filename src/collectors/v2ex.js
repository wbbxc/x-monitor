// V2EX 论坛适配器：API/RSS、节点、分页与 sov2ex 关键词搜索。
import { parseFeed } from './web.js';
import { cleanText } from './text.js';
import { configOf, defaultMaxItems } from './rules.js';

const V2EX_ORIGIN = 'https://www.v2ex.com';
const V2EX_LATEST = `${V2EX_ORIGIN}/api/topics/latest.json`;
const SOV2EX_API = 'https://www.sov2ex.com/api/search';

function maxItemsOf(settings) {
  return defaultMaxItems(settings, 500);
}

function topicItems(payload, source, platform, sourceUrl) {
  const topics = Array.isArray(payload) ? payload : payload?.topics || payload?.items || [];
  const base = sourceUrl || source?.url || V2EX_LATEST;
  return topics.map((topic) => {
    const rawUrl = topic.url || topic.topic_url
      || (topic.slug && topic.id ? `/t/${topic.slug}/${topic.id}` : (topic.id ? `/t/${topic.id}` : ''));
    let url = rawUrl;
    try { url = rawUrl ? new URL(rawUrl, base).href : ''; } catch {}
    return {
      platform,
      external_id: String(topic.id ?? topic.topic_id ?? topic.url ?? ''),
      canonical_url: url,
      source_url: source?.url || base,
      title: topic.title || topic.name || '',
      content: topic.content || topic.excerpt || topic.body || topic.text || topic.content_rendered || '',
      summary: topic.excerpt || topic.content || topic.body || topic.text || '',
      author: topic.author?.username || topic.member?.username || topic.username || topic.last_poster_username || '',
      published_at: topic.created_at || topic.created || topic.last_posted_at || topic.last_touched,
      links: [url, topic.share_url].filter(Boolean),
      raw_json: topic,
      metadata: {
        provider: 'v2ex',
        node: topic.node?.title || topic.node?.name || topic.node_name || '',
        replies: topic.replies ?? topic.posts_count ?? 0,
        notification: {
          event: 'topic',
          title: String(topic.title || '').slice(0, 200),
          body: String(topic.content || topic.excerpt || '').slice(0, 500),
        },
      },
    };
  }).filter((item) => item.title || item.canonical_url);
}

function sov2exItems(payload, source, query) {
  const hits = Array.isArray(payload?.hits) ? payload.hits : [];
  return hits.map((hit) => {
    const topic = hit._source || hit;
    const id = topic.id ?? hit._id;
    const url = topic.url ? new URL(topic.url, V2EX_ORIGIN).href : `${V2EX_ORIGIN}/t/${id}`;
    const content = cleanText(topic.content || topic.content_rendered || '');
    return {
      platform: 'v2ex',
      external_id: String(id),
      canonical_url: url,
      source_url: source?.url || SOV2EX_API,
      title: cleanText(topic.title || ''),
      content,
      summary: content.slice(0, 4000),
      author: topic.member || topic.author || '',
      published_at: topic.created || topic.created_at || null,
      links: [url],
      raw_json: hit,
      metadata: {
        provider: 'sov2ex',
        query,
        node: topic.node || '',
        replies: topic.replies ?? 0,
        notification: { event: 'topic', title: cleanText(topic.title || '').slice(0, 200), body: content.slice(0, 500) },
      },
    };
  }).filter((item) => item.canonical_url);
}

async function fetchTopics(ctx, url) {
  const response = await ctx.fetch(url, {
    headers: { accept: 'application/json, application/rss+xml, text/xml, */*;q=0.8' },
  });
  const text = String(response.text || '').trim();
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  if (payload) {
    return { items: topicItems(payload, ctx.source, 'v2ex', url), format: 'json', status: response.status };
  }
  const feed = parseFeed(text, 'v2ex', { keepIncomplete: true }).map((item) => ({
    platform: 'v2ex', external_id: item.url, canonical_url: item.url, source_url: url,
    title: item.title, content: item.summary, summary: item.summary, author: item.source_name,
    published_at: item.published_at, links: [item.url], raw_json: item,
    metadata: { provider: 'v2ex', format: 'rss', notification: { event: 'topic', title: item.title, body: item.summary } },
  }));
  return { items: feed, format: 'rss', status: response.status };
}

export async function collectV2ex(ctx) {
  const settings = { ...configOf(ctx.source), ...(ctx.rule?.options || {}) };
  const kind = String(ctx.rule?.kind || 'full').toLowerCase();
  const value = String(ctx.rule?.value || '').trim();
  const maxItems = maxItemsOf(settings);
  const attempts = [];

  if ((kind === 'keyword' || kind === 'search') && value) {
    const url = new URL(settings.searchUrl || SOV2EX_API);
    url.searchParams.set('q', value);
    url.searchParams.set('size', String(Math.min(100, maxItems)));
    url.searchParams.set('from', String(Math.max(0, Number(settings.from) || 0)));
    try {
      const response = await ctx.fetch(url.href);
      const payload = JSON.parse(response.text);
      let items;
      let format = 'sov2ex';
      if (Array.isArray(payload?.hits)) {
        items = sov2exItems(payload, ctx.source, value).slice(0, maxItems);
      } else {
        // 兼容将 V2EX 主题 JSON 直接配置为搜索地址的情况。
        format = 'topics';
        items = topicItems(payload, ctx.source, 'v2ex', ctx.source?.url || V2EX_LATEST).filter((item) => {
          const haystack = `${item.title}\n${item.content}\n${item.summary}`.toLowerCase();
          return haystack.includes(value.toLowerCase());
        }).slice(0, maxItems);
      }
      return {
        items,
        meta: { provider: 'v2ex', mode: 'search', format, query: value, url: url.href, status: response.status, count: items.length, degraded: false },
      };
    } catch (error) {
      attempts.push({ provider: 'sov2ex', error: error.message });
      if (settings.fallbackPublic === false) throw error;
      ctx.logger?.warn?.(`V2EX 搜索失败，回退公开主题本地过滤：${error.message}`);
    }
    const fallbackUrl = settings.fallbackUrl || ctx.source?.url || V2EX_LATEST;
    const result = await fetchTopics(ctx, fallbackUrl);
    const items = result.items.filter((item) => {
      const haystack = `${item.title}\n${item.content}\n${item.summary}`.toLowerCase();
      return haystack.includes(value.toLowerCase());
    }).slice(0, maxItems);
    return {
      items,
      meta: { provider: 'v2ex', mode: 'search-fallback', query: value, status: result.status, count: items.length, degraded: true, attempts },
    };
  }

  let urls = [];
  if (kind === 'node') {
    const node = value.replace(/^\/?go\//, '');
    if (!node) throw new Error('V2EX 节点规则需要 value');
    const base = settings.apiBase || V2EX_ORIGIN;
    urls = [`${base}/api/topics/show.json?node_name=${encodeURIComponent(node)}`];
  } else {
    const baseUrl = String(ctx.source?.url || V2EX_LATEST);
    const maxPages = Math.max(1, Math.min(20, Number(settings.maxPages) || 1));
    for (let page = 0; page < maxPages; page++) {
      if (maxPages === 1) { urls.push(baseUrl); break; }
      const url = new URL(baseUrl);
      url.searchParams.set('page', String(page + 1));
      urls.push(url.href);
    }
  }

  const items = [];
  const seen = new Set();
  for (const url of urls) {
    if (items.length >= maxItems) break;
    try {
      const result = await fetchTopics(ctx, url);
      for (const item of result.items) {
        if (seen.has(item.external_id)) continue;
        seen.add(item.external_id);
        items.push(item);
        if (items.length >= maxItems) break;
      }
      attempts.push({ url, status: result.status, format: result.format, count: result.items.length });
    } catch (error) {
      attempts.push({ url, status: error.status || 0, error: error.message });
      if (!attempts.some((item) => item.status >= 200 && item.status < 300)) throw error;
      break;
    }
  }
  return {
    items,
    meta: {
      provider: 'v2ex', mode: kind, attempts, count: items.length,
      degraded: attempts.some((item) => item.error), status: attempts[0]?.status || 0,
    },
  };
}

export function v2exDetect(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'v2ex.com' && !host.endsWith('.v2ex.com')) return null;
  const node = parsed.pathname.match(/^\/go\/([^/]+)/i)?.[1];
  return {
    platform: 'v2ex',
    kind: node ? 'node' : 'full',
    value: node || '',
    config: { maxItems: 100, maxPages: 1 },
    name: node ? `V2EX /go/${node}` : 'V2EX',
    url: node ? `${V2EX_ORIGIN}/go/${node}` : `${V2EX_ORIGIN}/`,
    confidence: 0.96,
    warnings: [],
  };
}

export const v2exAdapter = {
  id: 'v2ex', version: 2, label: 'V2EX',
  capabilities: ['json', 'rss', 'keyword', 'full', 'node', 'pagination'],
  auth: { types: ['none', 'cookie', 'bearer', 'token', 'api_key', 'basic', 'headers'] },
  authHints: { cookie: '公开主题不需要；搜索/受限节点可选' },
  publicFallback: 'V2EX API/RSS + sov2ex 搜索',
  rateLimit: { scope: 'host', requests: 1, perMs: 1000, burst: 2 },
  configExample: { maxItems: 100, maxPages: 1, fallbackPublic: true },
  ruleKinds: [
    { kind: 'full', label: '最新主题', requiresValue: false, valuePlaceholder: '' },
    { kind: 'node', label: '节点', requiresValue: true, valuePlaceholder: 'programming' },
    { kind: 'keyword', label: '关键词搜索', requiresValue: true, valuePlaceholder: '独立开发' },
  ],
  detect: v2exDetect,
  validateSource() {},
  validateRule(rule) {
    const kind = String(rule?.kind || 'full').toLowerCase();
    if (!['full', 'node', 'keyword', 'search'].includes(kind)) throw new Error(`V2EX 不支持规则类型: ${kind}`);
    if (['node', 'keyword', 'search'].includes(kind) && !String(rule?.value || '').trim()) {
      throw new Error('V2EX 节点/关键词规则需要 value');
    }
  },
  async probe(ctx) {
    const url = ctx.source?.url || V2EX_LATEST;
    const response = await ctx.fetch(url, { timeoutMs: 10_000, noRetry: true });
    return { ok: response.status >= 200 && response.status < 300, message: `HTTP ${response.status}` };
  },
  collect: collectV2ex,
};

export { cleanText };
