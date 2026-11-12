// 常驻 Worker：并发领取任务、续租、回收过期租约、优雅退出。
import { config } from '../config.js';
import { logs } from '../db.js';
import {
  activeQueueCount, claimJob, heartbeatJob, immediateQueueCount, reapExpired, releaseWorkerJobs,
} from './queue.js';
import { executeJob } from './runner.js';
import { CanceledError } from './errors.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultWorkerId() {
  return config.collector.workerId
    || `${process.env.HOSTNAME || 'local'}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
}

export class CollectorWorker {
  constructor({
    workerId = defaultWorkerId(),
    concurrency = config.collector.concurrency,
    leaseMs = config.collector.leaseMs,
    jobTimeoutMs = config.collector.jobTimeoutMs,
    fetchImpl,
    proxy = config.collector.proxy,
    timeoutMs = config.collector.timeoutMs,
    retries = config.collector.retries,
    maxResponseBytes = config.collector.maxResponseBytes,
    rateLimiter,
    pollMs = 500,
  } = {}) {
    this.workerId = workerId;
    this.concurrency = Math.max(1, Math.min(16, Number(concurrency) || 3));
    this.leaseMs = Math.max(10_000, Number(leaseMs) || 120_000);
    this.jobTimeoutMs = Math.max(10_000, Number(jobTimeoutMs) || 600_000);
    this.fetchImpl = fetchImpl;
    this.proxy = proxy;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.maxResponseBytes = maxResponseBytes;
    this.rateLimiter = rateLimiter;
    this.pollMs = Math.max(100, Number(pollMs) || 500);
    this.active = new Map();
    this.running = false;
    this.stopping = false;
    this.timer = null;
    this.reaperTimer = null;
    this.startedAt = null;
  }

  start() {
    if (this.running) return this.status();
    this.running = true;
    this.startedAt = new Date().toISOString();
    this.reap();
    this.reaperTimer = setInterval(() => this.reap(), Math.max(5_000, this.leaseMs / 2));
    this.schedule(0);
    console.log(`[collector-worker] ${this.workerId} 启动，并发 ${this.concurrency}`);
    return this.status();
  }

  schedule(delay = null) {
    if (!this.running) return;
    clearTimeout(this.timer);
    const wait = delay == null ? (this.active.size ? 100 : this.pollMs) : delay;
    this.timer = setTimeout(() => { this.tick().catch((error) => console.error('[collector-worker]', error)); }, wait);
  }

  /** 入队后立即唤醒，避免等下一次轮询才领取。 */
  wake() {
    if (this.running) this.schedule(0);
  }

  async tick() {
    if (!this.running) return;
    while (this.running && this.active.size < this.concurrency) {
      const job = claimJob({ workerId: this.workerId, leaseMs: this.leaseMs });
      if (!job) break;
      this.launch(job);
    }
    this.schedule();
  }

  launch(job) {
    const controller = new AbortController();
    this.active.set(job.id, { job, controller, startedAt: Date.now() });
    const heartbeat = setInterval(() => {
      try {
        const state = heartbeatJob({ jobId: job.id, workerId: this.workerId, leaseMs: this.leaseMs });
        if (!state || state.status !== 'running') { clearInterval(heartbeat); return; }
        if (state.cancel_requested) controller.abort(new CanceledError('用户取消任务'));
      } catch (error) {
        console.error('[collector-heartbeat]', error.message);
      }
    }, Math.max(1_000, this.leaseMs / 3));
    heartbeat.unref?.();

    executeJob(job, {
      fetchImpl: this.fetchImpl,
      workerId: this.workerId,
      signal: controller.signal,
      rateLimiter: this.rateLimiter,
      proxy: this.proxy,
      timeoutMs: this.timeoutMs,
      retries: this.retries,
      maxResponseBytes: this.maxResponseBytes,
      jobTimeoutMs: this.jobTimeoutMs,
    }).catch((error) => {
      console.error('[collector-runner]', error);
    }).finally(() => {
      clearInterval(heartbeat);
      this.active.delete(job.id);
      this.schedule(100);
    });
  }

  reap() {
    try {
      const count = reapExpired({ now: Date.now() });
      if (count > 0) {
        console.warn(`[collector-worker] 回收 ${count} 个租约过期任务`);
        logs.add('collection', `回收 ${count} 个租约过期任务`, 'warn');
      }
    } catch (error) {
      console.error('[collector-reaper]', error.message);
    }
  }

  async stop({ release = true, timeoutMs = 15_000 } = {}) {
    if (!this.running && this.active.size === 0) return;
    this.running = false;
    this.stopping = true;
    clearTimeout(this.timer);
    clearInterval(this.reaperTimer);
    const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || 15_000);
    while (this.active.size > 0 && Date.now() < deadline) await sleep(50);
    for (const { controller } of this.active.values()) {
      const reason = new Error('服务重启中断');
      reason.shutdown = true;
      controller.abort(reason);
    }
    const abortDeadline = Date.now() + 3_000;
    while (this.active.size > 0 && Date.now() < abortDeadline) await sleep(25);
    if (release) {
      try { releaseWorkerJobs(this.workerId); } catch (error) { console.error('[collector-stop]', error.message); }
    }
    this.stopping = false;
    console.log(`[collector-worker] ${this.workerId} 已停止`);
  }

  /** 测试/CLI 使用：等待当前立即可执行的任务清空。 */
  async waitForIdle({ timeoutMs = 120_000, ignoreDelayed = false, pollMs = 40 } = {}) {
    const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 120_000);
    while (Date.now() < deadline) {
      const pending = ignoreDelayed ? immediateQueueCount() : activeQueueCount();
      if (this.active.size === 0 && pending === 0) return true;
      await sleep(pollMs);
    }
    return false;
  }

  status() {
    return {
      workerId: this.workerId,
      running: this.running,
      concurrency: this.concurrency,
      active: [...this.active.values()].map(({ job, startedAt }) => ({
        jobId: job.id, sourceId: job.source_id, ruleId: job.rule_id,
        platform: job.payload?.source?.platform || null,
        startedAt: new Date(startedAt).toISOString(),
      })),
      startedAt: this.startedAt,
    };
  }
}
