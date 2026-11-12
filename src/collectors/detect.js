// 链接识别：先让各适配器做纯 URL 解析，未知站点回退通用 web；可选执行轻量探活。
import { getAdapter, listAdapterInstances } from './registry.js';
import { createContext } from './context.js';
import { rateLimiter } from './rate-limit.js';
import { canonicalPlatform, inferPlatformFromUrl } from './aliases.js';

function parseHttpUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch { throw new Error('链接无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('链接只支持 http/https');
  return parsed;
}

function fallbackWeb(parsed) {
  const host = parsed.hostname.replace(/^www\./, '');
  return {
    platform: 'web',
    kind: 'full',
    value: '',
    config: { mode: 'full', listUrlTemplate: parsed.href, maxPages: 1 },
    name: host || parsed.href,
    url: parsed.href,
    confidence: 0.3,
    warnings: ['未知站点，已回退通用 web 全量采集；可补充列表模板/搜索模板以获得更好效果'],
  };
}

/**
 * 纯离线识别（不发网络请求）。返回可直接用于创建来源/规则的草稿。
 */
export function detectSource(url) {
  const parsed = parseHttpUrl(url);
  const candidates = [];
  for (const adapter of listAdapterInstances()) {
    if (typeof adapter.detect !== 'function') continue;
    try {
      const result = adapter.detect(parsed.href);
      if (!result) continue;
      candidates.push({
        platform: canonicalPlatform(result.platform || adapter.id),
        label: adapter.label,
        kind: result.kind || 'full',
        value: result.value || '',
        config: result.config && typeof result.config === 'object' ? result.config : {},
        name: result.name || adapter.label,
        url: result.url || parsed.href,
        confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : 0.5,
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
        authRequired: Array.isArray(adapter.auth?.types) && adapter.auth.types.some((type) => type !== 'none'),
        publicFallback: adapter.publicFallback ?? null,
      });
    } catch (error) {
      candidates.push({
        platform: adapter.id,
        label: adapter.label,
        kind: 'full',
        value: '',
        config: {},
        name: adapter.label,
        url: parsed.href,
        confidence: 0,
        warnings: [`识别失败: ${error.message}`],
        authRequired: false,
        publicFallback: adapter.publicFallback ?? null,
      });
    }
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates.find((item) => item.confidence > 0) || fallbackWeb(parsed);
  const inferred = inferPlatformFromUrl(parsed.href);
  return {
    ...best,
    url: best.url || parsed.href,
    inferredPlatform: inferred,
  };
}

/**
 * 识别 + 可选探活。探活失败不影响离线建议，只附带 probe 结果。
 */
export async function detectSourceWithProbe(url, {
  probe = false, fetchImpl, proxy = '', timeoutMs = 15_000, retries = 0,
} = {}) {
  const suggestion = detectSource(url);
  if (!probe) return suggestion;
  const adapter = getAdapter(suggestion.platform);
  if (!adapter || typeof adapter.probe !== 'function') {
    return { ...suggestion, probed: false, probe: { supported: false, message: '该平台未实现探活' } };
  }
  const source = {
    platform: suggestion.platform,
    name: suggestion.name,
    url: suggestion.url,
    config: suggestion.config,
    enabled: true,
  };
  try {
    const ctx = createContext({
      adapter, source, rule: null, auth: { type: 'none' }, sourceId: null,
      fetchImpl, proxy, timeoutMs, retries, rateLimiter,
    });
    const result = await adapter.probe(ctx);
    return { ...suggestion, probed: true, probe: { supported: true, ...(result || {}) } };
  } catch (error) {
    return { ...suggestion, probed: true, probe: { supported: true, ok: false, message: error.message } };
  }
}
