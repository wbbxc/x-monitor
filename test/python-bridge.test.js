// JSONL 子进程桥：成功、失败、超时、取消和 stdin。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runJsonlCommand } from '../src/collectors/python.js';

const node = process.execPath;

test('JSONL 桥解析 stdout、诊断和 stdin', async () => {
  const script = `
    const fs = require('node:fs');
    const input = fs.readFileSync(0, 'utf8');
    console.error('# diagnostic line');
    console.log(JSON.stringify({ ok: true, input }));
    console.log(JSON.stringify({ ok: false, index: 2 }));
  `;
  const result = await runJsonlCommand({
    command: node,
    args: ['-e', script],
    input: { hello: '世界' },
    timeoutMs: 5000,
    cwd: process.cwd(),
  });
  assert.equal(result.items.length, 2);
  assert.deepEqual(JSON.parse(result.items[0].input), { hello: '世界' });
  assert.ok(result.diagnostics.some((line) => line.includes('diagnostic')));
});

test('JSONL 桥把非零退出转换成可读错误', async () => {
  await assert.rejects(
    runJsonlCommand({
      command: node,
      args: ['-e', 'console.error("boom"); process.exit(3);'],
      timeoutMs: 5000,
      cwd: process.cwd(),
    }),
    /boom/,
  );
});

test('JSONL 桥超时会终止子进程', async () => {
  await assert.rejects(
    runJsonlCommand({
      command: node,
      args: ['-e', 'setTimeout(() => {}, 5000);'],
      timeoutMs: 1000,
      cwd: process.cwd(),
    }),
    /超时/,
  );
});

test('JSONL 桥支持 AbortSignal 取消', async () => {
  const controller = new AbortController();
  const promise = runJsonlCommand({
    command: node,
    args: ['-e', 'setTimeout(() => {}, 5000);'],
    timeoutMs: 5000,
    signal: controller.signal,
    cwd: process.cwd(),
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(promise, /取消/);
});
