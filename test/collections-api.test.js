// 采集 API 回归测试：来源、认证、刷新和平台过滤。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmonitor-api-'));
process.env.DATA_DIR = dataDir;
process.env.PORT = '0';

const { collectionItems } = await import('../src/db.js');

async function boot() {
  const { startServer } = await import('../src/server.js');
  const server = startServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function json(method, body) {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

test('采集 API 支持来源、认证、刷新与平台过滤', async (t) => {
  const { server, base } = await boot();
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  let response = await fetch(`${base}/api/collections/adapters`);
  assert.equal(response.status, 200);
  const adapters = await response.json();
  assert.ok(adapters.items.some((item) => item.id === 'arxiv'));

  response = await fetch(`${base}/api/collections/sources`, json('POST', {
    platform: 'arxiv',
    name: 'API 测试源',
    url: 'https://export.arxiv.org/api/query?search_query=all:test&max_results=1',
  }));
  assert.equal(response.status, 200);
  const source = await response.json();
  assert.equal(source.platform, 'arxiv');
  assert.equal(source.auth.configured, false);

  response = await fetch(`${base}/api/collections/sources/${source.id}/auth`, json('PUT', {
    type: 'bearer', token: 'secret-value-123',
  }));
  assert.equal(response.status, 200);
  const authStatus = await response.json();
  assert.equal(authStatus.type, 'bearer');
  assert.equal(authStatus.configured, true);
  assert.ok(!JSON.stringify(authStatus).includes('secret-value-123'), '认证密钥不能出现在响应中');

  response = await fetch(`${base}/api/collections/sources`);
  assert.equal(response.status, 200);
  const listed = await response.json();
  assert.ok(!JSON.stringify(listed).includes('secret-value-123'));

  response = await fetch(`${base}/api/collections/sources/${source.id}/refresh`, { method: 'POST' });
  assert.equal(response.status, 200);
  const refreshed = await response.json();
  assert.equal(refreshed.source.id, source.id);
  assert.equal(refreshed.auth.configured, true);
  assert.ok(refreshed.refreshedAt);

  response = await fetch(`${base}/api/collections/sources/999999/refresh`, { method: 'POST' });
  assert.equal(response.status, 404);

  response = await fetch(`${base}/api/collections/platforms`);
  assert.equal(response.status, 200);
  const platforms = await response.json();
  assert.ok(platforms.items.some((item) => item.id === 'arxiv' && item.sourceCount >= 1));

  response = await fetch(`${base}/api/collections/rules`, json('POST', {
    sourceId: source.id, name: 'arXiv 测试规则', kind: 'keyword', value: 'agent', intervalMin: 60,
  }));
  assert.equal(response.status, 200);
  const rule = await response.json();
  assert.equal(rule.name, 'arXiv 测试规则');
  assert.equal(rule.interval_min, 60);
  assert.ok(rule.next_run_at);

  response = await fetch(`${base}/api/collections/rules?platform=arxiv`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).items.length, 1);

  response = await fetch(`${base}/api/collections/rules/${rule.id}`, json('PATCH', { intervalMin: 0, name: '手动规则' }));
  assert.equal(response.status, 200);
  const paused = await response.json();
  assert.equal(paused.interval_min, 0);
  assert.equal(paused.next_run_at, null);
  assert.equal(paused.name, '手动规则');

  response = await fetch(`${base}/api/collections/runs/stats?platform=arxiv`);
  assert.equal(response.status, 200);
  const runStats = await response.json();
  assert.ok(typeof runStats.total === 'number');

  for (let index = 0; index < 3; index++) {
    collectionItems.upsert({
      platform: 'arxiv', external_id: `api-${index}`, title: `API item ${index}`,
      content: 'body', canonical_url: `https://arxiv.org/abs/${index}`,
      links: [`https://arxiv.org/abs/${index}`],
      metadata: { category_id: 11, tags: index === 0 ? ['AI'] : ['other'] },
    });
  }
  response = await fetch(`${base}/api/collections/items?platform=arxiv&limit=2`);
  const page = await response.json();
  assert.equal(page.items.length, 2);
  assert.equal(page.total, 3);
  response = await fetch(`${base}/api/collections/items?platform=arxiv&tag=AI`);
  const tagged = await response.json();
  assert.equal(tagged.total, 1);
  response = await fetch(`${base}/api/collections/items?platform=arxiv&categoryId=11`);
  assert.equal((await response.json()).total, 3);

  response = await fetch(`${base}/api/collections/runs?platform=arxiv`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).items, []);

  response = await fetch(`${base}/api/collections/runs`, json('POST', { mode: 'emergency', sourceId: source.id }));
  assert.equal(response.status, 202);
  const trigger = await response.json();
  assert.equal(trigger.jobs.length, 1);
  const jobId = trigger.jobs[0].id;
  assert.equal(trigger.jobs[0].status, 'queued');

  response = await fetch(`${base}/api/collections/jobs?platform=arxiv&status=queued`);
  assert.equal(response.status, 200);
  const jobs = await response.json();
  assert.equal(jobs.total, 1);
  assert.equal(jobs.items[0].id, jobId);

  response = await fetch(`${base}/api/collections/jobs/${jobId}/cancel`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).job.status, 'canceled');

  response = await fetch(`${base}/api/collections/jobs/${jobId}/retry`, { method: 'POST' });
  assert.equal(response.status, 200);
  const retried = await response.json();
  assert.equal(retried.job.status, 'queued');
  assert.equal(retried.job.attempts, 0);

  response = await fetch(`${base}/api/collections/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.ok(health.queue);
  assert.ok(Array.isArray(health.platforms));

  response = await fetch(`${base}/api/collections/sources/${source.id}`, json('PATCH', {
    url: 'https://export.arxiv.org/api/query?search_query=all:updated&max_results=2',
  }));
  assert.equal(response.status, 200);
  assert.match((await response.json()).url, /updated/);
});
