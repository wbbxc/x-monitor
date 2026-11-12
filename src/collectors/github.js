// GitHub 采集：Releases/Tags、Issues、Pull Requests、Discussions。
import { configOf, defaultMaxItems } from './rules.js';
import { canonicalizeUrl } from './text.js';
import { CollectorError } from './errors.js';

const API = 'https://api.github.com';
const WEB = 'https://github.com';
const DEFAULT_EVENTS = ['releases', 'issues', 'pulls', 'discussions'];
const EVENTS = new Set([...DEFAULT_EVENTS, 'branches']);

function maxItemsOf(settings) {
  return defaultMaxItems(settings);
}

function maxPagesOf(settings, fallback = 2) {
  return Math.max(1, Math.min(20, Number(settings.maxPages) || fallback));
}

export function parseRepo(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('GitHub 仓库不能为空');
  let owner = '';
  let repo = '';
  const text = raw.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  const match = text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/.*)?$/);
  if (match) [, owner, repo] = match;
  if (!owner || !repo || owner === '.' || repo === '.') throw new Error(`GitHub 仓库格式无效: ${raw}`);
  return { owner, repo, slug: `${owner}/${repo}` };
}

function eventsOf(settings) {
  const raw = Array.isArray(settings.events) ? settings.events : DEFAULT_EVENTS;
  const events = [...new Set(raw.map((value) => String(value).toLowerCase()))].filter((value) => EVENTS.has(value));
  if (!events.length) throw new Error('GitHub events 不能为空');
  return events;
}

function headersFor(ctx) {
  const token = String(ctx.auth?.token || '').trim();
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'X-Monitor/1.2 (+local collector)',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function apiBase(ctx) {
  return String(ctx.settings.baseUrl || API).replace(/\/+$/, '');
}

function webBase(ctx) {
  return String(ctx.settings.webBaseUrl || WEB).replace(/\/+$/, '');
}

function resetDelay(headers = {}) {
  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const reset = Number(headers['x-ratelimit-reset']);
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - Date.now());
  return 0;
}

function errorFor(status, body, headers = {}) {
  const detail = String(body || '').slice(0, 300);
  const delay = resetDelay(headers);
  if (status === 401) {
    return new CollectorError('GitHub Token 无效或已过期', { code: 'AUTH_INVALID', status, retryable: false });
  }
  if (status === 403) {
    const exhausted = headers['x-ratelimit-remaining'] != null && Number(headers['x-ratelimit-remaining']) <= 0;
    const rateLimited = exhausted || /rate limit|secondary rate|abuse/i.test(detail);
    return new CollectorError(`GitHub ${rateLimited ? '触发限流' : '权限不足或拒绝访问'}${detail ? `：${detail}` : ''}`, {
      code: rateLimited ? 'RATE_LIMITED' : 'FORBIDDEN',
      status,
      retryable: rateLimited,
      retryAfterMs: rateLimited ? (delay || 60_000) : 0,
    });
  }
  if (status === 429) {
    return new CollectorError('GitHub 触发限流', { code: 'RATE_LIMITED', status, retryable: true, retryAfterMs: delay || 60_000 });
  }
  return new CollectorError(`GitHub HTTP ${status}${detail ? `：${detail}` : ''}`, {
    code: status >= 500 ? 'HTTP_5XX' : 'HTTP_4XX', status, retryable: status >= 500,
  });
}

async function requestJson(ctx, url, { method = 'GET', body = null, etag = '', accept = '' } = {}) {
  const headers = headersFor(ctx);
  if (accept) headers.accept = accept;
  if (etag) headers['if-none-match'] = etag;
  try {
    const response = await ctx.fetch(url, {
      method,
      body: body == null ? null : JSON.stringify(body),
      headers,
    });
    if (response.status === 304) return { notModified: true, status: 304, headers: response.headers };
    const text = String(response.text || '').trim();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch {
        throw new CollectorError('GitHub 返回不是有效 JSON', { code: 'PARSE_ERROR', status: response.status, retryable: false });
      }
    }
    return { payload, status: response.status, headers: response.headers, text };
  } catch (error) {
    if (error instanceof CollectorError && [401, 403, 429].includes(Number(error.status))) {
      throw errorFor(Number(error.status), error.body || error.message, error.headers || {});
    }
    if (error instanceof CollectorError) throw error;
    if (error.status) throw errorFor(error.status, error.body, error.headers);
    throw error;
  }
}

