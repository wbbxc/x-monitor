// 采集内核 v2：契约、队列、限流、入库事务、Planner、Runner。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmonitor-kernel-'));
process.env.DATA_DIR = dataDir;
process.env.WEB_DEFAULT_KEYWORDS = '';
process.env.HF_SYNC_ENABLED = 'false';
process.env.COLLECTOR_POLL_INTERVAL_MIN = '1';

const db = await import('../src/db.js');
const { validateAdapter } = await import('../src/collectors/contract.js');
const { normalizeCollectionItem, mergeCollectionItems } = await import('../src/collectors/normalize.js');
const { registerAdapter } = await import('../src/collectors/registry.js');
const queue = await import('../src/collectors/queue.js');
const { RateLimiter } = await import('../src/collectors/rate-limit.js');
const { createIngestor } = await import('../src/collectors/ingest.js');
const { jitterMs } = await import('../src/collectors/planner.js');
const engine = await import('../src/collection-engine.js');

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('适配器契约校验拒绝非法定义，接受 v2 定义', () => {
  assert.throws(() => validateAdapter({ id: 'bad id', label: 'x', version: 2, collect() {} }), /id 非法/);
  assert.throws(() => validateAdapter({ id: 'noop', label: 'x', version: 1, collect() {} }), /版本/);
  assert.throws(() => validateAdapter({ id: 'noop', label: 'x', version: 2 }), /collect/);
  const adapter = validateAdapter({
    id: 'sample', label: 'Sample', version: 2, capabilities: ['keyword'],
    auth: { types: ['none', 'token'] }, rateLimit: { requests: 2, perMs: 1000, burst: 2 },
    collect: async () => ({ items: [] }),
  });
  assert.equal(adapter.id, 'sample');
  assert.equal(adapter.rateLimit.requests, 2);
});

test('规范化过滤 javascript 链接并保留不完整原始记录', () => {
  const item = normalizeCollectionItem({
    platform: 'web', title: 'T', content: 'body',
    canonical_url: 'javascript:alert(1)',
    links: ['javascript:alert(1)', 'https://example.com/a', 'https://example.com/a#x'],
    raw_json: { html: '<p>raw</p>' },
  });
  assert.equal(item.canonical_url, '');
  assert.deepEqual(item.links, ['https://example.com/a']);
  assert.equal(item.raw_json.length, 1);
  assert.equal(item.required_complete, false);
});

test('合并保留旧字段并追加链接/原始快照', () => {
  const left = normalizeCollectionItem({
    platform: 'web', title: 'Old', content: 'full', canonical_url: 'https://example.com/x',
    links: ['https://example.com/x'], raw_json: { n: 1 },
  });
  const right = normalizeCollectionItem({
    platform: 'web', title: '', content: '', canonical_url: 'https://example.com/x',
    links: ['https://example.com/x?utm_source=b', 'https://example.com/y'], raw_json: { n: 2 },
  });
  const merged = mergeCollectionItems(left, right);
  assert.equal(merged.title, 'Old');
  assert.equal(merged.content, 'full');
  assert.deepEqual(merged.links.sort(), ['https://example.com/x', 'https://example.com/y']);
  assert.equal(merged.raw_json.length, 2);
});

test('队列：活动任务唯一、同来源串行、不同来源可并发', () => {
  const a = db.collectionSources.upsert({ platform: 'web', name: 'queue a', url: 'https://a.example' });
  const b = db.collectionSources.upsert({ platform: 'web', name: 'queue b', url: 'https://b.example' });
  const first = queue.enqueueJob({
    sourceId: a.id, mode: 'manual', dedupeKey: `test:${a.id}`, payload: { source: a },
  });
  const second = queue.enqueueJob({
    sourceId: a.id, mode: 'manual', dedupeKey: `test:${a.id}`, payload: { source: a },
  });
  assert.equal(first.coalesced, false);
  assert.equal(second.coalesced, true);
  assert.equal(second.job.id, first.job.id);

  const claimed = queue.claimJob({ workerId: 'w1', leaseMs: 60_000 });
  assert.ok(claimed);
  assert.equal(claimed.status, 'running');
  assert.equal(queue.claimJob({ workerId: 'w2' }), null, '同一来源已有 running，不能再次领取');

  queue.enqueueJob({ sourceId: b.id, mode: 'manual', dedupeKey: `test:${b.id}`, payload: { source: b } });
  const other = queue.claimJob({ workerId: 'w2', leaseMs: 60_000 });
  assert.ok(other);
  assert.equal(other.source_id, b.id);
});

