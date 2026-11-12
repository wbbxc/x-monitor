// 持久化任务队列：入队、领取、租约、重试、回收。
import {
  all, get, run, transaction, parseJson, collectionRuns,
} from '../db.js';
import { CanceledError, classifyError, retryDelayMs } from './errors.js';

const ACTIVE_STATUSES = ['queued', 'running'];
const iso = (value = Date.now()) => new Date(Number(value) || Date.now()).toISOString();

export function jobView(row) {
  if (!row) return null;
  return {
    ...row,
    priority: Number(row.priority) || 0,
    attempts: Number(row.attempts) || 0,
    max_attempts: Number(row.max_attempts) || 3,
    cancel_requested: !!row.cancel_requested,
    payload: parseJson(row.payload_json, {}),
  };
}

function activeByKey(dedupeKey) {
  if (!dedupeKey) return null;
  return get(
    `SELECT * FROM collection_jobs WHERE dedupe_key = ? AND status IN ('queued', 'running') ORDER BY id LIMIT 1`,
    String(dedupeKey),
  );
}

/**
 * 入队。dedupeKey 存在且已有活动任务时直接复用（coalesced）。
 * nextRunAt 用于 Planner 在同一个事务内推进规则的下次时间。
 */
export function enqueueJob({
  sourceId = null, ruleId = null, mode = 'scheduled', priority = 50,
  dedupeKey = null, payload = {}, availableAt = Date.now(), maxAttempts = 3,
  scheduledFor = null, nextRunAt = null,
} = {}) {
  return transaction(() => {
    if (dedupeKey) {
      const existing = activeByKey(dedupeKey);
      if (existing) {
        if (ruleId != null && nextRunAt) {
          run(`UPDATE collection_rules SET next_run_at = ?, updated_at = ? WHERE id = ?`,
            nextRunAt, iso(), Number(ruleId));
        }
        return { job: jobView(existing), coalesced: true };
      }
    }
    const at = iso();
    try {
      const info = run(
        `INSERT INTO collection_jobs
          (dedupe_key, source_id, rule_id, mode, priority, status, attempts, max_attempts,
           available_at, scheduled_for, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)`,
        dedupeKey, sourceId == null ? null : Number(sourceId), ruleId == null ? null : Number(ruleId),
        String(mode), Number(priority) || 50, Math.max(1, Number(maxAttempts) || 3),
        iso(availableAt), scheduledFor, JSON.stringify(payload || {}), at, at,
      );
      if (ruleId != null && nextRunAt) {
        run(`UPDATE collection_rules SET next_run_at = ?, updated_at = ? WHERE id = ?`,
          nextRunAt, at, Number(ruleId));
      }
      return { job: jobView(get(`SELECT * FROM collection_jobs WHERE id = ?`, Number(info.lastInsertRowid))), coalesced: false };
    } catch (error) {
      // 唯一索引兜底：多 Worker 同时入队时返回已有任务。
      if (dedupeKey && /UNIQUE/i.test(String(error.message))) {
        const existing = activeByKey(dedupeKey);
        if (existing) return { job: jobView(existing), coalesced: true };
      }
      throw error;
    }
  });
}

/** 领取一个可执行任务；同一来源已有 running 时跳过。 */
export function claimJob({ workerId, leaseMs = 120_000, now = Date.now() } = {}) {
  return transaction(() => {
    const at = iso(now);
    const row = get(
      `SELECT j.* FROM collection_jobs j
       WHERE j.status = 'queued' AND j.available_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM collection_jobs r
           WHERE r.source_id IS NOT NULL AND r.source_id = j.source_id AND r.status = 'running'
         )
       ORDER BY j.priority DESC, j.available_at ASC, j.id ASC
       LIMIT 1`,
      at,
    );
    if (!row) return null;
    run(
      `UPDATE collection_jobs
       SET status = 'running', attempts = attempts + 1, lease_owner = ?,
           lease_expires_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND status = 'queued'`,
      String(workerId), iso(Number(now) + Number(leaseMs)), at, at, Number(row.id),
    );
    return jobView(get(`SELECT * FROM collection_jobs WHERE id = ?`, Number(row.id)));
  });
}

/** 续租并返回当前 cancel 标记。 */
export function heartbeatJob({ jobId, workerId, leaseMs = 120_000, now = Date.now() } = {}) {
  run(
    `UPDATE collection_jobs SET lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND status = 'running' AND lease_owner = ?`,
    iso(Number(now) + Number(leaseMs)), iso(now), Number(jobId), String(workerId),
  );
  const row = get(`SELECT id, cancel_requested, status FROM collection_jobs WHERE id = ?`, Number(jobId));
  return row ? { ...row, cancel_requested: !!row.cancel_requested } : null;
}

