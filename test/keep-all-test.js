// keep-all 分支功能测试：mock LLM 返回低价值结果，验证推文仍全部入库
process.env.LLM_BASE_URL = 'http://127.0.0.1:3998/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';
process.env.SCRAPE_MODE = 'mock';

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 使用独立数据目录，避免依赖本机运行时库里的未分析推文
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmonitor-keepall-'));
process.env.DATA_DIR = dataDir;

// 动态 import：确保 config.js 读取到上面设置的环境变量
const dbMod = await import('../src/db.js');
const { default: db } = dbMod;
const { tweets, materials } = dbMod;
const { analyzeNewTweets } = await import('../src/analyzer.js');

// mock LLM：永远返回 低适合度 + 低评分
const LOW = JSON.stringify({
  suitable: false, score: 8, title: '【低价值测试】纯水内容',
  summary: '模拟 LLM 判定为低价值', category: '其他',
  tags: ['测试'], suggested_types: [], reason: '测试：低评分不应被过滤',
});
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: LOW } }] }));
  });
});
await new Promise((r) => server.listen(3998, r));

const TEST_IDS = ['KEEPTEST1', 'KEEPTEST2', 'KEEPTEST3'];
let ok = false;
try {
  for (const id of TEST_IDS) {
    tweets.insert({ id, author_username: 'tester', author_name: 'T', text: '低价值测试内容' + id, tweet_created_at: '2026-01-01T00:00:00+00:00', is_mock: 1 });
  }
  const r = await analyzeNewTweets(tweets, materials);
  console.log('分析结果:', JSON.stringify(r));

  const m = materials.list({ q: '低价值测试内容' });
  console.log(`入库素材数: ${m.length}（预期 3）`);
  console.log(`状态: ${m.map((x) => x.status).join(', ')}（预期全部 pending）`);
  ok = r.added === 3 && r.skipped === 0 && m.length === 3 && m.every((x) => x.status === 'pending');
  console.log(ok ? '✅ 通过：低价值推文也全部进入素材库，交由人工决断' : '❌ 失败');
} catch (e) {
  console.error('测试异常:', e.message);
} finally {
  db.exec(`DELETE FROM materials WHERE tweet_id IN ('${TEST_IDS.join("','")}')`);
  db.exec(`DELETE FROM tweets WHERE id IN ('${TEST_IDS.join("','")}')`);
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
