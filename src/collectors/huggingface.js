// Hugging Face Daily Papers 全量分页同步，支持 hf-mirror 镜像与回退。
import crypto from 'node:crypto';
import { fetchText } from './http.js';
import { buildAuthHeaders } from './auth.js';
import { configOf } from './rules.js';
import { config } from '../config.js';

export const OFFICIAL_BASE = 'https://huggingface.co';
export const API_PATH = '/api/daily_papers';

function stringValue(value) {
  return value == null ? '' : String(value);
}

function numberValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function dateValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function authorName(author) {
  if (typeof author === 'string') return author;
  return author?.name || author?.fullname || author?.user?.fullname || author?.user?.name || '';
}

function fallbackId(value) {
  return `raw-${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)}`;
}

export function baseUrlOf(settings = {}) {
  return String(settings.baseUrl || config.collector.hfBaseUrl || OFFICIAL_BASE).replace(/\/+$/, '');
}

export function apiUrlOf(baseUrl) {
  return `${String(baseUrl || OFFICIAL_BASE).replace(/\/+$/, '')}${API_PATH}`;
}

/** 把 HF API 的嵌套记录压平，便于 SQLite 查询和前端展示。 */
export function normalizeHuggingFacePaper(entry, { baseUrl = OFFICIAL_BASE } = {}) {
  const paper = entry?.paper || entry || {};
  const id = stringValue(paper.id || entry?.id).trim() || fallbackId(entry);
  const authors = Array.isArray(paper.authors)
    ? paper.authors.map(authorName).filter(Boolean)
    : [];
  const keywords = Array.isArray(paper.ai_keywords)
    ? paper.ai_keywords.map(stringValue).map((value) => value.trim()).filter(Boolean)
    : [];
  const base = String(baseUrl || OFFICIAL_BASE).replace(/\/+$/, '');
  return {
    id,
    title: stringValue(paper.title || entry?.title).trim() || id,
    summary: stringValue(paper.summary || entry?.summary).trim(),
    ai_summary: stringValue(paper.ai_summary || entry?.ai_summary).trim(),
    authors,
    keywords,
    published_at: dateValue(paper.publishedAt || paper.published_at || entry?.publishedAt),
    submitted_on_daily_at: dateValue(paper.submittedOnDailyAt || paper.submitted_on_daily_at || entry?.submittedOnDailyAt),
    upvotes: numberValue(paper.upvotes ?? entry?.upvotes),
    comments: numberValue(paper.numComments ?? paper.comments ?? entry?.numComments),
    source_url: id.startsWith('raw-') ? apiUrlOf(base) : `${base}/papers/${encodeURIComponent(id)}`,
    github_url: stringValue(paper.githubRepo || paper.github_url || entry?.githubRepo).trim(),
    project_url: stringValue(paper.projectPage || paper.project_url || entry?.projectPage).trim(),
    thumbnail_url: stringValue(entry?.thumbnail || paper.thumbnail || entry?.thumbnail_url).trim(),
    raw_json: JSON.stringify(entry),
  };
}

