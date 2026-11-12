// 新增平台适配器：GitHub、Reddit、Discord、Telegram、Google/Web、arXiv/HF、X。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectSource,
} from '../src/collectors/framework.js';
import { collectGithub, githubAdapter } from '../src/collectors/github.js';
import { parseTelegramTarget, parseTelegramPreview } from '../src/collectors/telegram.js';
import {
  extractJsonLd, parseSitemap, parseRobots, isPathAllowed, extractPageContent,
} from '../src/collectors/html.js';
import { normalizeHuggingFacePaper } from '../src/collectors/huggingface.js';
import { buildXArgs, filterByCursor, normalizeTweet } from '../src/collectors/x.js';

function response(body, status = 200, headers = {}) {
  return {
    status,
    headers,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const paperAtom = (id, title) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <entry><id>http://arxiv.org/abs/${id}</id><title>${title}</title><summary>Abstract ${title}</summary>
  <published>2026-10-18T00:00:00Z</published><author><name>Ada</name></author>
  <link rel="alternate" href="https://arxiv.org/abs/${id}"/></entry></feed>`;

test('GitHub 采集 Releases/Issues/PRs，过滤预发布并保留通知事件', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/releases')) {
      return response([{
        id: 1, tag_name: 'v1.0.0', name: 'v1.0.0', body: 'release body',
        html_url: 'https://github.com/acme/repo/releases/tag/v1.0.0',
        published_at: '2026-10-18T00:00:00Z', prerelease: false, draft: false,
        author: { login: 'alice' }, assets: [{ name: 'a.zip', browser_download_url: 'https://example.com/a.zip', size: 1 }],
      }, {
        id: 2, tag_name: 'v2.0.0-beta', name: 'beta', body: '', html_url: 'https://github.com/acme/repo/releases/tag/beta',
        published_at: '2026-10-18T00:00:00Z', prerelease: true, draft: false, assets: [],
      }]);
    }
    if (pathname.endsWith('/issues')) {
      return response([
        { id: 11, number: 1, title: 'Bug', body: 'bug body', html_url: 'https://github.com/acme/repo/issues/1', state: 'open', labels: [{ name: 'bug' }], user: { login: 'bob' }, comments: 2, created_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-18T01:00:00Z' },
        { id: 12, number: 2, title: 'PR in issues', body: '', html_url: 'https://github.com/acme/repo/pull/2', state: 'open', pull_request: {} },
      ]);
    }
    if (pathname.endsWith('/pulls')) {
      return response([{ id: 21, number: 2, title: 'Feat', body: 'pr body', html_url: 'https://github.com/acme/repo/pull/2', state: 'open', labels: [], user: { login: 'carol' }, comments: 0, created_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-18T02:00:00Z' }]);
    }
    return { status: 404, headers: {}, text: '[]' };
  };
  const result = await collectSource({
    source: { platform: 'github', name: 'gh', url: 'https://github.com/acme/repo' },
    rule: { kind: 'repo', value: 'acme/repo', options: { events: ['releases', 'issues', 'pulls'], includePrereleases: false, maxPages: 1 } },
    fetchImpl,
  });
  assert.equal(result.items.length, 3, JSON.stringify(result.meta));
  const events = result.items.map((item) => item.metadata.event).sort();
  assert.deepEqual(events, ['issue', 'pull', 'release']);
  const release = result.items.find((item) => item.metadata.event === 'release');
  assert.equal(release.external_id, 'release:1');
  assert.equal(release.metadata.notification.event, 'release');
  const pull = result.items.find((item) => item.metadata.event === 'pull');
  assert.equal(pull.metadata.isPullRequest, true);
  assert.ok(calls.some((url) => url.includes('/releases')));
  assert.ok(calls.every((url) => !url.includes('/discussions')));
  assert.ok(calls.every((url) => !/\/commits\/[^?]/.test(url)), '未开启 branches 时不应请求单提交详情');
});


test('GitHub 分支提交：默认分支、指定分支、merge 过滤和元数据', async () => {
  const calls = [];
  const commits = {
    main: [
      { sha: 'c1', html_url: 'https://github.com/acme/repo/commit/c1', commit: { message: 'feat: main one\n\nbody', author: { name: 'Ada', date: '2026-10-18T01:00:00Z' }, committer: { date: '2026-10-18T01:01:00Z' } }, author: { login: 'ada', html_url: 'https://github.com/ada' }, parents: [{ sha: 'p1' }] },
      { sha: 'm1', html_url: 'https://github.com/acme/repo/commit/m1', commit: { message: 'Merge branch dev', author: { name: 'Ada', date: '2026-10-18T02:00:00Z' }, committer: { date: '2026-10-18T02:01:00Z' } }, author: { login: 'ada' }, parents: [{ sha: 'p1' }, { sha: 'p2' }] },
    ],
    dev: [
      { sha: 'd1', html_url: 'https://github.com/acme/repo/commit/d1', commit: { message: 'fix: dev only', author: { name: 'Bob', date: '2026-10-18T03:00:00Z' }, committer: { date: '2026-10-18T03:01:00Z' } }, author: { login: 'bob' }, parents: [{ sha: 'p3' }] },
    ],
  };
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const parsed = new URL(url);
    if (parsed.pathname === '/repos/acme/repo') return response({ default_branch: 'main' });
    if (parsed.pathname === '/repos/acme/repo/commits') return response(commits[parsed.searchParams.get('sha')] || []);
    return { status: 404, headers: {}, text: '[]' };
  };
  const defaultBranch = await collectSource({
    source: { platform: 'github', name: 'gh', url: 'https://github.com/acme/repo' },
    rule: { kind: 'repo', value: 'acme/repo', options: { events: ['branches'], includeMergeCommits: false, maxItems: 10 } },
    fetchImpl,
  });
  assert.deepEqual(defaultBranch.items.map((item) => item.metadata.sha), ['c1']);
  assert.equal(defaultBranch.items[0].metadata.event, 'commit');
  assert.equal(defaultBranch.items[0].metadata.branch, 'main');
  assert.equal(defaultBranch.items[0].external_id, 'commit:c1');
  assert.equal(defaultBranch.items[0].title, 'feat: main one');
  assert.equal(defaultBranch.items[0].metadata.notification.event, 'commit');
  assert.equal(defaultBranch.meta.branchFiltered, 1);
  assert.ok(calls.some((url) => url.includes('sha=main')));

  calls.length = 0;
  const selected = await collectSource({
    source: { platform: 'github', name: 'gh', url: 'https://github.com/acme/repo' },
    rule: { kind: 'repo', value: 'acme/repo', options: { events: ['branches'], branches: ['dev'], includeDefaultBranch: false, maxItems: 10 } },
    fetchImpl,
  });
  assert.deepEqual(selected.items.map((item) => item.metadata.sha), ['d1']);
  assert.equal(selected.items[0].metadata.branch, 'dev');
  assert.ok(calls.some((url) => url.includes('sha=dev')));
  assert.ok(calls.every((url) => !url.includes('sha=main')));
});



test('GitHub 分支选项校验', () => {
  assert.doesNotThrow(() => githubAdapter.validateRule({ kind: 'repo', value: 'acme/repo', options: { events: ['branches'], branches: ['main', 'dev'] } }));
  assert.throws(() => githubAdapter.validateRule({ kind: 'repo', value: 'acme/repo', options: { events: ['branches'], branches: ['bad branch'] } }), /分支名无效/);
  assert.throws(() => githubAdapter.validateRule({ kind: 'repo', value: 'acme/repo', options: { events: [] } }), /events 不能为空/);
});

test('GitHub 分支代码改动：文件摘要、patch 截断和关闭开关', async () => {
  const calls = [];
  const commit = {
    sha: 'c9', html_url: 'https://github.com/acme/repo/commit/c9',
    commit: { message: 'feat: add code diff\n\nmore detail', author: { date: '2026-10-18T00:00:00Z' } },
    author: { login: 'ada' }, parents: [{ sha: 'p1' }],
  };
  const detail = {
    ...commit,
    files: [
      { filename: 'src/a.js', status: 'modified', additions: 12, deletions: 3, changes: 15, patch: '@@ -1 +1 @@\n-old\n+new and a very long patch' },
      { filename: 'assets/logo.png', status: 'added', additions: 0, deletions: 0, changes: 0 },
    ],
  };
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const path = new URL(url).pathname;
    if (path === '/repos/acme/repo/commits') return response([commit]);
    if (path === '/repos/acme/repo/commits/c9') return response(detail);
    return response([], 404);
  };
  const result = await collectSource({
    source: { platform: 'github', name: 'gh', url: 'https://github.com/acme/repo' },
    rule: { kind: 'repo', value: 'acme/repo', options: { events: ['branches'], branches: ['main'], includeDefaultBranch: false, includeCodeChanges: true, maxDiffCommitsPerRun: 10, maxFilesPerCommit: 1, maxPatchCharsPerFile: 100 } },
    fetchImpl,
  });
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.metadata.codeChanges.totalFiles, 2);
  assert.equal(item.metadata.codeChanges.returnedFiles, 1);
  assert.equal(item.metadata.codeChanges.truncated, true);
  assert.ok(item.metadata.codeChanges.files[0].patch.length <= 100);
  assert.match(item.content, /变更文件 2 个（已截断）/);
  assert.match(item.content, /对比：https:\/\/github.com\/acme\/repo\/compare\/p1\.\.\.c9/);
  assert.ok(calls.some((url) => url.endsWith('/commits/c9')));

  calls.length = 0;
  const disabled = await collectSource({
    source: { platform: 'github', name: 'gh', url: 'https://github.com/acme/repo' },
    rule: { kind: 'repo', value: 'acme/repo', options: { events: ['branches'], branches: ['main'], includeDefaultBranch: false, includeCodeChanges: false } },
    fetchImpl,
  });
  assert.equal(disabled.items.length, 1);
  assert.equal(disabled.items[0].metadata.codeChanges, undefined);
  assert.ok(calls.every((url) => !url.includes('/commits/c9')));
});


test('GitHub 代码改动文件状态与长 patch 截断', async () => {
  const commit = {
    sha: 'st1', html_url: 'https://github.com/acme/repo/commit/st1',
    commit: { message: 'chore: statuses', author: { date: '2026-10-18T00:00:00Z' } },
    author: { login: 'ada' }, parents: [{ sha: 'p1' }],
  };
  const longPatch = '@@ -1 +1 @@\n' + 'x'.repeat(220);
  const detail = {
    ...commit,
    files: [
      { filename: 'a.js', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: longPatch },
      { filename: 'b.js', status: 'added', additions: 2, deletions: 0, changes: 2, patch: '+b' },
      { filename: 'c.js', status: 'removed', additions: 0, deletions: 2, changes: 2, patch: '-c' },
      { filename: 'd.js', previous_filename: 'old.js', status: 'renamed', additions: 0, deletions: 0, changes: 0 },
      { filename: 'image.png', status: 'added', additions: 0, deletions: 0, changes: 0 },
    ],
  };
  const result = await collectSource({
    source: { platform: 'github', name: 'gh', url: 'https://github.com/acme/repo' },
    rule: { kind: 'repo', value: 'acme/repo', options: { events: ['branches'], branches: ['main'], includeDefaultBranch: false, includeCodeChanges: true, maxFilesPerCommit: 10, maxPatchCharsPerFile: 100 } },
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path === '/repos/acme/repo/commits') return response([commit]);
      if (path === '/repos/acme/repo/commits/st1') return response(detail);
      return response([], 404);
    },
  });
  const changes = result.items[0].metadata.codeChanges;
  assert.equal(changes.totalFiles, 5);
  assert.equal(changes.returnedFiles, 5);
  assert.equal(changes.truncated, true);
  assert.equal(changes.files[0].patch.length, 100);
  assert.equal(changes.files[3].previousFilename, 'old.js');
  assert.equal(changes.files[4].binary, true);
  assert.match(result.items[0].content, /R d\.js（原 old\.js）/);
});

test('GitHub allBranches 读取分支列表并应用 maxBranches', async () => {
  const calls = [];
  const result = await collectSource({
    source: { platform: 'github', name: 'gh', url: 'https://github.com/acme/repo' },
    rule: { kind: 'repo', value: 'acme/repo', options: { events: ['branches'], allBranches: true, includeDefaultBranch: false, maxBranches: 2, maxCommitsPerBranch: 5 } },
    fetchImpl: async (url) => {
      calls.push(String(url));
      const parsed = new URL(url);
      if (parsed.pathname === '/repos/acme/repo/branches') return response([{ name: 'main' }, { name: 'dev' }, { name: 'old' }]);
      if (parsed.pathname === '/repos/acme/repo/commits') {
        const sha = parsed.searchParams.get('sha');
        return response([{ sha: `${sha}-1`, html_url: `https://github.com/acme/repo/commit/${sha}-1`, commit: { message: sha, author: { date: '2026-10-18T00:00:00Z' } }, author: { login: 'ada' }, parents: [{ sha: 'p' }] }]);
      }
      return response([], 404);
    },
  });
  assert.deepEqual(result.meta.branches, ['main', 'dev']);
  assert.equal(result.meta.branchInfo.total, 3);
  assert.equal(result.meta.branchInfo.truncated, true);
  assert.ok(calls.some((url) => url.includes('/branches')));
});

