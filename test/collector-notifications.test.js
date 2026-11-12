// 站内通知：创建、去重、更新、已读和保留策略。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmonitor-notif-'));
process.env.DATA_DIR = dataDir;
process.env.WEB_DEFAULT_KEYWORDS = '';
process.env.HF_SYNC_ENABLED = 'false';

const db = await import('../src/db.js');
const { createIngestor } = await import('../src/collectors/ingest.js');
const { createNotificationHook } = await import('../src/collectors/notifications.js');
const { compileMatcher } = await import('../src/collectors/match.js');

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function reset() {
  db.run('DELETE FROM collection_notifications');
  db.run('DELETE FROM collection_items');
}

function setup({ notify = true, notifyUpdates = false, match = {} } = {}) {
  const source = db.collectionSources.upsert({ platform: 'web', name: `notif-${Math.random()}`, url: 'https://example.com/feed' });
  const rule = db.collectionRules.upsert({
    sourceId: source.id, name: 'notify rule', kind: 'full', value: '', intervalMin: 0,
    notify, notifyUpdates, match,
  });
  const matcher = compileMatcher({ match });
  const ingestor = createIngestor({
    sourceId: source.id, ruleId: rule.id, adapterId: 'web',
    matches: matcher.predicate,
    onItemSaved: createNotificationHook({ source, rule }),
  });
  return { source, rule, ingestor };
}

function item(id, extra = {}) {
  return {
    platform: 'web',
    external_id: id,
    canonical_url: `https://example.com/${id}`,
    title: `Item ${id}`,
    content: 'body',
    summary: 'summary',
    links: [`https://example.com/${id}`],
    raw_json: { id },
    ...extra,
  };
}

test('新内容通知、重复采集不重复、关闭通知不生成', () => {
  reset();
  const a = setup({ notify: true });
  a.ingestor.ingestPage([item('a1')]);
  assert.equal(db.collectionNotifications.count(), 1);
  const first = db.collectionNotifications.list()[0];
  assert.equal(first.platform, 'web');
  assert.equal(first.title, 'Item a1');
  assert.equal(first.unread, true);

  a.ingestor.ingestPage([item('a1')]);
  assert.equal(db.collectionNotifications.count(), 1, '重复采集不重复通知');

  const b = setup({ notify: false });
  b.ingestor.ingestPage([item('b1')]);
  assert.equal(db.collectionNotifications.count(), 1, '关闭通知不生成');
});

test('更新通知受 notify_updates 控制，同一更新键幂等', () => {
  reset();
  const a = setup({ notify: true, notifyUpdates: true });
  const first = item('u1', { metadata: { notification: { event: 'issue', updateKey: 'open:1' } } });
  a.ingestor.ingestPage([first]);
  assert.equal(db.collectionNotifications.count({ platform: 'web' }), 1);
  const second = item('u1', { title: 'Item u1 changed', metadata: { notification: { event: 'issue', updateKey: 'closed:2' } } });
  a.ingestor.ingestPage([second]);
  assert.equal(db.collectionNotifications.count({ platform: 'web' }), 2);
  a.ingestor.ingestPage([second]);
  assert.equal(db.collectionNotifications.count({ platform: 'web' }), 2, '同一 updateKey 不重复');

  const b = setup({ notify: true, notifyUpdates: false });
  b.ingestor.ingestPage([item('u2', { metadata: { notification: { event: 'issue', updateKey: 'open:1' } } })]);
  b.ingestor.ingestPage([item('u2', { metadata: { notification: { event: 'issue', updateKey: 'closed:2' } } })]);
  assert.equal(db.collectionNotifications.count({ platform: 'web' }), 3, '默认不生成更新通知');
});

test('匹配过滤的内容不入库也不通知', () => {
  reset();
  const a = setup({ notify: true, match: { excludeAny: ['招聘'] } });
  const beforeItems = db.collectionItems.count();
  const beforeNotifications = db.collectionNotifications.count();
  const counts = a.ingestor.ingestPage([
    item('f1', { title: 'AI 招聘', content: 'AI 招聘' }),
    item('f2', { title: 'AI news', content: 'AI news' }),
  ]);
  assert.equal(counts.collected, 2);
  assert.equal(counts.filtered, 1);
  assert.equal(counts.added, 1);
  assert.equal(db.collectionItems.count(), beforeItems + 1);
  assert.equal(db.collectionNotifications.count(), beforeNotifications + 1);
});

test('未读计数、单条已读、全部已读与 404', () => {
  reset();
  const a = setup({ notify: true });
  a.ingestor.ingestPage([item('r1'), item('r2'), item('r3')]);
  const unread = db.collectionNotifications.unreadCount();
  assert.equal(unread.total, 3);
  assert.deepEqual(unread.byPlatform, [{ platform: 'web', count: 3 }]);
  const one = db.collectionNotifications.list({ unread: true, limit: 1 })[0];
  const read = db.collectionNotifications.markRead(one.id);
  assert.equal(read.unread, false);
  assert.equal(db.collectionNotifications.unreadCount().total, 2);
  assert.equal(db.collectionNotifications.markRead(one.id).unread, false, '重复标记幂等');
  assert.equal(db.collectionNotifications.markRead(999999), null);
  const all = db.collectionNotifications.markAllRead({ platform: 'web' });
  assert.ok(all.updated >= 2);
  assert.equal(db.collectionNotifications.unreadCount().total, 0);
});

test('删除内容级联删除通知，过期清理不影响未读', () => {
  reset();
  const a = setup({ notify: true });
  a.ingestor.ingestPage([item('d1'), item('d2')]);
  const notifications = db.collectionNotifications.list({ platform: 'web', limit: 10 });
  const target = notifications.find((notification) => notification.title === 'Item d1');
  const itemId = target.item_id;
  db.collectionItems.remove(itemId);
  assert.equal(db.collectionNotifications.get(target.id), null, '内容删除后通知级联删除');

  const remaining = db.collectionNotifications.list({ platform: 'web', limit: 10 });
  assert.equal(remaining.length >= 1, true);
  const readOne = remaining[0];
  db.collectionNotifications.markRead(readOne.id);
  const removed = db.collectionNotifications.cleanup({ before: new Date(Date.now() + 60_000).toISOString() });
  assert.ok(removed >= 1);
  assert.equal(db.collectionNotifications.unreadCount().total, 0);
  assert.equal(db.collectionNotifications.get(readOne.id), null);
});
