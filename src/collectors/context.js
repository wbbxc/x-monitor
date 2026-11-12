// 单次任务上下文：适配器只通过 ctx 访问网络、认证、游标和日志。
import { fetchText } from './http.js';
import { buildAuthHeaders } from './auth.js';
import { CanceledError, CollectorError, classifyError, retryDelayMs } from './errors.js';
import { mergeRateLimit } from './rate-limit.js';
import { configOf } from './rules.js';
import { compileMatcher } from './match.js';

function scopeOf(adapter, source, sourceId) {
  if (adapter?.rateLimit?.scope === 'source') return `source:${source?.id ?? sourceId ?? 'adhoc'}`;
  try { return `host:${new URL(source?.url || '').hostname}`; } catch { return `source:${source?.id ?? sourceId ?? 'adhoc'}`; }
}

function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new CanceledError()); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, Math.min(ms, 2_147_483_647));
    const onAbort = () => { clearTimeout(timer); reject(new CanceledError()); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function statusError(response, cooldown) {
  const status = Number(response?.status) || 0;
  if (status === 429) {
    const error = new CollectorError('HTTP 429（平台限流）', {
      code: 'RATE_LIMITED', retryable: true, status, retryAfterMs: cooldown?.retryAfterMs || 0,
    });
    error.headers = response?.headers || {};
    return error;
  }
  if (status === 408 || status === 425 || status >= 500) {
    const error = new CollectorError(`HTTP ${status}`, { code: status >= 500 ? 'HTTP_5XX' : 'HTTP_4XX', retryable: true, status });
    error.headers = response?.headers || {};
    return error;
  }
  const error = new CollectorError(`HTTP ${status}`, { code: 'HTTP_4XX', retryable: false, status });
  error.headers = response?.headers || {};
  error.body = String(response?.text || '').slice(0, 2000);
  return error;
}

/**
 * @param {object} options
 * @param {object} options.adapter   已注册的适配器
 * @param {object} options.source    来源快照（可含 config）
 * @param {object} options.rule      规则快照
 * @param {object} options.auth      已解密的认证（不会写日志）
 * @param {object} options.rateLimiter 共享限流器
 * @param {Function} [options.emit]  分页模式的入库回调
 */
export function createContext({
  adapter, source, rule, auth = { type: 'none' }, sourceId = null, runId = null,
  fetchImpl, proxy = '', timeoutMs = 30_000, retries = 2, signal,
  rateLimiter, logger, cursor = null, maxResponseBytes = 0, maxWaitMs = 30_000, emit, matcher: providedMatcher,
} = {}) {
  const settings = configOf(source);
  const baseRateLimit = mergeRateLimit(adapter?.rateLimit, settings.rateLimit);
  const scope = scopeOf(adapter, source, sourceId);
  const authHeaders = buildAuthHeaders(auth);
  const warnings = [];
  let pendingCursor = undefined;
  const effectiveMatch = { ...(rule?.match || {}) };
  if (adapter?.keywordFilter === 'local' && String(rule?.kind || '').toLowerCase() === 'keyword'
    && rule?.value && !effectiveMatch.includeAny) {
    effectiveMatch.includeAny = [String(rule.value)];
  }
  const matcher = providedMatcher || compileMatcher({
    match: effectiveMatch,
    defaults: settings.match || {},
    rule,
  });

  const log = {
    info(message) { logger?.info?.(message); },
    warn(message) {
      const text = String(message || '');
      warnings.push(text);
      logger?.warn?.(text);
    },
    error(message) { logger?.error?.(message); },
  };

  function throwIfAborted() {
    if (signal?.aborted) throw new CanceledError();
  }

  const ctx = {
    adapter, source, rule, auth, sourceId, runId, settings,
    signal,
    logger: log,
    warnings,
    matcher,
    matches: matcher.predicate,
    http2Default: adapter?.http2Default === true,
    proxy,
    timeoutMs,
    retries,

    cursor: {
      get() { return cursor; },
      set(value) { pendingCursor = value; },
      clear() { pendingCursor = null; },
    },
    getPendingCursor() { return pendingCursor; },
    clearPendingCursor() { pendingCursor = undefined; },
    sleep(ms) { return sleep(ms, signal); },

    async fetch(url, opts = {}) {
      throwIfAborted();
      const maxRetries = opts.noRetry ? 0 : Math.max(0, Number(opts.retries ?? retries) || 0);
      const requestTimeout = Math.max(1_000, Number(opts.timeoutMs ?? timeoutMs) || timeoutMs);
      const limitConfig = mergeRateLimit(baseRateLimit, opts.rateLimit);
      const requestScope = adapter?.rateLimit?.scope === 'source'
        ? scope
        : (() => { try { return `host:${new URL(url).hostname}`; } catch { return scope; } })();
      let lastError;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        throwIfAborted();
        await rateLimiter.acquire(requestScope, {
          signal,
          config: limitConfig,
          maxWaitMs: Number(opts.maxWaitMs ?? maxWaitMs) || maxWaitMs,
        });
        try {
          const response = await fetchText(url, {
            fetchImpl,
            proxy,
            timeoutMs: requestTimeout,
            retries: 0,
            signal,
            maxBytes: Number(opts.maxBytes ?? maxResponseBytes) || 0,
            http2: opts.http2 ?? adapter?.http2Default === true,
            throwOnHttpError: false,
            method: opts.method || 'GET',
            body: opts.body ?? null,
            headers: { ...authHeaders, ...(opts.headers || {}) },
          });
          const cooldown = rateLimiter.noteResponse(requestScope, response);
          if ((response.status >= 200 && response.status < 300) || response.status === 304) return response;
          const error = statusError(response, cooldown);
          if (!error.retryable || attempt >= maxRetries) throw error;
          lastError = error;
          const delay = Math.max(
            retryDelayMs(attempt + 1),
            cooldown?.retryAfterMs || 0,
          );
          await sleep(delay, signal);
        } catch (error) {
          lastError = error;
          if (signal?.aborted) throw new CanceledError();
          if (error instanceof CollectorError && (!error.retryable || attempt >= maxRetries)) throw error;
          const info = classifyError(error);
          if (!info.retryable || attempt >= maxRetries) throw error;
          const delay = Math.max(info.retryAfterMs || 0, retryDelayMs(attempt + 1));
          await sleep(delay, signal);
        }
      }
      throw lastError || new CollectorError('请求失败', { code: 'NETWORK', retryable: true });
    },

    async emit(items, opts = {}) {
      if (typeof emit !== 'function') throw new Error('当前适配器不支持分页入库');
      const value = opts.cursor !== undefined ? opts.cursor : pendingCursor;
      const result = await emit(items, { cursor: value });
      pendingCursor = undefined;
      return result;
    },
  };

  // 兼容旧 helper：fetchText({fetchImpl}) 走 ctx.fetch，从而获得限流/代理/取消。
  ctx.fetchImpl = async (url, opts = {}) => {
    const response = await ctx.fetch(url, {
      headers: opts.headers,
      signal: opts.signal,
      method: opts.method,
      body: opts.body,
      noRetry: true,
    });
    return new Response(response.text, { status: response.status, headers: response.headers });
  };

  return ctx;
}

export { scopeOf };