export function attachRun(jobId, runId) {
  run(`UPDATE collection_jobs SET last_run_id = ?, updated_at = ? WHERE id = ?`,
    runId == null ? null : Number(runId), iso(), Number(jobId));
}

export function getJob(jobId) {
  return jobView(get(`SELECT * FROM collection_jobs WHERE id = ?`, Number(jobId)));
}

export function finishJob(jobId, { status = 'succeeded', runId = null, error = '', errorCode = '' } = {}) {  run(
    `UPDATE collection_jobs
     SET status = ?, finished_at = ?, lease_owner = NULL, lease_expires_at = NULL,
         last_run_id = COALESCE(?, last_run_id), last_error = ?, error_code = ?, updated_at = ?
     WHERE id = ?`,
    status, iso(), runId == null ? null : Number(runId), String(error || '').slice(0, 2000),
    String(errorCode || '').slice(0, 64), iso(), Number(jobId),
  );
  return jobView(get(`SELECT * FROM collection_jobs WHERE id = ?`, Number(jobId)));
}

export function failJob(jobId, { runId = null, error = '', errorCode = '' } = {}) {
  return finishJob(jobId, { status: 'failed', runId, error, errorCode });
}

/** 可重试失败：回到队列并设置 available_at。 */
export function requeueJob(jobId, {
  runId = null, error = '', errorCode = '', availableAt = Date.now(), maxAttempts,
} = {}) {
  return transaction(() => {
    const row = get(`SELECT * FROM collection_jobs WHERE id = ?`, Number(jobId));
    if (!row) return null;
    if (row.status !== 'queued' && row.status !== 'running') return jobView(row);
    const limit = Number(maxAttempts ?? row.max_attempts) || 3;
    if (Number(row.attempts) >= limit) {
      return finishJob(jobId, { status: 'failed', runId, error, errorCode });
    }
    run(
      `UPDATE collection_jobs
       SET status = 'queued', available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
           last_run_id = COALESCE(?, last_run_id), last_error = ?, error_code = ?, updated_at = ?
       WHERE id = ?`,
      iso(availableAt), runId == null ? null : Number(runId), String(error || '').slice(0, 2000),
      String(errorCode || '').slice(0, 64), iso(), Number(jobId),
    );
    return jobView(get(`SELECT * FROM collection_jobs WHERE id = ?`, Number(jobId)));
  });
}

export function cancelJob(jobId) {
  return transaction(() => {
    const row = get(`SELECT * FROM collection_jobs WHERE id = ?`, Number(jobId));
    if (!row) return null;
    if (row.status === 'queued') {
      run(`UPDATE collection_jobs SET status = 'canceled', finished_at = ?, updated_at = ? WHERE id = ?`,
        iso(), iso(), Number(jobId));
    } else if (row.status === 'running') {
      run(`UPDATE collection_jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?`, iso(), Number(jobId));
    }
    return jobView(get(`SELECT * FROM collection_jobs WHERE id = ?`, Number(jobId)));
  });
}

/** 手动重试：重置尝试次数并重新排队。 */
export function retryJob(jobId) {
  return transaction(() => {
    const row = get(`SELECT * FROM collection_jobs WHERE id = ?`, Number(jobId));
    if (!row) return null;
    if (!['failed', 'canceled'].includes(row.status)) {
      throw new Error('只有失败或已取消的任务可以重试');
    }
    run(
      `UPDATE collection_jobs
       SET status = 'queued', attempts = 0, available_at = ?, lease_owner = NULL,
           lease_expires_at = NULL, cancel_requested = 0, started_at = NULL, finished_at = NULL,
           last_error = '', error_code = '', updated_at = ?
       WHERE id = ?`,
      iso(), iso(), Number(jobId),
    );
    return jobView(get(`SELECT * FROM collection_jobs WHERE id = ?`, Number(jobId)));
  });
}

function interruptRun(runId, message, errorCode) {
  if (!runId) return;
  collectionRuns.finish(runId, {
    status: 'error', error: message, errorCode,
  });
}