async function paginate(ctx, url, { maxPages, onPage, etag = '', accept = '' }) {
  const pages = [];
  for (let page = 1; page <= maxPages; page++) {
    const next = new URL(url);
    next.searchParams.set('per_page', '100');
    next.searchParams.set('page', String(page));
    const result = await requestJson(ctx, next.href, { etag: page === 1 ? etag : '', accept });
    if (result.notModified) {
      pages.push({ page, notModified: true, count: 0 });
      break;
    }
    const values = Array.isArray(result.payload) ? result.payload : [];
    pages.push({ page, status: result.status, count: values.length, etag: result.headers?.etag || '' });
    if (values.length) await onPage(values, { page, headers: result.headers });
    if (values.length < 100) break;
  }
  return pages;
}

function repoMeta(owner, repo) {
  return { repo: `${owner}/${repo}`, owner, repository: repo };
}

function releaseItem(entry, ctx, owner, repo) {
  const tag = String(entry.tag_name || entry.name || '');
  return {
    platform: 'github',
    external_id: `release:${entry.id}`,
    canonical_url: canonicalizeUrl(entry.html_url || `${webBase(ctx)}/${owner}/${repo}/releases/tag/${tag}`),
    source_url: `${webBase(ctx)}/${owner}/${repo}`,
    title: entry.name || tag || `Release ${entry.id}`,
    content: entry.body || '',
    summary: entry.body || '',
    author: entry.author?.login || '',
    published_at: entry.published_at || entry.created_at || null,
    links: [entry.html_url, ...(entry.assets || []).map((asset) => asset.browser_download_url)],
    raw_json: entry,
    metadata: {
      ...repoMeta(owner, repo),
      event: 'release',
      tag,
      prerelease: !!entry.prerelease,
      draft: !!entry.draft,
      assets: (entry.assets || []).map((asset) => ({ name: asset.name, url: asset.browser_download_url, size: asset.size })),
      notification: {
        event: 'release',
        title: `${owner}/${repo} 发布 ${entry.name || tag}`,
        body: String(entry.body || '').slice(0, 500),
        updateKey: `release:${entry.id}:${entry.published_at || ''}`,
      },
    },
  };
}

function tagItem(entry, ctx, owner, repo) {
  const name = String(entry.name || '');
  return {
    platform: 'github',
    external_id: `tag:${name}`,
    canonical_url: canonicalizeUrl(`${webBase(ctx)}/${owner}/${repo}/releases/tag/${encodeURIComponent(name)}`),
    source_url: `${webBase(ctx)}/${owner}/${repo}`,
    title: `${owner}/${repo} ${name}`,
    content: `Tag ${name}`,
    summary: `Tag ${name}`,
    author: '',
    published_at: null,
    links: [entry.commit?.sha ? `${webBase(ctx)}/${owner}/${repo}/commit/${entry.commit.sha}` : ''],
    raw_json: entry,
    metadata: {
      ...repoMeta(owner, repo),
      event: 'tag',
      tag: name,
      notification: { event: 'tag', title: `${owner}/${repo} 新增 Tag ${name}` },
    },
  };
}

