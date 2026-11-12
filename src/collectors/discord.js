// Discord 采集：Bot Token 读取服务器/频道消息，或仅邀请信息探测。
import { configOf, defaultMaxItems } from './rules.js';
import { CollectorError } from './errors.js';
import { cleanText } from './text.js';

const API = 'https://discord.com/api/v10';

function maxItemsOf(settings) {
  return defaultMaxItems(settings);
}

function maxPagesOf(settings, fallback = 2) {
  return Math.max(1, Math.min(20, Number(settings.maxPages) || fallback));
}

function tokenOf(ctx) {
  return String(ctx.auth?.token || '').trim();
}

function headersFor(token = '') {
  const headers = {
    accept: 'application/json',
    'user-agent': 'DiscordBot (https://github.com/local/x-monitor, 1.2)',
  };
  if (token) headers.authorization = `Bot ${token}`;
  return headers;
}

function inviteCode(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/(?:discord\.gg|discord\.com\/invite)\/([A-Za-z0-9-]+)/i);
  if (match) return match[1];
  if (/^[A-Za-z0-9-]+$/.test(raw)) return raw;
  return '';
}

async function discordJson(ctx, path, { token = '', method = 'GET', body = null } = {}) {
  const url = path.startsWith('http') ? path : `${API}${path}`;
  try {
    const response = await ctx.fetch(url, {
      method,
      body: body == null ? null : JSON.stringify(body),
      headers: headersFor(token),
      timeoutMs: 20_000,
    });
    if (!response.text?.trim()) return { status: response.status, payload: null, headers: response.headers };
    return { status: response.status, payload: JSON.parse(response.text), headers: response.headers };
  } catch (error) {
    if (error.status === 401) {
      throw new CollectorError('Discord Bot Token 无效', { code: 'AUTH_INVALID', status: 401, retryable: false });
    }
    if (error.status === 403) {
      throw new CollectorError('Discord 权限不足：需要 View Channel 与 Read Message History', {
        code: 'FORBIDDEN', status: 403, retryable: false,
      });
    }
    if (error.status === 429) {
      throw new CollectorError('Discord 触发限流', { code: 'RATE_LIMITED', status: 429, retryable: true, retryAfterMs: 5000 });
    }
    throw error;
  }
}

function messageItem(message, { guildId, channelId, channelName = '' }) {
  const attachments = (message.attachments || []).map((item) => ({ id: item.id, name: item.filename, url: item.url, size: item.size }));
  const embeds = (message.embeds || []).map((embed) => ({ title: embed.title, description: embed.description, url: embed.url }));
  const reactions = (message.reactions || []).map((reaction) => ({ emoji: reaction.emoji?.name || '', count: reaction.count || 0 }));
  const content = cleanText(message.content || '');
  const url = `https://discord.com/channels/${guildId || '@me'}/${channelId}/${message.id}`;
  const title = content.slice(0, 160)
    || attachments[0]?.name
    || embeds[0]?.title
    || `Discord ${channelName || channelId} ${message.id}`;
  return {
    platform: 'discord',
    external_id: `${channelId}:${message.id}`,
    canonical_url: url,
    source_url: `https://discord.com/channels/${guildId || '@me'}/${channelId}`,
    title,
    content,
    summary: content || embeds[0]?.description || '',
    author: message.author?.username || message.author?.global_name || '',
    published_at: message.timestamp || null,
    links: [url, ...attachments.map((item) => item.url).filter(Boolean)],
    raw_json: message,
    metadata: {
      provider: 'discord',
      guildId: guildId || '',
      channelId,
      channelName,
      authorId: message.author?.id || '',
      attachments,
      embeds,
      reactions,
      thread: !!message.thread,
      notification: {
        event: 'message',
        title: `Discord ${channelName || channelId}: ${content.slice(0, 120)}`,
        body: content.slice(0, 500),
      },
    },
  };
}

