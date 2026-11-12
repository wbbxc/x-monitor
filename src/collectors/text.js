// 共享文本 / URL / 时间工具：适配器与规范化层共用，避免各平台各写一份。
import crypto from 'node:crypto';

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function decodeEntities(value) {
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

export function cleanText(value) {
  let text = String(value ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // RSS 描述经常是双重编码的 HTML，解码两轮后再去标签。
  for (let i = 0; i < 2; i++) text = decodeEntities(text);
  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ');
  for (let i = 0; i < 2; i++) text = decodeEntities(text);
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 规范化 URL：只接受 http/https，去掉 hash 和常见跟踪参数。
 * 无效/不支持的 URL 返回空字符串，调用方据此丢弃链接而不是把 javascript: 写进库。
 */
export function canonicalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$|mc_)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

/** 展示/入库用的安全链接；非 http(s) 一律丢弃。 */
export function safeUrl(value) {
  return canonicalizeUrl(value);
}

export function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function shortDigest(value, length = 40) {
  return digest(value).slice(0, length);
}

export function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
