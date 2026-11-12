import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWebFeedUrls,
  fetchKeywordArticles,
  parseFeed,
} from '../src/collectors/web.js';
import {
  normalizeHuggingFacePaper,
  syncHuggingFacePages,
} from '../src/collectors/huggingface.js';

test('parseFeed parses RSS items into normalized web articles', () => {
  const xml = `<?xml version="1.0"?>
    <rss version="2.0"><channel><title>News</title>
      <item>
        <title>Agent systems improve - Example Daily</title>
        <link>https://example.com/agent-systems</link>
        <guid>article-1</guid>
        <pubDate>Fri, 11 Sep 2026 10:00:00 GMT</pubDate>
        <description>&lt;b&gt;Useful&lt;/b&gt; summary &amp;amp; details.</description>
        <source url="https://example.com">Example Daily</source>
      </item>
    </channel></rss>`;

  assert.deepEqual(parseFeed(xml, 'google_news'), [{
    provider: 'google_news',
    source_name: 'Example Daily',
    source_url: 'https://example.com',
    title: 'Agent systems improve - Example Daily',
    summary: 'Useful summary & details.',
    url: 'https://example.com/agent-systems',
    published_at: '2026-09-11T10:00:00.000Z',
  }]);
});

test('fetchKeywordArticles combines providers, deduplicates results and keeps partial success', async () => {
  const urls = buildWebFeedUrls('AI Agent');
  const feeds = new Map([
    [urls[0].url, `<?xml version="1.0"?><rss><channel><item>
      <title>Shared story</title><link>https://example.com/shared</link>
      <pubDate>Fri, 11 Sep 2026 10:00:00 GMT</pubDate><source>Example</source>
    </item></channel></rss>`],
    [urls[1].url, `<?xml version="1.0"?><rss><channel><item>
      <title>Shared story</title><link>https://example.com/shared</link>
      <pubDate>Fri, 11 Sep 2026 10:00:00 GMT</pubDate><source>Example</source>
    </item><item>
      <title>Second story</title><link>https://example.com/second</link>
      <pubDate>Fri, 11 Sep 2026 09:00:00 GMT</pubDate><source>Another</source>
    </item></channel></rss>`],
  ]);
  const fetchImpl = async (url) => new Response(feeds.get(String(url)), { status: 200 });

  const result = await fetchKeywordArticles('AI Agent', { fetchImpl, retries: 0 });

  assert.equal(result.items.length, 2);
  assert.deepEqual(result.providers.map((item) => item.status), ['ok', 'ok']);

  const partial = await fetchKeywordArticles('AI Agent', {
    retries: 0,
    fetchImpl: async (url) => {
      if (String(url) === urls[0].url) throw new Error('provider unavailable');
      return new Response(feeds.get(String(url)), { status: 200 });
    },
  });
  assert.equal(partial.items.length, 2);
  assert.equal(partial.providers[0].status, 'error');
  assert.equal(partial.providers[1].status, 'ok');
});

test('normalizeHuggingFacePaper preserves searchable paper metadata', () => {
  const normalized = normalizeHuggingFacePaper({
    paper: {
      id: '2609.12345',
      title: 'A Useful Paper',
      summary: 'Full abstract',
      ai_summary: 'Short summary',
      ai_keywords: ['agents', 'retrieval'],
      authors: [{ name: 'Ada' }, { user: { fullname: 'Lin' } }],
      publishedAt: '2026-09-10T00:00:00.000Z',
      submittedOnDailyAt: '2026-09-11T00:00:00.000Z',
      upvotes: 42,
      numComments: 3,
      githubRepo: 'https://github.com/example/paper',
    },
    thumbnail: 'https://cdn.example.com/paper.png',
  });

  assert.equal(normalized.id, '2609.12345');
  assert.deepEqual(normalized.authors, ['Ada', 'Lin']);
  assert.deepEqual(normalized.keywords, ['agents', 'retrieval']);
  assert.equal(normalized.source_url, 'https://huggingface.co/papers/2609.12345');
  assert.equal(normalized.github_url, 'https://github.com/example/paper');
});

test('syncHuggingFacePages follows Link pagination and persists every page', async () => {
  const calls = [];
  const stored = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const page = Number(new URL(url).searchParams.get('p'));
    const body = page === 0
      ? [{ paper: { id: 'a', title: 'A' } }, { paper: { id: 'b', title: 'B' } }]
      : [{ paper: { id: 'c', title: 'C' } }];
    const headers = page === 0
      ? { Link: '<https://huggingface.co/api/daily_papers?limit=2&p=1>; rel="next"' }
      : {};
    return new Response(JSON.stringify(body), { status: 200, headers });
  };

  const result = await syncHuggingFacePages({
    fetchImpl,
    pageSize: 2,
    retries: 0,
    onPage: async (papers) => stored.push(...papers.map((paper) => paper.id)),
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(stored, ['a', 'b', 'c']);
  assert.deepEqual(result, { pages: 2, seen: 3, complete: true, nextUrl: null });
});
