// Telegram 采集：公开预览、Bot 更新、可选 MTProto 历史，以及 JSON/RSS feed 兼容。
import { parseFeed } from './web.js';
import { cleanText, digest } from './text.js';
import { configOf, defaultMaxItems } from './rules.js';
import { buildAuthHeaders } from './auth.js';
import { CollectorError } from './errors.js';
import { runPythonJsonl } from './python.js';

function maxItemsOf(settings) {
  return defaultMaxItems(settings);
}

export function parseTelegramTarget(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!['t.me', 'telegram.me'].includes(host)) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (!parts.length) return null;
  if (parts[0] === 's' && parts[1]) {
    return { type: 'preview', channel: parts[1], postId: parts[2] || null, previewUrl: `https://t.me/s/${parts[1]}`, url: raw };
  }
  if (parts[0].startsWith('+') || parts[0] === 'joinchat') {
    return { type: 'private', channel: '', invite: parts[1] || parts[0].replace(/^\+/, ''), url: raw };
  }
  if (parts[0] === 'c') {
    return { type: 'private', channel: '', invite: parts.slice(1).join('/'), url: raw };
  }
  return {
    type: 'public',
    channel: parts[0],
    postId: parts[1] || null,
    previewUrl: `https://t.me/s/${parts[0]}`,
    url: raw,
  };
}

function attr(attrs, name) {
  return String(attrs || '').match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] || '';
}

