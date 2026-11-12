import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listCollectors,
  normalizeCollectionItem,
  mergeCollectionItems,
  collectSource,
} from '../src/collectors/framework.js';
import {
  buildAuthHeaders,
  decryptSecret,
  encryptSecret,
  normalizeAuth,
} from '../src/collectors/auth.js';
import { parseArxivFeed } from '../src/collectors/arxiv.js';

test('collector registry exposes built-in and future platform adapters', () => {
  const names = listCollectors().map((item) => item.id);
  assert.deepEqual(names, ['arxiv', 'discord', 'github', 'google', 'huggingface', 'linux.do', 'macos.do', 'reddit', 'telegram', 'v2ex', 'web', 'x']);
});

test('normalizeCollectionItem keeps incomplete raw content and creates a stable dedupe key', () => {
  const item = normalizeCollectionItem({
    platform: 'v2ex',
    source_url: 'https://www.v2ex.com/api/topics/latest.json',
    external_id: '42',
    title: 'A topic',
    content: '',
    raw_json: { id: 42, title: 'A topic', body: 'raw body' },
    links: ['https://www.v2ex.com/t/42'],
  });

  assert.equal(item.external_id, '42');
  assert.equal(item.required_complete, false);
  assert.match(item.dedupe_key, /^id:v2ex:42$/);
  assert.deepEqual(item.links, ['https://www.v2ex.com/t/42']);
  assert.deepEqual(item.raw_json, [{ id: 42, title: 'A topic', body: 'raw body' }]);
});

test('mergeCollectionItems appends new links and raw snapshots without erasing content', () => {
  const previous = normalizeCollectionItem({
    platform: 'web',
    source_url: 'https://news.google.com/rss',
    canonical_url: 'https://example.com/story',
    external_id: 'story',
    title: 'Story',
    content: 'full body',
    links: ['https://example.com/story'],
    raw_json: { provider: 'google_news', body: 'full body' },
  });
  const next = normalizeCollectionItem({
    platform: 'web',
    source_url: 'https://www.bing.com/news',
    canonical_url: 'https://example.com/story',
    external_id: 'story',
    title: '',
    content: '',
    links: ['https://example.com/story?utm_source=bing', 'https://example.com/related'],
    raw_json: { provider: 'bing_news', body: '' },
  });
  const merged = mergeCollectionItems(previous, next);

  assert.equal(merged.title, 'Story');
  assert.equal(merged.content, 'full body');
  assert.deepEqual(merged.links, [
    'https://example.com/story',
    'https://example.com/related',
  ]);
  assert.equal(merged.raw_json.length, 2);
  assert.equal(merged.required_complete, true);
});

test('auth secrets round-trip encrypted and produce standard headers', () => {
  const encrypted = encryptSecret({ type: 'cookie', cookies: { auth_token: 'token', ct0: 'csrf' } }, Buffer.alloc(32, 7));
  assert.notEqual(encrypted, JSON.stringify({ type: 'cookie', cookies: { auth_token: 'token', ct0: 'csrf' } }));
  const secret = decryptSecret(encrypted, Buffer.alloc(32, 7));
  assert.deepEqual(secret, { type: 'cookie', cookies: { auth_token: 'token', ct0: 'csrf' } });
  assert.deepEqual(buildAuthHeaders(secret), { cookie: 'auth_token=token; ct0=csrf' });
  assert.throws(() => normalizeAuth({ type: 'headers', headers: { Host: 'evil.example' } }), /请求头名称无效/);
});

test('arxiv Atom entries retain title, abstract, authors and links', () => {
  const items = parseArxivFeed(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry><id>http://arxiv.org/abs/2609.00001</id><title> A paper </title>
      <summary> An abstract. </summary><published>2026-09-28T00:00:00Z</published>
      <author><name>Ada Lovelace</name></author>
      <link href="http://arxiv.org/abs/2609.00001"/><link rel="alternate" href="https://arxiv.org/abs/2609.00001"/>
    </entry></feed>`);
  assert.equal(items.length, 1);
  assert.equal(items[0].external_id, '2609.00001');
  assert.equal(items[0].author, 'Ada Lovelace');
  assert.equal(items[0].content, 'An abstract.');
  assert.equal(items[0].canonical_url, 'https://arxiv.org/abs/2609.00001');
});

test('web adapter keeps a plain HTML page when no feed parser matches', async () => {
  const result = await collectSource({
    source: { platform: 'web', name: 'HTML', url: 'https://example.com/page' },
    rule: { kind: 'full', value: '' },
    fetchImpl: async () => new Response('<html><head><title>Page</title></head><body><p>Important body</p></body></html>', { status: 200 }),
    retries: 0,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, 'Page');
  assert.match(result.items[0].content, /Important body/);
  assert.equal(result.items[0].metadata.format, 'html');
});

test('forum adapters normalize JSON topics and preserve raw payloads', async () => {
  const result = await collectSource({
    source: { platform: 'v2ex', name: 'V2EX', url: 'https://www.v2ex.com/api/topics/latest.json' },
    rule: { kind: 'keyword', value: 'agent' },
    fetchImpl: async () => new Response(JSON.stringify([{ id: 7, title: 'Agent topic', content: 'body', url: '/t/7' }]), { status: 200 }),
    retries: 0,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].external_id, '7');
  assert.equal(result.items[0].canonical_url, 'https://www.v2ex.com/t/7');
  assert.equal(result.items[0].raw_json[0].id, 7);
});