test('GitHub 代码改动限流降级并避免重复请求', async () => {
  let cursor = null;
  let detailCalls = 0;
  const commit = {
    sha: 's9', html_url: 'https://github.com/acme/repo/commit/s9',
    commit: { message: 'feat: diff', author: { date: '2026-10-18T00:00:00Z' } },
    author: { login: 'ada' }, parents: [{ sha: 'p9' }],
  };
  const ctx = {
    source: { platform: 'github', config: {} },
    rule: { kind: 'repo', value: 'acme/repo', options: { events: ['branches'], branches: ['main'], includeDefaultBranch: false, includeCodeChanges: true } },
    auth: {}, settings: {}, logger: { warn() {} },
    cursor: { get: () => cursor, set: (value) => { cursor = value; } },
    fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path === '/repos/acme/repo/commits') return { status: 200, headers: {}, text: JSON.stringify([commit]) };
      if (path === '/repos/acme/repo/commits/s9') {
        detailCalls++;
        const error = new Error('rate limited');
        error.status = 429;
        error.code = 'RATE_LIMITED';
        error.retryable = true;
        throw error;
      }
      return { status: 404, headers: {}, text: '[]' };
    },
  };
  const first = await collectGithub(ctx);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].metadata.codeChangesUnavailable, true);
  assert.equal(first.meta.degraded, true);
  assert.equal(detailCalls, 1);
  await collectGithub(ctx);
  assert.equal(detailCalls, 1, '限流后不应在下一轮重复请求同一提交的详情');
});