function issueItem(entry, ctx, owner, repo, kind) {
  const isPull = kind === 'pull';
  const labels = (entry.labels || []).map((label) => typeof label === 'string' ? label : label.name).filter(Boolean);
  return {
    platform: 'github',
    external_id: `${isPull ? 'pull' : 'issue'}:${entry.id}`,
    canonical_url: canonicalizeUrl(entry.html_url),
    source_url: `${webBase(ctx)}/${owner}/${repo}`,
    title: entry.title || `#${entry.number}`,
    content: entry.body || '',
    summary: entry.body || '',
    author: entry.user?.login || '',
    published_at: entry.created_at || null,
    links: [entry.html_url],
    raw_json: entry,
    metadata: {
      ...repoMeta(owner, repo),
      event: isPull ? 'pull' : 'issue',
      number: entry.number,
      state: entry.state,
      labels,
      assignees: (entry.assignees || []).map((user) => user.login).filter(Boolean),
      comments: entry.comments ?? 0,
      isPullRequest: isPull,
      updatedAt: entry.updated_at || null,
      notification: {
        event: isPull ? 'pull' : 'issue',
        title: `${owner}/${repo} ${isPull ? 'PR' : 'Issue'} #${entry.number} ${entry.title || ''}`,
        body: String(entry.body || '').slice(0, 500),
        updateKey: `${entry.state}:${entry.updated_at || ''}:${entry.comments || 0}`,
      },
    },
  };
}

function discussionItem(entry, ctx, owner, repo) {
  const labels = (entry.labels?.nodes || []).map((label) => label.name).filter(Boolean);
  return {
    platform: 'github',
    external_id: `discussion:${entry.id}`,
    canonical_url: canonicalizeUrl(entry.url),
    source_url: `${webBase(ctx)}/${owner}/${repo}`,
    title: entry.title || `Discussion #${entry.number}`,
    content: entry.body || '',
    summary: entry.body || '',
    author: entry.author?.login || '',
    published_at: entry.createdAt || null,
    links: [entry.url],
    raw_json: entry,
    metadata: {
      ...repoMeta(owner, repo),
      event: 'discussion',
      number: entry.number,
      category: entry.category?.name || '',
      state: entry.state || '',
      labels,
      comments: entry.comments?.totalCount ?? 0,
      updatedAt: entry.updatedAt || null,
      notification: {
        event: 'discussion',
        title: `${owner}/${repo} 讨论 ${entry.title || ''}`,
        body: String(entry.body || '').slice(0, 500),
        updateKey: `${entry.state || ''}:${entry.updatedAt || ''}:${entry.comments?.totalCount || 0}`,
      },
    },
  };
}

function filterIssue(entry, options) {
  const labels = (entry.labels || []).map((label) => (typeof label === 'string' ? label : label.name)).filter(Boolean);
  const wanted = Array.isArray(options.labels) ? options.labels.map(String).filter(Boolean) : [];
  if (wanted.length && !wanted.some((label) => labels.includes(label))) return false;
  const state = String(options.state || 'all').toLowerCase();
  if (state !== 'all' && String(entry.state || '').toLowerCase() !== state) return false;
  return true;
}

async function fetchReleases(ctx, repo, cursor, options) {
  const { owner, repo: name } = repo;
  const state = cursor.releases || {};
  const items = [];
  const pages = await paginate(ctx, `${apiBase(ctx)}/repos/${owner}/${name}/releases`, {
    maxPages: maxPagesOf(options, 2),
    etag: state.etag || '',
    onPage(values) {
      for (const entry of values) {
        if (entry.draft) continue;
        if (options.includePrereleases === false && entry.prerelease) continue;
        items.push(releaseItem(entry, ctx, owner, name));
      }
    },
  });
  if (!items.length && pages.every((page) => page.count === 0) && !pages.some((page) => page.notModified) && options.includeTagsFallback !== false) {
    const tags = await paginate(ctx, `${apiBase(ctx)}/repos/${owner}/${name}/tags`, {
      maxPages: 1,
      onPage(values) {
        for (const entry of values) items.push(tagItem(entry, ctx, owner, name));
      },
    });
    return { items, pages, tags, fallback: 'tags' };
  }
  return { items, pages };
}

