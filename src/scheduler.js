// 调度器：定时执行 抓取 → 分析 流水线
import { accounts, tweets, materials, logs } from './db.js';
import { runScrape } from './scraper.js';
import { analyzeNewTweets } from './analyzer.js';
import { config } from './config.js';
import { seedCollectionDefaults, startCollectionKernel, stopCollectionKernel, isCollectionRunning, collectionStatus } from './collection-engine.js';

let pipelineRunning = false;
let timer = null;
let lastRun = null;

/** 初始化默认监控账号（首次启动时） */
export function seedDefaultAccounts() {
  if (accounts.enabledList().length === 0 && config.monitorAccounts.length) {
    for (const u of config.monitorAccounts) {
      accounts.upsert(u);
    }
    logs.add('manual', `已初始化默认监控账号: ${config.monitorAccounts.join(', ')}`);
  }
}

/**
 * 执行完整流水线：抓取新推文 → LLM 分析 → 写入素材库
 * @param {{scrape?:boolean, analyze?:boolean}} opts
 */
export async function runPipeline(opts = {}) {
  const { scrape = true, analyze = true } = opts;
  if (pipelineRunning) {
    return { skipped: true, reason: '流水线正在运行中' };
  }
  pipelineRunning = true;
  const summary = { scraped: 0, newTweets: 0, analyzed: 0, added: 0, skipped: 0, mode: null, error: null };
  try {
    seedDefaultAccounts();

    if (scrape) {
      const names = accounts.enabledList().map((a) => a.username);
      const res = await runScrape(names);
      summary.mode = res.mode;
      if (!res.ok) {
        summary.error = res.error;
        logs.add('scrape', `抓取失败（模式=${res.mode}）: ${res.error}`, 'error');
      } else {
        let inserted = 0;
        for (const t of res.tweets) {
          if (!tweets.exists(t.id)) {
            const acc = accounts.list().find((a) => a.username === t.author_username);
            tweets.insert({ ...t, account_id: acc?.id ?? null });
            inserted++;
          }
        }
        summary.scraped = res.tweets.length;
        summary.newTweets = inserted;
        const warn = res.warnings?.length ? `｜${res.warnings.join('；')}` : '';
        logs.add('scrape', `模式=${res.mode}，抓到 ${res.tweets.length} 条，新增 ${inserted} 条${warn}`, inserted === 0 && res.tweets.length === 0 ? 'warn' : 'ok');
      }
    }

    if (analyze) {
      const r = await analyzeNewTweets(tweets, materials);
      summary.analyzed = r.analyzed;
      summary.added = r.added;
      summary.skipped = r.skipped;
      logs.add('analyze', `分析 ${r.analyzed} 条，新增素材 ${r.added} 条，重复 ${r.skipped} 条（全量收录，人工决断）`);
    }
  } catch (err) {
    summary.error = err.message;
    logs.add('pipeline', `流水线异常: ${err.message}`, 'error');
  } finally {
    pipelineRunning = false;
    lastRun = new Date().toISOString();
  }
  return summary;
}

/** 启动定时调度（每轮完成后按当前配置间隔重新排期，间隔修改即时生效） */
export function startScheduler() {
  seedDefaultAccounts();
  seedCollectionDefaults();
  runPipeline().catch(() => {}); // 启动后立即跑一轮
  startCollectionKernel();
  scheduleNext();
}

function scheduleNext() {
  if (timer) clearTimeout(timer);
  const minutes = Math.max(1, config.scrapeIntervalMin);
  timer = setTimeout(() => {
    runPipeline().catch((e) => console.error('[scheduler]', e));
    scheduleNext();
  }, minutes * 60 * 1000);
  timer.unref?.();
  console.log(`[scheduler] 已启动，每 ${minutes} 分钟抓取并分析一轮`);
}

export async function stopScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
  await stopCollectionKernel();
}

export function isPipelineRunning() {
  return pipelineRunning;
}

export function getLastRun() {
  return lastRun;
}

export { isCollectionRunning, collectionStatus };
