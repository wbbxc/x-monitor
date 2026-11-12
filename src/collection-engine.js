// 采集内核门面：任务入队、调度器/Worker 生命周期、健康状态。
import { config } from './config.js';
import { collectionItems, collectionNotifications, collectionRules, collectionRuns, collectionSources, logs } from './db.js';
import { listAdapters } from './collectors/registry.js';
import './collectors/framework.js';
import { planDueRules, ruleDedupeKey } from './collectors/planner.js';
import { CollectorWorker } from './collectors/worker.js';
import {
  activeQueueCount, deleteOldJobs, enqueueJob, getJob, listJobs, queueStats,
} from './collectors/queue.js';
import { probeSource } from './collectors/runner.js';
import { rateLimiter } from './collectors/rate-limit.js';
import { canonicalPlatform, inferPlatformFromUrl } from './collectors/aliases.js';

let kernel = null;

/** 首次启动初始化 Web 关键词 / Hugging Face 来源与规则。 */
export function seedCollectionDefaults() {
  const existing = collectionSources.list();
  let webSource = existing.find((item) => item.platform === 'web' && item.name === '全网关键词');
  if (config.webDefaultKeywords.length && !webSource) {
    webSource = collectionSources.upsert({
      platform: 'web', name: '全网关键词', url: '',
      config: { maxItems: config.collector.webMaxItemsPerKeyword }, enabled: true,
    });
  }
  if (webSource) {
    const rules = collectionRules.list({ sourceId: webSource.id });
    for (const keyword of config.webDefaultKeywords) {
      if (!rules.some((rule) => rule.kind === 'keyword' && rule.value === keyword)) {
        collectionRules.upsert({
          sourceId: webSource.id, kind: 'keyword', value: keyword,
          intervalMin: config.collector.webIntervalMin,
        });
      }
    }
  }

  if (config.collector.hfEnabled) {
    let hfSource = existing.find((item) => item.platform === 'huggingface' && item.name === 'Hugging Face Daily Papers');
    if (!hfSource) {
      hfSource = collectionSources.upsert({
        platform: 'huggingface',
        name: 'Hugging Face Daily Papers',
        url: 'https://huggingface.co/api/daily_papers',
        config: { pageSize: config.collector.hfPageSize, maxPages: config.collector.hfMaxPagesPerRun },
        enabled: true,
      });
    }
    if (hfSource && !collectionRules.list({ sourceId: hfSource.id }).some((rule) => rule.kind === 'full')) {
      collectionRules.upsert({
        sourceId: hfSource.id, kind: 'full', value: '',
        intervalMin: config.collector.hfIntervalHours * 60,
      });
    }
  }
}

export function startCollectionKernel({
  fetchImpl, concurrency = config.collector.concurrency,
  plannerIntervalMs = config.collector.planIntervalSeconds * 1000,
  jobTimeoutMs = config.collector.jobTimeoutMs,
  leaseMs = config.collector.leaseMs,
  planNow = true,
} = {}) {
  if (kernel) return kernel.worker.status();
  seedCollectionDefaults();
  const worker = new CollectorWorker({
    fetchImpl, concurrency, jobTimeoutMs, leaseMs,
    rateLimiter,
  });
  worker.start();
  const interval = Math.max(2_000, Number(plannerIntervalMs) || 15_000);
  const plannerTimer = setInterval(() => {
    try { planDueRules(); } catch (error) { console.error('[collection-planner]', error.message); }
  }, interval);
  plannerTimer.unref?.();
  if (planNow) {
    try { planDueRules(); } catch (error) { console.error('[collection-planner]', error.message); }
  }
  try {
    const removed = deleteOldJobs(config.collector.jobRetentionDays);
    if (removed > 0) console.log(`[collection-kernel] 清理 ${removed} 个已完成任务`);
  } catch (error) {
    console.error('[collection-kernel] 清理任务失败：', error.message);
  }
  try {
    const before = new Date(Date.now() - config.collector.notificationRetentionDays * 86400_000).toISOString();
    const removed = collectionNotifications.cleanup({ before });
    if (removed > 0) console.log(`[collection-kernel] 清理 ${removed} 条已读通知`);
  } catch (error) {
    console.error('[collection-kernel] 清理通知失败：', error.message);
  }
  kernel = { worker, plannerTimer, interval, startedAt: new Date().toISOString() };
  return worker.status();
}