async function fetchIssues(ctx, repo, cursor, options, kind) {
  const { owner, repo: name } = repo;
  const path = kind === 'pull' ? 'pulls' : 'issues';
  const state = cursor[kind === 'pull' ? 'pulls' : 'issues'] || {};
  const since = state.since || options.since || '';
  const items = [];
  const pages = [];
  for (let page = 1; page <= maxPagesOf(options, 2); page++) {
    const url = new URL(`${apiBase(ctx)}/repos/${owner}/${name}/${path}`);
    url.searchParams.set('state', String(options.state || 'all'));
    url.searchParams.set('sort', 'updated');
    url.searchParams.set('direction', 'desc');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    if (since) url.searchParams.set('since', since);
    const result = await requestJson(ctx, url.href, { etag: page === 1 ? state.etag || '' : '' });
    if (result.notModified) {
      pages.push({ page, notModified: true, count: 0, etag: result.headers?.etag || '' });
      break;
    }
    const values = Array.isArray(result.payload) ? result.payload : [];
    pages.push({ page, status: result.status, count: values.length, etag: result.headers?.etag || '' });
    for (const entry of values) {
      if (kind === 'issue' && entry.pull_request) continue;
      if (!filterIssue(entry, options)) continue;
      items.push(issueItem(entry, ctx, owner, name, kind));
    }
    if (values.length < 100) break;
  }
  return { items, pages };
}

async function fetchDiscussions(ctx, repo, cursor, options) {
  const token = String(ctx.auth?.token || '').trim();
  if (!token) {
    ctx.logger?.warn?.('GitHub Discussions 需要 Token，已跳过');
    return { items: [], skipped: 'discussions requires token' };
  }
  const { owner, repo: name } = repo;
  const state = cursor.discussions || {};
  const items = [];
  let after = state.endCursor || null;
  const pages = [];
  for (let page = 0; page < maxPagesOf(options, 2); page++) {
    const query = `query($owner:String!,$repo:String!,$after:String){repository(owner:$owner,name:$repo){discussions(first:50,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor}nodes{id number title body url createdAt updatedAt state author{login} category{name} labels(first:20){nodes{name}} comments{totalCount}}}}}`;
    const result = await requestJson(ctx, `${apiBase(ctx)}/graphql`, {
      method: 'POST',
      body: { query, variables: { owner, repo: name, after } },
    });
    if (result.payload?.errors?.length) {
      throw new CollectorError(`GitHub Discussions: ${result.payload.errors[0].message}`, {
        code: 'GRAPHQL_ERROR', retryable: false,
      });
    }
    const discussions = result.payload?.data?.repository?.discussions;
    const nodes = discussions?.nodes || [];
    for (const entry of nodes) items.push(discussionItem(entry, ctx, owner, name));
    pages.push({ page, count: nodes.length, cursor: discussions?.pageInfo?.endCursor || null });
    if (!discussions?.pageInfo?.hasNextPage) {
      after = discussions?.pageInfo?.endCursor || after;
      break;
    }
    after = discussions?.pageInfo?.endCursor || null;
    if (!after) break;
  }
  return { items, pages, endCursor: after };
}


function branchListOf(options = {}) {
  const raw = Array.isArray(options.branches)
    ? options.branches
    : String(options.branches || '').split(',');
  return [...new Set(raw.map((value) => String(value || '').trim()).filter(Boolean))];
}

function boundedInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function branchLimit(options = {}) {
  return boundedInt(options.maxBranches, 10, 1, 50);
}

function commitLimitPerBranch(options = {}) {
  return boundedInt(options.maxCommitsPerBranch, 50, 1, 500);
}

function codeChangesEnabled(options = {}) {
  return options.includeCodeChanges !== false;
}

function diffCommitLimit(options = {}) {
  return boundedInt(options.maxDiffCommitsPerRun, 10, 0, 100);
}

function filesPerCommitLimit(options = {}) {
  return boundedInt(options.maxFilesPerCommit, 20, 1, 100);
}

function patchCharsLimit(options = {}) {
  return boundedInt(options.maxPatchCharsPerFile, 2000, 100, 20_000);
}

