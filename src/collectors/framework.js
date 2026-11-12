// 采集门面：注册内置适配器，提供兼容的单次采集入口。
import { registerAdapter, getAdapter, listAdapters } from './registry.js';
import { normalizeCollectionItem, mergeCollectionItems } from './normalize.js';
import { createContext } from './context.js';
import { compileMatcher } from './match.js';
import { rateLimiter } from './rate-limit.js';
import { webAdapter } from './web.js';
import { googleAdapter } from './google.js';
import { arxivAdapter } from './arxiv.js';
import { huggingfaceAdapter } from './huggingface.js';
import { linuxdoAdapter } from './linuxdo.js';
import { createDiscourseAdapter } from './discourse.js';
import { v2exAdapter } from './v2ex.js';
import { redditAdapter } from './reddit.js';
import { telegramAdapter } from './telegram.js';
import { discordAdapter } from './discord.js';
import { githubAdapter } from './github.js';
import { xAdapter } from './x.js';

const macosdoAdapter = createDiscourseAdapter({
  id: 'macos.do',
  label: 'macos.do',
  origin: 'https://macos.do',
  defaultUrl: 'https://macos.do/latest.json',
});

for (const adapter of [
  webAdapter, googleAdapter, arxivAdapter, huggingfaceAdapter,
  linuxdoAdapter, macosdoAdapter, v2exAdapter, redditAdapter,
  telegramAdapter, discordAdapter, githubAdapter, xAdapter,
]) {
  registerAdapter(adapter);
}

/** 兼容旧调用：registerCollector(id, { label, capabilities, collect }) */
export function registerCollector(id, adapter = {}) {
  return registerAdapter({
    ...adapter,
    id,
    version: 2,
    label: adapter.label || id,
    capabilities: adapter.capabilities || [],
    auth: adapter.auth || { types: ['none'] },
    collect: adapter.collect,
    collectPages: adapter.collectPages,
  });
}

export function getCollector(id) {
  return getAdapter(id);
}

export function listCollectors() {
  return listAdapters();
}

/**
 * 单次采集（不入队、不写库），供测试、探活和临时调用。
 * 返回的 items 已经过统一规范化，并应用规则匹配条件。
 */
export async function collectSource({
  source, rule, auth = { type: 'none' }, fetchImpl, proxy = '', timeoutMs = 30_000, retries = 2,
} = {}) {
  const adapter = getAdapter(source?.platform);
  if (!adapter) throw new Error(`没有注册采集平台: ${source?.platform || '(空)'}`);
  const items = [];
  const effectiveMatch = { ...(rule?.match || {}) };
  if (adapter.keywordFilter === 'local' && String(rule?.kind || '').toLowerCase() === 'keyword'
    && rule?.value && !effectiveMatch.includeAny) {
    effectiveMatch.includeAny = [String(rule.value)];
  }
  const matcher = compileMatcher({
    match: effectiveMatch,
    defaults: source?.config?.match || {},
    rule,
  });
  const ctx = createContext({
    adapter,
    source,
    rule,
    auth,
    fetchImpl,
    proxy,
    timeoutMs,
    retries,
    rateLimiter,
    cursor: null,
    maxResponseBytes: 0,
    matcher,
    emit: async (pageItems) => { items.push(...(pageItems || [])); },
  });
  let result;
  let raw;
  if (typeof adapter.collectPages === 'function') {
    result = await adapter.collectPages(ctx);
    raw = items;
  } else {
    result = await adapter.collect(ctx);
    raw = result?.items || [];
  }
  return {
    items: raw.map(normalizeCollectionItem).filter((item) => matcher.predicate(item)),
    meta: result?.meta || {},
    match: matcher.summary(),
  };
}

export { normalizeCollectionItem, mergeCollectionItems, registerAdapter, getAdapter, listAdapters };