test('GitHub 分支游标只推进成功分支并保留 since', async () => {
  let cursor = null;
  const calls = [];
  const ctx = {
    source: { platform: 'github', config: {} },
    rule: { kind: 'repo', value: 'acme/repo', options: { events: ['branches'], branches: ['main'], includeMergeCommits: true } },
    auth: {}, settings: {}, logger: { warn() {} },
    cursor: { get: () => cursor, set: (value) => { cursor = value; } },
    fetch: async (url) => {
      calls.push(String(url));
      const parsed = new URL(url);
      if (parsed.pathname === '/repos/acme/repo/commits') {
        return { status: 200, headers: {}, text: JSON.stringify([{ sha: 's1', html_url: 'https://github.com/acme/repo/commit/s1', commit: { message: 'one', author: { date: '2026-10-18T00:00:00Z' } }, author: { login: 'ada' }, parents: [{ sha: 'p' }] }]) };
      }
      return { status: 404, headers: {}, text: '[]' };
    },
  };
  await collectGithub(ctx);
  assert.equal(cursor.repos['acme/repo'].branches.main.since, '2026-10-18T00:00:00Z');
  assert.equal(cursor.repos['acme/repo'].branches.main.lastSha, 's1');
  await collectGithub(ctx);
  assert.ok(calls.some((url) => url.includes('since=2026-10-18T00%3A00%3A00Z') || url.includes('since=2026-10-18T00:00:00Z')));
});

