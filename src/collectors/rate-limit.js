// 请求级限流：内存令牌桶 + SQLite 持久化冷却（429/503）。
import { collectionRateLimits } from '../db.js';
import { CanceledError, RateLimitedError, parseRetryAfter } from './errors.js';

const DEFAULT_CONFIG = { scope: 'host', requests: 1, perMs: 1000, burst: 1 };

function abortError() {
  return new CanceledError('请求已取消');
}

function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, Math.min(ms, 2_147_483_647));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function normalizeConfig(input = {}) {
  return {
    scope: input.scope === 'source' ? 'source' : 'host',
    requests: Math.max(1, Number(input.requests) || DEFAULT_CONFIG.requests),
    perMs: Math.max(100, Number(input.perMs) || DEFAULT_CONFIG.perMs),
    burst: Math.max(1, Number(input.burst) || DEFAULT_CONFIG.burst),
  };
}

/** 合并适配器默认限流与来源 config.rateLimit。 */
export function mergeRateLimit(base, override) {
  const merged = { ...DEFAULT_CONFIG, ...(base || {}), ...(override || {}) };
  if (base?.scope === 'source' && override?.scope == null) merged.scope = 'source';
  return normalizeConfig(merged);
}

export class RateLimiter {
  constructor({ now = () => Date.now(), sleepFn = sleep, persistence = collectionRateLimits } = {}) {
    this.now = now;
    this.sleep = sleepFn;
    this.persistence = persistence;
    this.buckets = new Map();
  }

  /** 冷却中先等待；超过 maxWaitMs 则交给任务退避。 */
  async acquire(scope, { signal, config, maxWaitMs = 30_000 } = {}) {
    const cfg = normalizeConfig(config);
    const persisted = this.persistence.get(scope);
    if (persisted?.untilMs > this.now()) {
      const wait = persisted.untilMs - this.now();
      if (wait > maxWaitMs) throw new RateLimitedError(`平台冷却中（${Math.ceil(wait / 1000)}s）`, wait);
      await this.sleep(wait, signal);
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      if (signal?.aborted) throw abortError();
      const bucket = this.buckets.get(scope) || { tokens: cfg.burst, updatedAt: this.now() };
      const elapsed = Math.max(0, this.now() - bucket.updatedAt);
      const refill = (elapsed / cfg.perMs) * cfg.requests;
      bucket.tokens = Math.min(cfg.burst, bucket.tokens + refill);
      bucket.updatedAt = this.now();
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        this.buckets.set(scope, bucket);
        return;
      }
      this.buckets.set(scope, bucket);
      const wait = Math.ceil(((1 - bucket.tokens) / cfg.requests) * cfg.perMs);
      if (wait > maxWaitMs) throw new RateLimitedError(`限流等待 ${wait}ms`, wait);
      await this.sleep(wait, signal);
    }
    throw new RateLimitedError('限流等待超时', maxWaitMs);
  }

  /** 记录 429/503 的 Retry-After，供其它 Worker/进程共享。 */
  noteResponse(scope, response) {
    const status = Number(response?.status) || 0;
    if (status !== 429 && status !== 503) return null;
    const retryAfterMs = parseRetryAfter(response?.headers?.['retry-after']);
    const delay = retryAfterMs > 0 ? retryAfterMs : 60_000;
    const until = this.now() + delay;
    this.persistence.set(scope, until, `HTTP ${status}`);
    return { cooldownMs: delay, retryAfterMs };
  }

  cooldown(scope, delayMs, reason = '') {
    const until = this.now() + Math.max(0, Number(delayMs) || 0);
    this.persistence.set(scope, until, reason);
    return until;
  }

  status() {
    return this.persistence.list().filter((item) => item.untilMs > this.now());
  }
}

export const rateLimiter = new RateLimiter();
