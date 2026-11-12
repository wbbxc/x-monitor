// Reddit 采集：公开 JSON 降级 + OAuth app-only。
import { configOf, defaultMaxItems } from './rules.js';
import { canonicalizeUrl } from './text.js';

const PUBLIC_BASE = 'https://www.reddit.com';
const OAUTH_BASE = 'https://oauth.reddit.com';
const TOKEN_URL = `${PUBLIC_BASE}/api/v1/access_token`;
const tokenCache = new Map();

function maxItemsOf(settings) {
  return defaultMaxItems(settings);
}

function maxPagesOf(settings, fallback = 1) {
  return Math.max(1, Math.min(20, Number(settings.maxPages) || fallback));
}

function headersFor(ctx, accessToken = '') {
  const headers = {
    accept: 'application/json',
    'user-agent': 'x-monitor/1.2 (local collector)',
  };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  return headers;
}

function credentialsOf(auth = {}) {
  if (auth.type === 'fields' && auth.fields) {
    return {
      clientId: String(auth.fields.clientId || auth.fields.client_id || '').trim(),
      clientSecret: String(auth.fields.clientSecret || auth.fields.client_secret || '').trim(),
    };
  }
  if (auth.type === 'basic') {
    return { clientId: String(auth.username || '').trim(), clientSecret: String(auth.password || '').trim() };
  }
  return { clientId: '', clientSecret: '' };
}

