// 采集错误分类：区分可重试、限流、认证和取消，供 Worker/队列统一决策。

export class CollectorError extends Error {
  constructor(message, {
    code = 'INTERNAL', retryable = false, retryAfterMs = 0, status = 0, cause,
  } = {}) {
    super(String(message || '采集失败'));
    this.name = 'CollectorError';
    this.code = code;
    this.retryable = !!retryable;
    this.retryAfterMs = Math.max(0, Number(retryAfterMs) || 0);
    this.status = Number(status) || 0;
    if (cause) this.cause = cause;
  }
}

export class CanceledError extends CollectorError {
  constructor(message = '任务已取消') {
    super(message, { code: 'CANCELED', retryable: false });
    this.name = 'CanceledError';
  }
}

export class RateLimitedError extends CollectorError {
  constructor(message = '触发平台限流', retryAfterMs = 0) {
    super(message, { code: 'RATE_LIMITED', retryable: true, retryAfterMs, status: 429 });
    this.name = 'RateLimitedError';
  }
}

function isTimeoutMessage(message) {
  return /timeout|timed out|超时|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(String(message || ''));
}

function isNetworkMessage(message) {
  return /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|fetch failed|连接已关闭|代理/i
    .test(String(message || ''));
}

/** 把任意异常归类成统一的 { code, retryable, retryAfterMs, status, message }。 */
export function classifyError(error) {
  if (error instanceof CollectorError) {
    return {
      code: error.code,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
      status: error.status,
      message: error.message,
      error,
    };
  }
  const message = String(error?.message || error || '未知错误');
  const status = Number(error?.status) || 0;
  if (error?.name === 'AbortError' || /abort|cancel|取消|任务超时/i.test(message)) {
    return { code: 'CANCELED', retryable: false, retryAfterMs: 0, status, message, error };
  }
  if (status === 429) {
    return { code: 'RATE_LIMITED', retryable: true, retryAfterMs: 0, status, message, error };
  }
  if (status === 408 || status === 425 || status >= 500) {
    return { code: status >= 500 ? 'HTTP_5XX' : 'HTTP_4XX', retryable: true, retryAfterMs: 0, status, message, error };
  }
  if (status >= 400) {
    return { code: 'HTTP_4XX', retryable: false, retryAfterMs: 0, status, message, error };
  }
  if (isTimeoutMessage(message)) {
    return { code: 'TIMEOUT', retryable: true, retryAfterMs: 0, status, message, error };
  }
  if (isNetworkMessage(message)) {
    return { code: 'NETWORK', retryable: true, retryAfterMs: 0, status, message, error };
  }
  if (/JSON|parse|解析|格式|XML|RSS|Atom/i.test(message)) {
    return { code: 'PARSE', retryable: false, retryAfterMs: 0, status, message, error };
  }
  return { code: 'INTERNAL', retryable: false, retryAfterMs: 0, status, message, error };
}

/** 指数退避 + 抖动；attempt 从 1 开始。 */
export function retryDelayMs(attempt, { baseMs = 2000, maxMs = 300000, jitter = 0.2, random = Math.random } = {}) {
  const exponent = Math.max(0, Number(attempt) - 1);
  const raw = Math.min(maxMs, baseMs * (2 ** exponent));
  const factor = 1 - jitter + random() * jitter * 2;
  return Math.max(0, Math.round(raw * factor));
}

/** 解析 Retry-After：秒数或 HTTP 日期。 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return 0;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, Math.round(Number(text) * 1000));
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

const SECRET_PATTERNS = [
  /(authorization\s*[:=]\s*)([^\s,;]+)/gi,
  /((?:cookie|set-cookie)\s*[:=]\s*)([^\n]+)/gi,
  /([?&](?:token|api[_-]?key|key|secret|password|passwd|auth|access_token)=)([^&\s]+)/gi,
  /(https?:\/\/[^\s/@:]+:)([^\s/@]+)(@)/gi,
];

/** 日志/错误展示前脱敏；不改变业务数据。 */
export function redactSecrets(value) {
  let text = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, prefix, secret, suffix = '') => `${prefix}***${suffix}`);
  }
  return text;
}

export function redactUrl(value) {
  return redactSecrets(String(value || ''));
}
