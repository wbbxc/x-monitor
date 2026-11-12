import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');

function functionSource(name) {
  const start = app.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `缺少函数 ${name}`);
  const body = app.slice(start);
  return body.slice(0, body.indexOf('\n}') + 2);
}

function evaluateFunction(name, context = {}, prefix = '') {
  return vm.runInNewContext(`${prefix}\n${functionSource(name)}\n${name}`, context);
}

test('主导航收敛到五个工作区，帮助仍然可达', () => {
  const navigation = html.match(/<nav[^>]*id="nav"[\s\S]*?<\/nav>/)[0];
  assert.deepEqual([...navigation.matchAll(/data-view="([^"]+)"/g)].map((match) => match[1]), [
    'dashboard', 'collections', 'content', 'creations', 'settings',
  ]);
  assert.match(html, /data-goto="guide"/);
  assert.match(html, /id="workspaceNav"/);
});

test('旧视图归入对应工作区，平台详情不会丢失导航高亮', () => {
  const meta = app.slice(app.indexOf('const VIEW_META ='), app.indexOf('\n};', app.indexOf('const VIEW_META =')) + 3);
  const workspace = evaluateFunction('viewWorkspace', {}, meta);
  for (const name of ['collections', 'collector-settings', 'accounts', 'collection-platform', 'collection-detail']) {
    assert.equal(workspace(name), 'collections');
  }
  for (const name of ['content', 'materials', 'tweets']) assert.equal(workspace(name), 'content');
  assert.equal(workspace('logs'), 'settings');
  assert.equal(workspace('creations'), 'creations');
  assert.equal(workspace('collection-detail', 'content'), 'content');
});

test('旧采集路由和新增内容库路由都可直接打开', () => {
  for (const [hash, expected] of [
    ['#/settings/collectors', 'collector-settings'],
    ['#/collections/github', 'collection-platform'],
    ['#/collections/github/items/17', 'collection-detail'],
    ['#/content', 'content'], ['#/tweets', 'tweets'], ['#/accounts', 'accounts'], ['#/logs', 'logs'],
  ]) {
    const visited = [];
    const context = { location: { hash }, switchView: (name) => visited.push(name), collectionRoute: {}, URLSearchParams, VIEW_META: Object.fromEntries(['content', 'tweets', 'accounts', 'logs'].map((name) => [name, {}])) };
    evaluateFunction('applyHashRoute', context)();
    assert.equal(visited.at(-1), expected, hash);
    if (expected === 'collection-detail') assert.equal(context.collectionRoute.itemId, 17);
  }
});

test('来源管理只展示当前平台和选定来源，不串到其他平台', () => {
  const scope = evaluateFunction('scopedCollectionSources');
  const sources = [{ id: 1, platform: 'github' }, { id: 2, platform: 'arxiv' }, { id: 3, platform: 'github' }];
  assert.deepEqual(Array.from(scope(sources, 'github', ''), (source) => source.id), [1, 3]);
  assert.deepEqual(Array.from(scope(sources, 'github', '3'), (source) => source.id), [3]);
  assert.deepEqual(Array.from(scope(sources, '', ''), (source) => source.id), [1, 2, 3]);
});

test('来源编辑默认折叠，保留原有配置、认证和保存能力', () => {
  const render = evaluateFunction('renderCollectorSetting', {
    esc: (value) => String(value ?? '').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    platformLabel: (value) => value,
  });
  const output = render({ id: 7, platform: 'github', name: '<repo>', config: { maxItems: 20 }, auth: { configured: true, type: 'bearer' } });
  assert.match(output, /<details class="source-editor"/);
  assert.doesNotMatch(output, /<details class="source-editor"[^>]*\bopen\b/);
  assert.match(output, /&lt;repo>/);
  for (const field of ['url', 'config', 'authType', 'auth']) assert.ok(output.includes(`name="${field}"`));
  assert.match(output, /data-source-rule="7"/);
  assert.match(output, /data-delete-source="7"/);
});

test('来源表单只有一个共享实例，新增规则按需展开', () => {
  for (const id of ['collectorSettingsWorkspace', 'collectorAddForm', 'platformRuleForm', 'platformSourcesSlot', 'platformManageSource']) {
    assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, id);
  }
  assert.match(html, /<details[^>]*id="platformRuleEditor"/);
  assert.doesNotMatch(html, /<details[^>]*id="platformRuleEditor"[^>]*\bopen\b/);
  for (const view of ['accounts', 'tweets', 'materials', 'creations', 'logs', 'guide', 'settings', 'collection-detail']) {
    assert.match(html, new RegExp(`id="view-${view}"`));
  }
});