async function resolveBranches(ctx, repo, state, options) {
  const { owner, repo: name } = repo;
  const names = [];
  let defaultBranch = state.defaultBranch || String(options.defaultBranch || '').trim();
  const configured = branchListOf(options);
  const includeDefault = options.includeDefaultBranch === true;
  const needsDefault = includeDefault || (!configured.length && !options.allBranches);
  if (needsDefault && !defaultBranch) {
    const info = await requestJson(ctx, `${apiBase(ctx)}/repos/${owner}/${name}`);
    defaultBranch = String(info.payload?.default_branch || '').trim();
    if (defaultBranch) state.defaultBranch = defaultBranch;
  }
  if (options.allBranches) {
    const list = await requestJson(ctx, `${apiBase(ctx)}/repos/${owner}/${name}/branches?per_page=100`);
    for (const entry of Array.isArray(list.payload) ? list.payload : []) {
      names.push(String(entry.name || '').trim());
    }
  }
  if (includeDefault && defaultBranch) names.unshift(defaultBranch);
  names.push(...configured);
  if (!names.length && defaultBranch) names.push(defaultBranch);
  const unique = [...new Set(names.filter(Boolean))];
  const limit = branchLimit(options);
  return {
    branches: unique.slice(0, limit),
    total: unique.length,
    truncated: unique.length > limit,
    defaultBranch,
  };
}

function commitItem(entry, ctx, repo, branch) {
  const { owner, repo: name } = repo;
  const sha = String(entry.sha || '');
  const message = String(entry.commit?.message || '');
  const firstLine = message.split(/\r?\n/)[0].trim() || sha.slice(0, 12);
  const parents = Array.isArray(entry.parents) ? entry.parents.map((parent) => parent.sha).filter(Boolean) : [];
  const author = entry.author?.login || entry.commit?.author?.name || entry.commit?.committer?.name || '';
  const date = entry.commit?.committer?.date || entry.commit?.author?.date || null;
  const url = canonicalizeUrl(entry.html_url || `${webBase(ctx)}/${owner}/${name}/commit/${sha}`);
  return {
    platform: 'github',
    external_id: `commit:${sha}`,
    canonical_url: url,
    source_url: `${webBase(ctx)}/${owner}/${name}`,
    title: firstLine,
    content: message,
    summary: message,
    author,
    published_at: date,
    links: [url, entry.author?.html_url].filter(Boolean),
    raw_json: entry,
    metadata: {
      ...repoMeta(owner, name),
      event: 'commit',
      branch,
      sha,
      shortSha: sha.slice(0, 12),
      parents,
      mergeCommit: parents.length >= 2,
      authorLogin: entry.author?.login || '',
      notification: {
        event: 'commit',
        title: `${owner}/${name} ${branch}: ${firstLine}`.slice(0, 220),
        body: message.slice(0, 500),
        updateKey: `commit:${sha}`,
      },
    },
  };
}

const CODE_STATUS_LABELS = {
  added: 'A', modified: 'M', removed: 'D', renamed: 'R', copied: 'C', changed: 'C', unchanged: ' ',
};

function commitContent(item, codeChanges) {
  const lines = [String(item.content || '').trim()];
  if (!codeChanges) return lines[0];
  const files = codeChanges.files || [];
  lines.push('', `变更文件 ${codeChanges.totalFiles} 个${codeChanges.truncated ? '（已截断）' : ''}：`);
  if (!files.length) {
    lines.push('- 无文件变更');
  } else {
    for (const file of files) {
      const rename = file.previousFilename ? `（原 ${file.previousFilename}）` : '';
      lines.push(`- ${CODE_STATUS_LABELS[file.status] || '?'} ${file.filename}${rename} +${file.additions || 0} -${file.deletions || 0}`);
    }
  }
  lines.push('', `提交：${codeChanges.commitUrl}`);
  if (codeChanges.compareUrl) lines.push(`对比：${codeChanges.compareUrl}`);
  return lines.join('\n');
}

function markDiffed(branchState, branch, sha) {
  const previous = branchState[branch] || {};
  const current = Array.isArray(previous.diffedShas) ? previous.diffedShas : [];
  const next = current.includes(sha) ? current : [...current, sha];
  branchState[branch] = { ...previous, diffedShas: next.slice(-50) };
}

