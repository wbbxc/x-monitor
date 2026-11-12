// HTTP 服务：REST API + 静态资源（Node 内置 http，零依赖）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, saveEnvValues } from './config.js';
import db, {
  accounts, materials, creations, tweets, settings, logs, stats,
  collectionSources, collectionRules, collectionAuth, collectionItems, collectionRuns, collectionNotifications,
} from './db.js';
import { runPipeline, isPipelineRunning, isCollectionRunning, collectionStatus } from './scheduler.js';
import { createFromMaterial, contentTypeLabel, pingLLM } from './creator.js';
import { resolveMode } from './scraper.js';
import { getCollector, listCollectors } from './collectors/framework.js';
import { fetchDiscourseCategories, DISCOURSE_DEFAULTS } from './collectors/discourse.js';
import {
  enqueueCollections, collectionHealth, listCollectionJobs, getCollectionJob, probeSource,
} from './collection-engine.js';
import { cancelJob, countJobs, queueStats, retryJob } from './collectors/queue.js';
import { exportCollectorConfig, importCollectorConfig, readCategoryCache, writeCategoryCache } from './collector-config.js';
import { canonicalPlatform, inferPlatformFromUrl } from './collectors/aliases.js';
import { detectSourceWithProbe } from './collectors/detect.js';
import { validateMatch } from './collectors/match.js';

const WEB_DIR = path.join(config.root, 'web');

