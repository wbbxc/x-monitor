// Python/子进程 JSONL 桥：逐行解析、超时、取消、stderr 诊断，密钥只走 stdin。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from '../config.js';

function killQuietly(child) {
  try { child.kill('SIGKILL'); } catch {}
}

/**
 * 运行一个输出 JSONL 的子进程。
 * @returns {Promise<{items:object[], diagnostics:string[], stderr:string, code:number|null}>}
 */
export function runJsonlCommand({
  command, args = [], cwd = config.pythonDir, env = {}, input = null,
  timeoutMs = 120_000, signal,
} = {}) {
  if (!command) return Promise.reject(new Error('缺少子进程命令'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const items = [];
    const diagnostics = [];
    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      killQuietly(child);
      const error = new Error('采集子进程已取消');
      error.code = 'CANCELED';
      finish(reject, error);
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, { once: true });

    timer = setTimeout(() => {
      killQuietly(child);
      const error = new Error(`采集子进程超时（${timeoutMs}ms）`);
      error.code = 'PYTHON_TIMEOUT';
      finish(reject, error);
    }, Math.max(1_000, Number(timeoutMs) || 120_000));
    timer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        try {
          const value = JSON.parse(text);
          if (value && typeof value === 'object') items.push(value);
          else diagnostics.push(String(value));
        } catch {
          diagnostics.push(text.slice(0, 500));
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      for (const line of String(chunk).split(/\r?\n/)) {
        const text = line.trim();
        if (text.startsWith('#')) diagnostics.push(text.slice(1).trim());
      }
    });
    child.once('error', (error) => {
      const wrapped = new Error(`无法启动采集子进程: ${error.message}`);
      wrapped.code = 'PYTHON_SPAWN';
      finish(reject, wrapped);
    });
    child.once('close', (code) => {
      if (stdoutBuffer.trim()) {
        try {
          const value = JSON.parse(stdoutBuffer.trim());
          if (value && typeof value === 'object') items.push(value);
        } catch {
          diagnostics.push(stdoutBuffer.trim().slice(0, 500));
        }
      }
      if (code !== 0) {
        const message = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join('；') || `退出码 ${code}`;
        const error = new Error(`采集子进程失败：${message.slice(0, 800)}`);
        error.code = 'PYTHON_FAILED';
        error.stderr = stderr;
        error.diagnostics = diagnostics;
        finish(reject, error);
        return;
      }
      finish(resolve, { items, diagnostics, stderr, code });
    });

    if (input != null) child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
    else child.stdin.end();
  });
}

export function runPythonJsonl({ script, args = [], input = null, timeoutMs, signal, env } = {}) {
  return runJsonlCommand({
    command: config.pythonBin,
    args: [path.join(config.pythonDir, script), ...args],
    cwd: config.pythonDir,
    input,
    timeoutMs,
    signal,
    env,
  });
}
