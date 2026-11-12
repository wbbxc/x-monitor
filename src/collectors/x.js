// X 采集：复用 twscrape 账号，支持账号时间线与关键词搜索。
import { config, readXAccounts } from '../config.js';
import { configOf, defaultMaxItems } from './rules.js';
import { canonicalizeUrl } from './text.js';
import { CollectorError } from './errors.js';
import { runPythonJsonl } from './python.js';

const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;

function maxItemsOf(settings) {
  return defaultMaxItems({ maxItems: settings.maxItems || settings.perRun });
}

function hasAccounts() {
  return readXAccounts().accounts.length > 0;
}

function modeOf(settings) {
  const mode = String(settings.mode || config.scrapeMode || 'auto').toLowerCase();
  if (mode === 'mock') return 'mock';
  if (mode === 'real') return 'real';
  return hasAccounts() ? 'real' : 'mock';
}

export function buildXArgs(rule, settings) {
  const kind = String(rule?.kind || 'keyword').toLowerCase();
  const value = String(rule?.value || '').trim();
  if (kind === 'account') {
    return ['fetch', '--accounts', value.replace(/^@+/, ''), '--per', String(Math.max(1, Number(settings.perAccount) || 20)), '--mode', modeOf(settings)];
  }
  if (kind === 'keyword' || kind === 'search') {
    const args = ['search', '--query', value, '--per', String(maxItemsOf(settings)), '--type', String(settings.searchType || 'latest'), '--mode', modeOf(settings)];
    if (Number(settings.minLikes) > 0) args.push('--min-likes', String(Number(settings.minLikes)));
    if (settings.lang) args.push('--lang', String(settings.lang));
    if (settings.since) args.push('--since', String(settings.since));
    if (settings.until) args.push('--until', String(settings.until));
    return args;
  }
  throw new Error(`X 不支持的规则类型: ${kind}`);
}

function bigish(value) {
  const text = String(value || '');
  if (/^\d+$/.test(text)) {
    try { return BigInt(text); } catch {}
  }
  return text;
}

export function filterByCursor(items, cursor) {
  const last = bigish(cursor?.lastId || '');
  const filtered = (items || []).filter((item) => {
    if (!last) return true;
    const current = bigish(item.id);
    if (typeof last === 'bigint' && typeof current === 'bigint') return current > last;
    return String(current) > String(last);
  });
  filtered.sort((a, b) => {
    const left = bigish(a.id);
    const right = bigish(b.id);
    if (typeof left === 'bigint' && typeof right === 'bigint') return right > left ? 1 : (right < left ? -1 : 0);
    return String(right).localeCompare(String(left));
  });
  return filtered;
}

export function normalizeTweet(tweet) {
  const id = String(tweet.id || '');
  const author = String(tweet.author_username || '').replace(/^@+/, '');
  const url = canonicalizeUrl(tweet.url || `https://x.com/${author}/status/${id}`);
  const media = Array.isArray(tweet.media) ? tweet.media : [];
  const text = String(tweet.text || '');
  return {
    platform: 'x',
    external_id: id,
    canonical_url: url,
    source_url: `https://x.com/${author}`,
    title: text.slice(0, 160) || `${author} ${id}`,
    content: text,
    summary: text,
    author,
    published_at: tweet.tweet_created_at || null,
    links: [url, ...media.map((item) => item?.url).filter(Boolean)],
    raw_json: tweet,
    metadata: {
      provider: 'x',
      likes: Number(tweet.like_count) || 0,
      retweets: Number(tweet.retweet_count) || 0,
      replies: Number(tweet.reply_count) || 0,
      views: Number(tweet.view_count) || 0,
      media,
      isMock: !!tweet.is_mock,
      notification: {
        event: 'tweet',
        title: `@${author} ${text.slice(0, 120)}`.trim(),
        body: text.slice(0, 500),
      },
    },
  };
}

