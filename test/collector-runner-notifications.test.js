// Runner 集成：通知钩子、过滤计数和游标。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmonitor-runner-'));
process.env.DATA_DIR = dataDir;
process.env.WEB_DEFAULT_KEYWORDS = '';
process.env.HF_SYNC_ENABLED = 'false';
process.env.COLLECTOR_POLL_INTERVAL_MIN = '1';

const db = await import('../src/db.js');
const { registerAdapter } = await import('../src/collectors/registry.js');
const engine = await import('../src/collection-engine.js');

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function response(body, status = 200, headers = {}) {
  return { status, headers, text: async () => JSON.stringify(body) };
}


test('GitHub 分支提交通过 Runner 生成 commit 通知', async () => {
  db.run('DELETE FROM collection_notifications');
  db.run('DELETE FROM collection_items');
  const source = db.collectionSources.upsert({ platform: 'github', name: 'gh runner', url: 'https://github.com/acme/repo' });
  db.collectionRules.upsert({
    sourceId: source.id, name: 'branch', kind: 'repo', value: 'acme/repo', intervalMin: 0,
    options: { events: ['branches'], branches: ['main'], includeDefaultBranch: false, includeCodeChanges: true },
    notify: true, notifyUpdates: false,
  });
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/repos/acme/repo/commits') {
      return response([{
        sha: 'r1', html_url: 'https://github.com/acme/repo/commit/r1',
        commit: { message: 'feat: runner commit', author: { date: '2026-10-18T00:00:00Z' } },
        author: { login: 'ada' }, parents: [{ sha: 'p1' }],
      }]);
    }
    if (parsed.pathname === '/repos/acme/repo/commits/r1') {
      return response({ files: [{ filename: 'src/a.js', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ +1' }] });
    }
    return response([], 404);
  };
  const result = await engine.runCollections({ mode: 'manual', sourceId: source.id, fetchImpl });
  assert.equal(result.results[0].added, 1);
  const items = db.collectionItems.list({ platform: 'github', limit: 10 });
  assert.equal(items.length, 1);
  assert.equal(items[0].metadata.codeChanges.files[0].filename, 'src/a.js');
  const notifications = db.collectionNotifications.list({ platform: 'github', limit: 10 });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].event, 'commit');
  assert.match(notifications[0].title, /acme\/repo main:/);
  assert.match(notifications[0].body, /变更文件/);
});

test('Runner 生成通知、统计过滤并保留游标', async () => {
  db.run('DELETE FROM collection_notifications');
  db.run('DELETE FROM collection_items');
  let updateKey = 'v1';
  const cursorSeen = [];
  registerAdapter({
    id: 'notifrunner', version: 2, label: 'Notif Runner',
    capabilities: ['full'], auth: { types: ['none'] },
    rateLimit: { requests: 100, perMs: 1000, burst: 20 },
    async collect(ctx) {
      cursorSeen.push(ctx.cursor.get());
      const items = [
        {
          platform: 'notifrunner', external_id: 'n1', title: 'Agent one', content: 'agent body',
          canonical_url: 'https://example.com/n1', links: ['https://example.com/n1'],
          metadata: { notification: { event: 'release', title: 'Release one', updateKey } },
        },
        {
          platform: 'notifrunner', external_id: 'n2', title: '招聘信息', content: '招聘',
          canonical_url: 'https://example.com/n2', links: ['https://example.com/n2'],
        },
      ];
      ctx.cursor.set({ last: updateKey });
      return { items, meta: { provider: 'notifrunner' } };
    },
  });
  const source = db.collectionSources.upsert({ platform: 'notifrunner', name: 'notify runner', url: 'https://example.com' });
  const rule = db.collectionRules.upsert({
    sourceId: source.id, name: 'notify', kind: 'full', value: '', intervalMin: 0,
    notify: true, notifyUpdates: true, match: { excludeAny: ['招聘'] },
  });

  let result = await engine.runCollections({ mode: 'manual', sourceId: source.id });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].collected, 2);
  assert.equal(result.results[0].added, 1);
  assert.equal(result.results[0].filtered, 1);
  assert.equal(db.collectionNotifications.count({ platform: 'notifrunner' }), 1);
  const firstRun = db.collectionRuns.list({ sourceId: source.id, limit: 1 })[0];
  assert.equal(firstRun.filtered_count, 1);
  assert.equal(firstRun.detail.filtered, 1);
  assert.equal(db.collectionCursors.get(source.id, 'notifrunner').last, 'v1');

  updateKey = 'v2';
  result = await engine.runCollections({ mode: 'manual', sourceId: source.id });
  assert.equal(result.results[0].updated, 1);
  assert.equal(db.collectionNotifications.count({ platform: 'notifrunner' }), 2);
  assert.equal(cursorSeen.at(-1)?.last, 'v1', '第二次运行从已保存游标继续');

  db.collectionRules.upsert({
    id: rule.id, sourceId: source.id, name: 'notify', kind: 'full', value: '', intervalMin: 0,
    notify: true, notifyUpdates: true, match: { excludeAny: ['招聘'] },
  });
  updateKey = 'v3';
  await engine.runCollections({ mode: 'manual', sourceId: source.id });
  assert.equal(db.collectionNotifications.count({ platform: 'notifrunner' }), 3);
});
