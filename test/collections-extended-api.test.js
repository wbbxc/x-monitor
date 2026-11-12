// 扩展采集 API：链接识别、平台别名、规则匹配、通知和内容删除。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmonitor-extapi-'));
process.env.DATA_DIR = dataDir;
process.env.PORT = '0';
process.env.WEB_DEFAULT_KEYWORDS = '';
process.env.HF_SYNC_ENABLED = 'false';

const { collectionItems, collectionNotifications } = await import('../src/db.js');
const { writeCategoryCache } = await import('../src/collector-config.js');

async function boot() {
  const { startServer } = await import('../src/server.js');
  const server = startServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function json(method, body) {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

test('detect、别名、规则匹配与通知 API', async (t) => {
  const { server, base } = await boot();
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const cases = [
    ['https://x.com/karpathy', 'x', 'account'],
    ['https://github.com/openai/openai-node', 'github', 'repo'],
    ['https://hf-mirror.com/papers/2601.00001', 'huggingface', 'full'],
    ['https://macos.do/t/example/123', 'macos.do', 'full'],
    ['https://t.me/durov', 'telegram', 'channel'],
    ['https://example.com/blog/post', 'web', 'full'],
  ];
  for (const [url, platform, kind] of cases) {
    const response = await fetch(`${base}/api/collections/detect`, json('POST', { url }));
    assert.equal(response.status, 200, url);
    const result = await response.json();
    assert.equal(result.platform, platform, url);
    assert.equal(result.kind, kind, url);
  }
  let response = await fetch(`${base}/api/collections/detect`, json('POST', { url: 'javascript:alert(1)' }));
  assert.equal(response.status, 400);

  response = await fetch(`${base}/api/collections/sources`, json('POST', {
    platform: 'hf-mirror', name: '镜像源', url: 'https://hf-mirror.com',
  }));
  assert.equal(response.status, 200);
  const source = await response.json();
  assert.equal(source.platform, 'huggingface');
  assert.equal(source.config.baseUrl, 'https://hf-mirror.com');

  response = await fetch(`${base}/api/collections/rules`, json('POST', {
    sourceId: source.id, name: 'agent', kind: 'keyword', value: 'agent', intervalMin: 0,
    match: { includeAny: ['agent'], excludeAny: ['招聘'], regex: ['\\bagent\\b'] },
    options: { maxItems: 10 }, notify: true, notifyUpdates: true,
  }));
  assert.equal(response.status, 200);
  const rule = await response.json();
  assert.deepEqual(rule.match.includeAny, ['agent']);
  assert.deepEqual(rule.options.maxItems, 10);
  assert.equal(rule.notify, true);
  assert.equal(rule.notify_updates, true);

  response = await fetch(`${base}/api/collections/sources`, json('POST', {
    platform: 'github', name: 'GitHub 分支', url: 'https://github.com/acme/repo',
  }));
  assert.equal(response.status, 200);
  const ghSource = await response.json();
  response = await fetch(`${base}/api/collections/rules`, json('POST', {
    sourceId: ghSource.id, name: '分支代码', kind: 'repo', value: 'acme/repo', intervalMin: 0,
    options: { events: ['releases', 'branches'], branches: ['main', 'dev'], includeCodeChanges: true, includeMergeCommits: false },
    notify: true, notifyUpdates: true,
  }));
  assert.equal(response.status, 200);
  const ghRule = await response.json();
  assert.deepEqual(ghRule.options.events, ['releases', 'branches']);
  assert.deepEqual(ghRule.options.branches, ['main', 'dev']);
  assert.equal(ghRule.options.includeCodeChanges, true);
  response = await fetch(`${base}/api/collections/rules`, json('POST', {
    sourceId: ghSource.id, kind: 'repo', value: 'acme/repo', options: { events: ['branches'], branches: ['bad branch'] },
  }));
  assert.equal(response.status, 400);

  response = await fetch(`${base}/api/collections/rules`, json('POST', {
    sourceId: source.id, kind: 'keyword', value: 'bad', match: { regex: ['[unclosed'] },
  }));
  assert.equal(response.status, 400);
  const bad = await response.json();
  assert.match(bad.error, /正则/);

  response = await fetch(`${base}/api/collections/rules`, json('POST', {
    sourceId: source.id, kind: 'keyword', value: 'bad2', match: { unknown: 1 },
  }));
  assert.equal(response.status, 400);

  const saved = collectionItems.upsert({
    platform: 'huggingface', external_id: '2601.00001', title: 'Agent paper',
    content: 'agent body', canonical_url: 'https://huggingface.co/papers/2601.00001',
    links: ['https://huggingface.co/papers/2601.00001'],
  }, { sourceId: source.id, ruleId: rule.id });
  const notification = collectionNotifications.create({
    dedupeKey: `test:${saved.id}:${rule.id}`,
    itemId: saved.id, sourceId: source.id, ruleId: rule.id,
    platform: 'huggingface', sourceName: source.name, ruleName: rule.name,
    event: 'paper', title: 'Agent paper', body: 'agent body',
  });
  assert.ok(notification.id);

  response = await fetch(`${base}/api/collections/notifications/unread-count`);
  const unread = await response.json();
  assert.equal(unread.total, 1);
  assert.deepEqual(unread.byPlatform, [{ platform: 'huggingface', count: 1 }]);

  response = await fetch(`${base}/api/collections/notifications?platform=huggingface&unread=true`);
  const list = await response.json();
  assert.equal(list.total, 1);
  assert.equal(list.items[0].title, 'Agent paper');
  assert.equal(list.items[0].unread, true);

  response = await fetch(`${base}/api/collections/notifications/${notification.id}/read`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).notification.unread, false);
  response = await fetch(`${base}/api/collections/notifications/${notification.id}/read`, { method: 'POST' });
  assert.equal(response.status, 200, '重复标记幂等');
  response = await fetch(`${base}/api/collections/notifications/999999/read`, { method: 'POST' });
  assert.equal(response.status, 404);

  writeCategoryCache([{ id: 7, name: 'macOS', slug: 'macos' }], 'macos.do');
  response = await fetch(`${base}/api/collections/categories?platform=macos.do`);
  assert.equal(response.status, 200);
  const categories = await response.json();
  assert.equal(categories.cached, true);
  assert.equal(categories.items[0].name, 'macOS');
  assert.equal(categories.platform, 'macos.do');

  response = await fetch(`${base}/api/collections/notifications/read-all`, json('POST', {}));
  assert.equal(response.status, 200);
  assert.equal((await (await fetch(`${base}/api/collections/notifications/unread-count`)).json()).total, 0);

  response = await fetch(`${base}/api/collections/items/${saved.id}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal(collectionItems.get(saved.id), null);
  assert.equal(collectionNotifications.get(notification.id), null, '删除内容级联删除通知');
});