export async function collectX(ctx) {
  const settings = { ...configOf(ctx.source), ...(ctx.rule?.options || {}) };
  const args = buildXArgs(ctx.rule, settings);
  const env = settings.proxy ? { X_PROXY: String(settings.proxy) } : {};
  let result;
  try {
    result = await runPythonJsonl({
      script: 'worker.py',
      args,
      timeoutMs: Math.max(30_000, Number(settings.timeoutMs) || 300_000),
      signal: ctx.signal,
      env,
    });
  } catch (error) {
    if (/accounts\.json|登录失败|twscrape|No module/i.test(error.message)) {
      throw new CollectorError(
        'X 采集失败：请配置 .env 的 X_ACCOUNTS_JSON（Cookie 或账号密码）并检查代理；开发环境可用 mode=mock',
        { code: 'AUTH_REQUIRED', retryable: false, cause: error },
      );
    }
    throw error;
  }
  const cursor = ctx.cursor.get() || {};
  const fresh = filterByCursor(result.items, cursor).slice(0, maxItemsOf(settings));
  const items = fresh.map(normalizeTweet);
  if (fresh.length) {
    const maxId = fresh.reduce((max, item) => {
      const left = bigish(item.id);
      const right = bigish(max);
      if (typeof left === 'bigint' && typeof right === 'bigint') return left > right ? item.id : max;
      return String(item.id) > String(max) ? item.id : max;
    }, fresh[0].id);
    ctx.cursor.set({ ...cursor, lastId: String(maxId) });
  }
  const mode = modeOf(settings);
  return {
    items,
    meta: {
      provider: 'x',
      mode,
      kind: ctx.rule?.kind || 'keyword',
      query: ctx.rule?.value || '',
      diagnostics: result.diagnostics,
      count: items.length,
      rawCount: result.items.length,
      isMock: mode === 'mock',
    },
  };
}

export function xDetect(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!['x.com', 'twitter.com'].includes(host)) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const username = parts[0];
  if (!username || ['home', 'explore', 'search', 'i', 'settings'].includes(username.toLowerCase())) return null;
  if (!USERNAME_RE.test(username)) return null;
  return {
    platform: 'x',
    kind: 'account',
    value: username,
    config: { mode: 'auto', perAccount: 20, maxItems: 100 },
    name: `@${username}`,
    url: `https://x.com/${username}`,
    confidence: 0.97,
    warnings: ['X 采集需要 .env 的 X_ACCOUNTS_JSON 登录账号；无账号时可用 mode=mock 演示'],
  };
}

export const xAdapter = {
  id: 'x', version: 2, label: 'X / Twitter',
  capabilities: ['account', 'keyword', 'search', 'twscrape'],
  auth: { types: ['none'] },
  authHints: { none: '复用 .env 的 X_ACCOUNTS_JSON；兼容旧 python/accounts.json' },
  publicFallback: false,
  rateLimit: { scope: 'source', requests: 1, perMs: 2000, burst: 1 },
  configExample: { mode: 'auto', perAccount: 20, maxItems: 100, searchType: 'latest', minLikes: 0, lang: '', since: '', until: '' },
  ruleKinds: [
    { kind: 'account', label: '监控账号', requiresValue: true, valuePlaceholder: 'karpathy' },
    { kind: 'keyword', label: '关键词搜索', requiresValue: true, valuePlaceholder: '"AI agent"', optionsExample: { searchType: 'latest', minLikes: 10 } },
  ],
  detect: xDetect,
  validateSource() {},
  validateRule(rule) {
    const kind = String(rule?.kind || 'keyword').toLowerCase();
    const value = String(rule?.value || '').trim();
    if (kind === 'account' && !USERNAME_RE.test(value.replace(/^@+/, ''))) {
      throw new Error('X 账号规则需要合法用户名（1-15 位字母数字下划线）');
    }
    if ((kind === 'keyword' || kind === 'search') && !value) throw new Error('X 关键词规则需要 value');
    if (!['account', 'keyword', 'search'].includes(kind)) throw new Error(`X 不支持规则类型: ${kind}`);
  },
  async probe(ctx) {
    const settings = configOf(ctx.source);
    const mode = modeOf(settings);
    return {
      ok: mode === 'mock' || hasAccounts(),
      supported: true,
      message: mode === 'mock'
        ? 'X mock 模式可用（不会访问 X）'
        : (hasAccounts() ? '已检测到 X 登录账号配置' : '未配置 X 登录账号'),
      mode,
    };
  },
  collect: collectX,
};