test('GitHub Discussions 无 Token 跳过，有 Token 使用 GraphQL', async () => {
  const noToken = await collectSource({
    source: { platform: 'github', name: 'gh', url: 'https://github.com/acme/repo' },
    rule: { kind: 'repo', value: 'acme/repo', options: { events: ['discussions'] } },
    fetchImpl: async () => response([]),
  });
  assert.equal(noToken.items.length, 0);
  assert.match(JSON.stringify(noToken.meta), /token/i);

  const withToken = await collectSource({
    source: { platform: 'github', name: 'gh', url: 'https://github.com/acme/repo' },
    rule: { kind: 'repo', value: 'acme/repo', options: { events: ['discussions'] } },
    auth: { type: 'token', token: 'ghp_test' },
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'POST');
      return response({
        data: { repository: { discussions: {
          pageInfo: { hasNextPage: false, endCursor: 'c1' },
          nodes: [{
            id: 'D1', number: 3, title: 'Roadmap', body: 'plan', url: 'https://github.com/acme/repo/discussions/3',
            createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T01:00:00Z', state: 'OPEN',
            author: { login: 'dave' }, category: { name: 'Ideas' },
            labels: { nodes: [{ name: 'roadmap' }] }, comments: { totalCount: 4 },
          }],
        } } },
      });
    },
  });
  assert.equal(withToken.items.length, 1);
  assert.equal(withToken.items[0].metadata.event, 'discussion');
  assert.equal(withToken.items[0].metadata.category, 'Ideas');
});

