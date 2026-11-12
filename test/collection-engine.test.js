import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmonitor-collection-'));
process.env.DATA_DIR = dataDir;
process.env.WEB_DEFAULT_KEYWORDS = '';
process.env.HF_SYNC_ENABLED = 'false';

const db = await import('../src/db.js');
const engine = await import('../src/collection-engine.js');

test('collection engine runs emergency and scheduled jobs idempotently', async () => {
  const source = db.collectionSources.upsert({ platform: 'web', name: 'engine test', url: 'https://example.com/page' });
  const rule = db.collectionRules.upsert({ sourceId: source.id, kind: 'full', value: '', intervalMin: 60 });
  const fetchImpl = async () => new Response('<html><head><title>Collected</title></head><body>body</body></html>', { status: 200 });

  const first = await engine.runScheduledCollections({ fetchImpl });
  assert.equal(first.results.length, 1);
  assert.equal(first.results[0].added, 1);
  const second = await engine.runCollections({ mode: 'emergency', sourceId: source.id, fetchImpl });
  assert.equal(second.results.length, 1);
  assert.equal(second.results[0].updated, 1);
  assert.equal(db.collectionItems.count(), 1);
  assert.equal(db.collectionRuns.list().length, 2);
  assert.equal(db.collectionRules.get(rule.id).next_run_at != null, true);
});

test('collection auth status never returns the secret value', () => {
  const source = db.collectionSources.list()[0];
  const status = db.collectionAuth.set(source.id, { type: 'cookie', cookies: { session: 'secret-value' } });
  assert.equal(status.configured, true);
  assert.equal(JSON.stringify(status).includes('secret-value'), false);
  assert.deepEqual(db.collectionAuth.get(source.id), { type: 'cookie', cookies: { session: 'secret-value' } });
});

test('different sources run concurrently while the same source is skipped', async () => {
  const a = db.collectionSources.upsert({ platform: 'web', name: 'parallel a', url: 'https://a.example/page' });
  const b = db.collectionSources.upsert({ platform: 'web', name: 'parallel b', url: 'https://b.example/page' });
  db.collectionRules.upsert({ sourceId: a.id, kind: 'full', value: '', intervalMin: 60 });
  db.collectionRules.upsert({ sourceId: b.id, kind: 'full', value: '', intervalMin: 60 });
  let active = 0;
  let maxActive = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async (url) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await gate;
    active--;
    return new Response(`<title>${url}</title><body>ok</body>`, { status: 200 });
  };

  const first = engine.runCollections({ mode: 'emergency', sourceId: a.id, fetchImpl });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const [same, other] = await Promise.all([
    engine.runCollections({ mode: 'emergency', sourceId: a.id, fetchImpl }),
    engine.runCollections({ mode: 'emergency', sourceId: b.id, fetchImpl }),
  ].map(async (promise, index) => {
    if (index === 1) setTimeout(release, 10);
    return promise;
  }));
  await first;

  assert.equal(same.skipped, true);
  assert.equal(other.skipped, false);
  assert.equal(maxActive, 2);
});

test('collection queries can filter by source and platform', () => {
  const source = db.collectionSources.upsert({ platform: 'arxiv', name: 'query filter', url: 'https://export.arxiv.org/api/query' });
  db.collectionItems.upsert({ platform: 'arxiv', external_id: 'filter-1', title: 'Filtered paper', content: 'body', source_url: source.url }, { sourceId: source.id });
  const runId = db.collectionRuns.start({ mode: 'emergency', sourceId: source.id });
  db.collectionRuns.finish(runId, { status: 'ok' });
  assert.equal(db.collectionItems.list({ sourceId: source.id }).some((item) => item.title === 'Filtered paper'), true);
  assert.equal(db.collectionRuns.list({ platform: 'arxiv' }).some((run) => run.id === runId), true);
});
