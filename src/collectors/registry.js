// 适配器注册表：采集内核只通过这里发现平台。
import { publicAdapter, validateAdapter } from './contract.js';
import { canonicalPlatform } from './aliases.js';

const adapters = new Map();

function resolveId(id) {
  const raw = String(id || '').trim().toLowerCase();
  const canonical = canonicalPlatform(raw);
  if (adapters.has(raw)) return raw;
  return adapters.has(canonical) ? canonical : raw;
}

export function registerAdapter(adapter) {
  const normalized = validateAdapter(adapter);
  adapters.set(normalized.id, normalized);
  return normalized;
}

export function getAdapter(id) {
  return adapters.get(resolveId(id)) || null;
}

export function listAdapterInstances() {
  return [...adapters.values()];
}

export function listAdapters() {
  return [...adapters.values()]
    .map(publicAdapter)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function hasAdapter(id) {
  return adapters.has(resolveId(id));
}

/** 仅测试使用：清空注册表。 */
export function clearAdaptersForTests() {
  adapters.clear();
}