// ---------- 工具 ----------
function json(res, code, data) {
  if (res.headersSent) return; // 防止重复写入响应头
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      // 跨站简单请求无法设置 application/json；用它阻断无预检的写入。
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      if (!contentType.includes('application/json')) {
        reject(new Error('请求 Content-Type 必须为 application/json'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('无效 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function getParams(url) {
  const u = new URL(url, 'http://localhost');
  return { pathname: u.pathname, query: Object.fromEntries(u.searchParams) };
}

function validateSourceUrl(value, { allowEmpty = true } = {}) {
  const raw = String(value || '').trim();
  if (!raw && allowEmpty) return '';
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('采集源 URL 无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('采集源只支持 http/https');
  return parsed.href;
}

function inferPlatform(value, url) {
  const explicit = canonicalPlatform(value);
  if (explicit && explicit !== 'auto') return explicit;
  return inferPlatformFromUrl(url);
}

/** 平台别名带来的默认配置（例如 hf-mirror → huggingface + baseUrl）。 */
function normalizePlatformConfig(platform, config = {}, url = '', rawPlatform = '') {
  const out = { ...(config || {}) };
  if (platform === 'huggingface' && !out.baseUrl) {
    if (['hf-mirror', 'hfmirror'].includes(String(rawPlatform || '').toLowerCase())) {
      out.baseUrl = 'https://hf-mirror.com';
    } else {
      try {
        const host = new URL(String(url || '')).hostname.toLowerCase();
        if (host === 'hf-mirror.com') out.baseUrl = 'https://hf-mirror.com';
      } catch {}
    }
  }
  return out;
}

function configContainsSecret(value) {
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (/(token|password|passwd|cookie|secret|api[_-]?key|authorization)/i.test(key)) return true;
    if (child && typeof child === 'object' && configContainsSecret(child)) return true;
  }
  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let filePath = path.join(WEB_DIR, pathname === '/' ? 'index.html' : pathname);
  // 防目录穿越
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(WEB_DIR, 'index.html');
  }
  const ext = path.extname(filePath).toLowerCase();
  const isHtml = ext === '.html';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // 本地工具：禁用缓存，避免用户看到旧版本前端
    'Cache-Control': isHtml ? 'no-cache' : 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- 创作执行（异步后台任务） ----------
async function executeCreation(creationId, materialId, type) {
  try {
    creations.setRunning(creationId);
    const material = materials.get(materialId);
    if (!material) throw new Error('素材不存在');
    const { title, content } = await createFromMaterial(material, type);
    creations.setDone(creationId, title, content);
    logs.add('create', `创作完成: 「${title}」(${contentTypeLabel(type)})`);
  } catch (err) {
    creations.setFailed(creationId, err.message);
    logs.add('create', `创作失败 #${creationId}: ${err.message}`, 'error');
  }
}

// ---------- 路由表 ----------
async function handleApi(req, res, { pathname, query }) {
  const method = req.method;
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]
  if (seg[0] !== 'api') return false;
  const route = seg.slice(1);

  // GET /api/stats
  if (route.length === 1 && route[0] === 'stats' && method === 'GET') {
    return json(res, 200, {
      ...stats.dashboard(),
      pipelineRunning: isPipelineRunning(),
      collectionRunning: isCollectionRunning(),
      collectionStatus: collectionStatus(),
      scrapeMode: resolveMode(),
      pythonBin: config.pythonBin,
      llmConfigured: !!config.llm.apiKey,
      collectors: listCollectors(),
    });
  }

  // GET /api/collections/platforms：平台汇总
  if (route.length === 2 && route[0] === 'collections' && route[1] === 'platforms' && method === 'GET') {
    const sources = collectionSources.list();
    const rules = collectionRules.list();
    const unread = collectionNotifications.unreadCount();
    const unreadByPlatform = Object.fromEntries(unread.byPlatform.map((item) => [item.platform, item.count]));
    const items = listCollectors().map((adapter) => {
      const platformSources = sources.filter((source) => source.platform === adapter.id);
      const platformRules = rules.filter((rule) => rule.platform === adapter.id);
      const nextRunAt = platformRules
        .filter((rule) => rule.enabled && rule.interval_min > 0 && rule.next_run_at)
        .map((rule) => rule.next_run_at)
        .sort()[0] || null;
      const lastRun = collectionRuns.list({ platform: adapter.id, limit: 1 })[0] || null;
      const queue = queueStats({ platform: adapter.id });
      return {
        id: adapter.id,
        label: adapter.label,
        capabilities: adapter.capabilities,
        ruleKinds: adapter.ruleKinds || [],
        publicFallback: adapter.publicFallback ?? null,
        sourceCount: platformSources.length,
        enabledCount: platformSources.filter((source) => source.enabled).length,
        ruleCount: platformRules.length,
        itemCount: collectionItems.count({ platform: adapter.id }),
        runToday: collectionRuns.stats({ platform: adapter.id }).today,
        queuedCount: queue.queued,
        runningCount: queue.running,
        nextRunAt,
        lastRunAt: lastRun?.started_at || null,
        lastRunStatus: lastRun?.status || null,
        unreadCount: unreadByPlatform[adapter.id] || 0,
      };
    });
    return json(res, 200, { items, unreadTotal: unread.total });
  }

  // GET /api/collections/runs/stats
  if (route.length === 3 && route[0] === 'collections' && route[1] === 'runs' && route[2] === 'stats' && method === 'GET') {
    return json(res, 200, collectionRuns.stats({ platform: query.platform || undefined }));
  }

  // GET /api/collections/categories?platform=linux.do|macos.do
  if (route.length === 2 && route[0] === 'collections' && route[1] === 'categories' && method === 'GET') {
    const platform = canonicalPlatform(query.platform || 'linux.do');
    const defaults = DISCOURSE_DEFAULTS[platform];
    if (!defaults) return json(res, 200, { items: [], platform, cached: false });
    const cached = readCategoryCache(platform);
    if (cached && !query.refresh) return json(res, 200, { ...cached, cached: true });
    try {
      const items = await fetchDiscourseCategories({
        origin: defaults.origin,
        proxy: config.collector.proxy,
        timeoutMs: config.collector.timeoutMs,
        retries: 0,
      });
      const saved = writeCategoryCache(items, platform);
      return json(res, 200, { ...saved, cached: false });
    } catch (error) {
      if (cached) return json(res, 200, { ...cached, cached: true, error: error.message });
      return json(res, 200, { items: [], platform, cached: false, error: error.message });
    }
  }

  // POST /api/collections/config/export：SQLite → data/collector/*.yaml
  if (route.length === 3 && route[0] === 'collections' && route[1] === 'config' && route[2] === 'export' && method === 'POST') {
    return json(res, 200, exportCollectorConfig());
  }

  // POST /api/collections/config/import：data/collector/*.yaml → SQLite
  if (route.length === 3 && route[0] === 'collections' && route[1] === 'config' && route[2] === 'import' && method === 'POST') {
    return json(res, 200, importCollectorConfig());
  }

  // GET /api/collections/adapters
  if (route.length === 2 && route[0] === 'collections' && route[1] === 'adapters' && method === 'GET') {
    return json(res, 200, { items: listCollectors() });
  }

  // POST /api/collections/detect { url, probe? }
  if (route.length === 2 && route[0] === 'collections' && route[1] === 'detect' && method === 'POST') {
    const body = await readBody(req);
    try {
      const result = await detectSourceWithProbe(body.url, {
        probe: body.probe === true,
        proxy: config.collector.proxy,
        timeoutMs: Math.min(30_000, Math.max(3_000, Number(body.timeoutMs) || 15_000)),
      });
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  // GET /api/collections/sources
  if (route.length === 2 && route[0] === 'collections' && route[1] === 'sources' && method === 'GET') {
    return json(res, 200, {
      items: collectionSources.list()
        .filter((source) => !query.platform || source.platform === query.platform)
        .map((source) => ({ ...source, auth: collectionAuth.status(source.id) })),
    });
  }

  // POST /api/collections/sources
  if (route.length === 2 && route[0] === 'collections' && route[1] === 'sources' && method === 'POST') {
    const body = await readBody(req);
    const platform = inferPlatform(body.platform, body.url);
    const adapter = getCollector(platform);
    if (!adapter) return json(res, 400, { error: `不支持的采集平台: ${platform || '(空)'}` });
    if (configContainsSecret(body.config)) return json(res, 400, { error: '认证信息请放在 auth 字段，不要写入平台配置' });
    const draft = {
      platform,
      name: String(body.name || platform).trim(),
      url: validateSourceUrl(body.url, { allowEmpty: true }),
      config: normalizePlatformConfig(platform, body.config && typeof body.config === 'object' ? body.config : {}, body.url, body.platform),
      enabled: body.enabled !== false,
    };
    adapter.validateSource?.(draft);
    const source = collectionSources.upsert(draft);
    if (body.auth !== undefined) collectionAuth.set(source.id, body.auth, { label: String(body.authLabel || '').trim() });
    logs.add('manual', `新增/更新采集源「${source.name}」(${source.platform})`);
    return json(res, 200, { ...source, auth: collectionAuth.status(source.id) });
  }

  // PATCH /api/collections/sources/:id
  if (route.length === 3 && route[0] === 'collections' && route[1] === 'sources' && method === 'PATCH') {
    const source = collectionSources.get(Number(route[2]));
    if (!source) return json(res, 404, { error: '采集源不存在' });
    const body = await readBody(req);
    if (body.config !== undefined && configContainsSecret(body.config)) return json(res, 400, { error: '认证信息请放在 auth 字段，不要写入平台配置' });
    if (body.url !== undefined || body.config !== undefined) {
      const nextUrl = body.url === undefined ? source.url : validateSourceUrl(body.url, { allowEmpty: source.platform === 'web' });
      const draft = {
        ...source,
        url: nextUrl,
        config: normalizePlatformConfig(
          source.platform,
          body.config === undefined ? source.config : (body.config && typeof body.config === 'object' ? body.config : {}),
          nextUrl,
        ),
      };
      getCollector(source.platform)?.validateSource?.(draft);
      collectionSources.upsert(draft);
    }
    if (body.auth !== undefined) collectionAuth.set(source.id, body.auth, { label: String(body.authLabel || '').trim() });
    if (body.enabled !== undefined) collectionSources.setEnabled(source.id, !!body.enabled);
    return json(res, 200, { ...collectionSources.get(source.id), auth: collectionAuth.status(source.id) });
  }

  // DELETE /api/collections/sources/:id
  if (route.length === 3 && route[0] === 'collections' && route[1] === 'sources' && method === 'DELETE') {
    const source = collectionSources.get(Number(route[2]));
    if (!source) return json(res, 404, { error: '采集源不存在' });
    collectionSources.remove(source.id);
    logs.add('manual', `删除采集源「${source.name}」`);
    return json(res, 200, { ok: true });
  }

  // GET /api/collections/sources/:id/auth
  if (route.length === 4 && route[0] === 'collections' && route[1] === 'sources' && route[3] === 'auth' && method === 'GET') {
    if (!collectionSources.get(Number(route[2]))) return json(res, 404, { error: '采集源不存在' });
    return json(res, 200, collectionAuth.status(Number(route[2])));
  }

  // PUT /api/collections/sources/:id/auth
  if (route.length === 4 && route[0] === 'collections' && route[1] === 'sources' && route[3] === 'auth' && method === 'PUT') {
    const source = collectionSources.get(Number(route[2]));
    if (!source) return json(res, 404, { error: '采集源不存在' });
    const body = await readBody(req);
    const status = collectionAuth.set(source.id, body, { label: String(body.label || '').trim() });
    logs.add('manual', `更新采集源认证「${source.name}」`);
    return json(res, 200, status);
  }

  // DELETE /api/collections/sources/:id/auth
  if (route.length === 4 && route[0] === 'collections' && route[1] === 'sources' && route[3] === 'auth' && method === 'DELETE') {
    collectionAuth.remove(Number(route[2]));
    return json(res, 200, { ok: true });
  }

  // POST /api/collections/sources/:id/refresh：配置保存后的轻量刷新确认
  if (route.length === 4 && route[0] === 'collections' && route[1] === 'sources' && route[3] === 'refresh' && method === 'POST') {
    const source = collectionSources.get(Number(route[2]));
    if (!source) return json(res, 404, { error: '采集源不存在' });
    const probe = await probeSource(source.id);
    return json(res, 200, {
      source, auth: collectionAuth.status(source.id), refreshedAt: new Date().toISOString(), probe,
    });
  }

  // GET /api/collections/rules
  if (route.length === 2 && route[0] === 'collections' && route[1] === 'rules' && method === 'GET') {
    return json(res, 200, { items: collectionRules.list({ platform: query.platform || undefined }) });
  }

  // POST /api/collections/rules
  if (route.length === 2 && route[0] === 'collections' && route[1] === 'rules' && method === 'POST') {
    const body = await readBody(req);
    const source = collectionSources.get(Number(body.sourceId));
    if (!source) return json(res, 400, { error: '采集源不存在' });
    let match;
    try { match = validateMatch(body.match || {}); } catch (error) { return json(res, 400, { error: error.message }); }
    const options = body.options && typeof body.options === 'object' && !Array.isArray(body.options) ? body.options : {};
    try {
      getCollector(source.platform)?.validateRule?.({
        kind: body.kind, value: body.value, name: body.name, interval_min: body.intervalMin,
        options, match,
      });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
    const rule = collectionRules.upsert({
      id: body.id,
      sourceId: Number(body.sourceId),
      name: body.name,
      kind: body.kind,
      value: body.value,
      intervalMin: body.intervalMin,
      enabled: body.enabled !== false,
      options,
      match,
      notify: body.notify === undefined ? true : body.notify !== false,
      notifyUpdates: body.notifyUpdates === true,
    });
    if (body.intervalMin !== undefined && rule.interval_min > 0 && !rule.next_run_at) {
      collectionRules.setSchedule(rule.id, {
        lastRunAt: rule.last_run_at,
        nextRunAt: new Date(Date.now() + rule.interval_min * 60000).toISOString(),
      });
    }
    logs.add('manual', `新增/更新采集规则「${rule.name || rule.value || rule.kind}」`);
    return json(res, 200, collectionRules.get(rule.id));
  }

  // PATCH /api/collections/rules/:id
  if (route.length === 3 && route[0] === 'collections' && route[1] === 'rules' && method === 'PATCH') {
    const rule = collectionRules.get(Number(route[2]));
    if (!rule) return json(res, 404, { error: '采集规则不存在' });
    const body = await readBody(req);
    let match = rule.match || {};
    if (body.match !== undefined) {
      try { match = validateMatch(body.match); } catch (error) { return json(res, 400, { error: error.message }); }
    }
    const options = body.options === undefined ? (rule.options || {}) : body.options;
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      return json(res, 400, { error: '规则 options 必须是对象' });
    }
    const kind = body.kind === undefined ? rule.kind : body.kind;
    const value = body.value === undefined ? rule.value : body.value;
    const intervalMin = body.intervalMin === undefined ? rule.interval_min : body.intervalMin;
    try {
      getCollector(rule.platform)?.validateRule?.({
        kind, value, name: body.name === undefined ? rule.name : body.name,
        interval_min: intervalMin, options, match,
      });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
    const updated = collectionRules.upsert({
      id: rule.id,
      sourceId: rule.source_id,
      name: body.name === undefined ? rule.name : body.name,
      kind,
      value,
      intervalMin,
      enabled: body.enabled === undefined ? rule.enabled : !!body.enabled,
      options,
      match,
      notify: body.notify === undefined ? rule.notify : body.notify !== false,
      notifyUpdates: body.notifyUpdates === undefined ? rule.notify_updates : body.notifyUpdates === true,
    });
    if (body.intervalMin !== undefined) {
      collectionRules.setSchedule(rule.id, {
        lastRunAt: rule.last_run_at,
        nextRunAt: Number(intervalMin) > 0 ? new Date(Date.now() + Number(intervalMin) * 60000).toISOString() : null,
      });
    }
    return json(res, 200, collectionRules.get(updated.id));
  }

  // DELETE /api/collections/rules/:id
  if (route.length === 3 && route[0] === 'collections' && route[1] === 'rules' && method === 'DELETE') {
    collectionRules.remove(Number(route[2]));
    return json(res, 200, { ok: true });
  }

  // POST /api/collections/runs {mode: scheduled|manual|emergency, sourceId, ruleId, keyword, platform, url}
  if (route.length === 2 && route[0] === 'collections' && route[1] === 'runs' && method === 'POST') {
    const body = await readBody(req);
    const mode = (body.mode === 'manual' || body.mode === 'emergency') ? 'manual' : 'scheduled';
    try {
      const result = enqueueCollections({
        mode,
        sourceId: body.sourceId == null ? undefined : Number(body.sourceId),
        ruleId: body.ruleId == null ? undefined : Number(body.ruleId),
        keyword: body.keyword,
        platform: body.platform,
        url: body.url,
        name: body.name,
      });
      return json(res, 202, {
        ok: true,
        mode,
        jobs: result.jobs,
        coalesced: result.coalesced || 0,
        message: mode === 'scheduled'
          ? `已检查定时规则，入队 ${result.jobs.length} 个任务`
          : `已入队 ${result.jobs.length} 个采集任务`,
      });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  // GET /api/collections/jobs
  if (route.length === 2 && route[0] === 'collections' && route[1] === 'jobs' && method === 'GET') {
    const filters = {
      status: query.status || undefined,
      sourceId: query.sourceId == null ? undefined : Number(query.sourceId),
      platform: query.platform || undefined,
      mode: query.mode || undefined,
    };
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));
    const offset = Math.max(0, Number(query.offset) || 0);
    return json(res, 200, {
      items: listCollectionJobs({ ...filters, limit, offset }).items,
      total: countJobs(filters),
      limit,
      offset,
    });
  }

  // GET /api/collections/jobs/:id
  if (route.length === 3 && route[0] === 'collections' && route[1] === 'jobs' && method === 'GET') {
    const job = getCollectionJob(Number(route[2]));
    if (!job) return json(res, 404, { error: '采集任务不存在' });
    return json(res, 200, { job });
  }

  // POST /api/collections/jobs/:id/retry
  if (route.length === 4 && route[0] === 'collections' && route[1] === 'jobs' && route[3] === 'retry' && method === 'POST') {
    try {
      const job = retryJob(Number(route[2]));
      if (!job) return json(res, 404, { error: '采集任务不存在' });
      logs.add('manual', `重试采集任务 #${job.id}`);
      return json(res, 200, { job });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  // POST /api/collections/jobs/:id/cancel
  if (route.length === 4 && route[0] === 'collections' && route[1] === 'jobs' && route[3] === 'cancel' && method === 'POST') {
    const job = cancelJob(Number(route[2]));
    if (!job) return json(res, 404, { error: '采集任务不存在' });
    logs.add('manual', `取消采集任务 #${job.id}`);
    return json(res, 200, { job });
  }

  // GET /api/collections/health
  if (route.length === 2 && route[0] === 'collections' && route[1] === 'health' && method === 'GET') {
    return json(res, 200, collectionHealth());
  }

  // GET /api/collections/runs
  if (route.length === 2 && route[0] === 'collections' && route[1] === 'runs' && method === 'GET') {
    return json(res, 200, { items: collectionRuns.list({ limit: Number(query.limit) || 100, sourceId: query.sourceId, platform: query.platform }), running: isCollectionRunning(), status: collectionStatus() });
  }

  // GET /api/collections/runs/:id
  if (route.length === 3 && route[0] === 'collections' && route[1] === 'runs' && method === 'GET') {
    const run = collectionRuns.get(Number(route[2]));
    if (!run) return json(res, 404, { error: '采集运行记录不存在' });
    return json(res, 200, run);
  }

  // GET /api/collections/notifications/unread-count
  if (route.length === 3 && route[0] === 'collections' && route[1] === 'notifications' && route[2] === 'unread-count' && method === 'GET') {
    return json(res, 200, collectionNotifications.unreadCount());
  }

  // GET /api/collections/notifications
  if (route.length === 2 && route[0] === 'collections' && route[1] === 'notifications' && method === 'GET') {
    const unread = query.unread == null ? undefined : (query.unread === 'true' || query.unread === '1');
    const filters = {
      platform: query.platform || undefined,
      unread,
    };
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));
    const offset = Math.max(0, Number(query.offset) || 0);
    return json(res, 200, {
      items: collectionNotifications.list({ ...filters, limit, offset }),
      total: collectionNotifications.count(filters),
      unreadTotal: collectionNotifications.count({ platform: filters.platform, unread: true }),
      limit,
      offset,
    });
  }

  // POST /api/collections/notifications/read-all
  if (route.length === 3 && route[0] === 'collections' && route[1] === 'notifications' && route[2] === 'read-all' && method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, { ok: true, ...collectionNotifications.markAllRead({ platform: body.platform || undefined }) });
  }

  // POST /api/collections/notifications/:id/read
  if (route.length === 4 && route[0] === 'collections' && route[1] === 'notifications' && route[3] === 'read' && method === 'POST') {
    const notification = collectionNotifications.markRead(Number(route[2]));
    if (!notification) return json(res, 404, { error: '通知不存在' });
    return json(res, 200, { notification });
  }

  // GET /api/collections/items/:id
  if (route.length === 3 && route[0] === 'collections' && route[1] === 'items' && method === 'GET') {
    const item = collectionItems.get(Number(route[2]));
    if (!item) return json(res, 404, { error: '采集内容不存在' });
    return json(res, 200, { item });
  }

  // DELETE /api/collections/items/:id
  if (route.length === 3 && route[0] === 'collections' && route[1] === 'items' && method === 'DELETE') {
    if (!collectionItems.get(Number(route[2]))) return json(res, 404, { error: '采集内容不存在' });
    collectionItems.remove(Number(route[2]));
    logs.add('manual', `删除采集内容 #${route[2]}`);
    return json(res, 200, { ok: true });
  }

  // GET /api/collections/items
  if (route.length === 2 && route[0] === 'collections' && route[1] === 'items' && method === 'GET') {
    const categoryValue = Number(query.categoryId);
    const filters = {
      q: query.q || '',
      platform: query.platform || undefined,
      sourceId: query.sourceId == null ? undefined : Number(query.sourceId),
      complete: query.complete == null ? undefined : query.complete === 'true',
      categoryId: Number.isFinite(categoryValue) && categoryValue > 0 ? categoryValue : undefined,
      tag: String(query.tag || '').trim() || undefined,
    };
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));
    const offset = Math.max(0, Number(query.offset) || 0);
    return json(res, 200, {
      items: collectionItems.list({ ...filters, limit, offset }),
      total: collectionItems.count(filters),
      limit,
      offset,
    });
  }

  // POST /api/run/now
  if (route.length === 2 && route[0] === 'run' && route[1] === 'now' && method === 'POST') {
    if (isPipelineRunning()) return json(res, 409, { error: '流水线正在运行中' });
    runPipeline().then((s) => console.log('[run/now]', s)).catch(() => {});
    return json(res, 202, { message: '已触发抓取+分析流水线' });
  }

  // POST /api/run/scrape-only  (仅抓取)
  if (route.length === 2 && route[0] === 'run' && route[1] === 'scrape' && method === 'POST') {
    if (isPipelineRunning()) return json(res, 409, { error: '流水线正在运行中' });
    runPipeline({ analyze: false }).then(() => {}).catch(() => {});
    return json(res, 202, { message: '已触发抓取' });
  }

  // GET /api/tweets
  if (route.length === 1 && route[0] === 'tweets' && method === 'GET') {
    const list = tweets.list({
      limit: Math.min(200, Number(query.limit) || 100),
      q: query.q || '',
    });
    return json(res, 200, { items: list });
  }

  // GET /api/materials
  if (route.length === 1 && route[0] === 'materials' && method === 'GET') {
    const list = materials.list({
      status: query.status || 'all',
      q: query.q || '',
      limit: Math.min(200, Number(query.limit) || 100),
      offset: Number(query.offset) || 0,
    });
    return json(res, 200, { items: list });
  }

  // GET /api/materials/:id
  if (route.length === 2 && route[0] === 'materials' && method === 'GET') {
    const m = materials.get(Number(route[1]));
    if (!m) return json(res, 404, { error: '素材不存在' });
    return json(res, 200, m);
  }

  // POST /api/materials/:id/approve | reject
  if (route.length === 3 && route[0] === 'materials' && ['approve', 'reject'].includes(route[2]) && method === 'POST') {
    const m = materials.get(Number(route[1]));
    if (!m) return json(res, 404, { error: '素材不存在' });
    const status = route[2] === 'approve' ? 'approved' : 'rejected';
    materials.setStatus(m.id, status);
    logs.add('manual', `${route[2] === 'approve' ? '确认' : '拒绝'}素材 #${m.id}「${m.title}」`);
    return json(res, 200, materials.get(m.id));
  }

  // POST /api/materials/:id/create  {type}
  if (route.length === 3 && route[0] === 'materials' && route[2] === 'create' && method === 'POST') {
    const m = materials.get(Number(route[1]));
    if (!m) return json(res, 404, { error: '素材不存在' });
    if (m.status !== 'approved') return json(res, 400, { error: '请先确认素材后再创作' });
    const { type } = await readBody(req);
    if (!['article', 'image', 'video_script'].includes(type)) {
      return json(res, 400, { error: 'type 必须是 article / image / video_script' });
    }
    const id = creations.insert(m.id, type);
    executeCreation(id, m.id, type).catch(() => {});
    return json(res, 202, { id, message: `已开始创作${contentTypeLabel(type)}` });
  }

  // GET /api/creations
  if (route.length === 1 && route[0] === 'creations' && method === 'GET') {
    return json(res, 200, { items: creations.list({ materialId: query.materialId ? Number(query.materialId) : undefined }) });
  }

  // GET /api/creations/:id
  if (route.length === 2 && route[0] === 'creations' && method === 'GET') {
    const c = creations.get(Number(route[1]));
    if (!c) return json(res, 404, { error: '创作记录不存在' });
    return json(res, 200, c);
  }

  // POST /api/creations/:id/retry
  if (route.length === 3 && route[0] === 'creations' && route[2] === 'retry' && method === 'POST') {
    const c = creations.get(Number(route[1]));
    if (!c) return json(res, 404, { error: '创作记录不存在' });
    const id = creations.insert(c.material_id, c.content_type);
    executeCreation(id, c.material_id, c.content_type).catch(() => {});
    return json(res, 202, { id, message: '已重新开始创作' });
  }

  // GET /api/accounts
  if (route.length === 1 && route[0] === 'accounts' && method === 'GET') {
    return json(res, 200, { items: accounts.list() });
  }

  // POST /api/accounts {username, display_name}
  if (route.length === 1 && route[0] === 'accounts' && method === 'POST') {
    const body = await readBody(req);
    const username = String(body.username || '').trim().replace(/^@/, '');
    if (!username) return json(res, 400, { error: '用户名不能为空' });
    const acc = accounts.upsert(username, String(body.display_name || '').trim());
    logs.add('manual', `新增监控账号 @${username}`);
    return json(res, 200, acc);
  }

  // DELETE /api/accounts/:id
  if (route.length === 2 && route[0] === 'accounts' && method === 'DELETE') {
    accounts.remove(Number(route[1]));
    return json(res, 200, { ok: true });
  }

  // PATCH /api/accounts/:id {enabled}
  if (route.length === 2 && route[0] === 'accounts' && method === 'PATCH') {
    const body = await readBody(req);
    accounts.setEnabled(Number(route[1]), !!body.enabled);
    return json(res, 200, { ok: true });
  }

  // GET /api/settings
  if (route.length === 1 && route[0] === 'settings' && method === 'GET') {
    return json(res, 200, {
      env: {
        LLM_BASE_URL: config.llm.baseUrl,
        LLM_MODEL: config.llm.model,
        LLM_API_KEY_SET: !!config.llm.apiKey,
        ANALYZE_THRESHOLD: config.analyzeThreshold,
        SCRAPE_INTERVAL_MIN: config.scrapeIntervalMin,
        SCRAPE_PER_ACCOUNT: config.scrapePerAccount,
        SCRAPE_MODE: config.scrapeMode,
        MONITOR_ACCOUNTS: config.monitorAccounts.join(','),
      },
      db: settings.all(),
    });
  }

  // PUT /api/settings  (写入 .env 并热更新)
  if (route.length === 1 && route[0] === 'settings' && method === 'PUT') {
    const body = await readBody(req);
    const updates = {};
    const STR_KEYS = ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY', 'SCRAPE_MODE', 'MONITOR_ACCOUNTS'];
    const NUM_KEYS = ['ANALYZE_THRESHOLD', 'SCRAPE_INTERVAL_MIN', 'SCRAPE_PER_ACCOUNT'];
    for (const k of STR_KEYS) {
      if (body[k] !== undefined) updates[k] = String(body[k]).trim();
    }
    for (const k of NUM_KEYS) {
      if (body[k] !== undefined) updates[k] = String(Number(body[k]));
    }
    // 写 .env
    saveEnvValues(updates);
    // 热更新内存配置
    if (updates.LLM_BASE_URL) config.llm.baseUrl = updates.LLM_BASE_URL.replace(/\/+$/, '');
    if (updates.LLM_MODEL) config.llm.model = updates.LLM_MODEL;
    if (updates.LLM_API_KEY !== undefined) config.llm.apiKey = updates.LLM_API_KEY;
    if (updates.ANALYZE_THRESHOLD) config.analyzeThreshold = Number(updates.ANALYZE_THRESHOLD);
    if (updates.SCRAPE_INTERVAL_MIN) {
      config.scrapeIntervalMin = Math.max(1, Number(updates.SCRAPE_INTERVAL_MIN));
    }
    if (updates.SCRAPE_PER_ACCOUNT) config.scrapePerAccount = Number(updates.SCRAPE_PER_ACCOUNT);
    if (updates.SCRAPE_MODE) config.scrapeMode = updates.SCRAPE_MODE;
    if (updates.MONITOR_ACCOUNTS !== undefined) {
      config.monitorAccounts = updates.MONITOR_ACCOUNTS.split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
    }
    logs.add('manual', '更新了系统设置');
    return json(res, 200, { ok: true, updated: Object.keys(updates) });
  }

  // POST /api/llm/ping
  if (route.length === 2 && route[0] === 'llm' && route[1] === 'ping' && method === 'POST') {
    try {
      await pingLLM();
      return json(res, 200, { ok: true, message: `LLM 连接正常 (${config.llm.model})` });
    } catch (err) {
      return json(res, 200, { ok: false, message: err.message });
    }
  }

  // GET /api/logs
  if (route.length === 1 && route[0] === 'logs' && method === 'GET') {
    return json(res, 200, { items: logs.list(Number(query.limit) || 100) });
  }

  // POST /api/logs/clear
  if (route.length === 2 && route[0] === 'logs' && route[1] === 'clear' && method === 'POST') {
    db.exec('DELETE FROM run_logs');
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: '接口不存在' });
}

// ---------- 启动 ----------
export function startServer() {
  const server = http.createServer(async (req, res) => {
    const { pathname, query } = getParams(req.url || '/');
    try {
      if (pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, { pathname, query });
        if (!handled) json(res, 404, { error: '接口不存在' });
      } else {
        serveStatic(req, res, pathname);
      }
    } catch (err) {
      if (!res.headersSent) json(res, 400, { error: err.message });
      else res.end();
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`
  ❌ 端口 ${config.port} 已被占用（可能已有 X-Monitor 实例在运行）
  解决办法：
    1. 若已有一个实例在跑，直接用浏览器访问 http://localhost:${config.port} 即可，无需重复启动；
    2. 或先停掉旧实例再启动：
       lsof -ti :${config.port} | xargs kill -9
       npm start
    3. 或换一个端口启动：
       PORT=8080 npm start`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(config.port, config.host, () => {
    console.log(`\n  ⚡ X-Monitor 已启动`);
    console.log(`  🌐 界面:  http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    console.log(`  📡 抓取模式: ${resolveMode()} (auto=有登录账号则真实抓取，否则演示数据)`);
    console.log(`  🤖 LLM: ${config.llm.baseUrl} / ${config.llm.model}${config.llm.apiKey ? '' : ' (未配置 Key)'}`);
    console.log(`\n`);
  });
  return server;
}
