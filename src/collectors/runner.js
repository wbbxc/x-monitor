// 单次任务执行：认证 → 适配器 → 分页入库 → run/job 收尾。
import { config } from '../config.js';
import {
  collectionAuth, collectionRules, collectionRuns, collectionSources, logs,
} from '../db.js';
import { getAdapter } from './registry.js';
import { createContext } from './context.js';
import { createIngestor } from './ingest.js';
import { compileMatcher } from './match.js';
import { createNotificationHook } from './notifications.js';
import { rateLimiter } from './rate-limit.js';
import {
  attachRun, failJob, finishJob, requeueJob,
} from './queue.js';
import {
  CanceledError, CollectorError, classifyError, redactSecrets, retryDelayMs,
} from './errors.js';

function compactMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = { ...meta };
  delete out.items;
  if (Array.isArray(out.providers)) {
    out.providers = out.providers.map(({ items: _items, ...rest }) => rest);
  }
  return out;
}

function ruleBackoffMs(rule, failures) {
  const base = Math.max(30 * 60_000, Number(rule?.interval_min || 0) * 60_000);
  const exponent = Math.max(0, Number(failures) || 0);
  return Math.min(6 * 3600_000, base * (2 ** exponent));
}

function addCounts(target, source) {
  target.collected += Number(source?.collected) || 0;
  target.added += Number(source?.added) || 0;
  target.updated += Number(source?.updated) || 0;
  target.incomplete += Number(source?.incomplete) || 0;
  target.filtered += Number(source?.filtered) || 0;
  return target;
}

function loggerFor(job) {
  const prefix = `[collector job#${job.id}]`;
  return {
    info(message) { console.log(prefix, redactSecrets(message)); },
    warn(message) { console.warn(prefix, redactSecrets(message)); },
    error(message) { console.error(prefix, redactSecrets(message)); },
  };
}

/**
 * 执行一次采集任务。返回可直接展示的摘要；所有异常都已转成 run/job 状态。
 */