async function accessToken(ctx, creds) {
  const key = `${creds.clientId}:${creds.clientSecret}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const response = await ctx.fetch(TOKEN_URL, {
    method: 'POST',
    body: 'grant_type=client_credentials',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'x-monitor/1.2 (local collector)',
    },
  });
  let payload;
  try { payload = JSON.parse(response.text); } catch { throw new Error('Reddit OAuth 返回不是有效 JSON'); }
  if (!payload.access_token) {
    throw new Error(`Reddit OAuth 失败：${payload.error || payload.message || '没有 access_token'}`);
  }
  const token = String(payload.access_token);
  tokenCache.set(key, { token, expiresAt: Date.now() + Math.max(60, Number(payload.expires_in) || 3600) * 1000 });
  return token;
}

export function redditSubreddit(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Reddit 需要 subreddit');
  const match = raw.match(/(?:reddit\.com\/)?r\/([A-Za-z0-9_]+)/i) || raw.match(/^\/?r\/([A-Za-z0-9_]+)$/i);
  if (match) return match[1];
  if (/^[A-Za-z0-9_]+$/.test(raw)) return raw.replace(/^r\//i, '');
  throw new Error(`Reddit subreddit 无效: ${raw}`);
}

function redditUsername(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/(?:reddit\.com\/)?u(?:ser)?\/([A-Za-z0-9_-]+)/i);
  if (match) return match[1];
  if (/^[A-Za-z0-9_-]+$/.test(raw)) return raw.replace(/^u\//i, '');
  throw new Error(`Reddit 用户名无效: ${raw}`);
}

function pathFor(ctx, rule, settings) {
  const kind = String(rule?.kind || 'subreddit').toLowerCase();
  const value = String(rule?.value || '').trim();
  const sort = String(settings.sort || 'new').toLowerCase();
  const limit = Math.min(100, maxItemsOf(settings));
  const params = new URLSearchParams({ limit: String(limit), raw_json: '1' });
  if (kind === 'subreddit' || kind === 'full') {
    const sub = redditSubreddit(value || settings.subreddit);
    params.set('sort', sort);
    if (sort === 'top' && settings.time) params.set('t', String(settings.time));
    return { path: `/r/${sub}/${sort === 'hot' ? 'hot' : sort}.json`, params, subreddit: sub };
  }
  if (kind === 'account') {
    const user = redditUsername(value || settings.username);
    params.delete('sort');
    return { path: `/user/${user}/submitted.json`, params, username: user };
  }
  if (kind === 'keyword' || kind === 'search') {
    params.set('q', value || settings.query || '');
    params.set('sort', sort === 'hot' ? 'relevance' : sort);
    params.set('restrict_sr', settings.subreddit ? '1' : '0');
    const sub = settings.subreddit ? redditSubreddit(settings.subreddit) : '';
    params.delete('limit');
    params.set('limit', String(limit));
    return { path: sub ? `/r/${sub}/search.json` : '/search.json', params, subreddit: sub, query: params.get('q') };
  }
  throw new Error(`Reddit 不支持的规则类型: ${kind}`);
}

function listingItems(payload, source, rule, meta) {
  const children = payload?.data?.children;
  if (!Array.isArray(children)) return [];
  return children.map((child) => child?.data).filter(Boolean).map((post) => {
    const permalink = `${PUBLIC_BASE}${post.permalink || `/r/${post.subreddit}/comments/${post.id}/`}`;
    const externalUrl = /^https?:\/\//i.test(String(post.url || '')) ? post.url : '';
    const content = String(post.selftext || post.url || post.title || '');
    return {
      platform: 'reddit',
      external_id: `t3_${post.id}`,
      canonical_url: canonicalizeUrl(permalink),
      source_url: source?.url || permalink,
      title: post.title || `r/${post.subreddit} ${post.id}`,
      content,
      summary: String(post.selftext || post.title || '').slice(0, 4000),
      author: post.author || '',
      published_at: post.created_utc ? new Date(Number(post.created_utc) * 1000).toISOString() : null,
      links: [permalink, externalUrl].filter(Boolean),
      raw_json: post,
      metadata: {
        provider: 'reddit',
        subreddit: post.subreddit || '',
        score: post.score ?? 0,
        comments: post.num_comments ?? 0,
        flair: post.link_flair_text || '',
        nsfw: !!post.over_18,
        isSelf: !!post.is_self,
        query: meta.query || '',
        mode: meta.mode || '',
        notification: {
          event: 'post',
          title: `r/${post.subreddit} ${post.title || ''}`.slice(0, 200),
          body: String(post.selftext || post.url || '').slice(0, 500),
        },
      },
    };
  });
}

async function fetchListing(ctx, base, pathInfo, { accessToken: token = '', after = '', maxPages = 1 } = {}) {
  const items = [];
  const pages = [];
  let cursor = after || '';
  for (let page = 0; page < maxPages; page++) {
    const path = base === OAUTH_BASE ? pathInfo.path.replace(/\.json$/i, '') : pathInfo.path;
    const url = new URL(`${base}${path}`);
    for (const [key, value] of pathInfo.params) url.searchParams.set(key, value);
    if (cursor) url.searchParams.set('after', cursor);
    const response = await ctx.fetch(url.href, { headers: headersFor(ctx, token) });
    let payload;
    try { payload = JSON.parse(response.text); } catch { throw new Error('Reddit 返回不是有效 JSON'); }
    const values = listingItems(payload, ctx.source, ctx.rule, { query: pathInfo.query, mode: pathInfo.subreddit ? 'subreddit' : 'search' });
    items.push(...values);
    cursor = payload?.data?.after || '';
    pages.push({ page: page + 1, count: values.length, after: cursor || null });
    if (!cursor || !values.length) break;
  }
  return { items, pages, after: cursor };
}

export async function collectReddit(ctx) {
  const settings = { ...configOf(ctx.source), ...(ctx.rule?.options || {}) };
  if (!settings.subreddit && ctx.source?.url) {
    try {
      const pathname = new URL(ctx.source.url).pathname;
      const match = pathname.match(/\/r\/([A-Za-z0-9_]+)/i);
      if (match) settings.subreddit = match[1];
      const userMatch = pathname.match(/\/(?:u|user)\/([A-Za-z0-9_-]+)/i);
      if (userMatch) settings.username = settings.username || userMatch[1];
    } catch {}
  }
  const pathInfo = pathFor(ctx, ctx.rule, settings);
  const creds = credentialsOf(ctx.auth);
  const maxPages = maxPagesOf(settings, 1);
  const cursor = ctx.cursor.get() || {};
  const after = cursor.after || settings.after || '';
  let token = '';
  let usedOAuth = false;
  let degraded = false;
  const attempts = [];
  if (creds.clientId && creds.clientSecret) {
    try {
      token = await accessToken(ctx, creds);
    } catch (error) {
      attempts.push({ provider: 'oauth', error: error.message });
      if (settings.fallbackPublic === false) throw error;
      ctx.logger?.warn?.(`Reddit OAuth 失败，回退公开 JSON：${error.message}`);
      degraded = true;
    }
  }
  const bases = token ? [OAUTH_BASE, PUBLIC_BASE] : [PUBLIC_BASE];
  let result = null;
  for (let index = 0; index < bases.length; index++) {
    const base = bases[index];
    try {
      const requestToken = base === OAUTH_BASE ? token : '';
      result = await fetchListing(ctx, base, pathInfo, { accessToken: requestToken, after, maxPages });
      usedOAuth = base === OAUTH_BASE;
      if (index > 0) degraded = true;
      break;
    } catch (error) {
      attempts.push({ provider: base === OAUTH_BASE ? 'oauth' : 'public', error: error.message });
      if (base === OAUTH_BASE && settings.fallbackPublic !== false) {
        ctx.logger?.warn?.(`Reddit OAuth 请求失败，回退公开 JSON：${error.message}`);
        degraded = true;
        continue;
      }
      throw error;
    }
  }
  if (!result) throw new Error(`Reddit 采集失败：${attempts.map((item) => `${item.provider}: ${item.error}`).join('；')}`);
  const nextCursor = { ...cursor, after: result.after || null };
  ctx.cursor.set(nextCursor);
  return {
    items: result.items.slice(0, maxItemsOf(settings)),
    meta: {
      provider: 'reddit',
      mode: usedOAuth ? 'oauth' : 'public',
      path: pathInfo.path,
      subreddit: pathInfo.subreddit || '',
      query: pathInfo.query || '',
      pages: result.pages,
      attempts,
      degraded,
      count: result.items.length,
    },
  };
}

export function redditDetect(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'reddit.com' && !host.endsWith('.reddit.com')) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const rIndex = parts.findIndex((part) => part.toLowerCase() === 'r');
  if (rIndex !== -1 && parts[rIndex + 1]) {
    return {
      platform: 'reddit',
      kind: 'subreddit',
      value: parts[rIndex + 1],
      config: { sort: 'new', maxPages: 1 },
      name: `r/${parts[rIndex + 1]}`,
      url: `https://www.reddit.com/r/${parts[rIndex + 1]}/`,
      confidence: 0.97,
      warnings: [],
    };
  }
  const uIndex = parts.findIndex((part) => ['u', 'user'].includes(part.toLowerCase()));
  if (uIndex !== -1 && parts[uIndex + 1]) {
    return {
      platform: 'reddit',
      kind: 'account',
      value: parts[uIndex + 1],
      config: { maxPages: 1 },
      name: `u/${parts[uIndex + 1]}`,
      url: `https://www.reddit.com/user/${parts[uIndex + 1]}/`,
      confidence: 0.95,
      warnings: [],
    };
  }
  return null;
}