function nextLink(value) {
  const header = stringValue(value);
  const match = header.match(/<([^>]+)>\s*;\s*rel\s*=\s*["']?next["']?/i);
  return match?.[1] || '';
}

function pageUrl(apiUrl, pageSize, page) {
  const url = new URL(apiUrl);
  url.searchParams.set('limit', String(pageSize));
  url.searchParams.set('p', String(page));
  return url.href;
}

/**
 * 沿着 Link: rel="next" 直到末页。onPage 在每页请求完成后调用，支持边采集边持久化。
 */
export async function syncHuggingFacePages({
  fetch,
  fetchImpl,
  proxy = '',
  baseUrl = OFFICIAL_BASE,
  startUrl = '',
  pageSize = 100,
  maxPages = 0,
  timeoutMs = 30_000,
  retries = 2,
  headers = {},
  onPage = async () => {},
} = {}) {
  const request = typeof fetch === 'function'
    ? fetch
    : (url, opts = {}) => fetchText(url, { ...opts, fetchImpl, proxy, timeoutMs, retries, headers });
  const size = Math.min(1000, Math.max(1, Number(pageSize) || 100));
  const cap = Math.max(0, Number(maxPages) || 0);
  const seenIds = new Set();
  const visited = new Set();
  let url = startUrl || pageUrl(apiUrlOf(baseUrl), size, 0);
  let pages = 0;

  while (url) {
    if (visited.has(url)) throw new Error(`Hugging Face 分页链接循环: ${url}`);
    if (cap > 0 && pages >= cap) {
      return { pages, seen: seenIds.size, complete: false, capped: true, nextUrl: url };
    }
    visited.add(url);
    const response = await request(url, { headers });
    let payload;
    try {
      payload = JSON.parse(response.text);
    } catch {
      throw new Error(`Hugging Face 返回不是有效 JSON（第 ${pages + 1} 页）`);
    }
    if (!Array.isArray(payload)) throw new Error('Hugging Face 返回格式异常：预期数组');
    const papers = payload.map((entry) => normalizeHuggingFacePaper(entry, { baseUrl })).filter(Boolean)
      .filter((paper) => {
        if (seenIds.has(paper.id)) return false;
        seenIds.add(paper.id);
        return true;
      });

    const linked = nextLink(response.headers.link);
    let nextUrl = '';
    if (linked) {
      nextUrl = new URL(linked, url).href;
    } else if (payload.length >= size) {
      // 兼容未提供 Link 头的镜像/网关；官方接口会优先走上面的 Link。
      nextUrl = pageUrl(apiUrlOf(baseUrl), size, pages + 1);
    }
    await onPage(papers, {
      page: pages, url, nextUrl, response,
      cursor: nextUrl ? { url: nextUrl } : null,
    });
    pages++;
    url = nextUrl;
  }
  return { pages, seen: seenIds.size, complete: true, nextUrl: null };
}

function toCollectionItem(paper) {
  return {
    platform: 'huggingface',
    external_id: paper.id,
    canonical_url: paper.source_url,
    title: paper.title,
    content: paper.summary || paper.ai_summary,
    summary: paper.ai_summary || paper.summary,
    author: paper.authors.join(', '),
    published_at: paper.published_at,
    links: [paper.source_url, paper.github_url, paper.project_url, paper.thumbnail_url].filter(Boolean),
    raw_json: paper.raw_json,
    metadata: {
      provider: 'huggingface',
      keywords: paper.keywords,
      upvotes: paper.upvotes,
      comments: paper.comments,
      notification: {
        event: 'paper',
        title: paper.title.slice(0, 200),
        body: String(paper.ai_summary || paper.summary || '').slice(0, 500),
      },
    },
  };
}

async function syncWithFallback(ctx, settings) {
  const configuredBase = baseUrlOf(settings);
  const cursor = ctx.cursor.get() || {};
  const attempts = [];
  const bases = [configuredBase];
  if (configuredBase !== OFFICIAL_BASE && settings.fallbackToOfficial !== false) bases.push(OFFICIAL_BASE);
  for (let index = 0; index < bases.length; index++) {
    const base = bases[index];
    const startUrl = index === 0 && cursor.url && new URL(cursor.url).hostname === new URL(base).hostname
      ? cursor.url : '';
    try {
      const result = await syncHuggingFacePages({
        fetch: ctx.fetch,
        baseUrl: base,
        startUrl,
        pageSize: settings.pageSize || ctx.settings.pageSize,
        maxPages: settings.maxPages,
        headers: buildAuthHeaders(ctx.auth),
        onPage: async (papers, page) => {
          await ctx.emit(papers.map(toCollectionItem), { cursor: page.cursor });
        },
      });
      return {
        baseUrl: base,
        configuredBase,
        fallback: base !== configuredBase,
        attempts,
        ...result,
      };
    } catch (error) {
      attempts.push({ baseUrl: base, error: error.message });
      if (index === bases.length - 1) throw error;
      ctx.logger?.warn?.(`Hugging Face 镜像 ${base} 失败，回退官方地址：${error.message}`);
    }
  }
  return null;
}

export async function collectHuggingFacePages(ctx) {
  const settings = { ...configOf(ctx.source), ...(ctx.rule?.options || {}) };
  if (!settings.baseUrl && ctx.source?.url) {
    try {
      const host = new URL(ctx.source.url).hostname.toLowerCase();
      if (host === 'hf-mirror.com' || host === 'huggingface.co') settings.baseUrl = `https://${host}`;
    } catch {}
  }
  const result = await syncWithFallback(ctx, settings);
  return {
    meta: {
      provider: 'huggingface',
      baseUrl: result?.baseUrl || baseUrlOf(settings),
      configuredBase: result?.configuredBase || baseUrlOf(settings),
      fallback: !!result?.fallback,
      attempts: result?.attempts || [],
      pages: result?.pages || 0,
      seen: result?.seen || 0,
      capped: !!result?.capped,
      count: result?.seen || 0,
      degraded: !!result?.fallback,
    },
  };
}

export function huggingfaceDetect(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!['huggingface.co', 'hf-mirror.com'].includes(host)) return null;
  const baseUrl = `https://${host}`;
  return {
    platform: 'huggingface',
    kind: 'full',
    value: '',
    config: { baseUrl, pageSize: 100, maxPages: 0 },
    name: `Daily Papers · ${host}`,
    url: `${baseUrl}/api/daily_papers`,
    confidence: 0.97,
    warnings: [],
  };
}

export const huggingfaceAdapter = {
  id: 'huggingface', version: 2, label: 'Hugging Face Daily Papers',
  capabilities: ['full-sync', 'pagination', 'token', 'mirror'],
  keywordFilter: 'local',
  auth: { types: ['none', 'bearer', 'token', 'api_key', 'headers'] },
  authHints: { token: '可选；私有接口或提高限额时填写' },
  publicFallback: '官方 / hf-mirror',
  rateLimit: { scope: 'host', requests: 1, perMs: 1000, burst: 2 },
  configExample: { baseUrl: 'https://huggingface.co', pageSize: 100, maxPages: 0, fallbackToOfficial: true },
  ruleKinds: [
    { kind: 'full', label: '全量同步', requiresValue: false, valuePlaceholder: '' },
    { kind: 'keyword', label: '关键词本地过滤', requiresValue: true, valuePlaceholder: 'agent' },
  ],
  detect: huggingfaceDetect,
  validateSource() {},
  validateRule(rule) {
    const kind = String(rule?.kind || 'full').toLowerCase();
    if (!['full', 'keyword'].includes(kind)) throw new Error(`Hugging Face 不支持规则类型: ${kind}`);
    if (kind === 'keyword' && !String(rule?.value || '').trim()) throw new Error('Hugging Face 关键词规则需要 value');
  },
  async probe(ctx) {
    const settings = configOf(ctx.source);
    const response = await ctx.fetch(apiUrlOf(baseUrlOf(settings)), {
      headers: buildAuthHeaders(ctx.auth),
      timeoutMs: 10_000,
      noRetry: true,
    });
    return { ok: response.status >= 200 && response.status < 300, message: `HTTP ${response.status}` };
  },
  async collectPages(ctx) {
    return collectHuggingFacePages(ctx);
  },
};

export const API_URL = apiUrlOf(OFFICIAL_BASE);