export async function stopCollectionKernel(options = {}) {
  if (!kernel) return { stopped: false };
  clearInterval(kernel.plannerTimer);
  const worker = kernel.worker;
  kernel = null;
  await worker.stop(options);
  return { stopped: true, workerId: worker.workerId };
}

function inferPlatform(url) {
  return inferPlatformFromUrl(url);
}

function sourceSnapshot(source) {
  return {
    id: source?.id ?? null,
    platform: source?.platform,
    name: source?.name,
    url: source?.url || '',
    config: source?.config || {},
    enabled: source?.enabled !== false,
  };
}

function syntheticSource({ platform, url, name, rule, keyword }) {
  const resolved = canonicalPlatform(platform || inferPlatform(url));
  return {
    id: null,
    platform: resolved,
    name: name || `手动采集 · ${resolved}`,
    url: String(url || ''),
    config: {},
    enabled: true,
    rule: rule || {
      id: null, source_id: null, name: keyword || '手动采集',
      kind: keyword ? 'keyword' : 'full', value: keyword || '', interval_min: 0, enabled: true,
    },
  };
}

/**
 * 入队采集任务。mode=scheduled 只检查到期规则；manual/emergency 立即入队。
 * 返回 { mode, jobs, coalesced, planned }，不等待执行。
 */
export function enqueueCollections({
  mode = 'manual', sourceId, ruleId, keyword = '', platform, url, name,
  priority = 100, wait = false, fetchImpl,
} = {}) {
  seedCollectionDefaults();
  const normalizedMode = mode === 'scheduled' ? 'scheduled' : 'manual';
  if (normalizedMode === 'scheduled') {
    const result = planDueRules();
    if (result.jobs.length) kernel?.worker.wake();
    return { mode: normalizedMode, planned: result.planned, coalesced: result.coalesced, jobs: result.jobs, skipped: result.jobs.length === 0 };
  }

  const jobs = [];
  let coalesced = 0;
  const requestKeyword = String(keyword || '').trim();
  let source = null;
  let rule = null;

  if (ruleId != null) {
    rule = collectionRules.get(ruleId);
    if (!rule) throw new Error('指定采集规则不存在');
    source = collectionSources.get(rule.source_id);
    if (!source) throw new Error('采集源不存在');
  } else if (sourceId != null) {
    source = collectionSources.get(sourceId);
    if (!source) throw new Error('指定采集源不存在');
  }

  if (source) {
    let rules = collectionRules.list({ sourceId: source.id, enabled: true });
    if (rule) rules = [rule];
    if (!rules.length) {
      rules = [{
        id: null, source_id: source.id, name: requestKeyword || '手动采集',
        kind: requestKeyword ? 'keyword' : 'full', value: requestKeyword,
        interval_min: 0, enabled: true,
      }];
    }
    for (const item of rules) {
      const key = item.id != null
        ? ruleDedupeKey(source.id, item.id)
        : `adhoc:source:${source.id}:${item.value || 'full'}`;
      const result = enqueueJob({
        sourceId: source.id,
        ruleId: item.id ?? null,
        mode: 'manual',
        priority,
        dedupeKey: key,
        payload: { source: sourceSnapshot(source), rule: item, keyword: item.value || requestKeyword },
        availableAt: Date.now(),
      });
      if (result.coalesced) coalesced++;
      jobs.push(result.job);
    }
  } else {
    const targetUrl = String(url || '').trim();
    const targetPlatform = canonicalPlatform(platform || inferPlatform(targetUrl));
    if (!targetPlatform) throw new Error('缺少采集平台');
    const adhocRule = {
      id: null, source_id: null, name: requestKeyword || '手动采集',
      kind: requestKeyword ? 'keyword' : 'full', value: requestKeyword,
      interval_min: 0, enabled: true,
    };
    const adhocSource = syntheticSource({
      platform: targetPlatform, url: targetUrl, name, rule: adhocRule, keyword: requestKeyword,
    });
    const result = enqueueJob({
      sourceId: null,
      ruleId: null,
      mode: 'manual',
      priority,
      dedupeKey: `adhoc:${targetPlatform}:${targetUrl}:${requestKeyword}`,
      payload: { source: adhocSource, rule: adhocRule, keyword: requestKeyword },
      availableAt: Date.now(),
    });
    if (result.coalesced) coalesced++;
    jobs.push(result.job);
  }

  if (jobs.length) kernel?.worker.wake();
  return { mode: normalizedMode, jobs, coalesced, skipped: jobs.length > 0 && coalesced === jobs.length };
}