export const redditAdapter = {
  id: 'reddit', version: 2, label: 'Reddit',
  capabilities: ['subreddit', 'account', 'keyword', 'oauth', 'pagination'],
  auth: { types: ['none', 'fields', 'basic'] },
  authHints: { fields: '{"clientId":"...","clientSecret":"..."}（Reddit app-only OAuth）' },
  publicFallback: '公开 JSON',
  rateLimit: { scope: 'host', requests: 1, perMs: 1000, burst: 2 },
  configExample: { sort: 'new', maxPages: 1, maxItems: 100, fallbackPublic: true },
  ruleKinds: [
    { kind: 'subreddit', label: 'Subreddit', requiresValue: true, valuePlaceholder: 'programming' },
    { kind: 'keyword', label: '关键词搜索', requiresValue: true, valuePlaceholder: 'AI agent' },
    { kind: 'account', label: '用户投稿', requiresValue: true, valuePlaceholder: 'spez' },
    { kind: 'full', label: '全量/最新', requiresValue: false, valuePlaceholder: '可选 subreddit' },
  ],
  detect: redditDetect,
  validateSource() {},
  validateRule(rule) {
    const kind = String(rule?.kind || 'subreddit').toLowerCase();
    if (!['subreddit', 'keyword', 'search', 'account', 'full'].includes(kind)) {
      throw new Error(`Reddit 不支持规则类型: ${kind}`);
    }
    if (kind === 'subreddit') redditSubreddit(rule?.value);
    if (kind === 'account') redditUsername(rule?.value);
    if ((kind === 'keyword' || kind === 'search') && !String(rule?.value || '').trim()) {
      throw new Error('Reddit 关键词规则需要 value');
    }
  },
  async probe(ctx) {
    const settings = { ...configOf(ctx.source), ...(ctx.rule?.options || {}) };
    const creds = credentialsOf(ctx.auth);
    let token = '';
    try { if (creds.clientId && creds.clientSecret) token = await accessToken(ctx, creds); } catch {}
    const info = pathFor(ctx, ctx.rule || { kind: 'subreddit', value: settings.subreddit || 'programming' }, settings);
    const probePath = token ? info.path.replace(/\.json$/i, '') : info.path;
    const url = new URL(`${token ? OAUTH_BASE : PUBLIC_BASE}${probePath}`);
    for (const [key, value] of info.params) url.searchParams.set(key, value);
    const response = await ctx.fetch(url.href, { headers: headersFor(ctx, token), timeoutMs: 10_000, noRetry: true });
    return { ok: response.status >= 200 && response.status < 300, message: `HTTP ${response.status}${token ? '（OAuth）' : '（公开）'}` };
  },
  collect: collectReddit,
};
