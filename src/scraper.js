// 抓取模块：调用 Python worker (twscrape / mock) 获取推文
import { spawn } from 'node:child_process';
import { config, readXAccounts } from './config.js';

function hasRealAccounts() {
  return readXAccounts().accounts.length > 0;
}

/** 根据配置决定本次抓取模式 */
export function resolveMode() {
  if (config.scrapeMode === 'real') return 'real';
  if (config.scrapeMode === 'mock') return 'mock';
  return hasRealAccounts() ? 'real' : 'mock';
}

/**
 * 执行一次抓取。
 * @param {string[]} usernames 监控账号
 * @returns {Promise<{ok:boolean, mode:string, tweets:object[], error?:string}>}
 */
export function runScrape(usernames) {
  const mode = resolveMode();
  return new Promise((resolve) => {
    if (!usernames.length) {
      return resolve({ ok: true, mode, tweets: [] });
    }
    const args = [
      'worker.py', 'fetch',
      '--accounts', usernames.join(','),
      '--per', String(config.scrapePerAccount),
      '--mode', mode,
    ];
    const child = spawn(config.pythonBin, args, { cwd: config.pythonDir });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60 * 1000);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 提取 worker 的诊断信息（登录状态等，以 # 开头）
      const warnings = err
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('#'))
        .slice(-20);
      if (code !== 0) {
        return resolve({
          ok: false, mode, tweets: [],
          error: (err || `worker 退出码 ${code}`).trim().slice(0, 600),
          warnings,
        });
      }
      const tweets = out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter((t) => t && t.id && t.text);
      resolve({ ok: true, mode, tweets, warnings });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, mode, tweets: [], error: `无法启动 Python worker: ${e.message}` });
    });
  });
}
