// 契约、认证、macos.do、V2EX 节点、GitHub Tags/401、Discord 探活与搜索。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmonitor-cover-'));
process.env.DATA_DIR = dataDir;
process.env.WEB_DEFAULT_KEYWORDS = '';
process.env.HF_SYNC_ENABLED = 'false';

const { validateAdapter, publicAdapter } = await import('../src/collectors/contract.js');
const {
  buildAuthHeaders, decryptSecret, encryptSecret, normalizeAuth, redactAuth,
} = await import('../src/collectors/auth.js');
const { collectSource } = await import('../src/collectors/framework.js');
const { probeSource } = await import('../src/collectors/runner.js');
const db = await import('../src/db.js');
const { config } = await import('../src/config.js');

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function response(body, status = 200, headers = {}) {
  return { status, headers, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

test('契约公开 ruleKinds/detect/publicFallback 但不暴露函数', () => {
  const adapter = validateAdapter({
    id: 'contract-test', version: 2, label: 'Contract',
    capabilities: ['keyword'], auth: { types: ['none', 'fields'] },
    ruleKinds: [{ kind: 'keyword', label: '关键词', requiresValue: true }, 'full'],
    publicFallback: '公开接口',
    authHints: { fields: '多字段' },
    detect() { return null; },
    collect: async () => ({ items: [] }),
  });
  const publicInfo = publicAdapter(adapter);
  assert.deepEqual(publicInfo.ruleKinds.map((item) => item.kind), ['keyword', 'full']);
  assert.equal(publicInfo.publicFallback, '公开接口');
  assert.deepEqual(publicInfo.authHints, { fields: '多字段' });
  assert.equal(publicInfo.detect, undefined, '公开元数据不能暴露函数');
  assert.deepEqual(publicInfo.auth.types, ['none', 'fields']);
});

test('fields 认证加密往返、空请求头与非法字段', () => {
  const secret = normalizeAuth({ type: 'fields', fields: { clientId: 'a', clientSecret: 'b' } });
  assert.deepEqual(secret.fields, { clientId: 'a', clientSecret: 'b' });
  assert.deepEqual(buildAuthHeaders(secret), {});
  const encrypted = encryptSecret(secret, Buffer.alloc(32, 9));
  assert.deepEqual(decryptSecret(encrypted, Buffer.alloc(32, 9)), secret);
  assert.deepEqual(redactAuth(secret), { type: 'fields', configured: true });
  assert.throws(() => normalizeAuth({ type: 'fields', fields: { 'bad-name': 'x' } }), /字段名称无效/);
  assert.throws(() => normalizeAuth({ type: 'fields', fields: {} }), /不能为空/);
});

test('macos.do 使用 Discourse 适配器并生成 macos.do 平台内容', async () => {
  const result = await collectSource({
    source: { platform: 'macos.do', name: 'macos', url: 'https://macos.do/latest.json' },
    rule: { kind: 'full', value: '' },
    fetchImpl: async () => response({
      topic_list: { topics: [{ id: 9, title: 'macOS topic', slug: 'mac-topic', excerpt: 'body', tags: ['mac'] }] },
    }),
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].platform, 'macos.do');
  assert.equal(result.items[0].canonical_url, 'https://macos.do/t/mac-topic/9');
});

test('V2EX 节点规则调用节点接口', async () => {
  const calls = [];
  const result = await collectSource({
    source: { platform: 'v2ex', name: 'v2', url: 'https://www.v2ex.com/api/topics/latest.json' },
    rule: { kind: 'node', value: 'programming' },
    fetchImpl: async (url) => {
      calls.push(String(url));
      return response([{ id: 7, title: 'Node topic', content: 'body', url: '/t/7' }]);
    },
  });
  assert.equal(result.items.length, 1);
  assert.ok(calls[0].includes('/api/topics/show.json?node_name=programming'));
});

test('GitHub 无 Release 时回退 Tags，401 不重试', async () => {
  const tags = await collectSource({
    source: { platform: 'github', name: 'gh', url: 'https://github.com/acme/repo' },
    rule: { kind: 'repo', value: 'acme/repo', options: { events: ['releases'], maxPages: 1 } },
    fetchImpl: async (url) => {
      if (String(url).includes('/releases')) return response([]);
      if (String(url).includes('/tags')) return response([{ name: 'v1.0.0', commit: { sha: 'abc' } }]);
      return response([], 404);
    },
  });
  assert.equal(tags.items.length, 1);
  assert.equal(tags.items[0].metadata.event, 'tag');
  assert.equal(tags.items[0].external_id, 'tag:v1.0.0');

  let calls = 0;
  await assert.rejects(collectSource({
    source: { platform: 'github', name: 'gh', url: 'https://github.com/acme/repo' },
    rule: { kind: 'repo', value: 'acme/repo', options: { events: ['releases'] } },
    auth: { type: 'token', token: 'bad' },
    fetchImpl: async () => { calls++; return response({ message: 'Bad credentials' }, 401); },
  }), /Token 无效/);
  assert.equal(calls, 1, '401 不进行无休止重试');
});

test('Telegram MTProto 未安装 Telethon 时明确降级', (t) => {
  const hasTelethon = spawnSync(config.pythonBin, ['-c', 'import telethon'], { encoding: 'utf8' }).status === 0;
  if (hasTelethon) return t.skip('当前环境已安装 Telethon，跳过缺失依赖测试');
  const result = spawnSync(config.pythonBin, ['telegram_worker.py', '--limit', '1'], {
    cwd: config.pythonDir,
    input: JSON.stringify({ apiId: 1, apiHash: 'x', channel: 'durov', limit: 1, minId: 0 }),
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MTPROTO_UNAVAILABLE/);
});

test('Discord 探活校验 Token/服务器/频道，搜索规则可用', async () => {
  const source = db.collectionSources.upsert({
    platform: 'discord', name: `discord-${Date.now()}`, url: 'https://discord.com/channels/g1/c1',
    config: { guildId: 'g1', channelIds: ['c1'] },
  });
  db.collectionAuth.set(source.id, { type: 'token', token: 'bot-token' });
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.endsWith('/users/@me')) return response({ id: 'u1', username: 'bot' });
    if (value.endsWith('/guilds/g1')) return response({ id: 'g1', name: 'Guild' });
    if (value.endsWith('/guilds/g1/channels')) return response([{ id: 'c1', name: 'general' }]);
    if (value.includes('/channels/c1/messages?limit=1')) return response([{ id: '1' }]);
    if (value.includes('/guilds/g1/messages/search')) return response({ messages: [[{ id: '9', channel_id: 'c1', content: 'release note', timestamp: '2026-10-18T00:00:00Z', author: { username: 'alice' } }]] });
    return response([], 404);
  };
  const probe = await probeSource(source.id, { fetchImpl });
  assert.equal(probe.ok, true);
  assert.equal(probe.guild.name, 'Guild');

  const search = await collectSource({
    source: { platform: 'discord', name: 'd', url: 'https://discord.com/channels/g1/c1', config: { guildId: 'g1' } },
    rule: { kind: 'search', value: 'release' },
    auth: { type: 'token', token: 'bot-token' },
    fetchImpl,
  });
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].content, 'release note');

  const threads = await collectSource({
    source: { platform: 'discord', name: 'd', url: 'https://discord.com/channels/g1/c1', config: { guildId: 'g1', channelIds: ['c1'], includeThreads: true } },
    rule: { kind: 'channel', value: 'c1' },
    auth: { type: 'token', token: 'bot-token' },
    fetchImpl: async (url) => {
      const value = String(url);
      if (value.includes('/channels/c1/threads/active')) return response({ threads: [{ id: 't1', name: 'thread one' }] });
      if (value.includes('/channels/t1/messages')) return response([{ id: '21', channel_id: 't1', content: 'thread message', timestamp: '2026-10-18T00:00:00Z', author: { username: 'bob' } }]);
      if (value.includes('/channels/c1/messages')) return response([]);
      return response([], 404);
    },
  });
  assert.equal(threads.items.length, 1);
  assert.equal(threads.items[0].metadata.channelId, 't1');
});
