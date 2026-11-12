// 采集配置 YAML 导出/导入。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmonitor-config-'));
process.env.DATA_DIR = dataDir;

const { collectionSources, collectionRules } = await import('../src/db.js');
const config = await import('../src/collector-config.js');

const source = collectionSources.upsert({ platform: 'web', name: '配置测试源', url: '', config: { maxItems: 10 } });
const rule = collectionRules.upsert({ sourceId: source.id, name: '配置规则', kind: 'keyword', value: 'config', intervalMin: 30 });

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('导出后可从 YAML 恢复来源和规则', () => {
  const exported = config.exportCollectorConfig();
  assert.equal(exported.sources, 1);
  assert.equal(exported.rules, 1);
  assert.ok(fs.existsSync(config.COLLECTOR_SOURCES_DIR));
  assert.ok(fs.existsSync(config.COLLECTOR_RULES_DIR));

  collectionRules.upsert({ id: rule.id, sourceId: source.id, name: '被改名', kind: 'keyword', value: 'config', intervalMin: 0 });
  const imported = config.importCollectorConfig();
  assert.equal(imported.sources, 1);
  assert.equal(imported.rules, 1);
  const restored = collectionRules.get(rule.id);
  assert.equal(restored.name, '配置规则');
  assert.equal(restored.interval_min, 30);
});

test('导出/导入保留 options、match 和通知开关', () => {
  const rule2 = collectionRules.upsert({
    sourceId: source.id, name: '带匹配规则', kind: 'keyword', value: 'matched', intervalMin: 0,
    options: { maxItems: 5 }, match: { includeAny: ['AI'], excludeAny: ['招聘'] },
    notify: false, notifyUpdates: true,
  });
  config.exportCollectorConfig();
  config.importCollectorConfig();
  const restored = collectionRules.get(rule2.id);
  assert.deepEqual(restored.options, { maxItems: 5 });
  assert.deepEqual(restored.match, { includeAny: ['AI'], excludeAny: ['招聘'] });
  assert.equal(restored.notify, false);
  assert.equal(restored.notify_updates, true);
});

test('导入拒绝包含认证字段的 config', () => {
  fs.writeFileSync(path.join(config.COLLECTOR_SOURCES_DIR, 'source-bad.yaml'), `platform: "web"
name: "坏来源"
url: ""
enabled: true
config: {"token":"secret"}
`);
  assert.throws(() => config.importCollectorConfig(), /config 中不能包含认证字段/);
});