export async function executeJob(job, {
  fetchImpl, workerId = 'local', signal: externalSignal, rateLimiter: limiter = rateLimiter,
  proxy = config.collector.proxy, timeoutMs = config.collector.timeoutMs,
  retries = config.collector.retries, maxResponseBytes = config.collector.maxResponseBytes,
  jobTimeoutMs = config.collector.jobTimeoutMs,
} = {}) {
  const startedAt = Date.now();
  let source = job.source_id != null ? collectionSources.get(job.source_id) : null;
  if (!source) source = job.payload?.source || null;
  let rule = job.rule_id != null ? collectionRules.get(job.rule_id) : null;
  if (!rule) rule = job.payload?.rule || null;

  const summary = {
    jobId: job.id, runId: null, status: 'error', collected: 0, added: 0, updated: 0,
    incomplete: 0, filtered: 0, error: null, errorCode: null,
  };

  if (!source || !source.platform) {
    const message = '采集源不存在或已删除';
    summary.error = message;
    summary.errorCode = 'SOURCE_MISSING';
    finishJob(job.id, { status: 'canceled', error: message, errorCode: 'SOURCE_MISSING' });
    logs.add('collection', `任务 #${job.id}：${message}`, 'warn');
    return summary;
  }
  if (source.enabled === false) {
    const message = '采集源已暂停';
    summary.error = message;
    summary.errorCode = 'SOURCE_DISABLED';
    finishJob(job.id, { status: 'canceled', error: message, errorCode: 'SOURCE_DISABLED' });
    logs.add('collection', `任务 #${job.id}：${message}`, 'warn');
    return summary;
  }

  const adapter = getAdapter(source.platform);
  if (!adapter) {
    const message = `没有注册采集平台: ${source.platform}`;
    summary.error = message;
    summary.errorCode = 'ADAPTER_MISSING';
    finishJob(job.id, { status: 'failed', error: message, errorCode: 'ADAPTER_MISSING' });
    logs.add('collection', `任务 #${job.id}：${message}`, 'error');
    return summary;
  }

  let auth = { type: 'none' };
  try {
    if (source.id != null) auth = collectionAuth.get(source.id);
  } catch (error) {
    const message = `认证配置不可用：${error.message}`;
    summary.error = message;
    summary.errorCode = 'AUTH_INVALID';
    finishJob(job.id, { status: 'failed', error: message, errorCode: 'AUTH_INVALID' });
    logs.add('collection', `任务 #${job.id}：${message}`, 'error');
    return summary;
  }

  let matcher;
  try {
    const effectiveMatch = { ...(rule?.match || {}) };
    if (adapter.keywordFilter === 'local' && String(rule?.kind || '').toLowerCase() === 'keyword'
      && rule?.value && !effectiveMatch.includeAny) {
      effectiveMatch.includeAny = [String(rule.value)];
    }
    matcher = compileMatcher({
      match: effectiveMatch,
      defaults: source.config?.match || {},
      rule,
    });
  } catch (error) {
    const message = `匹配条件无效：${error.message}`;
    summary.error = message;
    summary.errorCode = 'MATCH_INVALID';
    finishJob(job.id, { status: 'failed', error: message, errorCode: 'MATCH_INVALID' });
    logs.add('collection', `${source.name}：任务 #${job.id} 失败（${message}）`, 'error');
    return summary;
  }

  const runId = collectionRuns.start({
    mode: job.mode, sourceId: source.id || null, ruleId: rule?.id || null,
    jobId: job.id, attempt: job.attempts,
  });
  attachRun(job.id, runId);
  summary.runId = runId;

  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort(new CanceledError());
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(new CanceledError());
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`任务超时（${jobTimeoutMs}ms）`));
  }, Math.max(1_000, Number(jobTimeoutMs) || 600_000));
  timer.unref?.();

  const counts = { collected: 0, added: 0, updated: 0, incomplete: 0, filtered: 0 };
  const ingestor = createIngestor({
    sourceId: source.id || null, ruleId: rule?.id || null, runId, adapterId: adapter.id,
    matches: matcher.predicate,
    onItemSaved: createNotificationHook({ source, rule }),
  });
  const ctx = createContext({
    adapter,
    source,
    rule,
    auth,
    sourceId: source.id || null,
    runId,
    fetchImpl,
    proxy,
    timeoutMs,
    retries,
    signal: controller.signal,
    rateLimiter: limiter,
    logger: loggerFor(job),
    cursor: ingestor.getCursor(),
    maxResponseBytes,
    matcher,
    emit: async (items, options = {}) => {
      const result = ingestor.ingestPage(items, options);
      addCounts(counts, result);
      return result;
    },
  });

  try {
    let meta = {};
    if (typeof adapter.collectPages === 'function') {
      const result = await adapter.collectPages(ctx);
      meta = result?.meta || {};
      ingestor.clearCursor();
    } else {
      const result = await adapter.collect(ctx);
      meta = result?.meta || {};
      const page = ingestor.ingestPage(result?.items || []);
      addCounts(counts, page);
      const pendingCursor = ctx.getPendingCursor();
      if (pendingCursor !== undefined) {
        ingestor.setCursor(pendingCursor);
        ctx.clearPendingCursor();
      }
    }

    if (controller.signal.aborted && !timedOut) throw new CanceledError();
    const status = counts.incomplete > 0 || ctx.warnings.length ? 'warn' : 'ok';
    summary.status = status;
    summary.collected = counts.collected;
    summary.added = counts.added;
    summary.updated = counts.updated;
    summary.incomplete = counts.incomplete;
    summary.filtered = counts.filtered;
    summary.warnings = ctx.warnings;

    collectionRuns.finish(runId, {
      status,
      ...counts,
      durationMs: Date.now() - startedAt,
      detail: {
        platform: source.platform,
        source: source.name,
        rule: rule?.name || rule?.value || null,
        attempt: job.attempts,
        filtered: counts.filtered,
        match: matcher.summary(),
        meta: compactMeta(meta),
        warnings: ctx.warnings,
      },
    });
    finishJob(job.id, { status: 'succeeded', runId });
    if (source.id != null) collectionSources.markCollected(source.id);
    if (rule?.id != null) collectionRules.markSuccess(rule.id);
    logs.add('collection', `${source.name}：任务 #${job.id} 采集 ${counts.collected} 条，新增 ${counts.added} 条，更新 ${counts.updated} 条${counts.filtered ? `，过滤 ${counts.filtered} 条` : ''}${counts.incomplete ? `，字段不完整 ${counts.incomplete} 条但已保留原始内容` : ''}`, status);
    return summary;
  } catch (error) {
    const info = classifyError(error);
    const shutdown = controller.signal.reason?.shutdown === true;
    const canceled = !shutdown && (info.code === 'CANCELED' || (controller.signal.aborted && !timedOut));
    const durationMs = Date.now() - startedAt;
    const message = redactSecrets(timedOut ? `任务超时（${jobTimeoutMs}ms）` : info.message);
    summary.status = canceled ? 'canceled' : 'error';
    summary.error = message;
    summary.errorCode = shutdown ? 'WORKER_SHUTDOWN' : (canceled ? 'CANCELED' : info.code);
    summary.collected = counts.collected;
    summary.added = counts.added;
    summary.updated = counts.updated;
    summary.incomplete = counts.incomplete;
    summary.filtered = counts.filtered;

    collectionRuns.finish(runId, {
      status: canceled ? 'canceled' : 'error',
      ...counts,
      durationMs,
      error: shutdown ? '服务重启中断，任务已重新排队' : message,
      errorCode: summary.errorCode,
      detail: {
        platform: source.platform, source: source.name,
        rule: rule?.name || rule?.value || null, attempt: job.attempts,
        filtered: counts.filtered,
        match: matcher.summary(),
        meta: {},
      },
    });

    if (shutdown) {
      if (Number(job.attempts) < Number(job.max_attempts)) {
        requeueJob(job.id, {
          runId, error: '服务重启中断，任务已重新排队', errorCode: 'WORKER_SHUTDOWN', availableAt: Date.now(),
        });
      } else {
        failJob(job.id, { runId, error: message, errorCode: 'WORKER_SHUTDOWN' });
      }
      logs.add('collection', `${source.name}：任务 #${job.id} 因服务重启重新排队`, 'warn');
      return summary;
    }

    if (canceled) {
      finishJob(job.id, { status: 'canceled', runId, error: message, errorCode: 'CANCELED' });
      logs.add('collection', `${source.name}：任务 #${job.id} 已取消`, 'warn');
      return summary;
    }

    const retryable = timedOut || info.retryable;
    const retryAfterMs = Math.max(0, Number(info.retryAfterMs) || 0);
    if (retryable && Number(job.attempts) < Number(job.max_attempts)) {
      const delay = Math.max(retryDelayMs(job.attempts), retryAfterMs);
      if (info.code === 'RATE_LIMITED' && rule?.id != null) {
        const cooldown = Math.max(30 * 60_000, retryAfterMs);
        collectionRules.markFailure(rule.id, {
          nextRunAt: new Date(Date.now() + cooldown).toISOString(),
          error: message,
        });
      }
      requeueJob(job.id, {
        runId, error: message, errorCode: summary.errorCode, availableAt: Date.now() + delay,
      });
      logs.add('collection', `${source.name}：任务 #${job.id} 失败，${Math.ceil(delay / 1000)}s 后重试（${message}）`, 'warn');
      return summary;
    }

    failJob(job.id, { runId, error: message, errorCode: summary.errorCode });
    if (rule?.id != null && job.mode === 'scheduled') {
      const nextFailures = Number(collectionRules.get(rule.id)?.consecutive_failures || 0) + 1;
      collectionRules.markFailure(rule.id, {
        nextRunAt: new Date(Date.now() + ruleBackoffMs(rule, nextFailures - 1)).toISOString(),
        error: message,
      });
    }
    logs.add('collection', `${source.name}：任务 #${job.id} 失败（${message}）`, 'error');
    return summary;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', onExternalAbort);
  }
}

/** 刷新按钮：只验证认证/连通性，不写内容。 */
export async function probeSource(sourceId, {
  fetchImpl, proxy = config.collector.proxy, timeoutMs = config.collector.timeoutMs,
  retries = 0, rateLimiter: limiter = rateLimiter,
} = {}) {
  const source = collectionSources.get(sourceId);
  if (!source) throw new Error('采集源不存在');
  const adapter = getAdapter(source.platform);
  if (!adapter) throw new Error(`没有注册采集平台: ${source.platform}`);
  let auth = { type: 'none' };
  try { auth = collectionAuth.get(source.id); } catch (error) {
    throw new CollectorError(`认证配置不可用：${error.message}`, { code: 'AUTH_INVALID' });
  }
  const ctx = createContext({
    adapter, source, rule: null, auth, sourceId: source.id,
    fetchImpl, proxy, timeoutMs, retries, rateLimiter: limiter,
  });
  if (typeof adapter.probe !== 'function') {
    return { ok: true, supported: false, message: '该平台未实现探活，配置已加载' };
  }
  try {
    const result = await adapter.probe(ctx);
    return { supported: true, ...(result || {}) };
  } catch (error) {
    return { supported: true, ok: false, message: redactSecrets(error.message) };
  }
}
