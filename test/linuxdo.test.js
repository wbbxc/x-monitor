// linux.do 独立采集器：最新话题、关键词搜索、RSS 兜底和正文补全。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LINUXDO_DEFAULT_URL,
  buildLinuxdoUrl,
  collectLinuxdo,
  normalizeLinuxdoTopic,
} from '../src/collectors/linuxdo.js';

function response(body, status = 200) {
  return {
    status,
    headers: {},
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const latestPayload = {
  topic_list: {
    topics: [
      {
        id: 11,
        title: 'Hello <b>world</b>',
        slug: 'hello',
        excerpt: 'Excerpt &amp; more',
        created_at: '2026-10-17T08:00:00Z',
        category_name: '开发调优',
        replies: 3,
        views: 120,
        tags: ['ai', 'tools'],
        posters: [{ user: { username: 'alice' } }],
      },
    ],
  },
};

test('默认采集 latest.json 并规范化 Discourse 话题', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return response(latestPayload); };
  const result = await collectLinuxdo({
    source: { url: LINUXDO_DEFAULT_URL, config: {} },
    rule: { kind: 'full', value: '' },
    timeoutMs: 1000,
    retries: 0,
    fetchImpl,
  });

  assert.deepEqual(calls, [LINUXDO_DEFAULT_URL]);
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.platform, 'linux.do');
  assert.equal(item.title, 'Hello world');
  assert.equal(item.excerpt ?? item.content, 'Excerpt & more');
  assert.equal(item.author, 'alice');
  assert.equal(item.canonical_url, 'https://linux.do/t/hello/11');
  assert.equal(item.metadata.category, '开发调优');
  assert.equal(item.metadata.replies, 3);
  assert.deepEqual(item.metadata.tags, ['ai', 'tools']);
});

test('关键词规则调用 Discourse 搜索接口，且不按关键词二次过滤', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return response({ topics: [{ id: 12, title: 'AI 相关但标题不含关键词', url: '/t/ai/12' }] });
  };
  const result = await collectLinuxdo({
    source: { url: 'https://linux.do/latest.json', config: {} },
    rule: { kind: 'keyword', value: 'AI' },
    auth: { type: 'cookie', cookies: 'connect.sid=abc' },
    timeoutMs: 1000,
    retries: 0,
    fetchImpl,
  });

  assert.deepEqual(calls, ['https://linux.do/search.json?q=AI']);
  assert.equal(result.items.length, 1);
  assert.equal(result.meta.search, true);
});

test('返回 RSS 时自动降级解析', async () => {
  const rss = `<?xml version="1.0"?><rss><channel><item>
    <title>RSS topic</title><link>https://linux.do/t/rss/9</link>
    <description>Body</description><pubDate>Fri, 17 Oct 2026 08:00:00 GMT</pubDate>
  </item></channel></rss>`;
  const result = await collectLinuxdo({
    source: { url: 'https://linux.do/latest.rss', config: {} },
    rule: { kind: 'full', value: '' },
    timeoutMs: 1000,
    retries: 0,
    fetchImpl: async () => response(rss),
  });

  assert.equal(result.meta.format, 'rss');
  assert.equal(result.items[0].title, 'RSS topic');
  assert.equal(result.items[0].canonical_url, 'https://linux.do/t/rss/9');
});

test('开启 fetchDetails 时补全正文并携带 Cookie', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options.headers });
    if (url.endsWith('.json') && url.includes('/t/hello/11')) {
      return response({ post_stream: { posts: [{ cooked: '<p>full body</p>' }] } });
    }
    return response({ topics: [{ id: 11, title: 'T', url: '/t/hello/11', excerpt: '' }] });
  };
  const result = await collectLinuxdo({
    source: { url: 'https://linux.do/latest.json', config: { fetchDetails: true } },
    rule: { kind: 'full', value: '' },
    auth: { type: 'cookie', cookies: 'connect.sid=abc' },
    timeoutMs: 1000,
    retries: 0,
    fetchImpl,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.cookie, 'connect.sid=abc');
  assert.equal(result.items[0].content, 'full body');
  assert.ok(result.items[0].raw_json.detail);
});

test('buildLinuxdoUrl 与 normalizeLinuxdoTopic 的边界行为', () => {
  assert.equal(buildLinuxdoUrl({ url: '' }, { kind: 'full' }), LINUXDO_DEFAULT_URL);
  assert.equal(
    buildLinuxdoUrl({ url: 'https://linux.do/c/develop.json' }, { kind: 'keyword', value: 'docker' }),
    'https://linux.do/search.json?q=docker'
  );

  const item = normalizeLinuxdoTopic({ id: 5, title: 'Only id' });
  assert.equal(item.canonical_url, '');
  assert.equal(item.external_id, '5');
  assert.equal(item.content, '');
});

