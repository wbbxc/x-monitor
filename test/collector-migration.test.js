// 旧版 linux.do YAML → SQLite 一次性迁移。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmonitor-migrate-'));
process.env.DATA_DIR = dataDir;

const legacy = path.join(dataDir, 'linuxdo');
fs.mkdirSync(path.join(legacy, 'rules'), { recursive: true });
fs.writeFileSync(path.join(legacy, 'settings.yaml'), `url: "https://linux.do/latest.json"
maxItems: 30
fetchDetails: true
keywordFallback: true
publicFeeds: []
autoLatestEnabled: true
autoLatestIntervalMin: 30
autoLatestLastRunAt: "2026-10-18T10:00:00.000Z"
autoLatestNextRunAt: "2026-10-18T10:30:00.000Z"
`);
fs.writeFileSync(path.join(legacy, 'rules', 'ai.yaml'), `name: "AI 话题"
kind: "keyword"
value: "AI"
enabled: true
intervalMin: 15
lastRunAt: "2026-10-18T09:00:00.000Z"
nextRunAt: "2026-10-18T09:15:00.000Z"
`);

const dbMod = await import('../src/db.js');
const { collectionSources, collectionRules, settings } = dbMod;
const { migrateLinuxdoYaml, MIGRATION_KEY } = await import('../src/collector-migrate.js');

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('迁移 YAML 设置和规则到 SQLite，重复执行幂等', () => {
  const first = migrateLinuxdoYaml();
  assert.equal(first.skipped, false);
  assert.equal(first.migrated, 2);

  const source = collectionSources.list().find((item) => item.platform === 'linux.do');
  assert.ok(source);
  assert.equal(source.config.maxItems, 30);
  assert.equal(source.config.fetchDetails, true);

  const rules = collectionRules.list({ platform: 'linux.do' });
  const keyword = rules.find((rule) => rule.kind === 'keyword');
  assert.equal(keyword.name, 'AI 话题');
  assert.equal(keyword.value, 'AI');
  assert.equal(keyword.interval_min, 15);
  assert.equal(keyword.last_run_at, '2026-10-18T09:00:00.000Z');
  assert.equal(keyword.next_run_at, '2026-10-18T09:15:00.000Z');

  const latest = rules.find((rule) => rule.kind === 'full');
  assert.equal(latest.name, '最新话题');
  assert.equal(latest.interval_min, 30);
  assert.equal(latest.next_run_at, '2026-10-18T10:30:00.000Z');

  const second = migrateLinuxdoYaml();
  assert.equal(second.skipped, true);
  assert.ok(settings.get(MIGRATION_KEY));
});