test('未接入平台默认折叠，但所有平台仍可访问', () => {
  const render = evaluateFunction('renderCollectionBoard', {
    esc: String, platformMark: String, capabilityLabel: String, statusLabel: String, formatRunTime: String,
  });
  const output = render([{ id: 'github', sourceCount: 1 }, { id: 'arxiv', sourceCount: 0 }]);
  assert.match(output, /<details class="available-platforms"/);
  assert.doesNotMatch(output, /<details class="available-platforms"[^>]*\bopen\b/);
  assert.match(output, /#\/collections\/github/);
  assert.match(output, /#\/collections\/arxiv/);
});

test('深浅主题的全部设计 Token 保持不变', () => {
  const tokens = css.split('* { margin:')[0];
  assert.equal(crypto.createHash('sha256').update(tokens).digest('hex'), 'c21f2c38dd523a13632b4387891ea956a95f9f230446f288a4adcbb84371a6b0');
});

test('自动轮询保护草稿，但主动切换工作区仍会刷新来源范围', async () => {
  let loads = 0;
  const refresh = evaluateFunction('refresh', {
    currentView: 'collector-settings',
    document: { querySelector: () => ({}), body: { classList: { add() {}, remove() {} } } },
    setTimeout: () => 1, clearTimeout() {},
    loadCollectorSettings: async () => { loads++; },
  });
  await refresh();
  assert.equal(loads, 1, '主动切换必须刷新，不能被上个工作区的展开表单拦住');
  await refresh(true);
  assert.equal(loads, 1, '轮询不覆盖展开表单中的草稿');
});

test('规则带入当前来源仓库，但不覆盖手动填写的规则值', () => {
  const select = { value: '1' };
  const input = { value: '', dataset: {} };
  const fill = evaluateFunction('fillRuleSourceValue', {
    collectionState: { platform: 'github', sources: [{ id: 1, url: 'https://github.com/acme/first' }, { id: 2, url: 'https://github.com/acme/second' }] },
    URL,
    $: (selector) => selector === '#platformRuleSource' ? select : input,
  });
  fill();
  assert.equal(input.value, 'acme/first');
  select.value = '2';
  fill();
  assert.equal(input.value, 'acme/second');
  input.value = 'custom/repo';
  select.value = '1';
  fill();
  assert.equal(input.value, 'custom/repo');
});

test('内容库复用原采集接口，并正确传递平台、来源、搜索和分页', async () => {
  const elements = new Map();
  const paths = [];
  const context = {
    contentRequest: 0,
    contentState: { platform: 'github', sourceId: '7', q: 'agent', page: 2, pages: 1 },
    URLSearchParams,
    esc: String,
    renderCollectionItem: (item) => item.title,
    scopedCollectionSources: evaluateFunction('scopedCollectionSources'),
    $: (selector) => {
      if (!elements.has(selector)) elements.set(selector, {});
      return elements.get(selector);
    },
    api: async (path) => {
      paths.push(path);
      if (path.startsWith('/collections/items?')) return { total: 45, items: [{ title: 'result' }] };
      if (path === '/collections/platforms') return { items: [{ id: 'github', label: 'GitHub', sourceCount: 1 }] };
      return { items: [{ id: 7, platform: 'github', name: 'repo' }, { id: 8, platform: 'arxiv', name: 'paper' }] };
    },
  };
  await evaluateFunction('loadContent', context)();
  const query = new URLSearchParams(paths[0].split('?')[1]);
  assert.deepEqual(Object.fromEntries(query), { limit: '20', offset: '20', platform: 'github', sourceId: '7', q: 'agent' });
  assert.equal(elements.get('#contentList').innerHTML, 'result');
  assert.match(elements.get('#contentPager').innerHTML, /第 2 \/ 3 页/);
  assert.doesNotMatch(elements.get('#contentSource').innerHTML, /paper/);
});

test('采集后的快速轮询同样经过草稿保护，不直接重置规则表单', async () => {
  let tick;
  const preserved = [];
  const start = evaluateFunction('startPlatformPolling', {
    platformPollUntil: 0, platformPollTimer: null,
    currentView: 'collection-platform', collectionState: { platform: 'github', info: { runningCount: 1 } },
    Date,
    stopPlatformPolling() {},
    setInterval: (callback) => { tick = callback; return 1; },
    refresh: async (preserve) => preserved.push(preserve),
    loadCollectionPlatform: async () => preserved.push(false),
  });
  start();
  await tick();
  assert.deepEqual(preserved, [true]);
});
