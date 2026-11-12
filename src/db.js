// SQLite 存储层（Node 内置 node:sqlite，零外部依赖）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config, DB_PATH } from './config.js';
import { encryptSecret, decryptSecret, normalizeAuth, redactAuth, readEnvironmentAuth, saveEnvironmentAuth } from './collectors/auth.js';
import { mergeCollectionItems, normalizeCollectionItem } from './collectors/normalize.js';
import { canonicalPlatform } from './collectors/aliases.js';

fs.mkdirSync(config.dataDir, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT UNIQUE NOT NULL,
  display_name TEXT DEFAULT '',
  enabled     INTEGER DEFAULT 1,
  last_tweet_id TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS tweets (
  id             TEXT PRIMARY KEY,
  account_id     INTEGER,
  author_username TEXT NOT NULL,
  author_name    TEXT DEFAULT '',
  text           TEXT NOT NULL,
  tweet_created_at TEXT,
  like_count     INTEGER DEFAULT 0,
  retweet_count  INTEGER DEFAULT 0,
  reply_count    INTEGER DEFAULT 0,
  view_count     INTEGER DEFAULT 0,
  media          TEXT,          -- JSON array
  url            TEXT,
  is_mock        INTEGER DEFAULT 0,
  status         TEXT DEFAULT 'new',   -- new | analyzed | rejected
  fetched_at     TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS materials (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id      TEXT UNIQUE,
  title         TEXT NOT NULL,
  summary       TEXT DEFAULT '',
  score         REAL DEFAULT 0,
  score_reason  TEXT DEFAULT '',
  category      TEXT DEFAULT '',
  tags          TEXT DEFAULT '[]',     -- JSON array
  suggested_types TEXT DEFAULT '[]',   -- JSON array
  analysis_raw  TEXT DEFAULT '{}',
  status        TEXT DEFAULT 'pending', -- pending | approved | rejected
  created_at    TEXT DEFAULT (datetime('now', 'localtime')),
  decided_at    TEXT
);

CREATE TABLE IF NOT EXISTS creations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id  INTEGER NOT NULL,
  content_type TEXT NOT NULL,          -- article | image | video_script
  status       TEXT DEFAULT 'queued',  -- queued | running | done | failed
  title        TEXT DEFAULT '',
  content      TEXT,                   -- JSON 内容
  error        TEXT DEFAULT '',
  created_at   TEXT DEFAULT (datetime('now', 'localtime')),
  started_at   TEXT,
  finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS run_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type   TEXT NOT NULL,            -- scrape | analyze | create | manual
  detail     TEXT DEFAULT '',
  status     TEXT DEFAULT 'ok',
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 统一采集域：与旧的 X 业务表隔离，便于后续增加平台适配器。
CREATE TABLE IF NOT EXISTS collection_sources (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  platform           TEXT NOT NULL,
  name               TEXT NOT NULL,
  url                TEXT DEFAULT '',
  config_json        TEXT DEFAULT '{}',
  enabled            INTEGER DEFAULT 1,
  last_collected_at  TEXT,
  created_at         TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at         TEXT DEFAULT (datetime('now', 'localtime')),
  UNIQUE(platform, name, url)
);

CREATE TABLE IF NOT EXISTS collection_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   INTEGER NOT NULL REFERENCES collection_sources(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'keyword',
  value       TEXT DEFAULT '',
  interval_min INTEGER NOT NULL DEFAULT 360,
  enabled     INTEGER DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  options_json TEXT NOT NULL DEFAULT '{}',
  match_json   TEXT NOT NULL DEFAULT '{}',
  notify       INTEGER NOT NULL DEFAULT 1,
  notify_updates INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at  TEXT DEFAULT (datetime('now', 'localtime')),
  UNIQUE(source_id, kind, value)
);

CREATE TABLE IF NOT EXISTS collection_auth (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER NOT NULL UNIQUE REFERENCES collection_sources(id) ON DELETE CASCADE,
  auth_type     TEXT NOT NULL DEFAULT 'none',
  secret_cipher TEXT NOT NULL,
  metadata_json TEXT DEFAULT '{}',
  created_at    TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at    TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS collection_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key        TEXT NOT NULL UNIQUE,
  platform          TEXT NOT NULL,
  platforms_json    TEXT DEFAULT '[]',
  source_id         INTEGER REFERENCES collection_sources(id) ON DELETE SET NULL,
  external_id       TEXT DEFAULT '',
  canonical_url     TEXT DEFAULT '',
  source_url        TEXT DEFAULT '',
  title             TEXT DEFAULT '',
  content           TEXT DEFAULT '',
  summary           TEXT DEFAULT '',
  author            TEXT DEFAULT '',
  published_at      TEXT,
  links_json        TEXT DEFAULT '[]',
  raw_json          TEXT DEFAULT '[]',
  metadata_json     TEXT DEFAULT '{}',
  required_complete INTEGER DEFAULT 0,
  first_seen_at     TEXT DEFAULT (datetime('now', 'localtime')),
  last_seen_at      TEXT DEFAULT (datetime('now', 'localtime')),
  created_at        TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at        TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS collection_item_sources (
  item_id     INTEGER NOT NULL REFERENCES collection_items(id) ON DELETE CASCADE,
  source_id   INTEGER NOT NULL REFERENCES collection_sources(id) ON DELETE CASCADE,
  rule_id     INTEGER REFERENCES collection_rules(id) ON DELETE SET NULL,
  first_seen_at TEXT DEFAULT (datetime('now', 'localtime')),
  last_seen_at  TEXT DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY(item_id, source_id, rule_id)
);

CREATE TABLE IF NOT EXISTS collection_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  mode           TEXT NOT NULL DEFAULT 'scheduled',
  source_id      INTEGER REFERENCES collection_sources(id) ON DELETE SET NULL,
  rule_id        INTEGER REFERENCES collection_rules(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'running',
  started_at     TEXT DEFAULT (datetime('now', 'localtime')),
  finished_at    TEXT,
  collected_count INTEGER DEFAULT 0,
  new_count      INTEGER DEFAULT 0,
  updated_count  INTEGER DEFAULT 0,
  incomplete_count INTEGER DEFAULT 0,
  filtered_count INTEGER DEFAULT 0,
  error          TEXT DEFAULT '',
  detail_json    TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_collection_rules_due ON collection_rules(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_collection_items_platform ON collection_items(platform, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_collection_items_published ON collection_items(published_at);
CREATE INDEX IF NOT EXISTS idx_collection_runs_started ON collection_runs(started_at DESC);

-- 采集内核 v2：持久化任务队列、分页游标和 429 冷却。
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key        TEXT,
  source_id         INTEGER REFERENCES collection_sources(id) ON DELETE CASCADE,
  rule_id           INTEGER REFERENCES collection_rules(id) ON DELETE SET NULL,
  mode              TEXT NOT NULL DEFAULT 'scheduled',
  priority          INTEGER NOT NULL DEFAULT 50,
  status            TEXT NOT NULL DEFAULT 'queued',
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  available_at      TEXT NOT NULL,
  lease_owner       TEXT,
  lease_expires_at  TEXT,
  cancel_requested  INTEGER NOT NULL DEFAULT 0,
  scheduled_for     TEXT,
  started_at        TEXT,
  finished_at       TEXT,
  last_run_id       INTEGER,
  payload_json      TEXT NOT NULL DEFAULT '{}',
  last_error        TEXT NOT NULL DEFAULT '',
  error_code        TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_jobs_active
  ON collection_jobs(dedupe_key)
  WHERE status IN ('queued', 'running') AND dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collection_jobs_claim
  ON collection_jobs(status, available_at, priority);
CREATE INDEX IF NOT EXISTS idx_collection_jobs_source
  ON collection_jobs(source_id, status);

CREATE TABLE IF NOT EXISTS collection_cursors (
  source_id    INTEGER NOT NULL REFERENCES collection_sources(id) ON DELETE CASCADE,
  adapter_id   TEXT NOT NULL,
  cursor_json  TEXT NOT NULL DEFAULT '{}',
  updated_at   TEXT NOT NULL,
  PRIMARY KEY(source_id, adapter_id)
);

CREATE TABLE IF NOT EXISTS collection_rate_limits (
  scope      TEXT PRIMARY KEY,
  until      TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key  TEXT NOT NULL UNIQUE,
  item_id     INTEGER NOT NULL REFERENCES collection_items(id) ON DELETE CASCADE,
  source_id   INTEGER REFERENCES collection_sources(id) ON DELETE SET NULL,
  rule_id     INTEGER REFERENCES collection_rules(id) ON DELETE SET NULL,
  platform    TEXT NOT NULL,
  source_name TEXT NOT NULL DEFAULT '',
  rule_name   TEXT NOT NULL DEFAULT '',
  event       TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  read_at     TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collection_notifications_unread
  ON collection_notifications(read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_notifications_platform
  ON collection_notifications(platform, created_at DESC);
`);

// 迁移：collection_rules.name（幂等）
const ruleColumns = db.prepare(`PRAGMA table_info(collection_rules)`).all();
if (!ruleColumns.some((column) => column.name === 'name')) {
  db.exec(`ALTER TABLE collection_rules ADD COLUMN name TEXT NOT NULL DEFAULT ''`);
}
db.exec(`UPDATE collection_rules SET name = CASE WHEN value <> '' THEN value WHEN kind = 'full' THEN '全量' ELSE kind END WHERE name = ''`);
db.exec(`UPDATE collection_rules SET name = '全量' WHERE name = 'full' AND kind = 'full'`);

// 采集内核 v2 的加法迁移：旧代码可忽略新列，回滚安全。
function addColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }
  return false;
}
addColumn('collection_rules', 'consecutive_failures', 'INTEGER NOT NULL DEFAULT 0');
addColumn('collection_rules', 'last_error', "TEXT NOT NULL DEFAULT ''");
addColumn('collection_runs', 'job_id', 'INTEGER');
addColumn('collection_runs', 'attempt', 'INTEGER NOT NULL DEFAULT 1');
addColumn('collection_runs', 'duration_ms', 'INTEGER');
addColumn('collection_runs', 'error_code', "TEXT NOT NULL DEFAULT ''");
addColumn('collection_item_sources', 'last_run_id', 'INTEGER');

// v3：规则查询选项、匹配条件、通知开关；运行过滤计数。
addColumn('collection_rules', 'options_json', "TEXT NOT NULL DEFAULT '{}'");
addColumn('collection_rules', 'match_json', "TEXT NOT NULL DEFAULT '{}'");
const notifyAdded = addColumn('collection_rules', 'notify', 'INTEGER NOT NULL DEFAULT 1');
addColumn('collection_rules', 'notify_updates', 'INTEGER NOT NULL DEFAULT 0');
addColumn('collection_runs', 'filtered_count', 'INTEGER DEFAULT 0');
// 仅首次加列时关闭存量规则的通知，避免升级后历史内容洪泛。
if (notifyAdded) db.exec(`UPDATE collection_rules SET notify = 0`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_collection_runs_job ON collection_runs(job_id)`);
db.exec(`INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, '${new Date().toISOString()}')`);
db.exec(`INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, '${new Date().toISOString()}')`);

db.exec(`UPDATE collection_runs SET status = 'error', finished_at = datetime('now', 'localtime'), error = COALESCE(NULLIF(error, ''), '服务重启时中断') WHERE status = 'running'`);

function now() {
  return new Date().toLocaleString('sv-SE', { hour12: false }).replace('T', ' ');
}

// ---------- 基础工具 ----------
export const run = (sql, ...args) => db.prepare(sql).run(...args);
export const all = (sql, ...args) => db.prepare(sql).all(...args);
export const get = (sql, ...args) => db.prepare(sql).get(...args);
export const parseJson = (s, fallback) => {
  try { return JSON.parse(s); } catch { return fallback; }
};

let transactionDepth = 0;

/**
 * 同步事务（BEGIN IMMEDIATE）。node:sqlite 是同步 API，事务内不得 await 网络。
 * 使用嵌套调用时退化为 SAVEPOINT，避免队列/入库互相调用时提交过早。
 */
export function transaction(fn) {
  const nested = transactionDepth > 0;
  const savepoint = `sp_${transactionDepth}`;
  try {
    db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    transactionDepth++;
    const result = fn();
    transactionDepth--;
    db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    transactionDepth = Math.max(0, transactionDepth - 1);
    try { db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK'); } catch {}
    throw error;
  }
}

// ---------- 账号 ----------
export const accounts = {
  list() {
    return all(`SELECT * FROM accounts ORDER BY id`).map((r) => ({
      ...r, enabled: !!r.enabled,
    }));
  },
  upsert(username, displayName = '') {
    run(
      `INSERT INTO accounts (username, display_name) VALUES (?, ?)
       ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name`,
      username.replace(/^@/, ''), displayName
    );
    return get(`SELECT * FROM accounts WHERE username = ?`, username.replace(/^@/, ''));
  },
  remove(id) {
    run(`DELETE FROM accounts WHERE id = ?`, id);
  },
  setEnabled(id, enabled) {
    run(`UPDATE accounts SET enabled = ? WHERE id = ?`, enabled ? 1 : 0, id);
  },
  enabledList() {
    return all(`SELECT * FROM accounts WHERE enabled = 1 ORDER BY id`);
  },
};

// ---------- 推文 ----------
export const tweets = {
  exists(id) {
    return !!get(`SELECT 1 FROM tweets WHERE id = ?`, id);
  },
  insert(t) {
    run(
      `INSERT OR IGNORE INTO tweets
        (id, account_id, author_username, author_name, text, tweet_created_at,
         like_count, retweet_count, reply_count, view_count, media, url, is_mock)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.id, t.account_id ?? null, t.author_username, t.author_name || '', t.text,
      t.tweet_created_at || null, t.like_count ?? 0, t.retweet_count ?? 0,
      t.reply_count ?? 0, t.view_count ?? 0,
      t.media ? JSON.stringify(t.media) : null, t.url || '', t.is_mock ? 1 : 0
    );
  },
  markAnalyzed(id, status = 'analyzed') {
    run(`UPDATE tweets SET status = ? WHERE id = ?`, status, id);
  },
  /** 未分析的新推文（用于分析流水线） */
  newUnanalyzed(limit = 50) {
    return all(
      `SELECT * FROM tweets WHERE status = 'new' ORDER BY tweet_created_at DESC LIMIT ?`,
      limit
    );
  },
  /** 推文列表（含素材入库状态） */
  list({ limit = 100, q = '' } = {}) {
    let sql = `
      SELECT t.*, m.id AS material_id, m.status AS material_status, m.score AS material_score, m.title AS material_title
      FROM tweets t
      LEFT JOIN materials m ON m.tweet_id = t.id
    `;
    const args = [];
    if (q) {
      sql += ` WHERE t.text LIKE ? OR t.author_username LIKE ? OR t.author_name LIKE ?`;
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += ` ORDER BY t.tweet_created_at DESC, t.id DESC LIMIT ?`;
    args.push(limit);
    return all(sql, ...args);
  },
};

// ---------- 素材 ----------
export const materials = {
  list({ status, q, limit = 100, offset = 0 } = {}) {
    let sql = `
      SELECT m.*, t.text AS tweet_text, t.author_username, t.author_name, t.url AS tweet_url,
             t.like_count, t.retweet_count, t.reply_count, t.view_count, t.tweet_created_at,
             t.is_mock
      FROM materials m
      LEFT JOIN tweets t ON t.id = m.tweet_id
    `;
    const conds = [];
    const args = [];
    if (status && status !== 'all') { conds.push(`m.status = ?`); args.push(status); }
    if (q) {
      conds.push(`(m.title LIKE ? OR m.summary LIKE ? OR m.tags LIKE ? OR t.text LIKE ? OR t.author_username LIKE ?)`);
      args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (conds.length) sql += ` WHERE ` + conds.join(' AND ');
    sql += ` ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`;
    args.push(limit, offset);
    return all(sql, ...args).map((r) => ({
      ...r,
      tags: parseJson(r.tags, []),
      suggested_types: parseJson(r.suggested_types, []),
      analysis_raw: parseJson(r.analysis_raw, {}),
    }));
  },
  countByStatus() {
    const rows = all(`SELECT status, COUNT(*) AS n FROM materials GROUP BY status`);
    const out = { pending: 0, approved: 0, rejected: 0, total: 0 };
    for (const r of rows) { out[r.status] = r.n; out.total += r.n; }
    return out;
  },
  get(id) {
    const m = get(
      `SELECT m.*, t.text AS tweet_text, t.author_username, t.author_name, t.url AS tweet_url,
              t.like_count, t.retweet_count, t.reply_count, t.view_count, t.tweet_created_at, t.is_mock
       FROM materials m LEFT JOIN tweets t ON t.id = m.tweet_id WHERE m.id = ?`, id);
    if (!m) return null;
    return {
      ...m,
      tags: parseJson(m.tags, []),
      suggested_types: parseJson(m.suggested_types, []),
      analysis_raw: parseJson(m.analysis_raw, {}),
    };
  },
  insert({ tweet_id, title, summary, score, score_reason, category, tags, suggested_types, analysis_raw }) {
    run(
      `INSERT OR IGNORE INTO materials
        (tweet_id, title, summary, score, score_reason, category, tags, suggested_types, analysis_raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      tweet_id, title, summary, score, score_reason, category,
      JSON.stringify(tags || []), JSON.stringify(suggested_types || []), JSON.stringify(analysis_raw || {})
    );
  },
  setStatus(id, status) {
    run(`UPDATE materials SET status = ?, decided_at = ? WHERE id = ?`, status, now(), id);
  },
  existsByTweet(tweetId) {
    return !!get(`SELECT 1 FROM materials WHERE tweet_id = ?`, tweetId);
  },
};

// ---------- 创作 ----------
export const creations = {
  insert(materialId, contentType) {
    const info = run(
      `INSERT INTO creations (material_id, content_type) VALUES (?, ?)`,
      materialId, contentType
    );
    return Number(info.lastInsertRowid);
  },
  list({ materialId, limit = 200 } = {}) {
    let sql = `
      SELECT c.*, m.title AS material_title, m.score AS material_score, m.category AS material_category,
             t.text AS tweet_text, t.author_username
      FROM creations c
      LEFT JOIN materials m ON m.id = c.material_id
      LEFT JOIN tweets t ON t.id = m.tweet_id
    `;
    const args = [];
    if (materialId) { sql += ` WHERE c.material_id = ?`; args.push(materialId); }
    sql += ` ORDER BY c.id DESC LIMIT ?`;
    args.push(limit);
    return all(sql, ...args).map((r) => ({
      ...r,
      content: r.content ? parseJson(r.content, { raw: r.content }) : null,
    }));
  },
  get(id) {
    return all(`SELECT * FROM creations WHERE id = ?`, id)[0] || null;
  },
  setRunning(id) {
    run(`UPDATE creations SET status = 'running', started_at = ? WHERE id = ?`, now(), id);
  },
  setDone(id, title, content) {
    run(`UPDATE creations SET status = 'done', title = ?, content = ?, finished_at = ? WHERE id = ?`,
      title, typeof content === 'string' ? content : JSON.stringify(content), now(), id);
  },
  setFailed(id, error) {
    run(`UPDATE creations SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
      String(error).slice(0, 2000), now(), id);
  },
  stats() {
    const rows = all(`SELECT status, COUNT(*) AS n FROM creations GROUP BY status`);
    const out = { total: 0, done: 0, failed: 0, running: 0, queued: 0 };
    for (const r of rows) { out[r.status] = r.n; out.total += r.n; }
    return out;
  },
};

// ---------- 设置 ----------
export const settings = {
  get(key, fallback = '') {
    const r = get(`SELECT value FROM settings WHERE key = ?`, key);
    return r ? r.value : fallback;
  },
  set(key, value) {
    run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key, String(value)
    );
  },
  all() {
    const rows = all(`SELECT * FROM settings ORDER BY key`);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
};

// ---------- 统一采集 ----------
function parseObject(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function sourceView(row) {
  if (!row) return null;
  return { ...row, enabled: !!row.enabled, config: parseObject(row.config_json, {}) };
}

function jsonObject(value, fallback = {}) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return fallback;
}

function ruleView(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: !!row.enabled,
    notify: row.notify == null ? true : !!row.notify,
    notify_updates: !!row.notify_updates,
    interval_min: row.interval_min == null ? 1 : Number(row.interval_min),
    options: parseObject(row.options_json, {}),
    match: parseObject(row.match_json, {}),
  };
}

function collectionItemView(row) {
  if (!row) return null;
  return {
    ...row,
    platforms: parseObject(row.platforms_json, []),
    links: parseObject(row.links_json, []),
    raw_json: parseObject(row.raw_json, []),
    metadata: parseObject(row.metadata_json, {}),
    required_complete: !!row.required_complete,
  };
}

function rowAsCollectionItem(row) {
  return normalizeCollectionItem({
    platform: row.platform,
    external_id: row.external_id,
    canonical_url: row.canonical_url,
    source_url: row.source_url,
    title: row.title,
    content: row.content,
    summary: row.summary,
    author: row.author,
    published_at: row.published_at,
    links: parseObject(row.links_json, []),
    raw_json: parseObject(row.raw_json, []),
    metadata: parseObject(row.metadata_json, {}),
    required_complete: !!row.required_complete,
  });
}

export const collectionSources = {
  list({ enabled } = {}) {
    const rows = enabled == null
      ? all(`SELECT * FROM collection_sources ORDER BY id`)
      : all(`SELECT * FROM collection_sources WHERE enabled = ? ORDER BY id`, enabled ? 1 : 0);
    return rows.map(sourceView);
  },
  get(id) {
    return sourceView(get(`SELECT * FROM collection_sources WHERE id = ?`, Number(id)));
  },
  upsert({ id, platform, name, url = '', config = {}, enabled = true } = {}) {
    const normalizedPlatform = canonicalPlatform(platform);
    const normalizedName = String(name || normalizedPlatform || '').trim();
    if (!normalizedPlatform || !normalizedName) throw new Error('采集源 platform/name 不能为空');
    const normalizedUrl = String(url || '').trim();
    const configJson = JSON.stringify(config && typeof config === 'object' ? config : {});
    if (id) {
      run(`UPDATE collection_sources SET platform = ?, name = ?, url = ?, config_json = ?, enabled = ?, updated_at = ? WHERE id = ?`,
        normalizedPlatform, normalizedName, normalizedUrl, configJson, enabled ? 1 : 0, now(), Number(id));
      return this.get(id);
    }
    run(`INSERT INTO collection_sources (platform, name, url, config_json, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(platform, name, url) DO UPDATE SET config_json = excluded.config_json, enabled = excluded.enabled, updated_at = excluded.updated_at`,
      normalizedPlatform, normalizedName, normalizedUrl, configJson, enabled ? 1 : 0, now());
    return sourceView(get(`SELECT * FROM collection_sources WHERE platform = ? AND name = ? AND url = ?`, normalizedPlatform, normalizedName, normalizedUrl));
  },
  setEnabled(id, enabled) {
    run(`UPDATE collection_sources SET enabled = ?, updated_at = ? WHERE id = ?`, enabled ? 1 : 0, now(), Number(id));
  },
  remove(id) {
    run(`DELETE FROM collection_sources WHERE id = ?`, Number(id));
  },
  markCollected(id, at = new Date().toISOString()) {
    run(`UPDATE collection_sources SET last_collected_at = ?, updated_at = ? WHERE id = ?`, at, now(), Number(id));
  },
};

export const collectionRules = {
  list({ sourceId, enabled, platform } = {}) {
    let sql = `SELECT r.*, s.name AS source_name, s.platform FROM collection_rules r JOIN collection_sources s ON s.id = r.source_id`;
    const conds = [];
    const args = [];
    if (sourceId != null) { conds.push('r.source_id = ?'); args.push(Number(sourceId)); }
    if (enabled != null) { conds.push('r.enabled = ?'); args.push(enabled ? 1 : 0); }
    if (platform) { conds.push('s.platform = ?'); args.push(String(platform)); }
    if (conds.length) sql += ` WHERE ${conds.join(' AND ')}`;
    sql += ' ORDER BY r.id';
    return all(sql, ...args).map(ruleView);
  },
  get(id) { return ruleView(get(`SELECT r.*, s.name AS source_name, s.platform FROM collection_rules r JOIN collection_sources s ON s.id = r.source_id WHERE r.id = ?`, Number(id))); },
  upsert({
    id, sourceId, name = '', kind = 'keyword', value = '', intervalMin = 360, enabled = true,
    options, match, notify, notifyUpdates,
  } = {}) {
    const source = collectionSources.get(sourceId);
    if (!source) throw new Error('采集源不存在');
    const interval = Math.max(0, Math.floor(Number(intervalMin) || 0));
    const normalizedKind = String(kind || 'keyword').trim().toLowerCase();
    const normalizedValue = String(value || '').trim();
    const normalizedName = String(name || '').trim();
    if (id) {
      const current = this.get(id);
      const optionsJson = JSON.stringify(jsonObject(options === undefined ? current?.options : options));
      const matchJson = JSON.stringify(jsonObject(match === undefined ? current?.match : match));
      const notifyValue = notify === undefined ? (current?.notify === false ? 0 : 1) : (notify ? 1 : 0);
      const notifyUpdatesValue = notifyUpdates === undefined
        ? (current?.notify_updates ? 1 : 0) : (notifyUpdates ? 1 : 0);
      run(`UPDATE collection_rules SET source_id = ?, name = ?, kind = ?, value = ?, interval_min = ?, enabled = ?,
             options_json = ?, match_json = ?, notify = ?, notify_updates = ?, updated_at = ? WHERE id = ?`,
      Number(sourceId), normalizedName, normalizedKind, normalizedValue, interval, enabled ? 1 : 0,
      optionsJson, matchJson, notifyValue, notifyUpdatesValue, now(), Number(id));
      return this.get(id);
    }
    const optionsJson = JSON.stringify(jsonObject(options));
    const matchJson = JSON.stringify(jsonObject(match));
    const notifyValue = notify === false ? 0 : 1;
    const notifyUpdatesValue = notifyUpdates ? 1 : 0;
    run(`INSERT INTO collection_rules
           (source_id, name, kind, value, interval_min, enabled, options_json, match_json, notify, notify_updates, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, kind, value) DO UPDATE SET
           name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE collection_rules.name END,
           interval_min = excluded.interval_min, enabled = excluded.enabled,
           options_json = excluded.options_json, match_json = excluded.match_json,
           notify = excluded.notify, notify_updates = excluded.notify_updates, updated_at = excluded.updated_at`,
      Number(sourceId), normalizedName, normalizedKind, normalizedValue, interval, enabled ? 1 : 0,
      optionsJson, matchJson, notifyValue, notifyUpdatesValue, now());
    return this.get(get(`SELECT id FROM collection_rules WHERE source_id = ? AND kind = ? AND value = ?`, Number(sourceId), normalizedKind, normalizedValue).id);
  },
  setSchedule(id, { lastRunAt = null, nextRunAt = null } = {}) {
    run(`UPDATE collection_rules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
      lastRunAt, nextRunAt, now(), Number(id));
    return this.get(id);
  },
  setEnabled(id, enabled) {
    run(`UPDATE collection_rules SET enabled = ?, updated_at = ? WHERE id = ?`, enabled ? 1 : 0, now(), Number(id));
  },
  remove(id) { run(`DELETE FROM collection_rules WHERE id = ?`, Number(id)); },
  due(at = Date.now()) {
    return this.list({ enabled: true })
      .filter((rule) => Number(rule.interval_min) > 0)
      .filter((rule) => !rule.next_run_at || !Number.isFinite(Date.parse(rule.next_run_at)) || Date.parse(rule.next_run_at) <= at);
  },
  markRun(id, { success = true, at = new Date().toISOString(), backoffMin } = {}) {
    const rule = this.get(id);
    if (!rule) return;
    const minutes = Number(backoffMin) > 0 ? Number(backoffMin) : Number(rule.interval_min);
    const next = minutes > 0 ? new Date(Date.parse(at) + minutes * 60 * 1000).toISOString() : null;
    run(`UPDATE collection_rules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?`, at, next, now(), Number(id));
  },

  /** 成功：更新 last_run，清零连续失败；next_run_at 由 Planner 维护，不在这里覆盖。 */
  markSuccess(id, { at = new Date().toISOString() } = {}) {
    run(`UPDATE collection_rules SET last_run_at = ?, consecutive_failures = 0, last_error = '', updated_at = ? WHERE id = ?`,
      at, now(), Number(id));
    return this.get(id);
  },

  /** 最终失败：累计次数并推进下一次时间，避免持续打失败接口。 */
  markFailure(id, { at = Date.now(), nextRunAt = null, error = '' } = {}) {
    const rule = this.get(id);
    if (!rule) return null;
    const next = nextRunAt || new Date(Number(at) + Math.max(60_000, Number(rule.interval_min) * 60_000)).toISOString();
    run(`UPDATE collection_rules SET last_run_at = ?, next_run_at = ?, consecutive_failures = consecutive_failures + 1, last_error = ?, updated_at = ? WHERE id = ?`,
      new Date(Number(at)).toISOString(), next, String(error || '').slice(0, 1000), now(), Number(id));
    return this.get(id);
  },

  setNextRun(id, nextRunAt) {
    run(`UPDATE collection_rules SET next_run_at = ?, updated_at = ? WHERE id = ?`,
      nextRunAt, now(), Number(id));
  },
};

export const collectionAuth = {
  set(sourceId, input = {}, metadata = {}) {
    const source = collectionSources.get(sourceId);
    if (!source) throw new Error('采集源不存在');
    const auth = normalizeAuth(input);
    if (saveEnvironmentAuth(source, auth)) return this.status(sourceId);
    const cipher = encryptSecret(auth);
    run(`INSERT INTO collection_auth (source_id, auth_type, secret_cipher, metadata_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET auth_type = excluded.auth_type, secret_cipher = excluded.secret_cipher, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`,
      Number(sourceId), auth.type, cipher, JSON.stringify(metadata || {}), now());
    return this.status(sourceId);
  },
  get(sourceId) {
    const environment = readEnvironmentAuth(collectionSources.get(sourceId));
    if (environment) return environment;
    const row = get(`SELECT * FROM collection_auth WHERE source_id = ?`, Number(sourceId));
    if (!row) return { type: 'none' };
    return decryptSecret(row.secret_cipher);
  },
  status(sourceId) {
    const environment = readEnvironmentAuth(collectionSources.get(sourceId));
    if (environment) return { ...redactAuth(environment), storage: 'env' };
    const row = get(`SELECT auth_type, metadata_json, created_at, updated_at FROM collection_auth WHERE source_id = ?`, Number(sourceId));
    if (!row) return { type: 'none', configured: false };
    return { ...redactAuth({ type: row.auth_type }), metadata: parseObject(row.metadata_json, {}), created_at: row.created_at, updated_at: row.updated_at };
  },
  remove(sourceId) {
    saveEnvironmentAuth(collectionSources.get(sourceId), { type: 'none' });
    run(`DELETE FROM collection_auth WHERE source_id = ?`, Number(sourceId));
  },
};

function collectionItemWhere({ platform, q, sourceId, complete, categoryId, tag } = {}) {
  const conds = [];
  const args = [];
  if (q) {
    conds.push(`(title LIKE ? OR content LIKE ? OR summary LIKE ? OR author LIKE ? OR canonical_url LIKE ? OR metadata_json LIKE ?)`);
    args.push(...Array(6).fill(`%${q}%`));
  }
  if (platform) { conds.push('platform = ?'); args.push(String(platform)); }
  if (sourceId != null) {
    conds.push('(source_id = ? OR id IN (SELECT item_id FROM collection_item_sources WHERE source_id = ?))');
    args.push(Number(sourceId), Number(sourceId));
  }
  if (complete != null) { conds.push('required_complete = ?'); args.push(complete ? 1 : 0); }
  if (categoryId != null && categoryId !== '') {
    conds.push("json_extract(metadata_json, '$.category_id') = ?");
    args.push(Number(categoryId));
  }
  if (tag) {
    conds.push("EXISTS (SELECT 1 FROM json_each(metadata_json, '$.tags') WHERE value = ?)");
    args.push(String(tag));
  }
  return { where: conds.length ? ` WHERE ${conds.join(' AND ')}` : '', args };
}

export const collectionItems = {
  upsert(item, { sourceId = null, ruleId = null, runId = null } = {}) {
    const normalized = normalizeCollectionItem(item);
    const existing = get(`SELECT * FROM collection_items WHERE dedupe_key = ?`, normalized.dedupe_key);
    const at = new Date().toISOString();
    let merged = normalized;
    let id;
    let isNew = false;
    if (existing) {
      merged = mergeCollectionItems(rowAsCollectionItem(existing), normalized);
      id = Number(existing.id);
      run(`UPDATE collection_items SET platform = ?, platforms_json = ?, source_id = COALESCE(source_id, ?), external_id = ?, canonical_url = ?, source_url = ?, title = ?, content = ?, summary = ?, author = ?, published_at = COALESCE(published_at, ?), links_json = ?, raw_json = ?, metadata_json = ?, required_complete = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`,
        merged.platform, JSON.stringify([...new Set([...(parseObject(existing.platforms_json, [])), merged.platform, normalized.platform])]), sourceId,
        merged.external_id, merged.canonical_url, merged.source_url, merged.title, merged.content, merged.summary, merged.author,
        merged.published_at, JSON.stringify(merged.links), JSON.stringify(merged.raw_json), JSON.stringify(merged.metadata), merged.required_complete ? 1 : 0, at, now(), id);
    } else {
      const info = run(`INSERT INTO collection_items
        (dedupe_key, platform, platforms_json, source_id, external_id, canonical_url, source_url, title, content, summary, author, published_at, links_json, raw_json, metadata_json, required_complete, first_seen_at, last_seen_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        merged.dedupe_key, merged.platform, JSON.stringify([merged.platform]), sourceId, merged.external_id, merged.canonical_url,
        merged.source_url, merged.title, merged.content, merged.summary, merged.author, merged.published_at,
        JSON.stringify(merged.links), JSON.stringify(merged.raw_json), JSON.stringify(merged.metadata), merged.required_complete ? 1 : 0, at, at, now());
      id = Number(info.lastInsertRowid);
      isNew = true;
    }
    if (sourceId != null) {
      // SQLite 的 UNIQUE 把 NULL 视为互不相等，rule_id 为空时不能用 ON CONFLICT。
      const existingLink = get(
        `SELECT 1 FROM collection_item_sources WHERE item_id = ? AND source_id = ? AND rule_id IS ?`,
        id, Number(sourceId), ruleId == null ? null : Number(ruleId),
      );
      if (existingLink) {
        run(`UPDATE collection_item_sources SET last_seen_at = ?, last_run_id = COALESCE(?, last_run_id)
             WHERE item_id = ? AND source_id = ? AND rule_id IS ?`,
        at, runId == null ? null : Number(runId), id, Number(sourceId), ruleId == null ? null : Number(ruleId));
      } else {
        run(`INSERT INTO collection_item_sources (item_id, source_id, rule_id, last_run_id, first_seen_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        id, Number(sourceId), ruleId == null ? null : Number(ruleId), runId == null ? null : Number(runId), at, at);
      }
    }
    return { id, isNew, item: collectionItemView(get(`SELECT * FROM collection_items WHERE id = ?`, id)) };
  },
  remove(id) {
    return run(`DELETE FROM collection_items WHERE id = ?`, Number(id)).changes > 0;
  },
  get(id) { return collectionItemView(get(`SELECT * FROM collection_items WHERE id = ?`, Number(id))); },
  list({ limit = 100, offset = 0, ...options } = {}) {
    const { where, args } = collectionItemWhere(options);
    const sql = `SELECT * FROM collection_items${where} ORDER BY COALESCE(published_at, last_seen_at) DESC, id DESC LIMIT ? OFFSET ?`;
    args.push(Math.min(500, Math.max(1, Number(limit) || 100)), Math.max(0, Number(offset) || 0));
    return all(sql, ...args).map(collectionItemView);
  },
  count(options = {}) {
    const { where, args } = collectionItemWhere(options);
    return Number(get(`SELECT COUNT(*) AS n FROM collection_items${where}`, ...args).n || 0);
  },
  incompleteCount(options = {}) {
    const { where, args } = collectionItemWhere({ ...options, complete: false });
    return Number(get(`SELECT COUNT(*) AS n FROM collection_items${where}`, ...args).n || 0);
  },
};

export const collectionRuns = {
  start({ mode = 'scheduled', sourceId = null, ruleId = null, jobId = null, attempt = 1 } = {}) {
    const info = run(
      `INSERT INTO collection_runs (mode, source_id, rule_id, job_id, attempt, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      mode,
      sourceId == null ? null : Number(sourceId),
      ruleId == null ? null : Number(ruleId),
      jobId == null ? null : Number(jobId),
      Math.max(1, Number(attempt) || 1),
      new Date().toISOString(),
    );
    return Number(info.lastInsertRowid);
  },
  finish(id, {
    status = 'ok', collected = 0, added = 0, updated = 0, incomplete = 0, filtered = 0,
    error = '', errorCode = '', durationMs = null, detail = {},
  } = {}) {
    run(`UPDATE collection_runs SET status = ?, finished_at = ?, collected_count = ?, new_count = ?, updated_count = ?, incomplete_count = ?, filtered_count = ?, error = ?, error_code = ?, duration_ms = ?, detail_json = ? WHERE id = ?`,
      status, new Date().toISOString(), collected, added, updated, incomplete, filtered,
      String(error || '').slice(0, 2000), String(errorCode || '').slice(0, 64),
      durationMs == null ? null : Math.max(0, Number(durationMs) || 0),
      JSON.stringify(detail || {}), Number(id));
  },
  get(id) {
    const row = get(`SELECT r.*, s.platform, s.name AS source_name FROM collection_runs r LEFT JOIN collection_sources s ON s.id = r.source_id WHERE r.id = ?`, Number(id));
    return row ? { ...row, detail: parseObject(row.detail_json, {}) } : null;
  },
  stats({ platform } = {}) {
    const where = platform ? ' WHERE source_id IN (SELECT id FROM collection_sources WHERE platform = ?)' : '';
    const args = platform ? [String(platform)] : [];
    const rows = all(`SELECT status, COUNT(*) AS n FROM collection_runs${where} GROUP BY status`, ...args);
    const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.n)]));
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const todaySql = where
      ? `SELECT COUNT(*) AS n FROM collection_runs${where} AND date(started_at) = date('now','localtime')`
      : `SELECT COUNT(*) AS n FROM collection_runs WHERE date(started_at) = date('now','localtime')`;
    const today = get(todaySql, ...args);
    return {
      total,
      ok: counts.ok || 0,
      warn: counts.warn || 0,
      error: counts.error || 0,
      running: counts.running || 0,
      canceled: counts.canceled || 0,
      today: Number(today.n || 0),
    };
  },
  list(options = 100) {
    const opts = typeof options === 'object' ? options : { limit: options };
    const conds = [];
    const args = [];
    if (opts.sourceId != null) { conds.push('r.source_id = ?'); args.push(Number(opts.sourceId)); }
    if (opts.jobId != null) { conds.push('r.job_id = ?'); args.push(Number(opts.jobId)); }
    if (opts.platform) { conds.push('s.platform = ?'); args.push(String(opts.platform)); }
    const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
    let sql = 'SELECT r.*, s.platform, s.name AS source_name FROM collection_runs r LEFT JOIN collection_sources s ON s.id = r.source_id';
    if (conds.length) sql += ` WHERE ${conds.join(' AND ')}`;
    sql += ' ORDER BY r.id DESC LIMIT ?';
    args.push(limit);
    return all(sql, ...args)
      .map((row) => ({ ...row, detail: parseObject(row.detail_json, {}) }));
  },
};

// ---------- 采集通知 ----------
function notificationView(row) {
  if (!row) return null;
  return {
    ...row,
    read: !!row.read_at,
    unread: !row.read_at,
  };
}

function notificationWhere({ platform, unread } = {}) {
  const conds = [];
  const args = [];
  if (platform) { conds.push('platform = ?'); args.push(String(platform)); }
  if (unread != null) {
    conds.push(unread ? 'read_at IS NULL' : 'read_at IS NOT NULL');
  }
  return { where: conds.length ? ` WHERE ${conds.join(' AND ')}` : '', args };
}

export const collectionNotifications = {
  create({
    dedupeKey, itemId, sourceId = null, ruleId = null, platform,
    sourceName = '', ruleName = '', event = '', title, body = '', createdAt = null,
  } = {}) {
    const key = String(dedupeKey || '').trim();
    if (!key) throw new Error('通知去重键不能为空');
    const at = createdAt || new Date().toISOString();
    run(`INSERT OR IGNORE INTO collection_notifications
           (dedupe_key, item_id, source_id, rule_id, platform, source_name, rule_name, event, title, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    key, Number(itemId), sourceId == null ? null : Number(sourceId),
    ruleId == null ? null : Number(ruleId), String(platform || '').toLowerCase(),
    String(sourceName || '').slice(0, 300), String(ruleName || '').slice(0, 300),
    String(event || '').slice(0, 64), String(title || '(无标题)').slice(0, 500),
    String(body || '').slice(0, 500), at);
    return notificationView(get(`SELECT * FROM collection_notifications WHERE dedupe_key = ?`, key));
  },
  get(id) {
    return notificationView(get(`SELECT * FROM collection_notifications WHERE id = ?`, Number(id)));
  },
  list({ platform, unread, limit = 50, offset = 0 } = {}) {
    const { where, args } = notificationWhere({ platform, unread });
    const sql = `SELECT * FROM collection_notifications${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
    args.push(Math.min(500, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0));
    return all(sql, ...args).map(notificationView);
  },
  count({ platform, unread } = {}) {
    const { where, args } = notificationWhere({ platform, unread });
    return Number(get(`SELECT COUNT(*) AS n FROM collection_notifications${where}`, ...args).n || 0);
  },
  unreadCount() {
    const total = Number(get(`SELECT COUNT(*) AS n FROM collection_notifications WHERE read_at IS NULL`).n || 0);
    const byPlatform = all(
      `SELECT platform, COUNT(*) AS n FROM collection_notifications WHERE read_at IS NULL GROUP BY platform ORDER BY n DESC`,
    ).map((row) => ({ platform: row.platform, count: Number(row.n) || 0 }));
    return { total, byPlatform };
  },
  markRead(id, at = new Date().toISOString()) {
    const row = get(`SELECT id FROM collection_notifications WHERE id = ?`, Number(id));
    if (!row) return null;
    run(`UPDATE collection_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?`, at, Number(id));
    return this.get(id);
  },
  markAllRead({ platform } = {}, at = new Date().toISOString()) {
    const result = platform
      ? run(`UPDATE collection_notifications SET read_at = ? WHERE read_at IS NULL AND platform = ?`, at, String(platform))
      : run(`UPDATE collection_notifications SET read_at = ? WHERE read_at IS NULL`, at);
    return { updated: Number(result.changes) || 0 };
  },
  cleanup({ before = null, limit = 0 } = {}) {
    if (before) {
      const result = run(
        `DELETE FROM collection_notifications WHERE read_at IS NOT NULL AND read_at < ?`,
        String(before),
      );
      return Number(result.changes) || 0;
    }
    if (limit > 0) {
      const result = run(
        `DELETE FROM collection_notifications WHERE id IN (
           SELECT id FROM collection_notifications WHERE read_at IS NOT NULL ORDER BY created_at ASC LIMIT ?
         )`,
        Math.max(1, Number(limit) || 0),
      );
      return Number(result.changes) || 0;
    }
    return 0;
  },
};

// ---------- 采集游标 / 限流冷却 ----------
export const collectionCursors = {
  get(sourceId, adapterId) {
    const row = get(`SELECT * FROM collection_cursors WHERE source_id = ? AND adapter_id = ?`,
      Number(sourceId), String(adapterId));
    return row ? parseObject(row.cursor_json, null) : null;
  },
  set(sourceId, adapterId, value) {
    run(`INSERT INTO collection_cursors (source_id, adapter_id, cursor_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source_id, adapter_id) DO UPDATE SET cursor_json = excluded.cursor_json, updated_at = excluded.updated_at`,
    Number(sourceId), String(adapterId), JSON.stringify(value ?? null), new Date().toISOString());
  },
  clear(sourceId, adapterId) {
    run(`DELETE FROM collection_cursors WHERE source_id = ? AND adapter_id = ?`, Number(sourceId), String(adapterId));
  },
};

export const collectionRateLimits = {
  get(scope) {
    const row = get(`SELECT * FROM collection_rate_limits WHERE scope = ?`, String(scope));
    if (!row) return null;
    return { ...row, untilMs: Date.parse(row.until) || 0 };
  },
  set(scope, until, reason = '') {
    const at = new Date(Number(until) || Date.now()).toISOString();
    run(`INSERT INTO collection_rate_limits (scope, until, reason, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET until = excluded.until, reason = excluded.reason, updated_at = excluded.updated_at`,
    String(scope), at, String(reason || '').slice(0, 200), new Date().toISOString());
    return { scope: String(scope), until: at, reason: String(reason || '') };
  },
  list() {
    return all(`SELECT * FROM collection_rate_limits ORDER BY until`).map((row) => ({
      ...row, untilMs: Date.parse(row.until) || 0,
    }));
  },
  prune(at = Date.now()) {
    run(`DELETE FROM collection_rate_limits WHERE until < ?`, new Date(Number(at)).toISOString());
  },
};

// ---------- 运行日志 ----------
export const logs = {
  add(runType, detail = '', status = 'ok') {
    run(`INSERT INTO run_logs (run_type, detail, status) VALUES (?, ?, ?)`, runType, detail, status);
  },
  list(limit = 100) {
    return all(`SELECT * FROM run_logs ORDER BY id DESC LIMIT ?`, limit);
  },
};

// ---------- 统计 ----------
export const stats = {
  dashboard() {
    const tweetCount = get(`SELECT COUNT(*) AS n FROM tweets`).n;
    const accountCount = get(`SELECT COUNT(*) AS n FROM accounts WHERE enabled = 1`).n;
    const mat = materials.countByStatus();
    const cr = creations.stats();
    const lastScrape = get(`SELECT created_at FROM run_logs WHERE run_type = 'scrape' ORDER BY id DESC LIMIT 1`);
    const lastAnalyze = get(`SELECT created_at FROM run_logs WHERE run_type = 'analyze' ORDER BY id DESC LIMIT 1`);
    const collectionCount = collectionItems.count();
    const collectionIncomplete = collectionItems.incompleteCount();
    const lastCollection = get(`SELECT finished_at FROM collection_runs WHERE status IN ('ok', 'warn', 'error') ORDER BY id DESC LIMIT 1`);
    return {
      tweets: tweetCount,
      accounts: accountCount,
      materials: mat,
      creations: cr,
      lastScrape: lastScrape?.created_at || null,
      lastAnalyze: lastAnalyze?.created_at || null,
      collectionItems: collectionCount,
      collectionIncomplete,
      lastCollection: lastCollection?.finished_at || null,
    };
  },
};

export default db;
