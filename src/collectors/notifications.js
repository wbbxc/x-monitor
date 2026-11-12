// 通知构建：把“首次入库/允许更新”转成通知行，具体存储由 db.collectionNotifications 负责。
import { collectionNotifications } from '../db.js';
import { digest } from './text.js';

function truncate(value, length = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, length);
}

function updateHash(value) {
  return digest(String(value || '')).slice(0, 16);
}

/**
 * 返回可写入的通知参数；不满足条件时返回 null。
 * - 新内容：规则 notify !== false 时通知。
 * - 已有内容：仅规则 notify_updates、适配器提供 updateKey 且 updateKey 变化时通知。
 */
export function buildNotification({ source, rule, item, saved, normalized = null } = {}) {
  if (!saved?.id || !rule) return null;
  if (rule.notify === false || Number(rule.notify) === 0) return null;
  const stored = saved.item || item || {};
  const meta = { ...(stored.metadata || {}), ...(normalized?.metadata || {}) };
  const spec = meta.notification && typeof meta.notification === 'object' ? meta.notification : {};
  const event = String(spec.event || meta.event || '').slice(0, 64);
  const updateKey = String(spec.updateKey || meta.updateKey || '');
  const isNew = !!saved.isNew;
  if (!isNew) {
    if (!rule.notify_updates && Number(rule.notify_updates) !== 1) return null;
    if (!updateKey) return null;
  }
  const ruleId = rule.id == null ? 'adhoc' : Number(rule.id);
  const suffix = isNew ? 'new' : `update:${updateHash(updateKey)}`;
  const dedupeKey = `item:${saved.id}:rule:${ruleId}:${event || 'event'}:${suffix}`;
  const title = truncate(spec.title || stored.title || meta.title || '(无标题)', 500);
  const body = truncate(spec.body || stored.summary || stored.content || '', 500);
  return {
    dedupeKey,
    itemId: saved.id,
    sourceId: source?.id ?? null,
    ruleId: rule.id ?? null,
    platform: String(stored.platform || source?.platform || 'web').toLowerCase(),
    sourceName: source?.name || '',
    ruleName: rule.name || rule.value || rule.kind || '',
    event,
    title,
    body,
  };
}

export function notifySaved({ source, rule, item, saved, normalized = null } = {}) {
  const payload = buildNotification({ source, rule, item, saved, normalized });
  if (!payload) return null;
  return collectionNotifications.create(payload);
}

/** 供 createIngestor 使用的同步钩子。 */
export function createNotificationHook({ source, rule } = {}) {
  return ({ item, saved, normalized }) => notifySaved({ source, rule, item, saved, normalized });
}