test('GitHub 304 视为无更新，不写内容', async () => {
  const result = await collectSource({
    source: { platform: 'github', name: 'gh', url: 'https://github.com/acme/repo' },
    rule: { kind: 'repo', value: 'acme/repo', options: { events: ['releases'] } },
    fetchImpl: async () => response('', 304, { etag: 'etag-1' }),
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.meta.pages.releases[0].notModified, true);
});

test('Reddit 公开 JSON 与 OAuth 路径', async () => {
  const listing = (id, title) => ({
    data: {
      after: null,
      children: [{ data: {
        id, name: `t3_${id}`, title, selftext: 'post body', author: 'alice',
        permalink: `/r/programming/comments/${id}/post/`, url: `https://example.com/${id}`,
        subreddit: 'programming', score: 10, num_comments: 2, over_18: false, is_self: true,
        created_utc: 1760000000, link_flair_text: 'AI',
      } }],
    },
  });
  const publicResult = await collectSource({
    source: { platform: 'reddit', name: 'r', url: 'https://www.reddit.com/r/programming/' },
    rule: { kind: 'subreddit', value: 'programming' },
    fetchImpl: async () => response(listing('p1', 'Public post')),
  });
  assert.equal(publicResult.items.length, 1);
  assert.equal(publicResult.items[0].external_id, 't3_p1');
  assert.equal(publicResult.items[0].canonical_url, 'https://www.reddit.com/r/programming/comments/p1/post/');
  assert.equal(publicResult.meta.mode, 'public');

  const calls = [];
  const oauthResult = await collectSource({
    source: { platform: 'reddit', name: 'r', url: 'https://www.reddit.com/r/programming/' },
    rule: { kind: 'subreddit', value: 'programming' },
    auth: { type: 'fields', fields: { clientId: 'cid', clientSecret: 'secret' } },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      if (String(url).includes('/api/v1/access_token')) return response({ access_token: 'token', expires_in: 3600 });
      return response(listing('p2', 'OAuth post'));
    },
  });
  assert.equal(oauthResult.items.length, 1);
  assert.equal(oauthResult.meta.mode, 'oauth');
  assert.ok(calls.some((call) => call.method === 'POST'));
  assert.ok(calls.some((call) => call.url.startsWith('https://oauth.reddit.com/r/programming/new')));
});

test('Reddit OAuth 失败时公开 JSON 降级', async () => {
  const result = await collectSource({
    source: { platform: 'reddit', name: 'r', url: 'https://www.reddit.com/r/programming/' },
    rule: { kind: 'subreddit', value: 'programming' },
    auth: { type: 'fields', fields: { clientId: 'cid-fallback', clientSecret: 'secret-fallback' } },
    fetchImpl: async (url) => {
      if (String(url).includes('/api/v1/access_token')) return response({ error: 'invalid_grant' }, 401);
      return response({ data: { after: null, children: [{ data: { id: 'p3', title: 'Fallback', permalink: '/r/programming/comments/p3/x/', subreddit: 'programming', created_utc: 1760000000 } }] } });
    },
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.meta.degraded, true);
});

test('Discord Bot 消息、邀请模式和无 Token 错误', async () => {
  const message = {
    id: '100', channel_id: 'c1', content: 'hello discord', timestamp: '2026-10-18T00:00:00Z',
    author: { id: 'u1', username: 'alice' },
    attachments: [{ id: 'a1', filename: 'a.png', url: 'https://cdn.example/a.png', size: 10 }],
    embeds: [], reactions: [{ emoji: { name: '👍' }, count: 2 }],
  };
  const result = await collectSource({
    source: { platform: 'discord', name: 'd', url: 'https://discord.com/channels/g1/c1', config: { guildId: 'g1', channelIds: ['c1'], includeThreads: false } },
    rule: { kind: 'channel', value: 'c1' },
    auth: { type: 'token', token: 'bot-token' },
    fetchImpl: async (url) => {
      const value = String(url);
      if (value.includes('/channels/c1/messages')) return response([message]);
      if (value.includes('/channels/c1/threads/active')) return response({ threads: [] });
      return { status: 404, headers: {}, text: '[]' };
    },
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].content, 'hello discord');
  assert.equal(result.items[0].metadata.attachments[0].name, 'a.png');
  assert.equal(result.items[0].canonical_url, 'https://discord.com/channels/g1/c1/100');

  const invite = await collectSource({
    source: { platform: 'discord', name: 'd', url: 'https://discord.gg/abc', config: { mode: 'invite' } },
    rule: { kind: 'guild', value: 'abc' },
    fetchImpl: async () => response({ guild: { id: 'g1', name: 'Guild' }, approximate_member_count: 10, approximate_presence_count: 3 }),
  });
  assert.equal(invite.items.length, 1);
  assert.equal(invite.items[0].metadata.mode, 'invite');
  assert.equal(invite.meta.messageCollection, undefined);
  await assert.rejects(collectSource({
    source: { platform: 'discord', name: 'd', url: 'https://discord.com/channels/g1/c1', config: { guildId: 'g1', channelIds: ['c1'] } },
    rule: { kind: 'channel', value: 'c1' },
    fetchImpl: async () => response([], 200),
  }), /Bot Token/);
});

test('Telegram 频道识别、公开预览、Bot 和 feed 兼容', () => {
  assert.equal(parseTelegramTarget('https://t.me/durov').type, 'public');
  assert.equal(parseTelegramTarget('https://t.me/s/durov').type, 'preview');
  assert.equal(parseTelegramTarget('https://t.me/+abc').type, 'private');
  assert.equal(parseTelegramTarget('https://t.me/joinchat/abc').type, 'private');
  const html = `<html><meta property="og:title" content="Durov"><div class="tgme_channel_info_counter"><span class="counter_value">1.2M</span></div>
    <div class="tgme_widget_message" data-post="durov/100">
      <div class="tgme_widget_message_text">Hello Telegram</div>
      <time datetime="2026-10-18T00:00:00Z"></time>
      <span class="tgme_widget_message_views">1.2K</span>
      <a class="tgme_widget_message_photo_wrap" href="https://cdn.example/p.jpg"></a>
    </div></html>`;
  const parsed = parseTelegramPreview(html, 'durov');
  assert.equal(parsed.title, 'Durov');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].metadata.messageId, '100');
  assert.equal(parsed.items[0].metadata.views, '1.2K');
});

