// arXiv Atom 采集适配器：分页、镜像、游标和查询前缀。
import crypto from 'node:crypto';
import { fetchText } from './http.js';
import { buildAuthHeaders } from './auth.js';
import { canonicalizeUrl, cleanText } from './web.js';
import { configOf } from './rules.js';

export const ARXIV_API_URL = 'https://export.arxiv.org/api/query';
const PREFIX_RE = /^(?:all|ti|au|abs|co|jr|cat|rn|id):/i;
const KIND_PREFIX = { author: 'au:', category: 'cat:' };

function attr(attrs, name) {
  return attrs?.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] || '';
}

function tag(block, name) {
  return cleanText(block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || '');
}

function entryBlocks(xml) {
  return [...String(xml || '').matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]);
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function entryLinks(block) {
  return [...block.matchAll(/<link\b([^>]*?)(?:\/?>)/gi)]
    .map((m) => ({ href: canonicalizeUrl(attr(m[1], 'href')), rel: attr(m[1], 'rel') }))
    .filter((link) => link.href);
}

/** 解析 Atom；即使字段缺失也返回记录，避免静默丢弃原始 entry。 */
export function parseArxivFeed(xml) {
  return entryBlocks(xml).map((block) => {
    const idUrl = canonicalizeUrl(tag(block, 'id'));
    const links = entryLinks(block);
    const canonicalUrl = canonicalizeUrl(
      links.find((link) => link.rel === 'alternate')?.href || idUrl || links[0]?.href || ''
    );
    const externalId = (idUrl.match(/(?:abs|pdf)\/(?:arxiv\.)?([^?#]+)$/i)?.[1]
      || canonicalUrl.match(/(?:abs|pdf)\/(?:arxiv\.)?([^?#]+)$/i)?.[1]
      || digest(block));
    const authors = [...block.matchAll(/<author\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
      .map((match) => cleanText(match[1])).filter(Boolean);
    const title = tag(block, 'title') || externalId;
    const content = tag(block, 'summary') || tag(block, 'description');
    const allLinks = [...new Set([canonicalUrl, ...links.map((link) => link.href)].filter(Boolean))];
    return {
      platform: 'arxiv',
      external_id: externalId,
      title,
      content,
      summary: content,
      author: authors.join(', '),
      published_at: tag(block, 'published') || tag(block, 'updated') || null,
      canonical_url: canonicalUrl,
      links: allLinks,
      raw_json: { xml: block },
      metadata: {
        provider: 'arxiv',
        arxivId: externalId,
        notification: {
          event: 'paper',
          title: title.slice(0, 200),
          body: content.slice(0, 500),
        },
      },
    };
  });
}

function queryFor(rule, settings) {
  const value = String(rule?.value || settings.query || '').trim();
  if (!value) return 'all:*';
  if (PREFIX_RE.test(value)) return value;
  const kind = String(rule?.kind || '').toLowerCase();
  if (KIND_PREFIX[kind]) return `${KIND_PREFIX[kind]}${value}`;
  return `${String(settings.queryPrefix || 'all:')}${value}`;
}

export function buildArxivUrl(source, rule, settings = {}, { start = 0, pageSize } = {}) {
  const url = new URL(settings.baseUrl || source?.url || ARXIV_API_URL);
  if (!url.searchParams.has('search_query')) url.searchParams.set('search_query', queryFor(rule, settings));
  url.searchParams.set('start', String(Math.max(0, Number(start) || 0)));
  url.searchParams.set('max_results', String(Math.max(1, Math.min(2000, Number(pageSize || settings.pageSize || settings.maxResults) || 100))));
  if (!url.searchParams.has('sortBy')) url.searchParams.set('sortBy', settings.sortBy || 'submittedDate');
  if (!url.searchParams.has('sortOrder')) url.searchParams.set('sortOrder', settings.sortOrder || 'descending');
  return url.href;
}

export async function collectArxiv({ source, rule, auth, fetch, fetchImpl, proxy = '', timeoutMs, retries, start = 0 } = {}) {
  const settings = { ...configOf(source), ...(rule?.options || {}) };
  const url = buildArxivUrl(source, rule, settings, { start });
  const request = typeof fetch === 'function'
    ? fetch
    : (target, opts = {}) => fetchText(target, {
      ...opts, fetchImpl, proxy, timeoutMs, retries,
      headers: { ...buildAuthHeaders(auth), accept: 'application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8' },
    });
  const response = await request(url, {
    headers: { ...buildAuthHeaders(auth), accept: 'application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8' },
  });
  const items = parseArxivFeed(response.text);
  const pageSize = Number(new URL(url).searchParams.get('max_results')) || 100;
  return {
    items,
    meta: {
      provider: 'arxiv',
      url,
      status: response.status,
      query: new URL(url).searchParams.get('search_query'),
      start,
      pageSize,
      nextStart: items.length >= pageSize ? start + pageSize : null,
      count: items.length,
    },
  };
}

export async function collectArxivPages(ctx) {
  const settings = { ...configOf(ctx.source), ...(ctx.rule?.options || {}) };
  const maxResults = Math.max(1, Math.min(2000, Number(settings.maxResults) || 100));
  const pageSize = Math.max(1, Math.min(500, Number(settings.pageSize) || 100));
  const cursor = ctx.cursor.get() || {};
  let start = Math.max(0, Number(cursor.start) || 0);
  const pages = [];
  let total = 0;
  while (total < maxResults) {
    const result = await collectArxiv({
      source: ctx.source, rule: ctx.rule, auth: ctx.auth,
      fetch: ctx.fetch, timeoutMs: ctx.timeoutMs, retries: 0, start,
    });
    const items = result.items.slice(0, Math.min(pageSize, maxResults - total));
    pages.push({ start, count: items.length, status: result.meta.status, url: result.meta.url });
    if (items.length) {
      total += items.length;
      start += pageSize;
      await ctx.emit(items, { cursor: { start } });
    }
    if (items.length < pageSize) break;
    if (items.length) await ctx.sleep(3000);
  }
  return {
    meta: {
      provider: 'arxiv',
      pages,
      count: total,
      query: queryFor(ctx.rule, settings),
      maxResults,
      pageSize,
    },
  };
}

export function arxivDetect(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  if (!['arxiv.org', 'export.arxiv.org'].includes(host) && !host.endsWith('.arxiv.org')) return null;
  const id = parsed.pathname.match(/\/(?:abs|pdf)\/([^/?#]+?)(?:v\d+)?(?:\.pdf)?$/i)?.[1];
  return {
    platform: 'arxiv',
    kind: id ? 'keyword' : 'full',
    value: id ? `id:${id}` : '',
    config: { maxResults: 100, sortBy: 'submittedDate' },
    name: id ? `arXiv ${id}` : 'arXiv',
    url: 'https://export.arxiv.org/api/query',
    confidence: 0.97,
    warnings: [],
  };
}

export const arxivAdapter = {
  id: 'arxiv', version: 2, label: 'arXiv',
  capabilities: ['atom', 'keyword', 'author', 'category', 'full', 'pagination'],
  auth: { types: ['none', 'bearer', 'token', 'api_key', 'headers'] },
  publicFallback: 'arXiv 公开 API',
  rateLimit: { scope: 'host', requests: 1, perMs: 3000, burst: 1 },
  configExample: { maxResults: 100, pageSize: 100, sortBy: 'submittedDate', sortOrder: 'descending', queryPrefix: 'all:' },
  ruleKinds: [
    { kind: 'keyword', label: '关键词', requiresValue: true, valuePlaceholder: 'large language model' },
    { kind: 'author', label: '作者', requiresValue: true, valuePlaceholder: 'Yann LeCun' },
    { kind: 'category', label: '分类', requiresValue: true, valuePlaceholder: 'cs.AI' },
    { kind: 'full', label: '全量/最新', requiresValue: false, valuePlaceholder: '可选查询', optionsExample: { maxResults: 500, pageSize: 100 } },
  ],
  detect: arxivDetect,
  validateSource() {},
  validateRule(rule) {
    const kind = String(rule?.kind || 'keyword').toLowerCase();
    if (!['keyword', 'author', 'category', 'full'].includes(kind)) throw new Error(`arXiv 不支持规则类型: ${kind}`);
    const value = String(rule?.value || '').trim();
    if (value && value.length > 500) throw new Error('arXiv 查询词过长');
  },
  async probe(ctx) {
    const response = await ctx.fetch(ctx.source?.url || ARXIV_API_URL, {
      headers: { accept: 'application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8' },
      timeoutMs: 10_000,
      noRetry: true,
    });
    return { ok: response.status >= 200 && response.status < 300, message: `HTTP ${response.status}` };
  },
  async collectPages(ctx) {
    return collectArxivPages(ctx);
  },
};