export function parseTelegramPreview(html, channel = '') {
  const source = String(html || '');
  const title = cleanText(
    source.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i)?.[1]
    || source.match(/tgme_channel_info_header_title[^>]*>([\s\S]*?)<\//i)?.[1]
    || channel,
  );
  const description = cleanText(
    source.match(/<meta\b[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1]
    || source.match(/tgme_channel_info_description[^>]*>([\s\S]*?)<\//i)?.[1]
    || '',
  );
  const subscribers = cleanText(source.match(/tgme_channel_info_counter[^>]*>[\s\S]*?counter_value[^>]*>([\s\S]*?)<\/span>/i)?.[1] || '');
  const starts = [...source.matchAll(/data-post=["']([^"']+)["']/gi)];
  const items = [];
  for (let index = 0; index < starts.length; index++) {
    const match = starts[index];
    const dataPost = match[1];
    const start = match.index || 0;
    const end = index + 1 < starts.length ? starts[index + 1].index : source.length;
    const block = source.slice(start, end);
    const [postChannel, postId] = dataPost.split('/');
    const textBlock = block.match(/<div\b[^>]*class=["'][^"']*tgme_widget_message_text[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || '';
    const text = cleanText(textBlock);
    const date = block.match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1] || null;
    const author = cleanText(block.match(/tgme_widget_message_from_author[^>]*>([\s\S]*?)<\/span>/i)?.[1] || '');
    const views = cleanText(block.match(/tgme_widget_message_views[^>]*>([\s\S]*?)<\/span>/i)?.[1] || '');
    const media = [];
    for (const mediaMatch of block.matchAll(/<a\b[^>]*class=["'][^"']*tgme_widget_message_(?:photo|video)_wrap[^"']*["'][^>]*href=["']([^"']+)["']/gi)) {
      media.push({ type: 'photo', url: mediaMatch[1] });
    }
    for (const bgMatch of block.matchAll(/background-image:url\(['"]?([^'")]+)['"]?\)/gi)) {
      media.push({ type: 'image', url: bgMatch[1] });
    }
    const links = [...block.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)]
      .map((link) => link[1])
      .filter((url) => /^https?:\/\//i.test(url) && !url.includes('t.me/'));
    const url = `https://t.me/${postChannel || channel}/${postId}`;
    items.push({
      platform: 'telegram',
      external_id: `${postChannel || channel}:${postId}`,
      canonical_url: url,
      source_url: `https://t.me/s/${postChannel || channel}`,
      title: text.slice(0, 160) || `${postChannel || channel} ${postId}`,
      content: text,
      summary: text,
      author: author || title,
      published_at: date,
      links: [url, ...links, ...media.map((item) => item.url)],
      raw_json: { dataPost, html: block },
      metadata: {
        provider: 'telegram',
        channel: postChannel || channel,
        messageId: postId,
        views,
        media,
        mode: 'preview',
        notification: {
          event: 'message',
          title: `${title} ${text.slice(0, 120)}`.trim().slice(0, 200),
          body: text.slice(0, 500),
        },
      },
    });
  }
  return { title, description, subscribers, items };
}

export function parseTelegramFeedText(text, channel = '') {
  const source = String(text || '').trim();
  let payload = null;
  try { payload = JSON.parse(source); } catch {}
  if (payload) {
    const values = Array.isArray(payload) ? payload : payload.result || payload.messages || payload.items || [];
    return values.map((entry) => {
      const message = entry.message || entry.channel_post || entry;
      const textValue = message.text || message.caption || message.content || '';
      const chat = message.chat || {};
      const id = `${chat.id || chat.username || channel || 'channel'}:${message.message_id || message.id || digest(JSON.stringify(entry)).slice(0, 16)}`;
      const url = message.link || entry.url || (chat.username ? `https://t.me/${chat.username}/${message.message_id}` : '');
      return {
        platform: 'telegram',
        external_id: id,
        canonical_url: url,
        source_url: entry.source_url || `https://t.me/${chat.username || channel || ''}`,
        title: cleanText(textValue).slice(0, 160) || id,
        content: cleanText(textValue),
        summary: cleanText(textValue),
        author: message.from?.username || chat.username || chat.title || '',
        published_at: message.date ? new Date(Number(message.date) * 1000).toISOString() : null,
        links: [url].filter(Boolean),
        raw_json: entry,
        metadata: {
          provider: 'telegram',
          chat_id: chat.id || null,
          chat_title: chat.title || '',
          mode: 'feed',
          notification: { event: 'message', title: cleanText(textValue).slice(0, 200), body: cleanText(textValue).slice(0, 500) },
        },
      };
    });
  }
  return parseFeed(source, 'telegram', { keepIncomplete: true }).map((item) => ({
    platform: 'telegram',
    external_id: item.url || digest(item.title).slice(0, 20),
    canonical_url: item.url,
    source_url: item.source_url || '',
    title: item.title,
    content: item.summary,
    summary: item.summary,
    author: item.source_name,
    published_at: item.published_at,
    links: [item.url].filter(Boolean),
    raw_json: item,
    metadata: { provider: 'telegram', mode: 'feed', notification: { event: 'message', title: item.title, body: item.summary } },
  }));
}

async function collectFeed(ctx, settings) {
  const response = await ctx.fetch(ctx.source.url, {
    headers: { ...buildAuthHeaders(ctx.auth), accept: 'application/json, application/rss+xml, text/xml, */*;q=0.8' },
  });
  const items = parseTelegramFeedText(response.text, settings.channel || '');
  return {
    items: items.slice(0, maxItemsOf(settings)),
    meta: { provider: 'telegram', mode: 'feed', status: response.status, count: items.length },
  };
}

async function collectPreview(ctx, target, settings) {
  const cursor = ctx.cursor.get() || {};
  const maxItems = maxItemsOf(settings);
  const channel = target.channel;
  let before = settings.before || '';
  const lastId = Number(cursor.lastId) || 0;
  const items = [];
  const seen = new Set();
  const attempts = [];
  const maxPages = Math.max(1, Math.min(50, Number(settings.maxPages) || 1));
  for (let page = 0; page < maxPages && items.length < maxItems; page++) {
    const url = new URL(`https://t.me/s/${channel}`);
    if (before) url.searchParams.set('before', String(before));
    let response;
    try {
      response = await ctx.fetch(url.href, {
        headers: { ...buildAuthHeaders(ctx.auth), accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      });
    } catch (error) {
      throw new CollectorError(`Telegram 公开预览不可用：${error.message}。请尝试 Bot 或 MTProto 模式`, {
        code: 'PREVIEW_UNAVAILABLE', retryable: false, cause: error,
      });
    }
    const parsed = parseTelegramPreview(response.text, channel);
    if (!parsed.items.length) {
      attempts.push({ url: url.href, status: response.status, messages: 0 });
      break;
    }
    let added = 0;
    let minId = Infinity;
    for (const item of parsed.items) {
      const id = Number(item.metadata.messageId) || 0;
      if (id && id < minId) minId = id;
      if (seen.has(item.external_id)) continue;
      seen.add(item.external_id);
      if (lastId && id <= lastId) continue;
      items.push(item);
      added++;
      if (items.length >= maxItems) break;
    }
    attempts.push({ url: url.href, status: response.status, messages: parsed.items.length, added });
    if (!added) break;
    if (!Number.isFinite(minId)) break;
    before = String(minId);
    if (maxPages === 1) break;
    await ctx.sleep(400);
  }
  const maxId = items.reduce((max, item) => Math.max(max, Number(item.metadata.messageId) || 0), lastId);
  if (maxId) ctx.cursor.set({ ...cursor, lastId: maxId });
  return {
    items,
    meta: {
      provider: 'telegram', mode: 'preview', channel,
      attempts, count: items.length, degraded: false,
    },
  };
}

function botHeaders() {
  return { accept: 'application/json' };
}

async function botApi(ctx, token, method, params = {}) {
  const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await ctx.fetch(url.href, { headers: botHeaders(token) });
  let payload;
  try { payload = JSON.parse(response.text); } catch { throw new Error(`Telegram Bot ${method} 返回不是 JSON`); }
  if (!payload.ok) {
    throw new CollectorError(`Telegram Bot ${method} 失败：${payload.description || '未知错误'}`, {
      code: 'BOT_ERROR', status: response.status, retryable: response.status === 429,
      retryAfterMs: Number(payload.parameters?.retry_after) * 1000 || 0,
    });
  }
  return payload.result;
}

async function collectBot(ctx, target, settings) {
  const token = String(ctx.auth?.token || '').trim();
  if (!token) {
    throw new CollectorError('Telegram Bot 模式需要 Bot Token', { code: 'AUTH_REQUIRED', retryable: false });
  }
  const channel = target.channel || settings.channel;
  const chat = await botApi(ctx, token, 'getChat', { chat_id: channel.startsWith('@') ? channel : `@${channel}` });
  const cursor = ctx.cursor.get() || {};
  const updates = await botApi(ctx, token, 'getUpdates', {
    offset: cursor.updateId || undefined,
    timeout: 0,
    allowed_updates: JSON.stringify(['channel_post']),
  });
  const items = [];
  let maxUpdate = Number(cursor.updateId) || 0;
  for (const update of Array.isArray(updates) ? updates : []) {
    maxUpdate = Math.max(maxUpdate, Number(update.update_id) + 1);
    const message = update.channel_post;
    if (!message) continue;
    const username = chat.username || channel;
    if (message.chat?.username && message.chat.username !== chat.username) continue;
    if (message.chat?.id != null && chat.id != null && Number(message.chat.id) !== Number(chat.id)) continue;
    const text = message.text || message.caption || '';
    const url = `https://t.me/${username}/${message.message_id}`;
    items.push({
      platform: 'telegram',
      external_id: `${username}:${message.message_id}`,
      canonical_url: url,
      source_url: `https://t.me/${username}`,
      title: cleanText(text).slice(0, 160) || url,
      content: cleanText(text),
      summary: cleanText(text),
      author: chat.title || username,
      published_at: message.date ? new Date(Number(message.date) * 1000).toISOString() : null,
      links: [url],
      raw_json: update,
      metadata: {
        provider: 'telegram', mode: 'bot', channel: username, messageId: message.message_id,
        notification: { event: 'message', title: cleanText(text).slice(0, 200), body: cleanText(text).slice(0, 500) },
      },
    });
  }
  ctx.cursor.set({ ...cursor, updateId: maxUpdate });
  return {
    items: items.slice(0, maxItemsOf(settings)),
    meta: {
      provider: 'telegram', mode: 'bot', channel,
      chat: { id: chat.id, title: chat.title, username: chat.username },
      count: items.length,
      limitation: 'Bot getUpdates 只能接收加入后的新消息，不能读取历史',
    },
  };
}

async function collectMtproto(ctx, target, settings) {
  const fields = ctx.auth?.fields || {};
  const apiId = fields.apiId || fields.api_id;
  const apiHash = fields.apiHash || fields.api_hash;
  const session = fields.session || '';
  if (!apiId || !apiHash) {
    throw new CollectorError('Telegram MTProto 需要 api_id 和 api_hash', { code: 'AUTH_REQUIRED', retryable: false });
  }
  const channel = target.channel || settings.channel;
  const cursor = ctx.cursor.get() || {};
  const minId = Number(cursor.lastId) || 0;
  let result;
  try {
    result = await runPythonJsonl({
      script: 'telegram_worker.py',
      args: ['--limit', String(maxItemsOf(settings))],
      input: { apiId, apiHash, session, channel, minId, limit: maxItemsOf(settings) },
      timeoutMs: Math.max(30_000, Number(settings.timeoutMs) || 300_000),
      signal: ctx.signal,
    });
  } catch (error) {
    if (/MTPROTO_UNAVAILABLE|Telethon|No module/i.test(error.message)) {
      throw new CollectorError('Telegram MTProto 不可用：请安装 telethon 并配置 api_id/api_hash/session', {
        code: 'MTPROTO_UNAVAILABLE', retryable: false, cause: error,
      });
    }
    throw error;
  }
  const items = result.items.filter((item) => Number(item.id) > minId).map((message) => {
    const text = message.text || '';
    const url = message.url || `https://t.me/${channel}/${message.id}`;
    return {
      platform: 'telegram',
      external_id: `${channel}:${message.id}`,
      canonical_url: url,
      source_url: `https://t.me/${channel}`,
      title: cleanText(text).slice(0, 160) || url,
      content: cleanText(text),
      summary: cleanText(text),
      author: message.author || channel,
      published_at: message.date || null,
      links: [url, ...(message.media || []).map((item) => item?.url).filter(Boolean)],
      raw_json: message,
      metadata: {
        provider: 'telegram', mode: 'mtproto', channel, messageId: message.id,
        views: message.views ?? null,
        notification: { event: 'message', title: cleanText(text).slice(0, 200), body: cleanText(text).slice(0, 500) },
      },
    };
  });
  const maxId = items.reduce((max, item) => Math.max(max, Number(item.metadata.messageId) || 0), minId);
  if (maxId) ctx.cursor.set({ ...cursor, lastId: maxId });
  return {
    items,
    meta: {
      provider: 'telegram', mode: 'mtproto', channel,
      count: items.length, diagnostics: result.diagnostics,
      limitation: 'MTProto 按 min_id 增量读取，不会重复历史',
    },
  };
}

export async function collectTelegram(ctx) {
  const settings = { ...configOf(ctx.source), ...(ctx.rule?.options || {}) };
  const mode = String(settings.mode || 'auto').toLowerCase();
  const sourceUrl = String(ctx.source?.url || settings.url || '').trim();
  if (mode === 'feed' || (!parseTelegramTarget(sourceUrl) && /\.(json|rss|xml)(\?|$)/i.test(sourceUrl))) {
    return collectFeed(ctx, settings);
  }
  const target = parseTelegramTarget(sourceUrl || settings.channel || ctx.rule?.value);
  if (!target) throw new Error('Telegram 采集需要 t.me 频道链接或 feed 地址');
  if (target.type === 'private') {
    if (mode === 'mtproto' || (mode === 'auto' && ctx.auth?.fields?.apiId)) return collectMtproto(ctx, target, settings);
    if (mode === 'bot' || (mode === 'auto' && ctx.auth?.token)) return collectBot(ctx, target, settings);
    throw new CollectorError('Telegram 私有邀请需要 Bot 或 MTProto 凭据，公开预览不可用', {
      code: 'AUTH_REQUIRED', retryable: false,
    });
  }
  if (mode === 'mtproto') return collectMtproto(ctx, target, settings);
  if (mode === 'bot') return collectBot(ctx, target, settings);
  try {
    return await collectPreview(ctx, target, settings);
  } catch (error) {
    if (ctx.auth?.token) {
      ctx.logger?.warn?.(`Telegram 公开预览失败，尝试 Bot：${error.message}`);
      return collectBot(ctx, target, settings);
    }
    if (ctx.auth?.fields?.apiId) {
      ctx.logger?.warn?.(`Telegram 公开预览失败，尝试 MTProto：${error.message}`);
      return collectMtproto(ctx, target, settings);
    }
    throw error;
  }
}

export function telegramDetect(url) {
  const target = parseTelegramTarget(url);
  if (!target) return null;
  if (target.type === 'private') {
    return {
      platform: 'telegram',
      kind: 'channel',
      value: url,
      config: { mode: 'auto' },
      name: 'Telegram 私有频道',
      url,
      confidence: 0.95,
      warnings: ['私有邀请需要 Bot 或 MTProto 凭据，公开预览不可用'],
    };
  }
  return {
    platform: 'telegram',
    kind: 'channel',
    value: target.previewUrl,
    config: { mode: 'auto', maxPages: 1 },
    name: `Telegram / ${target.channel}`,
    url: target.previewUrl,
    confidence: 0.97,
    warnings: [],
  };
}

export const telegramAdapter = {
  id: 'telegram', version: 2, label: 'Telegram 频道',
  capabilities: ['preview', 'bot', 'mtproto', 'feed', 'channel-detect'],
  auth: { types: ['none', 'token', 'fields', 'bearer', 'api_key', 'headers'] },
  authHints: {
    token: 'Telegram Bot Token（Bot 需为频道管理员）',
    fields: '{"apiId":123,"apiHash":"...","session":"..."}（MTProto，需要 telethon）',
  },
  publicFallback: 't.me/s/ 公开预览',
  rateLimit: { scope: 'host', requests: 1, perMs: 1000, burst: 2 },
  configExample: { mode: 'auto', maxPages: 1, maxItems: 100, channel: '@channel' },
  ruleKinds: [
    { kind: 'channel', label: '频道', requiresValue: true, valuePlaceholder: 'https://t.me/durov' },
    { kind: 'keyword', label: '关键词（本地过滤）', requiresValue: true, valuePlaceholder: 'AI' },
    { kind: 'feed', label: 'JSON/RSS feed', requiresValue: false, valuePlaceholder: '' },
    { kind: 'full', label: '全量/最新', requiresValue: false, valuePlaceholder: '' },
  ],
  detect: telegramDetect,
  validateSource(source) {
    const config = configOf(source);
    if (!source?.url && !config.channel) throw new Error('Telegram 采集源需要 t.me 链接或 config.channel');
  },
  validateRule(rule) {
    const kind = String(rule?.kind || 'channel').toLowerCase();
    if (!['channel', 'keyword', 'feed', 'full'].includes(kind)) throw new Error(`Telegram 不支持规则类型: ${kind}`);
    if (['channel', 'keyword'].includes(kind) && !String(rule?.value || '').trim()) {
      throw new Error('Telegram 频道/关键词规则需要 value');
    }
  },
  async probe(ctx) {
    const settings = configOf(ctx.source);
    const target = parseTelegramTarget(ctx.source?.url || settings.channel);
    if (!target) return { ok: false, message: '没有可探测的 t.me 频道' };
    if (ctx.auth?.token) {
      try {
        const chat = await botApi(ctx, ctx.auth.token, 'getChat', { chat_id: target.channel.startsWith('@') ? target.channel : `@${target.channel}` });
        return { ok: true, message: `Bot 可访问：${chat.title || chat.username}`, chat: { id: chat.id, title: chat.title, username: chat.username } };
      } catch (error) {
        return { ok: false, message: error.message };
      }
    }
    const response = await ctx.fetch(target.previewUrl, {
      headers: { accept: 'text/html,*/*;q=0.8' }, timeoutMs: 10_000, noRetry: true,
    });
    const parsed = parseTelegramPreview(response.text, target.channel);
    return {
      ok: response.status >= 200 && response.status < 300 && parsed.items.length > 0,
      message: parsed.items.length ? `公开预览可访问：${parsed.title || target.channel}` : '没有公开预览，请使用 Bot/MTProto',
      title: parsed.title, subscribers: parsed.subscribers, mode: parsed.items.length ? 'preview' : 'unavailable',
    };
  },
  collect: collectTelegram,
};