async function inviteInfo(ctx, code, settings) {
  const response = await ctx.fetch(`${API}/invites/${encodeURIComponent(code)}?with_counts=true`, {
    headers: { ...headersFor(''), authorization: '' },
    timeoutMs: 15_000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new CollectorError(`Discord 邀请不可用（HTTP ${response.status}）`, {
      code: 'INVITE_UNAVAILABLE', status: response.status, retryable: false,
    });
  }
  const payload = JSON.parse(response.text);
  const guild = payload.guild || {};
  const title = guild.name || `Discord 邀请 ${code}`;
  return {
    items: [{
      platform: 'discord',
      external_id: `invite:${code}`,
      canonical_url: `https://discord.gg/${code}`,
      source_url: `https://discord.gg/${code}`,
      title,
      content: `邀请服务器：${title}，在线 ${payload.approximate_presence_count ?? '?'}，成员 ${payload.approximate_member_count ?? '?'}`,
      summary: guild.description || '',
      author: '',
      published_at: null,
      links: [`https://discord.gg/${code}`],
      raw_json: payload,
      metadata: {
        provider: 'discord',
        mode: 'invite',
        guildId: guild.id || '',
        memberCount: payload.approximate_member_count ?? null,
        presenceCount: payload.approximate_presence_count ?? null,
        messageCollection: false,
      },
    }],
    meta: {
      provider: 'discord',
      mode: 'invite',
      invite: code,
      guild: { id: guild.id, name: guild.name },
      degraded: true,
      message: '未配置 Bot Token，仅返回邀请公开信息；消息采集不可用',
    },
  };
}

async function collectChannel(ctx, channelId, settings, cursor, guildId, channelName) {
  const token = tokenOf(ctx);
  const items = [];
  const pages = [];
  const after = cursor?.channels?.[channelId] || '';
  const maxItems = maxItemsOf(settings);
  const maxPages = maxPagesOf(settings, 1);
  let before = '';
  let lastId = after;
  for (let page = 0; page < maxPages && items.length < maxItems; page++) {
    const url = new URL(`${API}/channels/${channelId}/messages`);
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    else if (before) url.searchParams.set('before', before);
    const result = await discordJson(ctx, url.href, { token });
    const values = Array.isArray(result.payload) ? result.payload : [];
    pages.push({ channelId, page: page + 1, count: values.length, after, before });
    for (const message of values) {
      items.push(messageItem(message, { guildId, channelId, channelName }));
      if (!lastId || BigInt(message.id) > BigInt(lastId)) lastId = message.id;
      if (items.length >= maxItems) break;
    }
    if (values.length < 100 || after) break;
    before = values[values.length - 1]?.id || '';
    if (!before) break;
  }
  return { items, pages, lastId };
}

async function collectThreads(ctx, channelId, settings, cursor, guildId) {
  if (settings.includeThreads === false) return { items: [], pages: [] };
  const token = tokenOf(ctx);
  let result;
  try {
    result = await discordJson(ctx, `/channels/${channelId}/threads/active`, { token });
  } catch {
    return { items: [], pages: [], warning: '无法读取活动线程' };
  }
  const threads = Array.isArray(result.payload?.threads) ? result.payload.threads : [];
  const items = [];
  const pages = [];
  for (const thread of threads) {
    if (items.length >= maxItemsOf(settings)) break;
    const child = await collectChannel(ctx, thread.id, settings, cursor, guildId, thread.name);
    items.push(...child.items);
    pages.push(...child.pages);
  }
  return { items, pages };
}

async function collectSearch(ctx, settings, cursor) {
  const token = tokenOf(ctx);
  const guildId = String(settings.guildId || '').trim();
  const query = String(ctx.rule?.value || settings.query || '').trim();
  if (!guildId) throw new Error('Discord 服务器搜索需要 config.guildId');
  if (!query) throw new Error('Discord 搜索规则需要关键词');
  const url = new URL(`${API}/guilds/${guildId}/messages/search`);
  url.searchParams.set('content', query);
  url.searchParams.set('limit', '25');
  if (cursor?.searchOffset) url.searchParams.set('offset', String(cursor.searchOffset));
  const result = await discordJson(ctx, url.href, { token });
  const items = [];
  for (const group of result.payload?.messages || []) {
    for (const message of group) {
      items.push(messageItem(message, {
        guildId,
        channelId: message.channel_id,
        channelName: message.channel_id,
      }));
    }
  }
  return { items: items.slice(0, maxItemsOf(settings)), meta: { status: result.status, count: items.length } };
}

export async function collectDiscord(ctx) {
  const settings = { ...configOf(ctx.source), ...(ctx.rule?.options || {}) };
  const token = tokenOf(ctx);
  const sourceUrl = String(ctx.source?.url || '').trim();
  const code = inviteCode(sourceUrl || settings.invite);
  const mode = String(settings.mode || '').toLowerCase();
  if (mode === 'invite' || (!token && code)) {
    if (!code) throw new CollectorError('Discord 邀请模式需要 discord.gg 链接或 config.invite', { code: 'INVITE_REQUIRED', retryable: false });
    return inviteInfo(ctx, code, settings);
  }
  if (!token) {
    throw new CollectorError('Discord 消息采集需要 Bot Token（View Channel / Read Message History）', {
      code: 'AUTH_REQUIRED', retryable: false,
    });
  }
  const kind = String(ctx.rule?.kind || 'channel').toLowerCase();
  const cursor = ctx.cursor.get() || {};
  if (kind === 'search') {
    const result = await collectSearch(ctx, settings, cursor);
    return { ...result, meta: { provider: 'discord', mode: 'search', ...result.meta, degraded: false } };
  }
  const urlInfo = parseDiscordUrl(sourceUrl);
  const guildId = String(settings.guildId || urlInfo?.guildId || (typeof ctx.rule?.value === 'string' && kind === 'guild' ? ctx.rule.value : '')).trim();
  if (!guildId) throw new Error('Discord 采集需要 config.guildId');
  const channelIds = Array.isArray(settings.channelIds) ? settings.channelIds.map(String) : [];
  if (kind === 'channel' && ctx.rule?.value) channelIds.push(String(ctx.rule.value));
  if (urlInfo?.channelId) channelIds.push(String(urlInfo.channelId));
  const channels = [...new Set(channelIds.filter(Boolean))];
  if (!channels.length) throw new Error('Discord 采集需要 config.channelIds 或 channel 规则');
  const items = [];
  const pages = [];
  const warnings = [];
  const nextCursor = { ...cursor, channels: { ...(cursor.channels || {}) } };
  for (const channelId of channels) {
    if (items.length >= maxItemsOf(settings)) break;
    const result = await collectChannel(ctx, channelId, settings, cursor, guildId, channelId);
    items.push(...result.items);
    if (result.items.length && result.items.every((item) => !item.content)) {
      warnings.push(`频道 ${channelId} 的消息正文为空，请确认 Bot 已开启 Message Content Intent`);
    }
    pages.push(...result.pages);
    nextCursor.channels[channelId] = result.lastId;
    const threads = await collectThreads(ctx, channelId, settings, cursor, guildId);
    items.push(...threads.items);
    pages.push(...threads.pages);
    if (threads.warning) warnings.push(threads.warning);
  }
  ctx.cursor.set(nextCursor);
  return {
    items: items.slice(0, maxItemsOf(settings)),
    meta: {
      provider: 'discord', mode: 'bot', guildId, channels,
      pages, warnings, count: items.length, degraded: warnings.length > 0,
    },
  };
}

function parseDiscordUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'discord.gg') {
    return { invite: parsed.pathname.split('/').filter(Boolean)[0] || '' };
  }
  if (host !== 'discord.com' && host !== 'discordapp.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts[0] === 'invite') return { invite: parts[1] || '' };
  if (parts[0] === 'channels' && parts[1] && parts[2]) {
    return { guildId: parts[1], channelId: parts[2] };
  }
  return null;
}

