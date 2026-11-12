// 配置加载：.env + 环境变量 + 默认值
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 极简 .env 解析（避免额外依赖）
export function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // 去掉可选引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export const ENV_FILE = process.env.XMONITOR_ENV_FILE
  ? path.resolve(process.env.XMONITOR_ENV_FILE) : path.join(ROOT, '.env');

loadEnvFile(ENV_FILE);

export function saveEnvValues(updates) {
  let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z_0-9]*$/.test(key) || /[\r\n\0]/.test(String(value))) {
      throw new Error('环境配置名称或值无效');
    }
    const line = `${key}=${String(value)}`;
    const expression = new RegExp(`^${key}=.*$`, 'm');
    if (expression.test(content)) content = content.replace(expression, () => line);
    else content += (content.endsWith('\n') || !content ? '' : '\n') + line + '\n';
  }
  const temporary = `${ENV_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, ENV_FILE);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  for (const [key, value] of Object.entries(updates)) process.env[key] = String(value);
}

export function readXAccounts() {
  const raw = process.env.X_ACCOUNTS_JSON;
  let value;
  try {
    value = raw?.trim() ? JSON.parse(raw)
      : (fs.existsSync(TWSCRAPE_ACCOUNTS_FILE) ? JSON.parse(fs.readFileSync(TWSCRAPE_ACCOUNTS_FILE, 'utf8')) : []);
  } catch {
    throw new Error('X_ACCOUNTS_JSON 或旧账号文件必须为合法 JSON');
  }
  const result = Array.isArray(value) ? { accounts: value } : value;
  if (!result || !Array.isArray(result.accounts) || result.accounts.some(account =>
    !account || typeof account !== 'object' || typeof account.username !== 'string' || !account.username.trim())) {
    throw new Error('X_ACCOUNTS_JSON 必须为账号数组或含 accounts 数组的对象');
  }
  return result;
}

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const config = {
  root: ROOT,
  port: num(process.env.PORT, 3081),
  // 默认只监听本机，避免采集/认证接口暴露到局域网；需要局域网访问时显式设置 HOST=0.0.0.0。
  host: process.env.HOST || '127.0.0.1',

  llm: {
    baseUrl: (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'deepseek-chat',
    // 是否在请求中附带 Authorization（某些本地网关无需 Key）
    requireKey: (process.env.LLM_REQUIRE_KEY ?? 'true') === 'true',
  },

  analyzeThreshold: num(process.env.ANALYZE_THRESHOLD, 60),
  scrapeIntervalMin: num(process.env.SCRAPE_INTERVAL_MIN, 30),
  scrapePerAccount: num(process.env.SCRAPE_PER_ACCOUNT, 10),
  monitorAccounts: (process.env.MONITOR_ACCOUNTS || 'karpathy,sama,ylecun,AndrewYNg,OpenAI,GoogleDeepMind,AnthropicAI,huggingface')
    .split(',')
    .map((s) => s.trim().replace(/^@/, ''))
    .filter(Boolean),

  // auto | mock | real
  scrapeMode: (process.env.SCRAPE_MODE || 'auto').toLowerCase(),

  pythonDir: path.join(ROOT, 'python'),
  // 可在测试/隔离部署中覆盖数据目录；默认路径保持兼容。
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data'),

  // 外部情报采集。WEB_COLLECT_INTERVAL_MIN 默认每 6 小时，HF 默认每天一次。
  collector: {
    proxy: process.env.COLLECTOR_PROXY || process.env.X_PROXY || '',
    masterKey: process.env.COLLECTOR_MASTER_KEY || '',
    webIntervalMin: Math.max(1, num(process.env.WEB_COLLECT_INTERVAL_MIN, 360)),
    webMaxItemsPerKeyword: Math.max(1, num(process.env.WEB_MAX_ITEMS_PER_KEYWORD, 100)),
    hfIntervalHours: Math.max(1, num(process.env.HF_SYNC_INTERVAL_HOURS, 24)),
    hfEnabled: (process.env.HF_SYNC_ENABLED ?? 'true') === 'true',
    hfPageSize: Math.min(1000, Math.max(1, num(process.env.HF_PAGE_SIZE, 100))),
    // 0 表示不设上限，沿 Link 头同步到末页；设置正数可用于受限网络的分批运行。
    hfMaxPagesPerRun: Math.max(0, num(process.env.HF_MAX_PAGES_PER_RUN, 0)),
    timeoutMs: Math.max(1000, num(process.env.COLLECTOR_TIMEOUT_MS, 30000)),
    retries: Math.max(0, num(process.env.COLLECTOR_RETRIES, 2)),
    pollIntervalMin: Math.max(1, num(process.env.COLLECTOR_POLL_INTERVAL_MIN, 1)),
    // 内核 v2：持久化队列与 Worker。
    concurrency: Math.min(16, Math.max(1, num(process.env.COLLECTOR_CONCURRENCY, 3))),
    maxAttempts: Math.min(10, Math.max(1, num(process.env.COLLECTOR_MAX_ATTEMPTS, 3))),
    retryBaseMs: Math.min(60_000, Math.max(100, num(process.env.COLLECTOR_RETRY_BASE_MS, 2000))),
    retryMaxMs: Math.min(3_600_000, Math.max(1_000, num(process.env.COLLECTOR_RETRY_MAX_MS, 300_000))),
    leaseMs: Math.min(1_800_000, Math.max(10_000, num(process.env.COLLECTOR_LEASE_MS, 120_000))),
    jobTimeoutMs: Math.min(7_200_000, Math.max(10_000, num(process.env.COLLECTOR_JOB_TIMEOUT_MS, 600_000))),
    planIntervalSeconds: process.env.COLLECTOR_POLL_INTERVAL_MIN
      ? Math.max(5, num(process.env.COLLECTOR_POLL_INTERVAL_MIN, 1) * 60)
      : Math.min(3600, Math.max(2, num(process.env.COLLECTOR_PLAN_INTERVAL_SECONDS, 15))),
    maxResponseBytes: Math.min(64 * 1024 * 1024, Math.max(64 * 1024, num(process.env.COLLECTOR_MAX_RESPONSE_BYTES, 8 * 1024 * 1024))),
    jobRetentionDays: Math.min(365, Math.max(1, num(process.env.COLLECTOR_JOB_RETENTION_DAYS, 30))),
    workerId: process.env.COLLECTOR_WORKER_ID || '',
    arxivMaxResults: Math.min(2000, Math.max(1, num(process.env.ARXIV_MAX_RESULTS, 100))),
    forumMaxItems: Math.min(500, Math.max(1, num(process.env.FORUM_MAX_ITEMS, 100))),
    // 通用采集默认值。
    defaultMaxItems: Math.min(5000, Math.max(1, num(process.env.COLLECTOR_DEFAULT_MAX_ITEMS, 100))),
    notificationRetentionDays: Math.min(3650, Math.max(1, num(process.env.COLLECTOR_NOTIFICATION_RETENTION_DAYS, 30))),
    webCrawlDelayMs: Math.min(60_000, Math.max(0, num(process.env.COLLECTOR_WEB_CRAWL_DELAY_MS, 1000))),
    googleCseCx: process.env.GOOGLE_CSE_CX || '',
    hfBaseUrl: (process.env.HF_BASE_URL || 'https://huggingface.co').replace(/\/+$/, ''),
  },

  // 首次启动时初始化的关键词。留空则由界面手动添加。
  webDefaultKeywords: (process.env.WEB_DEFAULT_KEYWORDS || '').split(',').map((s) => s.trim()).filter(Boolean),

  // 自动探测 Python 解释器：项目自带 venv（含 twscrape）存在时优先使用
  pythonBin: (() => {
    const explicit = process.env.PYTHON_BIN;
    const venvCandidates = [
      path.join(ROOT, 'python', '.venv', 'bin', 'python'),
      path.join(ROOT, 'python', '.venv', 'Scripts', 'python.exe'), // Windows
    ];
    const venv = venvCandidates.find((c) => fs.existsSync(c));
    // 1) 显式指定了真实文件路径 → 尊重用户选择
    if (explicit && fs.existsSync(explicit)) return explicit;
    // 2) 项目 venv 存在 → 优先使用（保证 twscrape 可用）
    if (venv) return venv;
    // 3) 显式指定（可能是 PATH 命令）→ 使用之
    if (explicit) return explicit;
    // 4) 回退系统 python3
    return 'python3';
  })(),
};

export const DB_PATH = path.join(config.dataDir, 'xmonitor.db');
export const TWSCRAPE_ACCOUNTS_FILE = path.join(config.pythonDir, 'accounts.json');