async function enrichCommitItem(ctx, repo, item, options, branchState) {
  const { owner, repo: name } = repo;
  const sha = item.metadata.sha;
  const detail = await requestJson(ctx, `${apiBase(ctx)}/repos/${owner}/${name}/commits/${sha}`);
  const rawFiles = Array.isArray(detail.payload?.files) ? detail.payload.files : [];
  const maxFiles = filesPerCommitLimit(options);
  const maxPatch = patchCharsLimit(options);
  const includePatch = options.includePatch !== false;
  let truncated = rawFiles.length > maxFiles;
  const files = rawFiles.slice(0, maxFiles).map((file) => {
    const originalPatch = typeof file.patch === 'string' ? file.patch : '';
    const patchTruncated = originalPatch.length > maxPatch;
    if (patchTruncated) truncated = true;
    const entry = {
      filename: String(file.filename || ''),
      previousFilename: String(file.previous_filename || ''),
      status: String(file.status || 'modified'),
      additions: Number(file.additions) || 0,
      deletions: Number(file.deletions) || 0,
      changes: Number(file.changes) || 0,
      binary: !Object.prototype.hasOwnProperty.call(file, 'patch'),
      patchUnavailable: !originalPatch,
    };
    if (includePatch && originalPatch) entry.patch = originalPatch.slice(0, maxPatch);
    return entry;
  });
  const parent = item.metadata.parents?.[0];
  const commitUrl = item.canonical_url || `${webBase(ctx)}/${owner}/${name}/commit/${sha}`;
  const compareUrl = parent ? `${webBase(ctx)}/${owner}/${name}/compare/${parent}...${sha}` : '';
  const codeChanges = {
    files,
    totalFiles: rawFiles.length,
    returnedFiles: files.length,
    truncated,
    commitUrl,
    compareUrl,
    available: true,
  };
  item.metadata.codeChanges = codeChanges;
  item.content = commitContent(item, codeChanges);
  item.summary = item.content;
  if (compareUrl && !item.links.includes(compareUrl)) item.links.push(compareUrl);
  item.metadata.notification.body = item.content.slice(0, 500);
  markDiffed(branchState, item.metadata.branch, sha);
  return item;
}

async function fetchBranchCommits(ctx, repo, state, options) {
  const { owner, repo: name } = repo;
  const resolved = await resolveBranches(ctx, repo, state, options);
  const branches = resolved.branches;
  const branchState = { ...(state.branches || {}) };
  const items = [];
  const pages = {};
  const errors = [];
  let filtered = 0;
  let codeChangesStopped = false;
  let codeChangesUnavailable = 0;
  let codeChangesEnriched = 0;
  let codeChangesTruncated = 0;
  const maxPages = Math.max(1, Math.min(3, boundedInt(options.maxCommitPages, 2, 1, 3)));
  for (const branch of branches) {
    const previous = branchState[branch] || {};
    const since = previous.since || options.since || '';
    const branchItems = [];
    const branchPages = [];
    try {
      for (let page = 1; page <= maxPages; page++) {
        const url = new URL(`${apiBase(ctx)}/repos/${owner}/${name}/commits`);
        url.searchParams.set('sha', branch);
        url.searchParams.set('per_page', '100');
        url.searchParams.set('page', String(page));
        if (since) url.searchParams.set('since', since);
        const result = await requestJson(ctx, url.href);
        const values = Array.isArray(result.payload) ? result.payload : [];
        branchPages.push({ page, status: result.status, count: values.length });
        for (const entry of values) {
          const parents = Array.isArray(entry.parents) ? entry.parents : [];
          if (options.includeMergeCommits === false && parents.length >= 2) {
            filtered++;
            continue;
          }
          branchItems.push(commitItem(entry, ctx, repo, branch));
        }
        if (values.length < 100) break;
        if (branchItems.length >= commitLimitPerBranch(options)) break;
      }
      const newest = branchItems
        .map((item) => item.published_at)
        .filter(Boolean)
        .sort()
        .pop();
      const maxSha = branchItems
        .map((item) => item.metadata.sha)
        .filter(Boolean)
        .sort()
        .pop();
      branchState[branch] = {
        ...previous,
        since: newest || previous.since || null,
        lastSha: maxSha || previous.lastSha || null,
        diffedShas: Array.isArray(previous.diffedShas) ? previous.diffedShas.slice(-50) : [],
      };
      items.push(...branchItems.slice(0, commitLimitPerBranch(options)));
      pages[branch] = branchPages;
    } catch (error) {
      errors.push({ branch, error: error.message, code: error.code || '' });
      pages[branch] = branchPages;
      if (error.retryable) throw error;
    }
  }

  if (codeChangesEnabled(options)) {
    const budget = diffCommitLimit(options);
    const candidates = items
      .filter((item) => {
        const seen = branchState[item.metadata.branch]?.diffedShas || [];
        return !seen.includes(item.metadata.sha);
      })
      .sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')))
      .slice(0, budget);
    for (const item of candidates) {
      if (codeChangesStopped) {
        item.metadata.codeChangesTruncated = true;
        codeChangesTruncated++;
        continue;
      }
      try {
        await enrichCommitItem(ctx, repo, item, options, branchState);
        codeChangesEnriched++;
      } catch (error) {
        const status = Number(error.status) || 0;
        item.metadata.codeChangesUnavailable = true;
        item.metadata.notification.body = `${item.content.slice(0, 450)}\n\n代码改动暂不可用`;
        codeChangesUnavailable++;
        markDiffed(branchState, item.metadata.branch, item.metadata.sha);
        if (status === 403 || status === 429 || error.code === 'RATE_LIMITED') {
          codeChangesStopped = true;
        }
      }
    }
    if (budget === 0 || candidates.length < items.length) {
      for (const item of items) {
        if (!item.metadata.codeChanges && !item.metadata.codeChangesUnavailable) {
          item.metadata.codeChangesTruncated = true;
          codeChangesTruncated++;
        }
      }
    }
  }

  return {
    branches,
    branchInfo: resolved,
    items,
    pages,
    errors,
    filtered,
    state: branchState,
    codeChanges: {
      enabled: codeChangesEnabled(options),
      enriched: codeChangesEnriched,
      unavailable: codeChangesUnavailable,
      truncated: codeChangesTruncated,
      stopped: codeChangesStopped,
    },
  };
}