function runSummaryForJob(jobId) {
  const job = getJob(jobId);
  if (!job) return null;
  const run = job.last_run_id ? collectionRuns.get(job.last_run_id) : null;
  return {
    jobId: job.id,
    runId: job.last_run_id || null,
    status: run?.status || job.status,
    collected: Number(run?.collected_count || 0),
    added: Number(run?.new_count || 0),
    updated: Number(run?.updated_count || 0),
    incomplete: Number(run?.incomplete_count || 0),
    filtered: Number(run?.filtered_count || 0),
    detail: run?.detail || {},
    error: run?.error || job.last_error || null,
    errorCode: run?.error_code || job.error_code || null,
    attempts: job.attempts,
  };
}

/**
 * 兼容旧调用：默认等待当前立即可执行的任务完成，方便测试与 CLI。
 * HTTP API 应使用 enqueueCollections；等待模式不包含延迟重试。
 */
export async function runCollections(options = {}) {
  const { wait = true, waitTimeoutMs = 120_000 } = options;
  const transient = !kernel;
  if (transient) startCollectionKernel({ fetchImpl: options.fetchImpl, planNow: false });
  try {
    const enqueued = enqueueCollections(options);
    if (!wait) return { ...enqueued, results: [], total: 0 };
    await kernel.worker.waitForIdle({ timeoutMs: waitTimeoutMs, ignoreDelayed: true });
    const results = enqueued.jobs.map((job) => runSummaryForJob(job.id)).filter(Boolean);
    return {
      ...enqueued,
      results,
      total: results.reduce((sum, item) => sum + (Number(item.collected) || 0), 0),
    };
  } finally {
    if (transient) await stopCollectionKernel({ release: true, timeoutMs: 5_000 });
  }
}

export function runScheduledCollections(options = {}) {
  return runCollections({ ...options, mode: 'scheduled' });
}

export function isCollectionRunning() {
  const active = kernel?.worker.status().active?.length || 0;
  return active > 0 || queueStats().running > 0;
}

export function collectionStatus() {
  const worker = kernel?.worker || null;
  return {
    running: isCollectionRunning(),
    current: worker?.status().active || [],
    workerId: worker?.workerId || null,
    queued: queueStats().queued,
    kernelStartedAt: kernel?.startedAt || null,
  };
}

export function collectionHealth() {
  const stats = queueStats();
  const platforms = listAdapters().map((adapter) => {
    const platformStats = queueStats({ platform: adapter.id });
    const runStats = collectionRuns.stats({ platform: adapter.id });
    const rules = collectionRules.list({ platform: adapter.id });
    const failures = rules.reduce((max, rule) => Math.max(max, Number(rule.consecutive_failures) || 0), 0);
    const lastError = rules.map((rule) => rule.last_error).find(Boolean) || '';
    return {
      platform: adapter.id,
      label: adapter.label,
      itemCount: collectionItems.count({ platform: adapter.id }),
      queued: platformStats.queued,
      running: platformStats.running,
      runs: runStats,
      consecutiveFailures: failures,
      lastError,
    };
  });
  return {
    kernel: kernel
      ? { running: true, startedAt: kernel.startedAt, plannerIntervalMs: kernel.interval, worker: kernel.worker.status() }
      : { running: false },
    queue: stats,
    rateLimits: rateLimiter.status(),
    platforms,
  };
}

export function listCollectionJobs(options = {}) {
  return { items: listJobs(options), total: undefined };
}

export function getCollectionJob(jobId) {
  return getJob(jobId);
}

export { probeSource, activeQueueCount };
