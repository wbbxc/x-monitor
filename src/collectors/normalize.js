// 统一内容模型：所有适配器返回的原始记录都经过这里，再进入入库层。
import { canonicalizeUrl, cleanText, digest, parseDate, safeUrl } from './text.js';

function rawArray(value, fallback) {
  if (Array.isArray(value)) return value;
  if (value == null) return [fallback];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch { return [value]; }
  }
  return [value];
}

function uniqueLinks(values) {
  const seen = new Set();
  const links = [];
  for (const value of values || []) {
    const link = safeUrl(value);
    if (!link || seen.has(link)) continue;
    seen.add(link);
    links.push(link);
  }
  return links;
}

/**
 * 规范化单条记录。字段缺失不丢弃：required_complete=false，raw_json 原样保留。
 */
export function normalizeCollectionItem(input = {}) {
  const platform = String(input.platform || 'web').trim().toLowerCase();
  const sourceUrl = safeUrl(input.source_url);
  const canonicalUrl = canonicalizeUrl(input.canonical_url || input.url || '');
  const title = cleanText(input.title || input.name || '') || '';
  const content = cleanText(input.content || input.summary || input.text || input.description || '') || '';
  const summary = cleanText(input.summary || input.description || content).slice(0, 4000);
  const externalId = String(input.external_id ?? input.id ?? '').trim();
  const fallbackId = externalId || canonicalUrl || `${title}\n${content}` || JSON.stringify(input.raw_json ?? input);
  const stableExternalId = externalId || digest(`${platform}|${fallbackId}`).slice(0, 40);
  const dedupeKey = canonicalUrl ? `url:${canonicalUrl}` : `id:${platform}:${stableExternalId}`;
  const raw = input.raw_json ?? input.raw ?? input;
  const links = uniqueLinks(input.links || input.urls || []);
  const requiredComplete = Boolean(title && (content || summary) && (canonicalUrl || sourceUrl) && stableExternalId);
  const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? input.metadata
    : {};
  return {
    platform,
    source_url: sourceUrl,
    canonical_url: canonicalUrl,
    external_id: stableExternalId,
    dedupe_key: dedupeKey,
    title: title || stableExternalId,
    content,
    summary,
    author: cleanText(input.author || input.author_name || input.username || ''),
    published_at: parseDate(input.published_at || input.publishedAt || input.created_at || input.createdAt),
    links,
    raw_json: rawArray(raw, input),
    metadata,
    required_complete: requiredComplete,
  };
}

/** 同一 dedupe_key 的重复采集：保留已有字段，追加链接和原始快照。 */
export function mergeCollectionItems(previous, next) {
  const left = normalizeCollectionItem(previous);
  const right = normalizeCollectionItem(next);
  const raw = [...left.raw_json];
  const seenRaw = new Set(raw.map((value) => JSON.stringify(value)));
  for (const value of right.raw_json) {
    const key = JSON.stringify(value);
    if (!seenRaw.has(key)) { seenRaw.add(key); raw.push(value); }
  }
  return {
    ...left,
    source_url: left.source_url || right.source_url,
    canonical_url: left.canonical_url || right.canonical_url,
    external_id: left.external_id || right.external_id,
    title: left.title && left.title !== left.external_id ? left.title : right.title,
    content: left.content || right.content,
    summary: left.summary || right.summary,
    author: left.author || right.author,
    published_at: left.published_at || right.published_at,
    links: uniqueLinks([...left.links, ...right.links]),
    raw_json: raw,
    metadata: { ...left.metadata, ...right.metadata },
    required_complete: left.required_complete || right.required_complete,
    dedupe_key: left.dedupe_key || right.dedupe_key,
  };
}
