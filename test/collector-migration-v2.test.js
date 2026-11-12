// 迁移：旧库加列/建通知表，首次升级关闭存量规则通知，重启不回退用户选择。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmonitor-migrate-'));
process.env.DATA_DIR = dataDir;
process.env.WEB_DEFAULT_KEYWORDS = '';
process.env.HF_SYNC_ENABLED = 'false';

const dbPath = path.join(dataDir, 'xmonitor.db');
const old = new DatabaseSync(dbPath);
old.exec(`
CREATE TABLE collection_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT DEFAULT '',
  config_json TEXT DEFAULT '{}',
  enabled INTEGER DEFAULT 1,
  last_collected_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(platform, name, url)
);
CREATE TABLE collection_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'keyword',
  value TEXT DEFAULT '',
  interval_min INTEGER NOT NULL DEFAULT 360,
  enabled INTEGER DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  name TEXT NOT NULL DEFAULT '',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  UNIQUE(source_id, kind, value)
);
CREATE TABLE collection_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL DEFAULT 'scheduled',
  source_id INTEGER,
  rule_id INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT,
  finished_at TEXT,
  collected_count INTEGER DEFAULT 0,
  new_count INTEGER DEFAULT 0,
  updated_count INTEGER DEFAULT 0,
  incomplete_count INTEGER DEFAULT 0,
  error TEXT DEFAULT '',
  detail_json TEXT DEFAULT '{}'
);
INSERT INTO collection_sources (id, platform, name, url, enabled) VALUES (1, 'web', '旧来源', 'https://example.com', 1);
INSERT INTO collection_rules (id, source_id, kind, value, interval_min, enabled, name) VALUES (1, 1, 'keyword', 'AI', 60, 1, '旧规则');
`);
old.close();

const db = await import('../src/db.js');

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('旧库迁移新增列和通知表，存量规则通知默认关闭', () => {
  const ruleColumns = db.all('PRAGMA table_info(collection_rules)').map((row) => row.name);
  for (const column of ['options_json', 'match_json', 'notify', 'notify_updates']) {
    assert.ok(ruleColumns.includes(column), column);
  }
  const runColumns = db.all('PRAGMA table_info(collection_runs)').map((row) => row.name);
  assert.ok(runColumns.includes('filtered_count'));
  const notificationTable = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='collection_notifications'");
  assert.ok(notificationTable);
  const rule = db.collectionRules.get(1);
  assert.equal(rule.notify, false, '升级前存量规则通知关闭');
  assert.deepEqual(rule.match, {});
  assert.deepEqual(rule.options, {});
  const versions = db.all('SELECT version FROM schema_migrations ORDER BY version').map((row) => row.version);
  assert.deepEqual(versions, [1, 2]);
});

test('重启迁移幂等，不会再次关闭用户已开启的通知', () => {
  db.collectionRules.upsert({ id: 1, sourceId: 1, name: '旧规则', kind: 'keyword', value: 'AI', intervalMin: 60, notify: true });
  const script = `
    const db = await import('./src/db.js');
    const rule = db.collectionRules.get(1);
    console.log(JSON.stringify({ notify: rule.notify, versions: db.all('SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version) }));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve('.'),
    env: { ...process.env, DATA_DIR: dataDir, WEB_DEFAULT_KEYWORDS: '', HF_SYNC_ENABLED: 'false' },
    encoding: 'utf8',
  }).trim().split(/\r?\n/).pop();
  const result = JSON.parse(output);
  assert.equal(result.notify, true);
  assert.deepEqual(result.versions, [1, 2]);
});