export function discordDetect(url) {
  const info = parseDiscordUrl(url);
  if (!info) return null;
  if (info.invite) {
    return {
      platform: 'discord',
      kind: 'guild',
      value: info.invite,
      config: { mode: 'invite' },
      name: `Discord 邀请 ${info.invite}`,
      url: `https://discord.gg/${info.invite}`,
      confidence: 0.96,
      warnings: ['未配置 Bot Token 时只能读取邀请公开信息，不能采集消息'],
    };
  }
  return {
    platform: 'discord',
    kind: 'channel',
    value: info.channelId,
    config: { guildId: info.guildId, channelIds: [info.channelId], includeThreads: false },
    name: `Discord ${info.guildId}/${info.channelId}`,
    url: `https://discord.com/channels/${info.guildId}/${info.channelId}`,
    confidence: 0.97,
    warnings: ['需要 Bot Token 与 Message Content Intent'],
  };
}

export const discordAdapter = {
  id: 'discord', version: 2, label: 'Discord',
  capabilities: ['bot', 'channel', 'guild', 'search', 'threads', 'invite'],
  auth: { types: ['none', 'token'] },
  authHints: { token: 'Discord Bot Token；需开启 Message Content Intent，并授予 View Channel/Read Message History' },
  publicFallback: '仅邀请公开信息（消息需要 Bot）',
  rateLimit: { scope: 'host', requests: 2, perMs: 1000, burst: 3 },
  configExample: { mode: 'bot', guildId: '', channelIds: [], includeThreads: false, maxItems: 100, maxPages: 1 },
  ruleKinds: [
    { kind: 'channel', label: '频道', requiresValue: true, valuePlaceholder: '频道 ID' },
    { kind: 'guild', label: '服务器', requiresValue: false, valuePlaceholder: '服务器 ID（可选）' },
    { kind: 'search', label: '服务器搜索', requiresValue: true, valuePlaceholder: 'release' },
  ],
  detect: discordDetect,
  validateSource(source) {
    const config = configOf(source);
    const info = parseDiscordUrl(source?.url || '');
    if (config.mode === 'invite' || info?.invite) return;
    if (!config.guildId && !info?.guildId) throw new Error('Discord 来源需要 config.guildId 或频道链接');
    if (!Array.isArray(config.channelIds) || !config.channelIds.length) {
      if (!info?.channelId) throw new Error('Discord 来源需要 config.channelIds 或频道链接');
    }
  },
  validateRule(rule) {
    const kind = String(rule?.kind || 'channel').toLowerCase();
    if (!['channel', 'guild', 'search'].includes(kind)) throw new Error(`Discord 不支持规则类型: ${kind}`);
    if (['channel', 'search'].includes(kind) && !String(rule?.value || '').trim()) {
      throw new Error('Discord 频道/搜索规则需要 value');
    }
  },
  async probe(ctx) {
    const token = tokenOf(ctx);
    if (!token) {
      const code = inviteCode(ctx.source?.url || configOf(ctx.source).invite);
      if (code) {
        try {
          const info = await inviteInfo(ctx, code, configOf(ctx.source));
          return { ok: true, supported: true, message: info.meta.message, mode: 'invite' };
        } catch (error) {
          return { ok: false, message: error.message };
        }
      }
      return { ok: false, message: 'Discord 需要 Bot Token；或配置邀请链接使用 invite 模式' };
    }
    const me = await discordJson(ctx, '/users/@me', { token });
    const settings = configOf(ctx.source);
    const guildId = String(settings.guildId || '').trim();
    const missing = [];
    if (guildId) {
      try {
        const guild = await discordJson(ctx, `/guilds/${guildId}`, { token });
        const channels = await discordJson(ctx, `/guilds/${guildId}/channels`, { token });
        const configured = Array.isArray(settings.channelIds) ? settings.channelIds.map(String) : [];
        for (const channelId of configured) {
          const channel = (channels.payload || []).find((item) => String(item.id) === String(channelId));
          if (!channel) { missing.push(`频道 ${channelId} 不存在`); continue; }
          try {
            await discordJson(ctx, `/channels/${channelId}/messages?limit=1`, { token });
          } catch (error) {
            missing.push(`频道 ${channelId}: ${error.message}`);
          }
        }
        return {
          ok: missing.length === 0,
          message: missing.length ? missing.join('；') : `Bot ${me.payload?.username || ''} 可访问 ${guild.payload?.name || guildId}`,
          bot: { id: me.payload?.id, username: me.payload?.username },
          guild: { id: guild.payload?.id, name: guild.payload?.name },
          missing,
        };
      } catch (error) {
        return { ok: false, message: error.message };
      }
    }
    return { ok: true, message: `Bot ${me.payload?.username || ''} 有效；未配置 guildId，无法校验频道权限` };
  },
  collect: collectDiscord,
};