test('Telegram 公开预览采集与 Bot 模式', async () => {
  const html = `<html><meta property="og:title" content="Durov"><div class="tgme_widget_message" data-post="durov/100"><div class="tgme_widget_message_text">Hello Telegram</div><time datetime="2026-10-18T00:00:00Z"></time></div></html>`;
  const preview = await collectSource({
    source: { platform: 'telegram', name: 'tg', url: 'https://t.me/s/durov', config: { mode: 'auto', maxPages: 1 } },
    rule: { kind: 'channel', value: 'https://t.me/s/durov' },
    fetchImpl: async () => response(html),
  });
  assert.equal(preview.items.length, 1);
  assert.equal(preview.items[0].content, 'Hello Telegram');
  assert.equal(preview.meta.mode, 'preview');

  const bot = await collectSource({
    source: { platform: 'telegram', name: 'tg', url: 'https://t.me/durov', config: { mode: 'bot' } },
    rule: { kind: 'channel', value: 'https://t.me/durov' },
    auth: { type: 'token', token: 'bot-token' },
    fetchImpl: async (url) => {
      if (String(url).includes('/getChat')) return response({ ok: true, result: { id: 1, title: 'Durov', username: 'durov' } });
      if (String(url).includes('/getUpdates')) return response({ ok: true, result: [{ update_id: 10, channel_post: { message_id: 2, chat: { username: 'durov' }, text: 'bot post', date: 1760000000 } }] });
      return response({ ok: false }, 404);
    },
  });
  assert.equal(bot.items.length, 1);
  assert.equal(bot.items[0].content, 'bot post');
  assert.equal(bot.meta.mode, 'bot');

  const feed = await collectSource({
    source: { platform: 'telegram', name: 'tg', url: 'https://example.com/tg.json', config: { mode: 'feed' } },
    rule: { kind: 'feed', value: '' },
    fetchImpl: async () => response([{ message_id: 1, chat: { id: 1, username: 'durov', title: 'Durov' }, text: 'feed post', date: 1760000000 }]),
  });
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].metadata.mode, 'feed');
});