/** 进程正常退出：把本 Worker 的 running 任务放回队列，重启后可继续。 */
export function releaseWorkerJobs(workerId) {
  return transaction(() => {
    const rows = all(`SELECT * FROM collection_jobs WHERE status = 'running' AND lease_owner = ?`, String(workerId));
    for (const row of rows) {
      interruptRun(row.last_run_id, '服务重启中断，任务已重新排队', 'WORKER_SHUTDOWN');
      requeueJob(row.id, {
        runId: row.last_run_id, error: '服务重启中断，任务已重新排队', errorCode: 'WORKER_SHUTDOWN',
      });
    }
    return rows.length;
  });
}

/** 回收租约过期的任务（进程崩溃/事件循环阻塞）。 */
export function reapExpired({ now = Date.now() } = {}) {
  return transaction(() => {
    const rows = all(
      `SELECT * FROM collection_jobs
       WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
      iso(now),
    );
    for (const row of rows) {
      interruptRun(row.last_run_id, '任务租约过期，已重新排队', 'LEASE_EXPIRED');
      requeueJob(row.id, {
        runId: row.last_run_id, error: '任务租约过期，已重新排队', errorCode: 'LEASE_EXPIRED',
      });
    }
    return rows.length;
  });
}

function jobFilters({ status, sourceId, platform, mode } = {}) {
  const conds = [];
  const args = [];
  if (status) { conds.push('j.status = ?'); args.push(String(status)); }
  if (sourceId != null) { conds.push('j.source_id = ?'); args.push(Number(sourceId)); }
  if (platform) { conds.push('s.platform = ?'); args.push(String(platform)); }
  if (mode) { conds.push('j.mode = ?'); args.push(String(mode)); }
  return { where: conds.length ? ` WHERE ${conds.join(' AND ')}` : '', args };
}

export function listJobs({ limit = 50, offset = 0, ...filters } = {}) {
  const { where, args } = jobFilters(filters);
  const rows = all(
    `SELECT j.*, s.platform, s.name AS source_name
     FROM collection_jobs j LEFT JOIN collection_sources s ON s.id = j.source_id
     ${where} ORDER BY j.id DESC LIMIT ? OFFSET ?`,
    ...args, Math.min(500, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0),
  );
  return rows.map(jobView);
}

export function countJobs(filters = {}) {
  const { where, args } = jobFilters(filters);
  return Number(get(
    `SELECT COUNT(*) AS n FROM collection_jobs j LEFT JOIN collection_sources s ON s.id = j.source_id${where}`,
    ...args,
  ).n || 0);
}

export function queueStats({ platform } = {}) {
  const where = platform ? ' WHERE s.platform = ?' : '';
  const args = platform ? [String(platform)] : [];
  const rows = all(
    `SELECT j.status, COUNT(*) AS n FROM collection_jobs j
     LEFT JOIN collection_sources s ON s.id = j.source_id${where} GROUP BY j.status`,
    ...args,
  );
  const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.n) || 0]));
  const oldest = get(
    `SELECT j.created_at FROM collection_jobs j LEFT JOIN collection_sources s ON s.id = j.source_id
     ${where ? `${where} AND` : ' WHERE'} j.status = 'queued' ORDER BY j.available_at ASC LIMIT 1`,
    ...args,
  );
  return {
    queued: counts.queued || 0,
    running: counts.running || 0,
    succeeded: counts.succeeded || 0,
    failed: counts.failed || 0,
    canceled: counts.canceled || 0,
    total: Object.values(counts).reduce((sum, n) => sum + n, 0),
    oldestQueuedAt: oldest?.created_at || null,
  };
}

export function activeQueueCount() {
  return Number(get(`SELECT COUNT(*) AS n FROM collection_jobs WHERE status IN ('queued', 'running')`).n || 0);
}

/** 只统计“现在就能跑”的任务，用于测试/CLI 等待，不包括延迟重试。 */
export function immediateQueueCount(now = Date.now()) {
  return Number(get(
    `SELECT COUNT(*) AS n FROM collection_jobs WHERE status IN ('queued', 'running') AND (status = 'running' OR available_at <= ?)`,
    iso(now),
  ).n || 0);
}

export function deleteOldJobs(days = 30, now = Date.now()) {
  const cutoff = iso(Number(now) - Math.max(1, Number(days) || 30) * 86_400_000);
  const info = run(
    `DELETE FROM collection_jobs WHERE status IN ('succeeded', 'failed', 'canceled') AND finished_at IS NOT NULL AND finished_at < ?`,
    cutoff,
  );
  return Number(info.changes || 0);
}

export function classifyJobError(error) {
  return classifyError(error);
}

export function retryDelay(attempt, options) {
  return retryDelayMs(attempt, options);
}

export { CanceledError, ACTIVE_STATUSES };