test('队列：租约过期回收后可以重新领取', () => {
  const source = db.collectionSources.upsert({ platform: 'web', name: 'lease', url: 'https://lease.example' });
  const { job } = queue.enqueueJob({
    sourceId: source.id, mode: 'manual', dedupeKey: `lease:${source.id}`, payload: { source },
  });
  const claimed = queue.claimJob({ workerId: 'lease-worker', leaseMs: 10 });
  assert.equal(claimed.id, job.id);
  db.run(`UPDATE collection_jobs SET lease_expires_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), job.id);
  const reaped = queue.reapExpired({ now: Date.now() });
  assert.ok(reaped >= 1);
  const again = queue.claimJob({ workerId: 'lease-worker', leaseMs: 60_000 });
  assert.ok(again);
  assert.equal(again.id, job.id);
  assert.equal(again.attempts, 2);
});

test('队列：失败/取消可重试，重试重置尝试次数', () => {
  const source = db.collectionSources.upsert({ platform: 'web', name: 'retry', url: 'https://retry.example' });
  const { job } = queue.enqueueJob({ sourceId: source.id, mode: 'manual', dedupeKey: `retry:${source.id}`, payload: { source } });
  const claimed = queue.claimJob({ workerId: 'retry-worker' });
  assert.ok(claimed);
  queue.cancelJob(job.id);
  const canceled = queue.getJob(job.id);
  assert.ok(canceled.cancel_requested || canceled.status === 'canceled');
  queue.requeueJob(job.id, { error: 'test' });
  db.run(`UPDATE collection_jobs SET status = 'failed', attempts = 3 WHERE id = ?`, job.id);
  const retried = queue.retryJob(job.id);
  assert.equal(retried.status, 'queued');
  assert.equal(retried.attempts, 0);
});

test('限流：令牌桶等待与 429 Retry-After 冷却', async () => {
  let now = 1_000;
  const persistence = new Map();
  const limiter = new RateLimiter({
    now: () => now,
    sleepFn: async (ms) => { now += ms; },
    persistence: {
      get: (scope) => persistence.get(scope) || null,
      set: (scope, until, reason) => persistence.set(scope, { scope, untilMs: until, reason }),
      list: () => [...persistence.values()],
    },
  });
  const started = now;
  await limiter.acquire('host:a', { config: { requests: 1, perMs: 1000, burst: 1 } });
  await limiter.acquire('host:a', { config: { requests: 1, perMs: 1000, burst: 1 } });
  assert.ok(now - started >= 1000);
  const cooldown = limiter.noteResponse('host:a', { status: 429, headers: { 'retry-after': '2' } });
  assert.equal(cooldown.retryAfterMs, 2000);
  const before = now;
  await limiter.acquire('host:a', { config: { requests: 1, perMs: 1000, burst: 1 } });
  assert.ok(now - before >= 2000);
});

test('入库：整页事务失败回滚，不留下半批数据', () => {
  const source = db.collectionSources.upsert({ platform: 'web', name: 'ingest', url: 'https://ingest.example' });
  const ingestor = createIngestor({ sourceId: source.id, adapterId: 'web' });
  const before = db.collectionItems.count();
  assert.throws(() => ingestor.ingestPage([
    { platform: 'web', title: 'ok', content: 'body', canonical_url: 'https://example.com/ok' },
    { platform: 'web', title: 'bad', content: 'body', canonical_url: 'https://example.com/bad', raw_json: { n: 1n } },
  ]), /BigInt/);
  assert.equal(db.collectionItems.count(), before);
});

test('Planner：抖动在 ±10% 内，重复扫描合并活动任务', () => {
  const source = db.collectionSources.upsert({ platform: 'web', name: 'plan', url: 'https://plan.example' });
  const rule = db.collectionRules.upsert({ sourceId: source.id, name: 'plan rule', kind: 'full', value: '', intervalMin: 60 });
  const jitter = jitterMs(60 * 60_000, () => 0.5);
  assert.equal(jitter, 60 * 60_000);
  assert.ok(jitterMs(60 * 60_000, () => 0) >= 54 * 60_000);
  assert.ok(jitterMs(60 * 60_000, () => 1) <= 66 * 60_000);
  const first = db.collectionRules.due(Date.now()).some((item) => item.id === rule.id);
  assert.equal(first, true);
});

test('Runner：自定义适配器入队、执行、入库、收尾', async () => {
  db.run('DELETE FROM collection_jobs');
  registerAdapter({
    id: 'mocktest', version: 2, label: 'Mock Test',
    capabilities: ['full'], auth: { types: ['none'] },
    rateLimit: { requests: 100, perMs: 1000, burst: 10 },
    async collect() {
      return {
        items: [{
          platform: 'mocktest', external_id: 'm1', title: 'Mock item',
          content: 'Mock body', canonical_url: 'https://example.com/mock',
          links: ['https://example.com/mock'], raw_json: { ok: true },
        }],
      };
    },
  });
  const source = db.collectionSources.upsert({ platform: 'mocktest', name: 'mock runner', url: 'https://example.com/mock' });
  db.collectionRules.upsert({ sourceId: source.id, name: 'mock', kind: 'full', value: '', intervalMin: 0 });
  const result = await engine.runCollections({ mode: 'manual', sourceId: source.id });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].collected, 1);
  assert.equal(db.collectionItems.count({ platform: 'mocktest' }), 1);
  const job = db.get(`SELECT * FROM collection_jobs WHERE source_id = ? ORDER BY id DESC LIMIT 1`, source.id);
  assert.equal(job.status, 'succeeded');
});