test('Google CSE 与 News/Bing 降级链', async () => {
  const cse = await collectSource({
    source: { platform: 'google', name: 'g', url: '', config: { cx: 'cx-1', maxItems: 10, maxPages: 1 } },
    rule: { kind: 'keyword', value: 'AI', options: { site: 'example.com' } },
    auth: { type: 'api_key', token: 'key-1' },
    fetchImpl: async (url) => {
      assert.match(String(url), /customsearch\/v1/);
      return response({ items: [{ title: 'AI story', link: 'https://example.com/a', snippet: 'snippet', displayLink: 'example.com' }] });
    },
  });
  assert.equal(cse.items.length, 1);
  assert.equal(cse.items[0].metadata.provider, 'google_cse');

  const rss = `<?xml version="1.0"?><rss><channel><item><title>AI news</title><link>https://example.com/news</link><description>body</description><pubDate>Fri, 17 Oct 2026 08:00:00 GMT</pubDate></item></channel></rss>`;
  const news = await collectSource({
    source: { platform: 'google', name: 'g', url: '', config: { maxItems: 10 } },
    rule: { kind: 'keyword', value: 'AI' },
    fetchImpl: async () => response(rss),
  });
  assert.equal(news.items.length, 1);
  assert.equal(news.items[0].metadata.provider, 'google_news');

  const fallback = await collectSource({
    source: { platform: 'google', name: 'g', url: '', config: { cx: 'cx-1', maxItems: 10 } },
    rule: { kind: 'keyword', value: 'AI' },
    auth: { type: 'api_key', token: 'key-1' },
    fetchImpl: async (url) => {
      if (String(url).includes('customsearch')) return response({ error: { message: 'quota' } }, 403);
      return response(rss);
    },
  });
  assert.equal(fallback.items.length, 1);
  assert.equal(fallback.meta.degraded, true);
});

test('通用 Web 站点搜索、全量列表、sitemap 与 robots', async () => {
  const robots = 'User-agent: *\nAllow: /\nDisallow: /private\n';
  const search = await collectSource({
    source: { platform: 'web', name: 'site', url: 'https://example.com' },
    rule: { kind: 'keyword', value: 'AI', options: {
      mode: 'search', searchUrlTemplate: 'https://example.com/search?q={query}&page={page}',
      resultLinkPattern: 'href="(/post/[^"]+)"', maxPages: 2, maxItems: 10,
    } },
    fetchImpl: async (url) => {
      if (String(url).endsWith('/robots.txt')) return response(robots);
      if (String(url).includes('page=1')) return response('<a href="/post/1">One</a><a href="/post/2">Two</a>');
      return response('<a href="/post/2">Two</a><a href="/post/3">Three</a>');
    },
  });
  assert.equal(search.items.length, 3, JSON.stringify(search.meta));

  const listing = await collectSource({
    source: { platform: 'web', name: 'list', url: 'https://example.com' },
    rule: { kind: 'full', value: '', options: {
      mode: 'full', listUrlTemplate: 'https://example.com/list?page={page}', maxPages: 2,
      itemLinkIncludes: ['/post/'], maxItems: 10,
    } },
    fetchImpl: async (url) => {
      if (String(url).endsWith('/robots.txt')) return response(robots);
      if (String(url).includes('page=1')) return response('<a href="/post/1">One</a><a href="/post/2">Two</a>');
      return response('<a href="/post/2">Two</a><a href="/post/3">Three</a>');
    },
  });
  assert.equal(listing.items.length, 3);

  const sitemap = await collectSource({
    source: { platform: 'web', name: 'sitemap', url: 'https://example.com/sitemap.xml' },
    rule: { kind: 'sitemap', value: '', options: { mode: 'sitemap', sitemapUrl: 'https://example.com/sitemap.xml', maxItems: 10 } },
    fetchImpl: async (url) => {
      if (String(url).endsWith('/robots.txt')) return response(robots);
      if (String(url).endsWith('sitemap.xml')) return response('<?xml version="1.0"?><sitemapindex><sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap></sitemapindex>');
      return response('<?xml version="1.0"?><urlset><url><loc>https://example.com/post/9</loc></url></urlset>');
    },
  });
  assert.equal(sitemap.items.length, 1);
  assert.equal(sitemap.items[0].metadata.mode, 'sitemap');
});

test('HTML/sitemap/robots 工具与无结构化数据回退', () => {
  const html = `<html><head><meta property="og:title" content="OG title"><script type="application/ld+json">{"@type":"NewsArticle","headline":"LD title","datePublished":"2026-10-18T00:00:00Z","author":{"name":"Ada"}}</script></head><body><article><p>${'long body '.repeat(20)}</p></article></body></html>`;
  const ld = extractJsonLd(html);
  assert.equal(ld.title, 'LD title');
  assert.equal(ld.author, 'Ada');
  assert.equal(parseSitemap('<urlset><url><loc>https://a</loc></url></urlset>').type, 'urlset');
  assert.equal(parseSitemap('<sitemapindex><sitemap><loc>https://a</loc></sitemap></sitemapindex>').type, 'index');
  const robots = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\n');
  assert.equal(isPathAllowed('/private/x', robots), false);
  assert.equal(isPathAllowed('/private/ok/1', robots), true);
  const page = extractPageContent('<html><head><title>Plain</title></head><body><p>Important body</p></body></html>', 'https://example.com');
  assert.equal(page.format, 'html');
  assert.match(page.content, /Important body/);
});