export async function collectGithub(ctx) {
  const options = { ...configOf(ctx.source), ...(ctx.rule?.options || {}) };
  const repo = parseRepo(ctx.rule?.value || options.repo);
  const events = eventsOf(options);
  const existing = ctx.cursor.get() || {};
  const cursor = { ...existing };
  const repoKey = repo.slug;
  const state = { ...(cursor.repos?.[repoKey] || {}) };
  const result = {
    items: [],
    meta: { provider: 'github', repo: repoKey, events, skipped: [], pages: {} },
  };

  if (events.includes('releases')) {
    const releases = await fetchReleases(ctx, repo, state, options);
    // 只保留本次上限内的条目，并推进 release 游标。
    result.items.push(...releases.items.slice(0, maxItemsOf(options)));
    state.releases = {
      ...(state.releases || {}),
      etag: releases.pages[0]?.etag || state.releases?.etag || '',
      lastPublishedAt: releases.items.map((item) => item.published_at).filter(Boolean).sort().pop() || state.releases?.lastPublishedAt || null,
    };
    result.meta.pages.releases = releases.pages;
    if (releases.fallback) result.meta.pages.releasesFallback = releases.fallback;
  }
  if (events.includes('issues')) {
    const issues = await fetchIssues(ctx, repo, state, options, 'issue');
    result.items.push(...issues.items.slice(0, maxItemsOf(options)));
    state.issues = {
      ...(state.issues || {}),
      etag: issues.pages[0]?.etag || state.issues?.etag || '',
      since: issues.items.map((item) => item.metadata?.updatedAt).filter(Boolean).sort().pop() || state.issues?.since || null,
    };
    result.meta.pages.issues = issues.pages;
  }
  if (events.includes('pulls')) {
    const pulls = await fetchIssues(ctx, repo, state, options, 'pull');
    result.items.push(...pulls.items.slice(0, maxItemsOf(options)));
    state.pulls = {
      ...(state.pulls || {}),
      etag: pulls.pages[0]?.etag || state.pulls?.etag || '',
      since: pulls.items.map((item) => item.metadata?.updatedAt).filter(Boolean).sort().pop() || state.pulls?.since || null,
    };
    result.meta.pages.pulls = pulls.pages;
  }
  if (events.includes('discussions')) {
    const discussions = await fetchDiscussions(ctx, repo, state, options);
    result.items.push(...discussions.items.slice(0, maxItemsOf(options)));
    if (discussions.skipped) result.meta.skipped.push(discussions.skipped);
    state.discussions = {
      ...(state.discussions || {}),
      endCursor: discussions.endCursor || state.discussions?.endCursor || null,
    };
    result.meta.pages.discussions = discussions.pages;
  }

  if (events.includes('branches')) {
    const branchResult = await fetchBranchCommits(ctx, repo, state, options);
    result.items.push(...branchResult.items.slice(0, maxItemsOf(options)));
    state.branches = branchResult.state;
    result.meta.branches = branchResult.branches;
    result.meta.pages.branches = branchResult.pages;
    result.meta.branchErrors = branchResult.errors;
    result.meta.branchFiltered = branchResult.filtered;
    result.meta.branchInfo = branchResult.branchInfo;
    result.meta.codeChanges = branchResult.codeChanges;
    if (branchResult.errors.length) result.meta.skipped.push(...branchResult.errors.map((item) => `${item.branch}: ${item.error}`));
    if (branchResult.codeChanges.unavailable) result.meta.skipped.push(`代码改动不可用 ${branchResult.codeChanges.unavailable} 个提交`);
    if (branchResult.codeChanges.truncated) result.meta.skipped.push(`代码改动已截断 ${branchResult.codeChanges.truncated} 个提交`);
  }

  cursor.repos = { ...(cursor.repos || {}), [repoKey]: state };
  ctx.cursor.set(cursor);
  result.meta.count = result.items.length;
  result.meta.degraded = result.meta.skipped.length > 0;
  return result;
}

