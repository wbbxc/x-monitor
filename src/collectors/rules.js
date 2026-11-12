// 规则匹配与来源配置读取，供 web / huggingface 等适配器复用。
import { config } from '../config.js';

export function defaultMaxItems(settings = {}, cap = 5000) {
  const value = Number(settings.maxItems) || Number(config.collector.defaultMaxItems) || 100;
  return Math.max(1, Math.min(cap, value));
}

export function configOf(source) {
  if (!source?.config) return {};
  if (typeof source.config === 'object') return source.config;
  try { return JSON.parse(source.config); } catch { return {}; }
}

export function matchesRule(item, rule) {
  const value = String(rule?.value || '').trim().toLocaleLowerCase();
  if (!value) return true;
  const kind = String(rule?.kind || 'keyword').toLowerCase();
  if (kind === 'account' || kind === 'author' || kind === 'user') {
    return String(item.author || '').toLocaleLowerCase().includes(value);
  }
  const haystack = [item.title, item.content, item.summary, item.author, ...(item.metadata?.keywords || [])]
    .join('\n').toLocaleLowerCase();
  return haystack.includes(value);
}
