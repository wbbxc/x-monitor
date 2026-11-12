// 采集配置导入/导出：SQLite 为运行态，data/collector/ 是 YAML 镜像。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { collectionSources, collectionRules } from './db.js';
import { listCollectors } from './collectors/framework.js';
import { canonicalPlatform } from './collectors/aliases.js';

function unquote(value) {
  const text = String(value ?? '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseScalar(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('[') && value.endsWith(']')) || (value.startsWith('{') && value.endsWith('}'))) {
    try { return JSON.parse(value); } catch {}
    if (value.startsWith('[')) {
      return value.slice(1, -1).split(',').map((item) => unquote(item.trim())).filter(Boolean);
    }
  }
  return unquote(value);
}

export function parseYaml(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = parseScalar(match[2]);
  }
  return out;
}

function yamlValue(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value && typeof value === 'object') return JSON.stringify(value);
  return JSON.stringify(String(value ?? ''));
}

export function stringifyYaml(object, header = '') {
  const lines = header ? [`# ${header}`, ''] : [];
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null) continue;
    lines.push(`${key}: ${yamlValue(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

export const COLLECTOR_CONFIG_DIR = path.join(config.dataDir, 'collector');
export const COLLECTOR_SOURCES_DIR = path.join(COLLECTOR_CONFIG_DIR, 'sources');
export const COLLECTOR_RULES_DIR = path.join(COLLECTOR_CONFIG_DIR, 'rules');
export const COLLECTOR_CATEGORIES_FILE = path.join(COLLECTOR_CONFIG_DIR, 'categories.json');

function categoryCacheFile(platform = 'linux.do') {
  const safe = String(platform || 'linux.do').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return path.join(COLLECTOR_CONFIG_DIR, `categories-${safe}.json`);
}

function ensureDirs() {
  fs.mkdirSync(COLLECTOR_SOURCES_DIR, { recursive: true });
  fs.mkdirSync(COLLECTOR_RULES_DIR, { recursive: true });
}

function containsSecret(value) {
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (/(token|password|passwd|cookie|secret|api[_-]?key|authorization)/i.test(key)) return true;
    if (child && typeof child === 'object' && containsSecret(child)) return true;
  }
  return false;
}

export function exportCollectorConfig() {
  const sources = collectionSources.list();
  const rules = collectionRules.list();
  const tmp = `${COLLECTOR_CONFIG_DIR}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'sources'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'rules'), { recursive: true });

  for (const source of sources) {
    const body = {
      platform: source.platform,
      name: source.name,
      url: source.url,
      enabled: source.enabled,
      config: source.config || {},
    };
    fs.writeFileSync(path.join(tmp, 'sources', `source-${source.id}.yaml`), stringifyYaml(body, `采集源：${source.name}`), 'utf8');
  }
  for (const rule of rules) {
    const body = {
      platform: rule.platform,
      source: rule.source_name,
      name: rule.name,
      kind: rule.kind,
      value: rule.value,
      options: rule.options || {},
      match: rule.match || {},
      notify: rule.notify !== false,
      notifyUpdates: !!rule.notify_updates,
      intervalMin: rule.interval_min,
      enabled: rule.enabled,
      lastRunAt: rule.last_run_at || null,
      nextRunAt: rule.next_run_at || null,
    };
    fs.writeFileSync(path.join(tmp, 'rules', `rule-${rule.id}.yaml`), stringifyYaml(body, `采集规则：${rule.name || rule.value || rule.kind}`), 'utf8');
  }

  fs.rmSync(COLLECTOR_CONFIG_DIR, { recursive: true, force: true });
  fs.renameSync(tmp, COLLECTOR_CONFIG_DIR);
  return { dir: COLLECTOR_CONFIG_DIR, sources: sources.length, rules: rules.length };
}

function readYamlDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, value: parseYaml(fs.readFileSync(path.join(dir, file), 'utf8')) }));
}

export function importCollectorConfig() {
  const platforms = new Set(listCollectors().map((item) => item.id));
  const sourceFiles = readYamlDir(COLLECTOR_SOURCES_DIR);
  const ruleFiles = readYamlDir(COLLECTOR_RULES_DIR);
  for (const entry of sourceFiles) {
    const platform = canonicalPlatform(entry.value.platform);
    if (!platform || !platforms.has(platform)) {
      throw new Error(`${entry.file}: 不支持的平台 ${entry.value.platform || '(空)'}`);
    }
    if (containsSecret(entry.value.config)) throw new Error(`${entry.file}: config 中不能包含认证字段`);
  }
  for (const entry of ruleFiles) {
    const platform = canonicalPlatform(entry.value.platform);
    if (!platform || !platforms.has(platform)) {
      throw new Error(`${entry.file}: 不支持的平台 ${entry.value.platform || '(空)'}`);
    }
  }

  let sourceCount = 0;
  let ruleCount = 0;
  for (const entry of sourceFiles) {
    collectionSources.upsert({
      platform: canonicalPlatform(entry.value.platform),
      name: String(entry.value.name || entry.value.platform),
      url: String(entry.value.url || ''),
      config: entry.value.config && typeof entry.value.config === 'object' ? entry.value.config : {},
      enabled: entry.value.enabled !== false,
    });
    sourceCount++;
  }
  for (const entry of ruleFiles) {
    const platform = canonicalPlatform(entry.value.platform);
    const sources = collectionSources.list({}).filter((source) => source.platform === platform);
    const source = sources.find((item) => item.name === String(entry.value.source || '')) || sources[0];
    if (!source) throw new Error(`${entry.file}: 找不到平台 ${platform} 的采集源`);
    const rule = collectionRules.upsert({
      sourceId: source.id,
      name: String(entry.value.name || ''),
      kind: String(entry.value.kind || 'keyword'),
      value: String(entry.value.value || ''),
      options: entry.value.options && typeof entry.value.options === 'object' ? entry.value.options : {},
      match: entry.value.match && typeof entry.value.match === 'object' ? entry.value.match : {},
      notify: entry.value.notify !== false,
      notifyUpdates: entry.value.notifyUpdates === true,
      intervalMin: Number(entry.value.intervalMin) || 0,
      enabled: entry.value.enabled !== false,
    });
    collectionRules.setSchedule(rule.id, {
      lastRunAt: entry.value.lastRunAt || null,
      nextRunAt: entry.value.nextRunAt || null,
    });
    ruleCount++;
  }
  return { dir: COLLECTOR_CONFIG_DIR, sources: sourceCount, rules: ruleCount };
}

export function readCategoryCache(platform = 'linux.do') {
  const candidates = [categoryCacheFile(platform)];
  // 兼容旧版单文件缓存。
  if (platform === 'linux.do') candidates.push(COLLECTOR_CATEGORIES_FILE);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(data.items)) continue;
      return { items: data.items, fetchedAt: data.fetchedAt || null, platform };
    } catch {}
  }
  return null;
}

export function writeCategoryCache(items, platform = 'linux.do') {
  ensureDirs();
  const payload = { fetchedAt: new Date().toISOString(), items, platform };
  fs.writeFileSync(categoryCacheFile(platform), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}