export function githubDetect(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'github.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const repo = `${parts[0]}/${parts[1].replace(/\.git$/, '')}`;
  return {
    platform: 'github',
    kind: 'repo',
    value: repo,
    config: { events: ['releases', 'pulls', 'branches'], branches: [], includeDefaultBranch: false },
    name: repo,
    url: `https://github.com/${repo}`,
    confidence: 0.98,
    warnings: [],
  };
}

export const githubAdapter = {
  id: 'github', version: 2, label: 'GitHub 仓库更新',
  capabilities: ['releases', 'issues', 'pulls', 'discussions', 'branches', 'pagination', 'token'],
  auth: { types: ['none', 'token', 'bearer', 'api_key'] },
  authHints: { token: 'GitHub Personal Access Token；Discussions 必须配置' },
  publicFallback: '公开 REST；Discussions 需要 Token',
  rateLimit: { scope: 'host', requests: 1, perMs: 1000, burst: 2 },
  configExample: {
    events: ['releases', 'issues', 'pulls', 'branches'],
    branches: [],
    includeDefaultBranch: false,
    includeMergeCommits: false,
    maxBranches: 10,
    maxCommitsPerBranch: 50,
    includePrereleases: true,
    labels: [],
    state: 'all',
    maxItems: 100,
    maxPages: 2,
  },
  ruleKinds: [
    { kind: 'repo', label: '仓库', requiresValue: true, valuePlaceholder: 'owner/repo', optionsExample: { events: ['releases', 'pulls'] } },
  ],
  detect: githubDetect,
  validateSource() {},
  validateRule(rule) {
    if (String(rule?.kind || '') !== 'repo') throw new Error('GitHub 只支持 repo 规则');
    parseRepo(rule?.value);
    eventsOf(rule?.options || {});
    const branches = branchListOf(rule?.options || {});
    for (const branch of branches) {
      if (branch.length > 200 || /\s/.test(branch)) throw new Error(`GitHub 分支名无效: ${branch}`);
    }
    if (branches.length > 50) throw new Error('GitHub 分支列表最多 50 个');
  },
  async probe(ctx) {
    const result = await requestJson(ctx, `${apiBase(ctx)}/rate_limit`);
    const rate = result.payload?.resources;
    return {
      ok: result.status >= 200 && result.status < 300,
      message: rate?.core ? `GitHub API 剩余 ${rate.core.remaining}/${rate.core.limit}` : `HTTP ${result.status}`,
      rate,
    };
  },
  collect: collectGithub,
};
