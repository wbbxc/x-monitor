// 统一调度：多平台到期规则、手动规则跳过、429 退避。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmonitor-sched-'));
process.env.DATA_DIR = dataDir;
process.env.HF_SYNC_ENABLED = 'false';
process.env.WEB_DEFAULT_KEYWORDS = '';

const { collectionSources, collectionRules } = await import('../src/db.js');
const { runScheduledCollections } = await import('../src/collection-engine.js');

function rss(title) {
  return `<?xml version="1.0"?><rss><channel><item><title>${title}</title><link>https://example.com/${encodeURIComponent(title)}</link><description>body</description><pubDate>Fri, 17 Oct 2026 08:00:00 GMT</pubDate></item></channel></rss>`;
}
const webSource = collectionSources.upsert({ platform: 'web', name: '调度测试源', url: '', config: {} });

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('到期规则执行并推进 last/next；interval=0 不参与调度', async () => {
  const rule = collectionRules.upsert({ sourceId: webSource.id, name: 'AI', kind: 'keyword', value: 'AI', intervalMin: 60 });
  const result = await runScheduledCollections({
    fetchImpl: async () => ({ status: 200, headers: {}, text: async () => rss('AI news') }),
  });
  assert.equal(result.results.length, 1);
  const updated = collectionRules.get(rule.id);
  assert.ok(updated.last_run_at);
  assert.ok(updated.next_run_at);
  const gapMinutes = (Date.parse(updated.next_run_at) - Date.parse(updated.last_run_at)) / 60_000;
  assert.ok(gapMinutes >= 54 && gapMinutes <= 66, `expected jittered ~60m, got ${gapMinutes}m`);

  collectionRules.upsert({ id: rule.id, sourceId: webSource.id, name: 'AI', kind: 'keyword', value: 'AI', intervalMin: 0 });
  const skipped = await runScheduledCollections({
    fetchImpl: async () => ({ status: 200, headers: {}, text: async () => rss('AI news') }),
  });
  assert.equal(skipped.results.length, 0);
});

test('429 失败按 30 分钟退避', async () => {
  const arxivSource = collectionSources.upsert({
    platform: 'arxiv',
    name: '调度 429',
    url: 'https://export.arxiv.org/api/query?search_query=all:test&max_results=1',
    config: {},
  });
  const rule = collectionRules.upsert({ sourceId: arxivSource.id, name: 'Rate', kind: 'full', value: '', intervalMin: 5 });
  await runScheduledCollections({
    fetchImpl: async () => ({ status: 429, headers: {}, text: async () => '' }),
  });
  const updated = collectionRules.get(rule.id);
  const minutes = (Date.parse(updated.next_run_at) - Date.parse(updated.last_run_at)) / 60000;
  assert.ok(minutes >= 29 && minutes <= 31, `expected ~30m backoff, got ${minutes}m`);
});
