// 适配器契约 v2：只描述能力，不关心存储、调度和页面。

export const ADAPTER_VERSION = 2;
export const AUTH_TYPES = new Set(['none', 'cookie', 'bearer', 'token', 'api_key', 'basic', 'headers', 'fields']);
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function normalizeRuleKinds(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of input) {
    const value = typeof entry === 'string' ? { kind: entry } : entry;
    if (!value || typeof value !== 'object') continue;
    const kind = String(value.kind || '').trim().toLowerCase();
    if (!ID_PATTERN.test(kind) || seen.has(kind)) continue;
    seen.add(kind);
    out.push({
      kind,
      label: String(value.label || kind),
      requiresValue: value.requiresValue !== false,
      valuePlaceholder: String(value.valuePlaceholder || ''),
      optionsExample: value.optionsExample && typeof value.optionsExample === 'object'
        ? value.optionsExample : null,
    });
  }
  return out;
}

function normalizeRateLimit(input) {
  if (!input) return null;
  const scope = input.scope === 'source' ? 'source' : 'host';
  const requests = Math.max(1, Math.floor(Number(input.requests) || 1));
  const perMs = Math.max(100, Math.floor(Number(input.perMs) || 1000));
  const burst = Math.max(1, Math.floor(Number(input.burst) || 1));
  return { scope, requests, perMs, burst };
}

/** 注册前校验，尽早暴露写错的适配器。 */
export function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('采集适配器必须是对象');
  const id = String(adapter.id || '').trim().toLowerCase();
  if (!ID_PATTERN.test(id)) throw new Error(`采集适配器 id 非法: ${adapter.id || '(空)'}`);
  if (!adapter.label) throw new Error(`采集适配器 ${id} 缺少 label`);
  const version = Number(adapter.version || 0);
  if (version !== ADAPTER_VERSION) throw new Error(`采集适配器 ${id} 版本必须为 ${ADAPTER_VERSION}`);
  const hasCollect = typeof adapter.collect === 'function';
  const hasPages = typeof adapter.collectPages === 'function';
  if (hasCollect === hasPages) throw new Error(`采集适配器 ${id} 必须且只能实现 collect 或 collectPages`);
  const capabilities = Array.isArray(adapter.capabilities)
    ? adapter.capabilities.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const authTypes = Array.isArray(adapter.auth?.types)
    ? adapter.auth.types.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
    : ['none'];
  for (const type of authTypes) {
    if (!AUTH_TYPES.has(type)) throw new Error(`采集适配器 ${id} 的认证类型不支持: ${type}`);
  }
  if (adapter.probe != null && typeof adapter.probe !== 'function') throw new Error(`采集适配器 ${id} 的 probe 必须是函数`);
  if (adapter.detect != null && typeof adapter.detect !== 'function') throw new Error(`采集适配器 ${id} 的 detect 必须是函数`);
  if (adapter.validateSource != null && typeof adapter.validateSource !== 'function') throw new Error(`采集适配器 ${id} 的 validateSource 必须是函数`);
  if (adapter.validateRule != null && typeof adapter.validateRule !== 'function') throw new Error(`采集适配器 ${id} 的 validateRule 必须是函数`);
  return {
    ...adapter,
    id,
    version,
    label: String(adapter.label),
    capabilities,
    auth: { ...(adapter.auth || {}), types: authTypes },
    rateLimit: normalizeRateLimit(adapter.rateLimit),
    http2Default: adapter.http2Default === true,
    ruleKinds: normalizeRuleKinds(adapter.ruleKinds),
    publicFallback: adapter.publicFallback === undefined ? null : adapter.publicFallback,
    authHints: adapter.authHints && typeof adapter.authHints === 'object' ? { ...adapter.authHints } : null,
  };
}

/** 暴露给 API/UI 的公开元数据，不包含 collect 函数。 */
export function publicAdapter(adapter) {
  return {
    id: adapter.id,
    label: adapter.label,
    version: adapter.version,
    capabilities: [...adapter.capabilities],
    auth: { types: [...adapter.auth.types] },
    authHints: adapter.authHints ? { ...adapter.authHints } : null,
    rateLimit: adapter.rateLimit ? { ...adapter.rateLimit } : null,
    configExample: adapter.configExample || null,
    ruleKinds: (adapter.ruleKinds || []).map((item) => ({ ...item, optionsExample: item.optionsExample ? { ...item.optionsExample } : null })),
    publicFallback: adapter.publicFallback ?? null,
  };
}