test('arXiv 分页与 Hugging Face 镜像回退、关键词过滤', async () => {
  const arxiv = await collectSource({
    source: { platform: 'arxiv', name: 'a', url: 'https://export.arxiv.org/api/query' },
    rule: { kind: 'keyword', value: 'agent', options: { maxResults: 3, pageSize: 2 } },
    fetchImpl: async (url) => {
      const start = Number(new URL(url).searchParams.get('start'));
      if (start === 0) return response(`${paperAtom('1', 'Agent one')}${paperAtom('2', 'Agent two')}`);
      return response(paperAtom('3', 'Agent three'));
    },
  });
  assert.equal(arxiv.items.length, 3);

  const baseEntry = (id, title, keywords = ['agent']) => ({ paper: { id, title, summary: 'summary', ai_keywords: keywords, authors: [{ name: 'Ada' }], upvotes: 2 } });
  const hf = await collectSource({
    source: { platform: 'huggingface', name: 'hf', url: 'https://hf-mirror.com/api/daily_papers', config: { baseUrl: 'https://hf-mirror.com', pageSize: 2, maxPages: 1 } },
    rule: { kind: 'full', value: '' },
    fetchImpl: async (url) => {
      if (String(url).includes('hf-mirror.com')) throw new Error('mirror down');
      return response([baseEntry('p1', 'Agent paper'), baseEntry('p2', 'Other paper')]);
    },
  });
  assert.equal(hf.items.length, 2);
  assert.equal(hf.meta.fallback, true);
  assert.equal(hf.items[0].canonical_url.startsWith('https://huggingface.co/papers/'), true);

  const filtered = await collectSource({
    source: { platform: 'huggingface', name: 'hf', url: 'https://huggingface.co/api/daily_papers', config: { baseUrl: 'https://huggingface.co', pageSize: 2, maxPages: 1 } },
    rule: { kind: 'keyword', value: 'agent' },
    fetchImpl: async () => response([baseEntry('p3', 'Agent paper'), baseEntry('p4', 'Other paper', ['other'])]),
  });
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].title, 'Agent paper');
});

test('X mock 模式通过 Python worker 采集', async (t) => {
  try {
    const result = await collectSource({
      source: { platform: 'x', name: 'x', url: 'https://x.com/karpathy', config: { mode: 'mock', maxItems: 3 } },
      rule: { kind: 'keyword', value: 'agent' },
    });
    assert.ok(result.items.length >= 1);
    assert.equal(result.items[0].platform, 'x');
    assert.equal(result.items[0].metadata.isMock, true);
  } catch (error) {
    if (/无法启动|PYTHON|python|module/i.test(error.message)) return t.skip(`Python 不可用：${error.message}`);
    throw error;
  }
});

test('X 参数、游标与归一化', () => {
  const args = buildXArgs({ kind: 'account', value: '@karpathy' }, { mode: 'mock', perAccount: 5 });
  assert.deepEqual(args.slice(0, 4), ['fetch', '--accounts', 'karpathy', '--per']);
  const searchArgs = buildXArgs({ kind: 'keyword', value: 'AI agent' }, { mode: 'mock', maxItems: 5, searchType: 'latest', minLikes: 2 });
  assert.ok(searchArgs.includes('search'));
  assert.ok(searchArgs.includes('--min-likes'));

  const fresh = filterByCursor([{ id: '1005' }, { id: '995' }, { id: '1001' }], { lastId: '1000' });
  assert.deepEqual(fresh.map((item) => item.id), ['1005', '1001']);
  const item = normalizeTweet({ id: '1', author_username: 'karpathy', text: 'AI', like_count: 3, media: [{ type: 'photo', url: 'https://x.com/a.jpg' }] });
  assert.equal(item.platform, 'x');
  assert.equal(item.canonical_url, 'https://x.com/karpathy/status/1');
  assert.equal(item.metadata.likes, 3);
  assert.equal(item.metadata.notification.event, 'tweet');
});
