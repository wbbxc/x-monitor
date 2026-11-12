// 一次性把旧版 linux.do YAML 规则/设置迁移到 SQLite。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import db, { settings, collectionSources, collectionRules } from './db.js';
import { parseYaml } from './collector-config.js';

const LEGACY_DIR = path.join(config.dataDir, 'linuxdo');

function readLegacySettings() {
  const file = path.join(LEGACY_DIR, 'settings.yaml');
  if (!fs.existsSync(file)) return null;
  try { return parseYaml(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readLegacyRules() {
  const dir = path.join(LEGACY_DIR, 'rules');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.yaml'))
    .sort()
    .map((file) => {
      const value = parseYaml(fs.readFileSync(path.join(dir, file), 'utf8'));
      return {
        slug: file.slice(0, -5),
        name: String(value.name || file.slice(0, -5)),
        kind: String(value.kind || 'keyword'),
        value: String(value.value || ''),
        intervalMin: Math.max(0, Number(value.intervalMin) || 0),
        enabled: value.enabled !== false,
        lastRunAt: value.lastRunAt || null,
        nextRunAt: value.nextRunAt || null,
      };
    });
}

export const MIGRATION_KEY = 'collector_yaml_migrated_v1';

export function migrateLinuxdoYaml() {
  if (settings.get(MIGRATION_KEY)) return { skipped: true, migrated: 0 };
  const stored = readLegacySettings();
  const rules = readLegacyRules();
  if (!stored && !rules.length) {
    settings.set(MIGRATION_KEY, new Date().toISOString());
    return { skipped: true, migrated: 0 };
  }

  const current = collectionSources.list().find((source) => source.platform === 'linux.do');
  const baseConfig = current?.config || {};
  const sourceConfig = {
    ...baseConfig,
    maxItems: stored?.maxItems ?? baseConfig.maxItems ?? 50,
    fetchDetails: stored?.fetchDetails ?? baseConfig.fetchDetails ?? false,
    keywordFallback: stored?.keywordFallback ?? baseConfig.keywordFallback ?? true,
    publicFeeds: Array.isArray(stored?.publicFeeds) ? stored.publicFeeds : (baseConfig.publicFeeds || []),
  };

  db.exec('BEGIN');
  try {
    const source = collectionSources.upsert({
      id: current?.id,
      platform: 'linux.do',
      name: current?.name || 'linux.do',
      url: stored?.url || current?.url || 'https://linux.do/latest.json',
      config: sourceConfig,
      enabled: true,
    });

    let migrated = 0;
    for (const rule of rules) {
      const row = collectionRules.upsert({
        sourceId: source.id,
        name: rule.name,
        kind: rule.kind,
        value: rule.value,
        intervalMin: rule.intervalMin || 0,
        enabled: rule.enabled,
      });
      collectionRules.setSchedule(row.id, { lastRunAt: rule.lastRunAt || null, nextRunAt: rule.nextRunAt || null });
      migrated++;
    }

    if (stored?.autoLatestEnabled) {
      const existing = collectionRules.list({ sourceId: source.id }).find((rule) => rule.kind === 'full');
      const row = collectionRules.upsert({
        id: existing?.id,
        sourceId: source.id,
        name: '最新话题',
        kind: 'full',
        value: '',
        intervalMin: stored.autoLatestIntervalMin || 60,
        enabled: true,
      });
      collectionRules.setSchedule(row.id, {
        lastRunAt: stored.autoLatestLastRunAt || null,
        nextRunAt: stored.autoLatestNextRunAt || null,
      });
      migrated++;
    }

    settings.set(MIGRATION_KEY, new Date().toISOString());
    db.exec('COMMIT');
    return { skipped: false, migrated, sourceId: source.id };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
