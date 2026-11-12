// X-Monitor 入口
import { startServer } from './server.js';
import { startScheduler, stopScheduler, seedDefaultAccounts } from './scheduler.js';
import { migrateLinuxdoYaml } from './collector-migrate.js';
import { config } from './config.js';

console.log('── X-Monitor · AI 账号监控 & 创意素材系统 ──');
console.log(`数据目录: ${config.dataDir}`);
console.log(`Python: ${config.pythonBin}`);
if (!config.llm.apiKey) {
  console.log('⚠️  未配置 LLM_API_KEY —— 素材分析与创作功能将不可用（可在界面「设置」中填写）');
}

seedDefaultAccounts();
try {
  const migration = migrateLinuxdoYaml();
  if (!migration.skipped) console.log(`[migrate] linux.do YAML → SQLite：${migration.migrated} 条规则`);
} catch (error) {
  console.error('[migrate] linux.do YAML 迁移失败，保留 YAML 供重试：', error.message);
}
const server = startServer();
startScheduler();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] 收到 ${signal}，正在停止采集任务并关闭服务…`);
  const force = setTimeout(() => {
    console.error('[shutdown] 优雅退出超时，强制结束');
    process.exit(1);
  }, 20_000);
  force.unref?.();
  try {
    await stopScheduler();
  } catch (error) {
    console.error('[shutdown] 停止调度失败：', error.message);
  }
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
    setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, 2_000).unref?.();
  });
  clearTimeout(force);
  console.log('[shutdown] 已退出');
  process.exit(0);
}

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