test('Discourse latest 真实结构：users / posters / 对象标签', async () => {
  const payload = {
    users: [{ id: 1, username: 'neo' }],
    topic_list: {
      topics: [{
        id: 7, title: 'Real topic', slug: 'real-topic', excerpt: 'ex',
        category_id: 2, reply_count: 5, views: 9, last_poster_username: 'someone',
        tags: [{ name: '公告' }, { name: 'iOS' }],
        posters: [{ user_id: 1, description: '原始发帖人' }],
      }],
    },
  };
  const result = await collectLinuxdo({
    source: { url: 'https://linux.do/latest.json', config: {} },
    rule: { kind: 'full', value: '' },
    timeoutMs: 1000,
    retries: 0,
    fetchImpl: async () => response(payload),
  });
  const item = result.items[0];
  assert.equal(item.author, 'neo');
  assert.equal(item.metadata.category_id, 2);
  assert.deepEqual(item.metadata.tags, ['公告', 'iOS']);
  assert.equal(item.metadata.replies, 5);
  assert.equal(item.canonical_url, 'https://linux.do/t/real-topic/7');
});

test('无 Cookie 时关键词采集降级为公开话题本地过滤', async () => {
  const calls = [];
  const latest = {
    users: [{ id: 1, username: 'alice' }],
    topic_list: { topics: [
      { id: 21, title: 'Docker 部署经验', url: '/t/docker/21', excerpt: 'docker compose', tags: [{ name: 'Docker' }], posters: [{ user_id: 1, description: '原始发帖人' }] },
      { id: 22, title: '显卡选购', url: '/t/gpu/22', excerpt: 'GPU', posters: [{ user_id: 1, description: '原始发帖人' }] },
    ] },
  };
  const top = {
    topic_list: { topics: [
      { id: 21, title: 'Docker 部署经验', url: '/t/docker/21', excerpt: 'docker compose' },
      { id: 23, title: 'K8s 与 Docker', url: '/t/k8s/23', excerpt: '容器编排' },
    ] },
  };
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('top.json')) return response(top);
    return response(latest);
  };
  const result = await collectLinuxdo({
    source: { url: 'https://linux.do/latest.json', config: { maxItems: 10 } },
    rule: { kind: 'keyword', value: 'docker' },
    timeoutMs: 1000,
    retries: 0,
    fetchImpl,
  });
  assert.equal(result.meta.mode, 'public-scan');
  assert.equal(result.meta.reason, 'anonymous');
  assert.deepEqual(calls, [
    'https://linux.do/latest.json',
    'https://linux.do/top.json?period=weekly',
  ]);
  assert.deepEqual(result.items.map((item) => item.external_id).sort(), ['21', '23']);
  assert.equal(result.items.find((item) => item.external_id === '21').author, 'alice');
});

test('有 Cookie 但搜索失败时自动降级到公开扫描', async () => {
  const result = await collectLinuxdo({
    source: { url: 'https://linux.do/latest.json', config: {} },
    rule: { kind: 'keyword', value: 'docker' },
    auth: { type: 'cookie', cookies: 'connect.sid=expired' },
    timeoutMs: 1000,
    retries: 0,
    fetchImpl: async (url) => {
      if (url.includes('search.json')) return response('{"errors":["您需要登录才能执行此操作。"],"error_type":"not_logged_in"}', 403);
      return response({ topic_list: { topics: [{ id: 31, title: 'Docker 问题', url: '/t/d/31' }] } });
    },
  });
  assert.equal(result.meta.mode, 'public-scan');
  assert.match(result.meta.reason, /search-error/);
  assert.equal(result.items.length, 1);
});

test('关闭降级后搜索失败返回可操作提示', async () => {
  await assert.rejects(
    collectLinuxdo({
      source: { url: 'https://linux.do/latest.json', config: { keywordFallback: false } },
      rule: { kind: 'keyword', value: 'docker' },
      timeoutMs: 1000,
      retries: 0,
      fetchImpl: async () => response('{"errors":["您需要登录才能执行此操作。"],"error_type":"not_logged_in"}', 403),
    }),
    /需要登录.*Cookie/
  );
  await assert.rejects(
    collectLinuxdo({
      source: { url: 'https://linux.do/latest.json', config: { keywordFallback: false } },
      rule: { kind: 'full', value: '' },
      timeoutMs: 1000,
      retries: 0,
      fetchImpl: async () => response('', 429),
    }),
    /限流/
  );
});
