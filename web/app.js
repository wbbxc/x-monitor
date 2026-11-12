/* X-Monitor 前端逻辑 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- Toast ----------
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 320);
  }, 3200);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 只允许 http/https，避免采集内容里的 javascript: 链接进入 href。 */
function safeHref(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

// ---------- 极简 Markdown 渲染 ----------
function renderMarkdown(md) {
  // 采集内容来自不可信站点：先转义 HTML，再做 Markdown 替换。
  const lines = esc(md).split('\n');
  let html = '';
  let inList = false;
  let inCode = false;
  let codeBuf = [];
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) { html += `<pre><code>${codeBuf.join('\n')}</code></pre>`; codeBuf = []; inCode = false; }
      else inCode = true;
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += '</ul>';
  if (inCode) html += `<pre><code>${codeBuf.join('\n')}</code></pre>`;
  return html;
}

// ---------- 导航 ----------
let currentView = 'dashboard';
let detailContentOrigin = false;
const VIEW_META = {
  dashboard: { section: '工作台', label: '总览' },
  guide: { section: '帮助', label: '使用指南', workspace: 'dashboard' },
  content: { section: '内容库', label: '原始内容' },
  materials: { section: '内容库', label: '素材库', workspace: 'content' },
  tweets: { section: '内容库', label: 'X 监控推文', workspace: 'content' },
  creations: { section: '创作', label: '创作记录' },
  accounts: { section: '采集中心', label: 'X 监控账号', workspace: 'collections' },
  collections: { section: '采集中心', label: '平台总览' },
  linuxdo: { section: '采集中心', label: 'linux.do', workspace: 'collections' },
  'collector-settings': { section: '采集中心', label: '全部来源', workspace: 'collections' },
  logs: { section: '设置', label: '运行日志', workspace: 'settings' },
  settings: { section: '设置', label: '服务与流水线' },
  'collection-platform': { section: '采集中心', label: '采集详情', workspace: 'collections' },
  'collection-detail': { section: '采集中心', label: '内容详情', workspace: 'collections' },
};

function viewWorkspace(name, origin = '') {
  if (name === 'collection-detail' && origin === 'content') return 'content';
  return VIEW_META[name]?.workspace || name;
}

function renderWorkspaceNav(name) {
  const workspace = viewWorkspace(name, detailContentOrigin ? 'content' : '');
  const links = {
    collections: [['collections', '平台总览'], ['collector-settings', '全部来源'], ['accounts', 'X 监控账号']],
    content: [['content', '原始内容'], ['tweets', 'X 监控推文'], ['materials', '素材库']],
    settings: [['settings', '服务与流水线'], ['logs', '运行日志']],
  }[workspace] || [];
  const nav = $('#workspaceNav');
  nav.hidden = !links.length;
  nav.innerHTML = links.map(([view, label]) => {
    const active = name === view || (view === 'collections' && name.startsWith('collection-')) || (view === 'content' && name === 'collection-detail' && detailContentOrigin);
    return `<button class="tab ${active ? 'active' : ''}" type="button" data-workspace-view="${view}" aria-current="${active ? 'page' : 'false'}">${label}</button>`;
  }).join('');
}

function setTopbar(section, label) {
  const sectionEl = $('#topbarSection');
  const viewEl = $('#topbarView');
  if (sectionEl) sectionEl.textContent = section;
  if (viewEl) viewEl.textContent = label;
  document.title = `${label} · X-Monitor`;
}

function switchView(name) {
  if (!['content', 'collection-detail'].includes(name)) detailContentOrigin = false;
  currentView = name;
  if (name !== 'collection-platform') stopPlatformPolling();
  const navView = viewWorkspace(name, detailContentOrigin ? 'content' : '');
  $$('.nav-item').forEach((b) => {
    const active = b.dataset.view === navView;
    b.classList.toggle('active', active);
    b.setAttribute('aria-current', active ? 'page' : 'false');
  });
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  const workspace = $('#collectorSettingsWorkspace');
  const destination = name === 'collection-platform' ? $('#platformSourcesSlot') : $('#collectorSettingsHome');
  if (workspace.parentElement !== destination) {
    destination.appendChild(workspace);
    delete workspace.dataset.context;
  }
  renderWorkspaceNav(name);
  if (!['collection-platform', 'collection-detail'].includes(name)) {
    const route = name === 'collector-settings' ? 'settings/collectors' : name === 'collections' ? 'collections' : name;
    history.replaceState(null, '', `${location.pathname}${location.search}#/${route}`);
  }
  const meta = VIEW_META[name];
  if (meta) setTopbar(meta.section, meta.label);
  refresh();
}

function navigateView(name) {
  if (name === 'linuxdo') {
    location.hash = '/collections/linux.do';
    return;
  }
  if (!VIEW_META[name]) return;
  const route = name === 'collector-settings' ? 'settings/collectors' : name;
  if (location.hash === `#/${route}`) switchView(name);
  else location.hash = `/${route}`;
}

$('#workspaceNav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-workspace-view]');
  if (button) navigateView(button.dataset.workspaceView);
});
$$('.nav-item').forEach((b) => b.addEventListener('click', () => {
  navigateView(b.dataset.view);
}));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => navigateView(b.dataset.goto)));
$$('[data-quick-start]').forEach((b) => b.addEventListener('click', openQuickStart));
$('#btnQuickStart')?.addEventListener('click', openQuickStart);
$('#quickStartClose')?.addEventListener('click', closeQuickStart);
$('#quickStartModal')?.addEventListener('click', (event) => { if (event.target.id === 'quickStartModal') closeQuickStart(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#quickStartModal')?.hidden) closeQuickStart();
});

// ---------- 刷新调度 ----------
async function refresh(preserveDrafts = false) {
  if (preserveDrafts && document.querySelector('.view.active input:focus, .view.active textarea:focus, .view.active select:focus, .view.active .source-editor[open], .view.active #platformRuleEditor[open], .view.active #collectorAddSection[open]')) return;
  const loadingTimer = setTimeout(() => document.body.classList.add('is-loading'), 160);
  try {
    if (currentView === 'dashboard') await loadDashboard();
    else if (currentView === 'content') await loadContent();
    else if (currentView === 'materials') await loadMaterials();
    else if (currentView === 'tweets') await loadTweets();
    else if (currentView === 'creations') await loadCreations();
    else if (currentView === 'accounts') await loadAccounts();
    else if (currentView === 'collections') await loadCollections();
    else if (currentView === 'collection-platform') await loadCollectionPlatform(collectionRoute.platform);
    else if (currentView === 'collection-detail') await loadCollectionDetail(collectionRoute.itemId);
    else if (currentView === 'collector-settings') await loadCollectorSettings();
    else if (currentView === 'logs') await loadLogs();
    else if (currentView === 'settings') await loadSettings();
  } catch (e) {
    console.error(e);
  } finally {
    clearTimeout(loadingTimer);
    document.body.classList.remove('is-loading');
  }
}

let collectionRoute = { platform: '', itemId: null };
function applyHashRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!parts[0]) { switchView('dashboard'); return; }
  if (parts[0] === 'linuxdo') { location.hash = '/collections/linux.do'; return; }
  if (parts[0] === 'settings' && parts[1] === 'collectors') {
    collectionRoute = { platform: '', itemId: null };
    switchView('collector-settings');
    return;
  }
  if (parts[0] !== 'collections') {
    switchView(VIEW_META[parts[0]] ? parts[0] : 'dashboard');
    return;
  }
  if (!parts[1]) { collectionRoute = { platform: '', itemId: null }; switchView('collections'); return; }
  if (parts[2] === 'items' && parts[3]) {
    collectionRoute = { platform: parts[1], itemId: Number(parts[3]) };
    switchView('collection-detail');
    return;
  }
  collectionRoute = { platform: parts[1], itemId: null };
  switchView('collection-platform');
}

window.addEventListener('hashchange', applyHashRoute);

// ---------- 首次使用引导 ----------
const START_COLLAPSED_KEY = 'xmonitor-start-collapsed';

function startStepAction(action) {
  if (action === 'llm') return switchView('settings');
  if (action === 'source') return openQuickStart();
  if (action === 'rule') return navigateView('collections');
  if (action === 'run') return navigateView('collections');
  if (action === 'notif') return openNotificationDrawer(true);
}

function renderOnboarding(s) {
  const sourceCount = Number(s.collectionSources) || 0;
  const ruleCount = Number(s.collectionRules) || 0;
  const hasRun = !!s.collectionHasRun;
  const unread = Number(s.collectionUnread) || 0;
  const steps = [
    { key: 'llm', n: 1, title: '配置 LLM', desc: s.llmConfigured ? '已配置，可分析与创作' : '只采集可不配，分析/创作需要', done: !!s.llmConfigured },
    { key: 'source', n: 2, title: '添加来源', desc: sourceCount ? `已有 ${sourceCount} 个来源` : '从哪里采，例如 GitHub 仓库', done: sourceCount > 0 },
    { key: 'rule', n: 3, title: '创建规则', desc: ruleCount ? `已有 ${ruleCount} 条规则` : '采什么，例如分支提交', done: ruleCount > 0 },
    { key: 'run', n: 4, title: '运行采集', desc: hasRun ? '已有运行记录' : '手动或定时运行一次', done: hasRun },
    { key: 'notif', n: 5, title: '查看通知', desc: unread ? `有 ${unread} 条未读` : '命中新内容后会提醒', done: unread > 0 },
  ];
  const current = steps.findIndex((step) => !step.done);
  const allDone = current === -1;
  const collapsed = allDone && localStorage.getItem(START_COLLAPSED_KEY) === '1';
  const card = $('#onboarding');
  if (!card) return;
  card.hidden = false;
  if (collapsed) {
    card.classList.add('is-collapsed');
    card.innerHTML = `<div class="start-card-head"><div><h2>开始使用已完成</h2><p>需要回顾时再展开。</p></div><button class="start-collapse" type="button" data-start-expand>展开</button></div>`;
    card.querySelector('[data-start-expand]').onclick = () => {
      localStorage.removeItem(START_COLLAPSED_KEY);
      renderOnboarding(s);
    };
    return;
  }
  card.classList.remove('is-collapsed');
  const stepHtml = steps.map((step, index) => {
    const state = step.done ? 'is-done' : index === current ? 'is-current' : '';
    return `<div class="start-step ${state}">
      <div class="start-step-num">${step.done ? '✓' : step.n}</div>
      <div class="start-step-body">
        <div class="start-step-title">${step.title}</div>
        <div class="start-step-desc">${esc(step.desc)}</div>
        ${index === current ? `<button class="btn sm primary" type="button" data-start-action="${step.key}">${step.key === 'source' ? '快速开始' : step.key === 'rule' ? '去采集' : step.key === 'run' ? '立即运行' : step.key === 'notif' ? '打开通知' : '去设置'}</button>` : ''}
      </div>
    </div>`;
  }).join('');
  card.innerHTML = `
    <div class="start-card-head">
      <div><h2>${allDone ? '开始使用已完成' : '开始使用'}</h2><p>${allDone ? '五个步骤都完成了，可以收起这张卡片。' : '按顺序完成五步；不确定时点“快速开始”。'}</p></div>
      <div class="start-card-actions">
        <button class="btn sm primary" type="button" data-quick-start>快速开始</button>
        ${allDone ? '<button class="start-collapse" type="button" data-start-collapse>收起</button>' : ''}
      </div>
    </div>
    <div class="start-steps">${stepHtml}</div>`;
  $$('#onboarding [data-start-action]').forEach((button) => {
    button.onclick = () => startStepAction(button.dataset.startAction);
  });
  $$('#onboarding [data-quick-start]').forEach((button) => {
    button.onclick = () => openQuickStart();
  });
  card.querySelector('[data-start-collapse]')?.addEventListener('click', () => {
    localStorage.setItem(START_COLLAPSED_KEY, '1');
    renderOnboarding(s);
  });
}

// ---------- 快速开始 ----------
const QUICK_START_GOALS = {
  'github-branches': {
    id: 'github-branches', label: 'GitHub 分支代码', desc: '仓库发布、PR、分支提交和代码改动',
    platform: 'github', fieldLabel: '仓库', placeholder: 'openai/openai-node', defaultValue: 'openai/openai-node',
    valueHint: '填 owner/repo，也可以直接粘贴 GitHub 仓库链接。',
    sourceName: (value) => `GitHub · ${value}`,
    sourceUrl: (value) => `https://github.com/${value}`,
    sourceConfig: {},
    ruleKind: 'repo', ruleValue: (value) => value,
    ruleOptions: { events: ['releases', 'pulls', 'branches'], includeCodeChanges: true, includeMergeCommits: false },
    summary: '监控 Releases、PR、分支提交和代码改动',
  },
  'arxiv-papers': {
    id: 'arxiv-papers', label: 'arXiv 论文', desc: '按关键词跟踪最新论文',
    platform: 'arxiv', fieldLabel: '关键词', placeholder: 'large language model', defaultValue: 'large language model',
    valueHint: '一个关键词或短语，例如 AI agent、robotics。',
    sourceName: (value) => `arXiv · ${value}`,
    sourceUrl: () => 'https://arxiv.org',
    sourceConfig: { maxResults: 100 },
    ruleKind: 'keyword', ruleValue: (value) => value,
    ruleOptions: { maxResults: 100 },
    summary: '按关键词采集最新论文',
  },
  'google-web': {
    id: 'google-web', label: 'Google 关键词', desc: '全网网页和新闻搜索',
    platform: 'google', fieldLabel: '关键词', placeholder: 'AI agent', defaultValue: 'AI agent',
    valueHint: '需要 Google CSE 配置；没有配置时可在来源与规则里改用通用 Web。',
    sourceName: (value) => `Google · ${value}`,
    sourceUrl: () => 'https://www.google.com',
    sourceConfig: {},
    ruleKind: 'keyword', ruleValue: (value) => value,
    ruleOptions: {},
    summary: '用关键词搜索全网网页',
  },
  'reddit-community': {
    id: 'reddit-community', label: 'Reddit 社区', desc: 'subreddit 新帖和讨论',
    platform: 'reddit', fieldLabel: 'Subreddit', placeholder: 'MachineLearning', defaultValue: 'MachineLearning',
    valueHint: '填 subreddit 名称，不用带 r/。',
    sourceName: (value) => `r/${value}`,
    sourceUrl: (value) => `https://www.reddit.com/r/${value}`,
    sourceConfig: { sort: 'new' },
    ruleKind: 'subreddit', ruleValue: (value) => value,
    ruleOptions: { sort: 'new' },
    summary: '采集该社区的新帖',
  },
};

let quickStartState = {
  step: 1, goalId: 'github-branches', value: '', error: '', sourceId: null, runNow: false, busy: false,
};

function quickStartGoal() {
  return QUICK_START_GOALS[quickStartState.goalId] || QUICK_START_GOALS['github-branches'];
}

function normalizeQuickValue(goal, raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  if (goal.platform === 'github') {
    value = value.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').split(/[?#]/)[0].replace(/\/+$/, '');
    const match = value.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
    return match ? match[1] : value;
  }
  if (goal.platform === 'reddit') {
    value = value.replace(/^https?:\/\/(www\.)?reddit\.com\/r\//i, '').replace(/^r\//i, '').split(/[\/?#]/)[0];
  }
  return value;
}

function quickStartError(message) {
  quickStartState.error = message;
  quickStartRender();
}

function openQuickStart() {
  quickStartState = { step: 1, goalId: 'github-branches', value: '', error: '', sourceId: null, runNow: false, busy: false };
  $('#quickStartModal').hidden = false;
  quickStartRender();
  setTimeout(() => $('#quickStartBody input')?.focus(), 0);
}

function closeQuickStart() {
  if (quickStartState.busy) return;
  $('#quickStartModal').hidden = true;
  quickStartState.sourceId = null;
  quickStartState.error = '';
}

function quickStartChoose(goalId) {
  quickStartState.goalId = goalId;
  quickStartState.value = '';
  quickStartState.error = '';
  quickStartState.sourceId = null;
  quickStartRender();
}

function quickStartNext() {
  if (quickStartState.step === 1) {
    quickStartState.step = 2;
    quickStartState.error = '';
    quickStartRender();
    setTimeout(() => $('#quickStartBody input')?.focus(), 0);
    return;
  }
  if (quickStartState.step === 2) {
    const goal = quickStartGoal();
    const input = $('#quickStartValue');
    if (input) quickStartState.value = input.value;
    const value = normalizeQuickValue(goal, quickStartState.value);
    if (!value) return quickStartError(`请填写${goal.fieldLabel}`);
    if (goal.platform === 'github' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
      return quickStartError('GitHub 仓库格式应为 owner/repo');
    }
    quickStartState.value = value;
    quickStartState.step = 3;
    quickStartState.error = '';
    quickStartRender();
  }
}

function quickStartBack() {
  if (quickStartState.sourceId) return;
  if (quickStartState.step > 1) {
    quickStartState.step -= 1;
    quickStartState.error = '';
    quickStartRender();
  }
}

function quickStartSourcePayload(goal) {
  return {
    platform: goal.platform,
    name: goal.sourceName(quickStartState.value),
    url: goal.sourceUrl(quickStartState.value),
    config: goal.sourceConfig || {},
  };
}

function quickStartRulePayload(goal, sourceId) {
  return {
    sourceId,
    name: `${goal.label} · ${quickStartState.value}`.slice(0, 120),
    kind: goal.ruleKind,
    value: goal.ruleValue(quickStartState.value),
    intervalMin: 60,
    options: goal.ruleOptions || {},
    match: {},
    notify: true,
    notifyUpdates: true,
  };
}

async function quickStartCreate() {
  if (quickStartState.busy) return;
  const goal = quickStartGoal();
  quickStartState.busy = true;
  quickStartState.error = '';
  quickStartRender();
  try {
    let sourceId = quickStartState.sourceId;
    if (!sourceId) {
      const source = await api('/collections/sources', { method: 'POST', body: JSON.stringify(quickStartSourcePayload(goal)) });
      sourceId = source.id;
      quickStartState.sourceId = sourceId;
    }
    const rule = await api('/collections/rules', { method: 'POST', body: JSON.stringify(quickStartRulePayload(goal, sourceId)) });
    if (quickStartState.runNow) {
      await api('/collections/runs', { method: 'POST', body: JSON.stringify({ mode: 'emergency', sourceId }) });
    }
    $('#quickStartModal').hidden = true;
    toast(quickStartState.runNow ? '已创建并开始采集' : '已创建来源和规则');
    quickStartState.busy = false;
    navigateView('collections');
    await refreshNotificationBadge();
    return rule;
  } catch (error) {
    quickStartState.error = quickStartState.sourceId
      ? `来源已创建，规则未创建：${error.message}`
      : error.message;
    quickStartState.busy = false;
    quickStartRender();
    return null;
  }
}

function quickStartRender() {
  const modal = $('#quickStartModal');
  if (!modal || modal.hidden) return;
  const goal = quickStartGoal();
  const steps = ['选择目标', '填写信息', '确认创建'];
  $('#quickStartSteps').innerHTML = steps.map((label, index) => {
    const n = index + 1;
    const cls = quickStartState.step === n ? 'is-current' : quickStartState.step > n ? 'is-done' : '';
    return `<span class="qs-step ${cls}"><b>${quickStartState.step > n ? '✓' : n}</b>${label}</span>`;
  }).join('');
  const error = quickStartState.error ? `<div class="qs-error" role="alert">${esc(quickStartState.error)}</div>` : '';
  if (quickStartState.step === 1) {
    $('#quickStartSub').textContent = '先选一个目标，之后只填最少信息';
    $('#quickStartBody').innerHTML = `<div class="qs-goal-grid">${Object.values(QUICK_START_GOALS).map((item) => `
      <button class="qs-goal ${item.id === quickStartState.goalId ? 'active' : ''}" type="button" data-qs-goal="${item.id}">
        <strong>${esc(item.label)}</strong><span>${esc(item.desc)}</span>
      </button>`).join('')}</div>`;
    $$('#quickStartBody [data-qs-goal]').forEach((button) => { button.onclick = () => quickStartChoose(button.dataset.qsGoal); });
    $('#quickStartActions').innerHTML = `<button class="btn ghost" type="button" data-qs-cancel>取消</button><div class="right"><button class="btn primary" type="button" data-qs-next>下一步</button></div>`;
  } else if (quickStartState.step === 2) {
    $('#quickStartSub').textContent = goal.summary;
    $('#quickStartBody').innerHTML = `${error}<label class="qs-field"><span>${esc(goal.fieldLabel)}</span><input id="quickStartValue" value="${esc(quickStartState.value || goal.defaultValue)}" placeholder="${esc(goal.placeholder)}" /><small>${esc(goal.valueHint)}</small></label>`;
    $('#quickStartActions').innerHTML = `<button class="btn ghost" type="button" data-qs-back>上一步</button><div class="right"><button class="btn ghost" type="button" data-qs-cancel>取消</button><button class="btn primary" type="button" data-qs-next>下一步</button></div>`;
    setTimeout(() => $('#quickStartValue')?.focus(), 0);
  } else {
    $('#quickStartSub').textContent = '确认后创建来源和规则';
    const payload = quickStartSourcePayload(goal);
    $('#quickStartBody').innerHTML = `${error}
      <div class="qs-summary">
        <div><span>目标</span><strong>${esc(goal.label)}</strong></div>
        <div><span>来源</span><strong>${esc(payload.name)}</strong></div>
        <div><span>链接</span><strong>${esc(payload.url)}</strong></div>
        <div><span>规则</span><strong>${esc(ruleKindLabel(goal.ruleKind))} · ${esc(goal.ruleValue(quickStartState.value))}</strong></div>
        <div><span>采集</span><strong>${esc(goal.summary)}</strong></div>
      </div>
      <label class="toggle-inline"><input id="quickStartRunNow" type="checkbox" ${quickStartState.runNow ? 'checked' : ''} /> 创建后立即试跑一次</label>`;
    $('#quickStartRunNow').onchange = (event) => { quickStartState.runNow = event.target.checked; };
    $('#quickStartActions').innerHTML = `<button class="btn ghost" type="button" data-qs-back ${quickStartState.busy || quickStartState.sourceId ? 'disabled' : ''}>上一步</button><div class="right"><button class="btn ghost" type="button" data-qs-cancel ${quickStartState.busy ? 'disabled' : ''}>取消</button><button class="btn primary" type="button" data-qs-create ${quickStartState.busy ? 'disabled' : ''}>${quickStartState.busy ? '创建中…' : quickStartState.sourceId ? '重试创建规则' : '创建并完成'}</button></div>`;
  }
  $$('#quickStartActions [data-qs-next]').forEach((button) => { button.onclick = quickStartNext; });
  $$('#quickStartActions [data-qs-back]').forEach((button) => { button.onclick = quickStartBack; });
  $$('#quickStartActions [data-qs-cancel]').forEach((button) => { button.onclick = closeQuickStart; });
  $$('#quickStartActions [data-qs-create]').forEach((button) => { button.onclick = quickStartCreate; });
}

// ---------- 仪表盘 ----------
async function loadDashboard() {
  const [s, platforms] = await Promise.all([api('/stats'), api('/collections/platforms').catch(() => ({ items: [] }))]);
  // 兜底：老版本后端没有 llmConfigured 字段时，从设置接口获取
  if (s.llmConfigured === undefined) {
    try {
      const st = await api('/settings');
      s.llmConfigured = !!st.env.LLM_API_KEY_SET;
    } catch { s.llmConfigured = false; }
  }
  const platformItems = platforms.items || [];
  s.collectionSources = platformItems.reduce((sum, item) => sum + (Number(item.sourceCount) || 0), 0);
  s.collectionRules = platformItems.reduce((sum, item) => sum + (Number(item.ruleCount) || 0), 0);
  s.collectionHasRun = platformItems.some((item) => !!item.lastRunAt);
  s.collectionUnread = Number(platforms.unreadTotal) || 0;
  renderOnboarding(s);
  $('#onboarding').hidden = s.collectionSources > 0 || s.collectionHasRun;
  const m = s.materials || { pending: 0, approved: 0, rejected: 0, total: 0 };
  const c = s.creations || { total: 0, done: 0, failed: 0, running: 0 };
  const cards = [
    { label: '待确认素材', value: m.pending, tone: m.pending > 0 ? 'attention' : '', sub: `共 ${m.total} 条素材` },
    { label: '已确认素材', value: m.approved, tone: m.approved > 0 ? 'positive' : '', sub: m.approved > 0 ? '可在素材库一键创作' : '确认素材后解锁创作' },
    { label: '创作完成', value: c.done, tone: c.done > 0 ? 'positive' : '', sub: c.failed ? `失败 ${c.failed}` : '查看已有创作' },
    { label: '采集来源', value: s.collectionSources, tone: '', sub: `另有 ${s.accounts} 个 X 监控账号` },
  ];
  $('#statGrid').innerHTML = cards.map((x) => `
    <div class="stat-card" data-tone="${x.tone || ''}">
      <div class="stat-label">${x.label}</div>
      <div class="stat-value">${x.value}</div>
      <div class="stat-sub">${x.sub}</div>
    </div>`).join('');

  const mats = await api('/materials?status=pending&limit=4');
  $('#dashMaterials').innerHTML = mats.items.length
    ? mats.items.map((m) => `
      <div class="mini-item" onclick="switchView('materials')">
        <div class="mi-score">${m.score}</div>
        <div>
          <div class="mi-title">${esc(m.title)}</div>
          <div class="mi-sub">${esc(m.category)} · ${esc((m.tags || []).slice(0, 3).join(' / '))} · ${m.status === 'pending' ? '待确认' : m.status === 'approved' ? '已确认' : '已拒绝'}</div>
        </div>
      </div>`).join('')
    : '<div class="empty compact"><strong>待处理素材已清空</strong><span>新素材到达后会显示在这里。</span></div>';

  const logs = await api('/logs?limit=30');
  const attention = logs.items.filter((entry) => ['error', 'failed', 'warn'].includes(entry.status)).slice(0, 4);
  $('#dashLogs').innerHTML = attention.length
    ? attention.map((l) => `
      <div class="mini-item">
        <div class="mi-mark is-error">${l.status === 'warn' ? '警告' : '失败'}</div>
        <div>
          <div class="mi-title">${esc(l.detail)}</div>
          <div class="mi-sub">${esc(l.run_type)} · ${esc(l.created_at)}</div>
        </div>
      </div>`).join('')
    : '<div class="empty compact"><strong>最近运行没有异常</strong><span>全部运行记录可在设置中查看。</span></div>';

  // 流水线状态
  const dot = $('#pipelineDot');
  const txt = $('#pipelineText');
  dot.className = `dot ${s.pipelineRunning ? 'running' : ''}`;
  txt.textContent = s.pipelineRunning ? '流水线运行中…' : '流水线空闲';
  $('#scrapeModeTag').textContent = `模式: ${s.scrapeMode}`;
  $('#badgePending').textContent = m.pending;
  $('#badgePending').classList.toggle('hidden', m.pending === 0);
}

let contentState = { platform: '', sourceId: '', q: '', page: 1, pages: 1 };
let contentRequest = 0;

async function loadContent() {
  const request = ++contentRequest;
  const state = { ...contentState };
  const params = new URLSearchParams({ limit: '20', offset: String((state.page - 1) * 20) });
  if (state.platform) params.set('platform', state.platform);
  if (state.sourceId) params.set('sourceId', state.sourceId);
  if (state.q) params.set('q', state.q);
  const [items, platforms, sources] = await Promise.all([
    api(`/collections/items?${params}`), api('/collections/platforms'), api('/collections/sources'),
  ]);
  if (request !== contentRequest) return;
  const platformSelect = $('#contentPlatform');
  platformSelect.innerHTML = '<option value="">全部采集平台</option>' + (platforms.items || [])
    .filter((platform) => platform.sourceCount || platform.itemCount)
    .map((platform) => `<option value="${esc(platform.id)}">${esc(platform.label || platform.id)}</option>`).join('');
  platformSelect.value = state.platform;
  $('#contentSource').innerHTML = '<option value="">全部来源</option>' + scopedCollectionSources(sources.items || [], state.platform)
    .map((source) => `<option value="${source.id}">${esc(source.name)}</option>`).join('');
  $('#contentSource').value = state.sourceId;
  contentState.pages = Math.max(1, Math.ceil((items.total || 0) / 20));
  if (state.page > contentState.pages) {
    contentState.page = contentState.pages;
    return loadContent();
  }
  $('#contentCount').textContent = `${items.total || 0} 条`;
  $('#contentList').innerHTML = items.items?.length ? items.items.map(renderCollectionItem).join('')
    : '<div class="empty"><strong>没有匹配的内容</strong><span>试试其他平台或关键词；X 旧流水线的原文在“X 监控推文”中。</span><div class="empty-actions"><button class="btn sm ghost" type="button" onclick="clearContentFilters()">清除筛选</button><button class="btn sm primary" type="button" onclick="navigateView(\'collections\')">管理采集</button></div></div>';
  $('#contentPager').innerHTML = `<button class="btn sm" type="button" ${state.page <= 1 ? 'disabled' : ''} onclick="goContentPage(${state.page - 1})">上一页</button><span class="tip">第 ${state.page} / ${contentState.pages} 页</span><button class="btn sm" type="button" ${state.page >= contentState.pages ? 'disabled' : ''} onclick="goContentPage(${state.page + 1})">下一页</button>`;
}

function goContentPage(page) {
  contentState.page = Math.min(contentState.pages, Math.max(1, Number(page) || 1));
  loadContent().catch((error) => toast(error.message, 'err'));
}

function clearContentFilters() {
  contentState = { platform: '', sourceId: '', q: '', page: 1, pages: 1 };
  $('#contentSearch').value = '';
  loadContent().catch((error) => toast(error.message, 'err'));
}

$('#contentPlatform').addEventListener('change', (event) => {
  contentState.platform = event.target.value;
  contentState.sourceId = '';
  contentState.page = 1;
  loadContent().catch((error) => toast(error.message, 'err'));
});
$('#contentSource').addEventListener('change', (event) => {
  contentState.sourceId = event.target.value;
  contentState.page = 1;
  loadContent().catch((error) => toast(error.message, 'err'));
});
$('#contentList').addEventListener('click', (event) => {
  if (event.target.closest('.collection-item-title') && !event.metaKey && !event.ctrlKey) detailContentOrigin = true;
});
let contentSearchTimer;
$('#contentSearch').addEventListener('input', (event) => {
  contentState.q = event.target.value.trim();
  contentState.page = 1;
  clearTimeout(contentSearchTimer);
  contentSearchTimer = setTimeout(() => loadContent().catch((error) => toast(error.message, 'err')), 300);
});

// ---------- 素材库 ----------
let materialFilter = 'all';
let materialQ = '';
let materialLimit = 60;
async function loadMaterials() {
  const q = encodeURIComponent(materialQ || '');
  const data = await api(`/materials?status=${materialFilter}&q=${q}&limit=${materialLimit}`);
  const list = $('#materialList');
  $('#materialEmpty').hidden = data.items.length > 0;
  $('#btnMoreMaterials').hidden = data.items.length < materialLimit;
  list.innerHTML = data.items.map(renderMaterialCard).join('');
}

function renderMaterialCard(m) {
  const stBadge = { pending: 'st-pending', approved: 'st-approved', rejected: 'st-rejected' }[m.status] || '';
  const stLabel = { pending: '待确认', approved: '已确认', rejected: '已拒绝' }[m.status] || m.status;
  const scoreCls = m.score >= 80 ? 'hi' : m.score >= 60 ? '' : 'lo';
  const mockBadge = m.is_mock ? '<span class="badge mock">演示数据</span>' : '';
  const types = (m.suggested_types || []).map((t) => ({
    article: '文章', image: '配图', video_script: '视频',
  })[t]).filter(Boolean);

  let actions = '';
  if (m.status === 'pending') {
    actions = `
      <button class="btn sm danger" onclick="decideMaterial(${m.id},'reject')">拒绝</button>
      <button class="btn sm primary" onclick="decideMaterial(${m.id},'approve')">确认为素材</button>`;
  } else if (m.status === 'approved') {
    actions = `
      <button class="btn sm danger" onclick="decideMaterial(${m.id},'reject')">撤销</button>
      <button class="btn sm primary" onclick="openCreateModal(${m.id}, '${esc(m.title)}')">开始创作</button>`;
  } else {
    actions = `
      <button class="btn sm" onclick="decideMaterial(${m.id},'approve')">恢复</button>`;
  }

  return `
  <div class="material-card">
    <div class="mc-top">
      <div class="mc-cats">
        <span class="badge st-${m.status}">${stLabel}</span>
        <span class="badge cat">${esc(m.category)}</span>
        ${mockBadge}
        ${types.map((t) => `<span class="badge type">${t}</span>`).join('')}
      </div>
      <div class="mc-score ${scoreCls}" title="创意评分">${m.score}</div>
    </div>
    <div class="mc-title">${esc(m.title)}</div>
    <div class="mc-summary">${esc(m.summary)}</div>
    <div class="mc-tweet">
      <div class="tweet-quote-label">原文</div>
      <div>${esc(m.tweet_text || '(无原文)')}</div>
      <div class="tweet-meta">
        <span>@${esc(m.author_username || '')}</span>
        ${m.like_count ? `<span>赞 ${m.like_count}</span>` : ''}
        ${m.retweet_count ? `<span>转 ${m.retweet_count}</span>` : ''}
        ${m.view_count ? `<span>阅 ${m.view_count}</span>` : ''}
        ${m.tweet_url ? `<a href="${esc(m.tweet_url)}" target="_blank">查看原文</a>` : ''}
      </div>
    </div>
    <div class="mc-actions">
      <span class="spacer"></span>
      ${actions}
    </div>
  </div>`;
}

async function decideMaterial(id, status) {
  try {
    await api(`/materials/${id}/${status}`, { method: 'POST' });
    toast(status === 'approve' ? '已确认为素材，可开始创作' : '已拒绝该素材');
    loadMaterials();
    loadDashboard();
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- 创作弹窗 ----------
let createMaterialId = null;
function openCreateModal(id, title) {
  createMaterialId = id;
  $('#createModalSub').textContent = `素材：${title}`;
  $('#createModal').hidden = false;
}
$('#closeModal').addEventListener('click', () => { $('#createModal').hidden = true; });
$('#createModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $('#createModal').hidden = true;
});
$$('.type-opt').forEach((b) => b.addEventListener('click', async () => {
  const type = b.dataset.type;
  $('#createModal').hidden = true;
  try {
    const r = await api(`/materials/${createMaterialId}/create`, { method: 'POST', body: JSON.stringify({ type }) });
    toast(r.message);
    switchView('creations');
  } catch (e) { toast(e.message, 'err'); }
}));

// ---------- 抓取推文 ----------
let tweetQ = '';
let tweetLimit = 60;
async function loadTweets() {
  const q = encodeURIComponent(tweetQ || '');
  const data = await api(`/tweets?limit=${tweetLimit}&q=${q}`);
  const list = $('#tweetList');
  $('#tweetEmpty').hidden = data.items.length > 0;
  $('#btnMoreTweets').hidden = data.items.length < tweetLimit;
  list.innerHTML = data.items.map(renderTweetItem).join('');
}

function tweetStatusBadge(t) {
  if (t.material_status === 'approved') return '<span class="badge st-approved">素材已确认</span>';
  if (t.material_status === 'pending') return '<span class="badge st-pending">素材待确认</span>';
  if (t.material_status === 'rejected') return '<span class="badge st-rejected">素材已拒绝</span>';
  if (t.status === 'analyzed') return '<span class="badge">已分析 · 未入库</span>';
  if (t.status === 'rejected') return '<span class="badge st-rejected">分析后淘汰</span>';
  return '<span class="badge">待分析</span>';
}

function renderTweetItem(t) {
  const mediaCount = (() => {
    try {
      const m = JSON.parse(t.media || '[]');
      return m.length ? `${m.length} 个附件` : '';
    } catch { return ''; }
  })();
  const scoreHtml = t.material_score != null
    ? `<span class="tweet-score">评分 ${t.material_score}</span>` : '';
  return `
  <div class="tweet-item">
    <div class="tweet-avatar">${esc((t.author_name || t.author_username).slice(0, 1).toUpperCase())}</div>
    <div class="tweet-body">
      <div class="tweet-head">
        <span class="tweet-author">${esc(t.author_name || t.author_username)}</span>
        <span class="tweet-user">@${esc(t.author_username)}</span>
        <span class="tweet-time">${esc(t.tweet_created_at || t.fetched_at || '')}</span>
        ${t.is_mock ? '<span class="badge mock">演示数据</span>' : ''}
        <span class="spacer"></span>
        ${scoreHtml}
        ${tweetStatusBadge(t)}
      </div>
      <div class="tweet-text">${esc(t.text)}</div>
      <div class="tweet-meta">
        ${t.like_count ? `<span>赞 ${t.like_count}</span>` : ''}
        ${t.retweet_count ? `<span>转 ${t.retweet_count}</span>` : ''}
        ${t.reply_count ? `<span>评 ${t.reply_count}</span>` : ''}
        ${t.view_count ? `<span>阅 ${t.view_count}</span>` : ''}
        ${mediaCount ? `<span>附件 ${mediaCount}</span>` : ''}
        ${t.material_title ? `<span class="tweet-material">素材 ${esc(t.material_title)}</span>` : ''}
        ${t.url ? `<a href="${esc(t.url)}" target="_blank">查看原文</a>` : ''}
      </div>
    </div>
  </div>`;
}

// ---------- 创作记录 ----------
let creationFilter = null;
async function loadCreations() {
  const data = await api('/creations');
  const list = $('#creationList');
  $('#creationEmpty').hidden = data.items.length > 0;
  list.innerHTML = data.items.map(renderCreationCard).join('');
}

const TYPE_ICON = { article: 'A', image: 'I', video_script: 'V' };
const TYPE_LABEL = { article: '文章', image: '配图', video_script: '视频脚本' };

function renderCreationCard(c) {
  const st = c.status;
  const stHtml = st === 'running'
    ? '<span class="st-running"><span class="spin"></span> 生成中…</span>'
    : st === 'done' ? '<span class="st-done">完成</span>'
    : st === 'failed' ? '<span class="st-failed">失败</span>'
    : '<span class="st-queued">排队中</span>';

  let body = '';
  if (st === 'done' && c.content) {
    if (c.content.type === 'article') {
      body = `
        <div class="article-body">${renderMarkdown(c.content.body || '')}</div>
        <div class="cc-tools">
          <span style="font-size:12px;color:var(--text3)">约 ${c.content.read_minutes || '?'} 分钟阅读 · ${(c.content.tags || []).map((t) => `#${esc(t)}`).join(' ')}</span>
          <button class="btn sm copy-btn" onclick="copyCreation(${c.id})">复制全文</button>
        </div>`;
    } else if (c.content.type === 'image') {
      body = `
        <div class="img-prompt"><div class="lbl">核心视觉概念</div><div class="val">${esc(c.content.concept || '')}</div></div>
        <div class="img-prompt"><div class="lbl">中文提示词</div><div class="val">${esc(c.content.prompt_zh || '')}</div></div>
        <div class="img-prompt"><div class="lbl">English Prompt</div><div class="val">${esc(c.content.prompt_en || '')}</div></div>
        <div class="img-prompt"><div class="lbl">负面提示词 · 风格 · 比例</div>
          <div class="val">${esc(c.content.negative_prompt || '-')} ｜ ${esc(c.content.style || '-')} ｜ ${esc(c.content.aspect_ratio || '-')}</div></div>
        <div class="img-prompt"><div class="lbl">使用建议</div><div class="val">${esc(c.content.usage_suggestion || '')}</div></div>
        <div class="cc-tools">
          <button class="btn sm" onclick="copyText(${c.id},'prompt_en')">复制英文提示词</button>
          <button class="btn sm" onclick="copyText(${c.id},'prompt_zh')">复制中文提示词</button>
        </div>`;
    } else if (c.content.type === 'video_script') {
      body = `
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px;font-size:13px;color:var(--text2)">
          <span>时长 ${c.content.duration_seconds || 60}s</span>
          <span>画幅 ${esc(c.content.orientation || '竖屏 9:16')}</span>
          <span>钩子 ${esc(c.content.hook || '')}</span>
        </div>
        ${(c.content.scenes || []).map((s) => `
          <div class="scene-row">
            <div class="scene-no">${s.no}</div>
            <div class="scene-cell"><div class="c-lbl">画面 ${s.time || ''}</div><div class="c-val">${esc(s.scene || '')}</div></div>
            <div class="scene-cell"><div class="c-lbl">口播</div><div class="c-val">${esc(s.voiceover || '')}</div>
              ${s.on_screen_text ? `<div style="margin-top:6px"><div class="c-lbl">字幕</div><div class="c-val">${esc(s.on_screen_text)}</div></div>` : ''}
              ${s.bgm ? `<div style="margin-top:6px"><div class="c-lbl">BGM</div><div class="c-val">${esc(s.bgm)}</div></div>` : ''}
            </div>
          </div>`).join('')}
        <div class="img-prompt" style="margin-top:12px"><div class="lbl">结尾引导 (CTA)</div><div class="val">${esc(c.content.cta || '')}</div></div>
        <div class="cc-tools"><button class="btn sm copy-btn" onclick="copyCreation(${c.id})">复制完整脚本</button></div>`;
    }
  } else if (st === 'failed') {
    body = `<div style="color:var(--red);font-size:13px;line-height:1.7">${esc(c.error || '未知错误')}</div>
      <div class="cc-tools"><button class="btn sm" onclick="retryCreation(${c.id})">重试</button></div>`;
  }

  return `
  <div class="creation-card ${st === 'done' ? 'open' : ''}" data-cid="${c.id}">
    <div class="cc-head" onclick="toggleCreation(${c.id})">
      <div class="cc-type ${c.content_type}">${TYPE_ICON[c.content_type] || 'C'}</div>
      <div class="cc-main">
        <div class="cc-title">${esc(c.title || (TYPE_LABEL[c.content_type] || '') + ' · ' + esc(c.material_title || ''))}</div>
        <div class="cc-sub">素材「${esc(c.material_title || '')}」 · @${esc(c.author_username || '')} · ${esc(c.created_at)}</div>
      </div>
      <div class="cc-status">${stHtml}</div>
      <div style="color:var(--text3);font-size:11px">${TYPE_LABEL[c.content_type] || c.content_type}</div>
    </div>
    <div class="cc-body">${body}</div>
  </div>`;
}

function toggleCreation(id) {
  const card = document.querySelector(`.creation-card[data-cid="${id}"]`);
  card.classList.toggle('open');
}
async function retryCreation(id) {
  try {
    const r = await api(`/creations/${id}/retry`, { method: 'POST' });
    toast(r.message);
    loadCreations();
  } catch (e) { toast(e.message, 'err'); }
}
async function copyCreation(id) {
  const c = await api(`/creations/${id}`);
  const content = c.content;
  let text = '';
  if (content.type === 'article') text = `# ${content.title}\n\n${content.body}`;
  else if (content.type === 'video_script') {
    text = `【${content.title}】${content.duration_seconds}s ${content.orientation}\n\n钩子：${content.hook}\n\n` +
      content.scenes.map((s) => `[${s.no} ${s.time}]\n画面：${s.scene}\n口播：${s.voiceover}`).join('\n\n') +
      `\n\nCTA：${content.cta}`;
  } else text = JSON.stringify(content, null, 2);
  copyToClipboard(text);
}
async function copyText(id, field) {
  const c = await api(`/creations/${id}`);
  copyToClipboard(c.content[field] || '');
}
function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(
    () => toast('已复制到剪贴板'),
    () => toast('复制失败', 'err')
  );
}

// ---------- 账号 ----------
async function loadAccounts() {
  const { items } = await api('/accounts');
  $('#accountList').innerHTML = items.length
    ? items.map((a) => `
      <div class="account-row">
        <div class="acct-avatar">${esc((a.display_name || a.username).slice(0, 1).toUpperCase())}</div>
        <div>
          <div class="acct-name">${esc(a.display_name || a.username)}</div>
          <div class="acct-username">@${esc(a.username)}</div>
        </div>
        <div class="acct-meta">${a.enabled ? '监控中' : '已暂停'}</div>
        <button class="toggle ${a.enabled ? 'on' : ''}" onclick="toggleAccount(${a.id}, ${!a.enabled})" title="启用/暂停"></button>
        <button class="btn sm danger" onclick="removeAccount(${a.id})">删除</button>
      </div>`).join('')
    : '<div class="empty">暂无监控账号</div>';
}

async function toggleAccount(id, enabled) {
  await api(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
  loadAccounts();
}
async function removeAccount(id) {
  if (!confirm('确认删除该监控账号？')) return;
  await api(`/accounts/${id}`, { method: 'DELETE' });
  toast('已删除');
  loadAccounts();
}
$('#addAccountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#accountInput');
  try {
    await api('/accounts', { method: 'POST', body: JSON.stringify({ username: input.value }) });
    input.value = '';
    toast('已添加监控账号');
    loadAccounts();
  } catch (err) { toast(err.message, 'err'); }
});

// ---------- 统一采集 ----------
let collectionItemQ = '';
let collectionSourceCache = [];
function parseJsonInput(value, fallback = {}) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { throw new Error('JSON 配置格式无效'); }
}

function formatRunTime(value) {
  return value ? String(value).slice(0, 16).replace('T', ' ') : '';
}

function collectionItemTaxonomy(item) {
  const meta = item.metadata || {};
  const category = meta.category || (['linux.do', 'macos.do'].includes(item.platform) && meta.category_id != null ? collectionCategoryName(meta.category_id) : '');
  const tags = Array.isArray(meta.tags) ? meta.tags.filter(Boolean) : [];
  return { category, tags };
}

function collectionLinkLabel(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('arxiv.org')) return parsed.pathname.includes('/pdf/') ? 'PDF' : '摘要';
    if (parsed.hostname.includes('github.com')) return 'GitHub';
    if (parsed.hostname.includes('x.com') || parsed.hostname.includes('twitter.com')) return '原帖';
  } catch {}
  return '原文';
}

function renderCollectionItem(item) {
  const seenLinks = new Set();
  const links = (item.links || []).map(safeHref).filter(Boolean)
    .filter((url) => { if (seenLinks.has(url)) return false; seenLinks.add(url); return true; })
    .slice(0, 4)
    .map((url) => `<a href="${esc(url)}" target="_blank" rel="noreferrer">${collectionLinkLabel(url)}</a>`)
    .join(' ');
  const { category, tags } = collectionItemTaxonomy(item);
  const chips = [
    category ? `<span class="tag-chip category">${esc(category)}</span>` : '',
    ...tags.map((tag) => `<span class="tag-chip">${esc(tag)}</span>`),
  ].join('');
  return `
    <article class="collection-item">
      <a class="collection-item-title" href="#/collections/${encodeURIComponent(item.platform)}/items/${item.id}">${esc(item.title || '(无标题)')} <span class="link">查看详情</span></a>
      <div class="collection-item-content">${esc(item.content || item.summary || '(原始内容为空，已保留 raw_json)')}</div>
      ${chips ? `<div class="collection-item-tags">${chips}</div>` : ''}
      <div class="collection-item-meta">
        <span>${esc(platformLabel(item.platform))}</span><span>${esc(item.author || '未知作者')}</span><span>${esc(formatRunTime(item.published_at || item.last_seen_at || ''))}</span>
        ${item.metadata?.provider && item.metadata.provider !== item.platform ? `<span class="tag-chip">${esc(item.metadata.provider)}</span>` : ''}
        ${item.metadata?.mode ? `<span class="tag-chip">${esc(item.metadata.mode)}</span>` : ''}
        ${item.metadata?.event ? `<span class="tag-chip">${esc(item.metadata.event)}</span>` : ''}
        ${item.metadata?.degraded ? '<span class="tag-chip warn">降级</span>' : ''}
        ${item.metadata?.isMock ? '<span class="tag-chip warn">演示数据</span>' : ''}
        ${item.metadata?.codeChanges ? `<span class="tag-chip">变更 ${item.metadata.codeChanges.totalFiles} 文件</span>` : ''}
        ${item.metadata?.codeChangesUnavailable ? '<span class="tag-chip warn">代码改动不可用</span>' : ''}
        ${item.required_complete ? '' : '<span class="collection-incomplete">字段不完整（原始内容已保留）</span>'} ${links}
      </div>
    </article>`;
}

function platformLabel(platform) {
  return ({
    web: '通用 Web', google: 'Google', huggingface: 'Hugging Face', arxiv: 'arXiv',
    v2ex: 'V2EX', 'linux.do': 'linux.do', 'macos.do': 'macos.do', telegram: 'Telegram',
    reddit: 'Reddit', discord: 'Discord', github: 'GitHub', x: 'X / Twitter',
  }[platform] || platform || '平台');
}

let collectionState = {
  platform: '', tab: 'items', page: 1, q: '', categoryId: '', tag: '', total: 0, pages: 1,
  rules: [], sources: [], info: null,
};
let collectionCategories = [];
let collectionCategoriesLoaded = false;
const COLLECTION_PAGE_SIZE = 50;

function collectionCategoryName(id) {
  const hit = collectionCategories.find((category) => String(category.id) === String(id));
  return hit ? (hit.name || hit.slug || '') : '';
}

let collectionCategoriesPlatform = '';
async function ensureCollectionCategories(platform) {
  const visible = ['linux.do', 'macos.do'].includes(platform);
  const filters = $('#platformFilters');
  if (filters) filters.style.display = visible ? '' : 'none';
  if (!visible) {
    collectionCategories = [];
    collectionCategoriesPlatform = '';
    return;
  }
  if (!collectionCategoriesLoaded || collectionCategoriesPlatform !== platform) {
    try {
      const data = await api(`/collections/categories?platform=${encodeURIComponent(platform)}`);
      collectionCategories = Array.isArray(data.items) ? data.items : [];
    } catch {
      collectionCategories = [];
    }
    collectionCategoriesLoaded = true;
    collectionCategoriesPlatform = platform;
  }
  const select = $('#platformCategoryFilter');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">全部分类</option>' + collectionCategories
    .map((category) => `<option value="${category.id}">${esc(category.name || category.slug)}</option>`)
    .join('');
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

const CAPABILITY_LABEL = {
  keyword: '关键词', search: '搜索', rss: 'RSS', json: 'JSON', atom: 'Atom', html: 'HTML',
  'full-sync': '全量同步', pagination: '分页', token: 'Token', cookie: 'Cookie',
  'discourse-json': 'Discourse', bot: 'Bot', channel: '频道', guild: '服务器', threads: '线程',
  invite: '邀请', releases: 'Releases', issues: 'Issues', pulls: 'PRs', discussions: 'Discussions',
  preview: '预览', feed: 'Feed', oauth: 'OAuth', 'web-search': '网页搜索', news: '新闻',
  cse: 'CSE', mirror: '镜像', sitemap: 'Sitemap', full: '全量', node: '节点',
  category: '分类', tag: '标签', account: '账号', subreddit: '子版', mtproto: 'MTProto',
  'channel-detect': '频道检测', 'full-scan': '全量扫描', 'keyword-filter': '本地过滤',
};

function capabilityLabel(value) {
  return CAPABILITY_LABEL[value] || value;
}

const PLATFORM_MARK = {
  arxiv: 'AR', discord: 'DC', github: 'GH', google: 'GO', huggingface: 'HF',
  'linux.do': 'LD', 'macos.do': 'MD', reddit: 'RD', telegram: 'TG',
  v2ex: 'V2', web: 'WEB', x: 'X',
};

function platformMark(platform) {
  return PLATFORM_MARK[platform] || String(platform || '?').slice(0, 2).toUpperCase();
}

function statusLabel(status) {
  return ({
    ok: '成功', succeeded: '成功', error: '失败', failed: '失败',
    warn: '警告', running: '运行中', queued: '排队中', canceled: '已取消',
  }[status] || status || '未运行');
}

function renderCollectionBoard(items) {
  const configured = items.filter((item) => item.sourceCount > 0);
  const available = items.filter((item) => !item.sourceCount);
  const group = (key, title, list) => `
    <section class="platform-group">
      <div class="platform-group-head"><h2>${title}</h2><span>${list.length}</span></div>
      <div class="platform-rows">
        ${list.map((platform) => `
          <a class="platform-row ${key === 'available' ? 'is-available' : ''}" href="#/collections/${encodeURIComponent(platform.id)}" aria-label="打开 ${esc(platform.label || platform.id)} 采集工作台">
            <div class="platform-row-main">
              <span class="platform-mark" aria-hidden="true">${platformMark(platform.id)}</span>
              <span class="platform-row-copy">
                <strong>${esc(platform.label || platform.id)}</strong>
                <small>${(platform.capabilities || []).slice(0, 3).map((item) => esc(capabilityLabel(item))).join(', ')}</small>
              </span>
            </div>
            <div class="platform-metrics">
              <span class="platform-metric"><span>来源</span><b>${platform.enabledCount}/${platform.sourceCount}</b></span>
              <span class="platform-metric"><span>内容</span><b>${platform.itemCount}</b></span>
              <span class="platform-metric"><span>今日</span><b>${platform.runToday}</b></span>
              <span class="platform-metric"><span title="运行 / 排队">运行/排队</span><b>${platform.runningCount || 0}/${platform.queuedCount || 0}</b></span>
            </div>
            <div class="platform-row-side">
              <span class="status-pill status-${esc(platform.lastRunStatus || 'idle')}">${esc(statusLabel(platform.lastRunStatus))}</span>
              <span class="platform-next">${platform.nextRunAt ? `下次 ${esc(formatRunTime(platform.nextRunAt))}` : '未设定时'}</span>
              <span class="platform-enter">进入</span>
            </div>
          </a>`).join('') || '<div class="empty compact">暂无平台</div>'}
      </div>
    </section>`;
  return `<div class="platform-board">
    ${group('configured', '已配置来源', configured)}
    <details class="available-platforms"><summary>添加其他平台<span class="tip">${available.length} 个可接入平台</span></summary>${group('available', '可接入平台', available)}</details>
  </div>`;
}

async function loadCollections() {
  const [platforms, runs] = await Promise.all([
    api('/collections/platforms'),
    api('/collections/runs?limit=20'),
  ]);
  $('#collectionPlatformCards').innerHTML = renderCollectionBoard(platforms.items || []);
  $('#collectionRunBody').innerHTML = (runs.items || []).length
    ? runs.items.map((run) => `<tr>
        <td class="cell-time">${esc(formatRunTime(run.started_at))}</td>
        <td>${esc(platformLabel(run.platform || run.source_name || ''))}</td>
        <td><span class="status-pill status-${esc(run.status)}">${esc(statusLabel(run.status))}</span></td>
        <td class="cell-number">${run.collected_count || 0}<span class="cell-muted"> / 过滤 ${run.filtered_count || 0}</span></td>
        <td class="cell-error" title="${esc(run.error || '')}">${esc(run.error || '无')}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty compact">暂无运行记录</td></tr>';
}

function renderPlatformSummary(info, total, stats) {
  const sources = collectionState.sources || [];
  const activeRules = (collectionState.rules || []).filter((rule) => rule.enabled && rule.interval_min > 0).length;
  const metrics = [
    ['内容', total],
    ['来源', `${sources.filter((source) => source.enabled).length}/${sources.length}`],
    ['运行队列', `${info.runningCount || 0} 运行 / ${info.queuedCount || 0} 排队`],
    ['定时规则', `${activeRules} 条`],
  ];
  $('#platformSummary').innerHTML = `<div class="metric-strip">${metrics
    .map(([label, value]) => `<div class="metric"><span>${label}</span><b>${esc(String(value))}</b></div>`)
    .join('')}</div>`;
}

async function loadCollectionPlatform(platform) {
  if (collectionState.platform !== platform) {
    stopPlatformPolling();
    collectionState = { platform, tab: 'items', page: 1, q: '', categoryId: '', tag: '', total: 0, pages: 1, rules: [], sources: [], info: null };
    $('#platformItemSearch').value = '';
    $('#platformTagFilter').value = '';
    $('#platformCategoryFilter').value = '';
  }
  ensureCollectionCategories(platform);
  const state = collectionState;
  const offset = (state.page - 1) * COLLECTION_PAGE_SIZE;
  const params = new URLSearchParams({ platform, limit: String(COLLECTION_PAGE_SIZE), offset: String(offset) });
  if (state.q) params.set('q', state.q);
  if (state.categoryId) params.set('categoryId', state.categoryId);
  if (state.tag) params.set('tag', state.tag);
  const [platforms, sources, rules, items, stats, runs, jobs] = await Promise.all([
    api('/collections/platforms'),
    api(`/collections/sources?platform=${encodeURIComponent(platform)}`),
    api(`/collections/rules?platform=${encodeURIComponent(platform)}`),
    api(`/collections/items?${params.toString()}`),
    api(`/collections/runs/stats?platform=${encodeURIComponent(platform)}`),
    api(`/collections/runs?platform=${encodeURIComponent(platform)}&limit=50`),
    api(`/collections/jobs?platform=${encodeURIComponent(platform)}&limit=20`),
  ]);
  if (currentView !== 'collection-platform' || collectionRoute.platform !== platform) return;
  const info = (platforms.items || []).find((item) => item.id === platform) || {};
  renderRuleKindOptions(platform, info);
  updateGithubQuickFields(platform);
  const sourceList = sources.items || [];
  const ruleList = rules.items || [];
  renderRuleSourceOptions(sourceList);
  collectionState.info = info;
  collectionState.sources = sourceList;
  collectionState.rules = ruleList;
  if (pendingSourceId) {
    collectionState.sourceId = sourceList.some((source) => String(source.id) === pendingSourceId) ? pendingSourceId : '';
    collectionState.tab = 'rules';
    pendingSourceId = '';
  }
  if (collectionState.sourceId && !sourceList.some((source) => String(source.id) === collectionState.sourceId)) collectionState.sourceId = '';
  $('#platformManageSource').innerHTML = '<option value="">当前平台的全部来源</option>' + sourceList.map((source) => `<option value="${source.id}">${esc(source.name)}</option>`).join('');
  $('#platformManageSource').value = collectionState.sourceId || '';
  renderRuleSourceOptions(sourceList);
  collectionState.total = items.total || 0;
  collectionState.pages = Math.max(1, Math.ceil(collectionState.total / COLLECTION_PAGE_SIZE));
  if (collectionState.page > collectionState.pages) {
    collectionState.page = collectionState.pages;
    return loadCollectionPlatform(platform);
  }
  setTopbar('采集中心', info.label || platformLabel(platform));
  $('#collectionPlatformTitle').textContent = info.label || platformLabel(platform);
  $('#collectionPlatformSub').textContent = `${sourceList.length} 个来源 · ${sourceList.filter((source) => source.enabled).length} 个启用 · 规则与内容按来源隔离`;
  $('#platformSourceStatus').textContent = `${collectionState.total} 条`;
  renderPlatformSummary(info, collectionState.total, stats);
  renderPlatformRules(ruleList, sourceList);
  renderPlatformRuns(stats, runs.items || []);
  renderPlatformQueue(jobs.items || [], info);
  const itemRows = items.items || [];
  const emptyActions = sourceList.length
    ? `<button class="btn sm primary" type="button" onclick="document.querySelector('#btnPlatformRun').click()">立即采集</button><button class="btn sm ghost" type="button" onclick="focusRuleForm()">查看规则</button>`
    : `<button class="btn sm primary" type="button" onclick="openPlatformSourceForm()">添加当前平台来源</button><button class="btn sm ghost" type="button" onclick="openQuickStart()">快速开始</button>`;
  $('#platformItemList').innerHTML = itemRows.length
    ? itemRows.map(renderCollectionItem).join('')
    : `<div class="empty"><strong>${sourceList.length ? '还没有采集内容' : '先添加来源'}</strong><span>${sourceList.length ? '来源和规则已就绪，运行一次采集后内容会出现在这里。' : '来源决定从哪里采。添加一个 GitHub 仓库或关键词后，再创建规则。'}</span><div class="empty-actions">${emptyActions}</div></div>`;
  renderPlatformPager(collectionState.total);
  switchPlatformTab(collectionState.tab);
  $$('.nav-item').forEach((button) => {
    const active = button.dataset.view === 'collections';
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
}

function switchPlatformTab(tab) {
  collectionState.tab = tab;
  $$('#platformTabs .tab').forEach((button) => {
    const active = button.dataset.platformTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $$('#view-collection-platform [data-platform-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.platformPanel !== tab;
  });
  if (tab === 'rules') {
    const context = `${collectionState.platform}:${collectionState.sourceId || ''}`;
    if ($('#collectorSettingsWorkspace').dataset.context !== context) {
      loadCollectorSettings().catch((error) => toast(error.message, 'err'));
    }
  }
}

function renderRuleSourceOptions(sources) {
  sources = scopedCollectionSources(sources, collectionState.platform, collectionState.sourceId);
  const select = $('#platformRuleSource');
  if (!select) return;
  const current = select.value;
  select.innerHTML = sources.map((source) => `<option value="${source.id}">${esc(source.name)}</option>`).join('')
    || '<option value="">请先添加来源</option>';
  if (sources.some((source) => String(source.id) === current)) select.value = current;
}

function renderRuleKindOptions(platform, info = {}) {
  const kinds = Array.isArray(info.ruleKinds) && info.ruleKinds.length
    ? info.ruleKinds
    : [{ kind: 'keyword', label: '关键词', requiresValue: true, valuePlaceholder: '关键词' }, { kind: 'full', label: '全量/最新', requiresValue: false }];
  const select = $('#platformRuleKind');
  const current = select.value;
  select.innerHTML = kinds.map((item) => `<option value="${esc(item.kind)}">${esc(item.label || item.kind)}</option>`).join('');
  if (kinds.some((item) => item.kind === current)) select.value = current;
  select.dataset.kinds = JSON.stringify(kinds);
  updateRuleKindHints();
}

function updateRuleKindHints() {
  const select = $('#platformRuleKind');
  let kinds = [];
  try { kinds = JSON.parse(select.dataset.kinds || '[]'); } catch {}
  const kind = kinds.find((item) => item.kind === select.value) || {};
  const valueInput = $('#platformRuleValue');
  valueInput.placeholder = kind.valuePlaceholder || (kind.requiresValue === false ? '可留空' : '规则值');
  valueInput.disabled = kind.requiresValue === false && !kind.valuePlaceholder;
  const options = $('#platformRuleForm textarea[name="options"]');
  if (options && kind.optionsExample) options.placeholder = JSON.stringify(kind.optionsExample);
}

const GITHUB_EVENT_LABELS = { releases: 'Releases', issues: 'Issues', pulls: 'PRs', discussions: 'Discussions', branches: '分支提交' };

function updateGithubQuickFields(platform) {
  const fields = $('#platformGitHubFields');
  if (!fields) return;
  fields.hidden = platform !== 'github';
  if (platform === 'github') {
    const code = fields.querySelector('[name="ghCodeChanges"]');
    if (code) code.checked = true;
  }
}

function ruleKindLabel(kind) {
  return ({ repo: '仓库', keyword: '关键词', full: '全量', subreddit: 'Subreddit', account: '账号', category: '分类', author: '作者', site: '站点', search: '搜索' }[kind] || kind || '规则');
}

function splitBranches(value) {
  return [...new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean))];
}

function githubRuleSummary(options = {}) {
  const events = Array.isArray(options.events) && options.events.length ? options.events : ['releases', 'issues', 'pulls'];
  const parts = events.map((event) => GITHUB_EVENT_LABELS[event] || event);
  if (events.includes('branches')) {
    const branches = Array.isArray(options.branches) ? options.branches.filter(Boolean) : splitBranches(options.branches);
    parts.push(branches.length ? `分支 ${branches.join(', ')}` : '默认分支');
    parts.push(options.includeCodeChanges === false ? '代码改动关' : '代码改动开');
  }
  return parts.join(' / ');
}

function focusRuleForm() {
  switchPlatformTab('rules');
  $('#platformRuleEditor').open = true;
  fillRuleSourceValue();
  setTimeout(() => {
    const form = $('#platformRuleForm');
    form?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    form?.querySelector('[name="name"]')?.focus();
  }, 60);
}

function applyGithubRuleTemplate() {
  if (collectionState.platform !== 'github') return focusRuleForm();
  const form = $('#platformRuleForm');
  form.querySelector('[name="name"]').value = 'GitHub 发布与分支代码';
  form.querySelector('[name="kind"]').value = 'repo';
  form.querySelector('[name="value"]').value = '';
  form.querySelector('[name="ghBranches"]').value = '';
  for (const input of form.querySelectorAll('[name="ghEvents"]')) {
    input.checked = ['releases', 'pulls', 'branches'].includes(input.value);
  }
  form.querySelector('[name="ghCodeChanges"]').checked = true;
  form.querySelector('[name="ghMergeCommits"]').checked = false;
  focusRuleForm();
  toast('已填入 GitHub 推荐规则，可调整来源、分支与通知');
}

function applyAdvancedMode(enabled) {
  const details = $('#platformAdvanced');
  if (details) details.hidden = !enabled;
  const toggle = $('#advancedToggle');
  if (toggle) toggle.checked = enabled;
  document.body.classList.toggle('advanced-on', enabled);
  try { localStorage.setItem('xmonitor-advanced', enabled ? '1' : '0'); } catch {}
}

function initAdvancedMode() {
  let enabled = false;
  try { enabled = localStorage.getItem('xmonitor-advanced') === '1'; } catch {}
  applyAdvancedMode(enabled);
}

function renderPlatformRules(rules, sources) {
  sources = scopedCollectionSources(sources, collectionState.platform, collectionState.sourceId);
  if (collectionState.sourceId) rules = rules.filter((rule) => String(rule.source_id) === collectionState.sourceId);
  const discourse = ['linux.do', 'macos.do'].includes(collectionState.platform);
  const autoRow = document.querySelector('.platform-auto-row');
  if (autoRow) autoRow.style.display = discourse ? '' : 'none';
  const auto = discourse ? (rules.find((rule) => rule.kind === 'full' && rule.name === '最新话题') || null) : null;
  $('#platformAutoLatest').checked = !!auto?.enabled;
  $('#platformAutoLatest').disabled = !sources.length;
  $('#platformAutoInterval').value = auto?.interval_min || 60;
  $('#platformAutoInterval').disabled = !sources.length;
  $('#platformRulesHint').textContent = sources.length ? `自动任务按来源串行执行；间隔 0 表示仅手动` : '请先在来源与规则里添加来源';
  const rows = rules.filter((rule) => !(discourse && rule.kind === 'full' && rule.name === '最新话题'));
  const empty = sources.length
    ? `<div class="empty compact"><strong>还没有规则</strong><span>规则决定采什么。GitHub 仓库可一键填入发布、PR、分支和代码改动。</span><div class="empty-actions"><button class="btn sm primary" type="button" onclick="focusRuleForm()">新建规则</button>${collectionState.platform === 'github' ? '<button class="btn sm ghost" type="button" onclick="applyGithubRuleTemplate()">使用 GitHub 推荐</button>' : ''}</div></div>`
    : `<div class="empty compact"><strong>先添加来源</strong><span>来源决定从哪里采，在当前工作区添加后即可创建规则。</span><div class="empty-actions"><button class="btn sm primary" type="button" onclick="openPlatformSourceForm()">添加来源</button></div></div>`;
  $('#platformRuleList').innerHTML = rows.length
    ? rows.map((rule) => `
      <div class="setting-rule">
        <span class="badge">${esc(ruleKindLabel(rule.kind))}</span>
        <span class="setting-rule-value">${esc(rule.name || rule.value || '未命名')}</span>
        <span class="tip">${collectionState.platform === 'github' ? esc(githubRuleSummary(rule.options || {})) : esc(rule.value || '全量')}</span>
        <span class="tip">${rule.notify === false ? '通知关' : '通知开'}</span>
        ${rule.match && Object.keys(rule.match).length ? `<span class="tip">匹配 ${esc(JSON.stringify(rule.match))}</span>` : ''}
        <label class="toggle-inline">间隔 <input class="rule-interval" type="number" min="0" max="10080" value="${rule.interval_min}" onchange="setCollectionRuleInterval(${rule.id}, this.value)" /> 分钟</label>
        <span class="tip">${rule.interval_min > 0 ? (rule.next_run_at ? `下次 ${formatRunTime(rule.next_run_at)}` : '等待调度') : '仅手动'}</span>
        <button class="btn sm" type="button" onclick="runCollectionRule(${rule.id})">采集</button>
        <button class="btn sm ghost" type="button" onclick="toggleCollectionRule(${rule.id}, ${rule.enabled ? 'false' : 'true'})">${rule.enabled ? '暂停' : '启用'}</button>
        <button class="link danger" type="button" onclick="deleteCollectionRule(${rule.id})">删除</button>
      </div>`).join('')
    : empty;
}

function renderPlatformRuns(stats, runs) {
  const cards = [
    ['总运行', stats.total || 0], ['成功', stats.ok || 0], ['警告', stats.warn || 0],
    ['失败', stats.error || 0], ['取消', stats.canceled || 0], ['运行中', stats.running || 0], ['今日', stats.today || 0],
  ];
  $('#platformRunStats').innerHTML = cards
    .map(([label, value]) => `<div class="linuxdo-stat"><span>${label}</span><b>${value}</b></div>`)
    .join('');
  $('#platformRunBody').innerHTML = runs.length
    ? runs.map((run) => `<tr>
        <td class="cell-time">${esc(formatRunTime(run.started_at))}</td>
        <td>${esc(run.mode)}</td>
        <td><span class="status-pill status-${esc(run.status)}">${esc(statusLabel(run.status))}</span></td>
        <td class="cell-number">${run.attempt || 1}</td>
        <td class="cell-number">${run.collected_count || 0}<span class="cell-muted"> / 新增 ${run.new_count || 0} / 更新 ${run.updated_count || 0} / 过滤 ${run.filtered_count || 0}</span></td>
        <td class="cell-number">${run.duration_ms == null ? '-' : `${(Number(run.duration_ms) / 1000).toFixed(1)}s`}</td>
        <td class="cell-error" title="${esc(run.error || '')}">${esc(run.error || '无')}</td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="empty compact">暂无运行记录</td></tr>';
}

function renderPlatformQueue(jobs, info) {
  const counts = { queued: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 };
  for (const job of jobs) if (counts[job.status] != null) counts[job.status]++;
  const cards = [
    ['排队', info?.queuedCount ?? counts.queued], ['运行', info?.runningCount ?? counts.running],
    ['成功', counts.succeeded], ['失败', counts.failed],
  ];
  $('#platformQueueStats').innerHTML = cards
    .map(([label, value]) => `<div class="linuxdo-stat"><span>${label}</span><b>${value}</b></div>`)
    .join('');
  $('#platformQueueHint').textContent = jobs.length ? '最近 20 个任务；失败/取消可重试' : '暂无任务';
  $('#platformQueueList').innerHTML = jobs.length
    ? jobs.map((job) => {
      const action = job.status === 'failed' || job.status === 'canceled'
        ? `<button class="btn sm" type="button" onclick="retryCollectionJob(${job.id})">重试</button>`
        : (job.status === 'queued' || job.status === 'running'
          ? `<button class="btn sm ghost" type="button" onclick="cancelCollectionJob(${job.id})">取消</button>`
          : '');
      const name = job.payload?.source?.name || job.source_name || job.platform || '任务';
      return `<div class="setting-rule">
        <span class="badge">#${job.id}</span>
        <span class="setting-rule-value">${esc(name)}</span>
        <span class="tip">${esc(job.mode)} · ${job.attempts}/${job.max_attempts}</span>
        <span class="status-pill status-${esc(job.status)}">${esc(statusLabel(job.status))}</span>
        <span class="tip">${esc(job.last_error || '')}</span>
        ${action}
      </div>`;
    }).join('')
    : '<div class="empty">暂无任务</div>';
}

let platformPollTimer = null;
let platformPollUntil = 0;

function stopPlatformPolling() {
  if (platformPollTimer) clearInterval(platformPollTimer);
  platformPollTimer = null;
  platformPollUntil = 0;
}

function startPlatformPolling() {
  stopPlatformPolling();
  platformPollUntil = Date.now() + 60_000;
  platformPollTimer = setInterval(async () => {
    if (currentView !== 'collection-platform' || Date.now() > platformPollUntil) {
      stopPlatformPolling();
      return;
    }
    await refresh(true);
    const info = collectionState.info || {};
    if (!(Number(info.runningCount) > 0) && !(Number(info.queuedCount) > 0)) stopPlatformPolling();
  }, 2_000);
}

async function retryCollectionJob(id) {
  try {
    await api(`/collections/jobs/${id}/retry`, { method: 'POST', body: JSON.stringify({}) });
    toast('任务已重新入队');
    startPlatformPolling();
    await loadCollectionPlatform(collectionState.platform);
  } catch (error) { toast(error.message, 'err'); }
}

async function cancelCollectionJob(id) {
  try {
    await api(`/collections/jobs/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) });
    toast('已请求取消任务');
    await loadCollectionPlatform(collectionState.platform);
  } catch (error) { toast(error.message, 'err'); }
}

function renderPlatformPager(total) {
  const pages = Math.max(1, Math.ceil(total / COLLECTION_PAGE_SIZE));
  collectionState.pages = pages;
  $('#platformPager').innerHTML = `
    <button class="btn sm" type="button" ${collectionState.page <= 1 ? 'disabled' : ''} onclick="goCollectionPage(${collectionState.page - 1})">← 上一页</button>
    <span class="tip">第 ${collectionState.page} / ${pages} 页 · 共 ${total} 条 · 每页 ${COLLECTION_PAGE_SIZE} 条</span>
    <button class="btn sm" type="button" ${collectionState.page >= pages ? 'disabled' : ''} onclick="goCollectionPage(${collectionState.page + 1})">下一页 →</button>`;
}

function goCollectionPage(page) {
  collectionState.page = Math.min(collectionState.pages, Math.max(1, Number(page) || 1));
  loadCollectionPlatform(collectionState.platform);
}

async function setCollectionRuleInterval(id, value) {
  try {
    await api(`/collections/rules/${id}`, { method: 'PATCH', body: JSON.stringify({ intervalMin: Number(value) || 0 }) });
    toast('规则间隔已保存');
    await loadCollectionPlatform(collectionState.platform);
  } catch (error) { toast(error.message, 'err'); }
}

async function runCollectionRule(id) {
  try {
    const result = await api('/collections/runs', { method: 'POST', body: JSON.stringify({ mode: 'emergency', ruleId: id }) });
    toast(result.message || '已开始采集');
    startPlatformPolling();
    await loadCollectionPlatform(collectionState.platform);
  } catch (error) { toast(error.message, 'err'); }
}

async function toggleCollectionRule(id, enabled) {
  try {
    await api(`/collections/rules/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
    await loadCollectionPlatform(collectionState.platform);
  } catch (error) { toast(error.message, 'err'); }
}

async function deleteCollectionRule(id) {
  if (!confirm('确认删除该采集规则？')) return;
  try {
    await api(`/collections/rules/${id}`, { method: 'DELETE' });
    toast('规则已删除');
    await loadCollectionPlatform(collectionState.platform);
  } catch (error) { toast(error.message, 'err'); }
}

async function setAutoLatest(enabled) {
  const source = (collectionState.sources || [])[0];
  if (!source) {
    $('#platformAutoLatest').checked = false;
    return toast('请先在来源与规则里添加来源', 'err');
  }
  const interval = Number($('#platformAutoInterval').value) || 60;
  const auto = (collectionState.rules || []).find((rule) => rule.kind === 'full' && rule.name === '最新话题');
  try {
    if (auto) {
      await api(`/collections/rules/${auto.id}`, { method: 'PATCH', body: JSON.stringify({ enabled, intervalMin: interval }) });
    } else if (enabled) {
      await api('/collections/rules', { method: 'POST', body: JSON.stringify({ sourceId: source.id, name: '最新话题', kind: 'full', value: '', intervalMin: interval }) });
    }
    toast(enabled ? '已开启自动采集最新话题' : '已关闭自动采集');
    await loadCollectionPlatform(collectionState.platform);
  } catch (error) { toast(error.message, 'err'); }
}

async function setAutoLatestInterval(value) {
  const auto = (collectionState.rules || []).find((rule) => rule.kind === 'full' && rule.name === '最新话题');
  if (!auto) return;
  try {
    await api(`/collections/rules/${auto.id}`, { method: 'PATCH', body: JSON.stringify({ intervalMin: Number(value) || 60 }) });
    await loadCollectionPlatform(collectionState.platform);
  } catch (error) { toast(error.message, 'err'); }
}

function codeStatusLabel(status) {
  return ({ added: 'A', modified: 'M', removed: 'D', renamed: 'R', copied: 'C' }[status] || '?');
}

function renderCodeChanges(item) {
  const changes = item.metadata?.codeChanges;
  if (!changes) {
    if (item.metadata?.codeChangesUnavailable) return '<div class="code-empty">该提交的代码改动暂不可用（限流、权限或详情请求失败），提交本身已保留。</div>';
    return '';
  }
  const files = Array.isArray(changes.files) ? changes.files : [];
  if (!files.length) return '<div class="code-empty">该提交没有文件变更。</div>';
  return `<details class="code-changes" open><summary>代码改动 ${changes.totalFiles} 个文件${changes.truncated ? '（已截断）' : ''}</summary>
    <div class="code-change-list">${files.map((file) => `
      <div class="code-file">
        <div class="code-file-head">
          <span class="code-status ${esc(file.status)}">${codeStatusLabel(file.status)}</span>
          <span class="code-file-name">${esc(file.filename)}${file.previousFilename ? `（原 ${esc(file.previousFilename)}）` : ''}</span>
          <span class="code-file-stat">+${file.additions || 0} -${file.deletions || 0}</span>
        </div>
        ${file.patch ? `<pre class="code-patch">${esc(file.patch)}</pre>` : `<div class="code-empty">${file.binary ? '二进制文件，无 patch' : '无 patch 内容'}</div>`}
      </div>`).join('')}</div>
    ${changes.compareUrl ? `<p class="form-hint" style="margin-top:10px"><a href="${esc(changes.compareUrl)}" target="_blank" rel="noreferrer">查看完整对比</a></p>` : ''}
  </details>`;
}

async function loadCollectionDetail(itemId) {
  let item;
  try {
    ({ item } = await api(`/collections/items/${itemId}`));
  } catch (error) {
    toast('通知对应的内容已不可用', 'err');
    if (collectionRoute.platform) location.hash = `/collections/${encodeURIComponent(collectionRoute.platform)}`;
    return;
  }
  setTopbar(detailContentOrigin ? '内容库' : '采集中心', '内容详情');
  ensureCollectionCategories(item.platform);
  const { category, tags } = collectionItemTaxonomy(item);
  $('#collectionDetailTitle').textContent = item.title || '(无标题)';
  $('#collectionDetailMeta').textContent = [
    platformLabel(item.platform),
    item.author || '未知作者',
    item.published_at || item.last_seen_at || '',
    category,
    ...tags.map((tag) => `#${tag}`),
  ].filter(Boolean).join(' · ');
  $('#collectionDetailContent').innerHTML = `<div class="detail-body">${renderMarkdown(item.content || item.summary || '暂无正文')}</div>${renderCodeChanges(item)}<div class="detail-meta"><span class="badge">${esc(item.required_complete ? '字段完整' : '字段不完整，已保留原文')}</span><span>来源：${esc(item.source_url || '')}</span></div>`;
  $('#collectionDetailLinks').innerHTML = (item.links || []).map(safeHref).filter(Boolean).map((url) => `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(url)} ↗</a>`).join('');
  $('#collectionDetailRaw').textContent = JSON.stringify(item.raw_json || [], null, 2);
  $('#collectionDetailBack').textContent = detailContentOrigin ? '返回内容库' : '返回平台';
  $('#collectionDetailBack').onclick = () => {
    if (detailContentOrigin) navigateView('content');
    else location.hash = `/collections/${encodeURIComponent(collectionRoute.platform || item.platform)}`;
  };
}

function renderCollectorSetting(source) {
  const auth = source.auth || {};
  return `<details class="source-editor" data-source-id="${source.id}">
    <summary><span class="source-summary"><strong>${esc(source.name)}</strong><span class="badge">${esc(platformLabel(source.platform))}</span></span><span class="setting-auth-state ${auth.configured ? 'is-on' : ''}">${auth.configured ? `已配置 ${esc(auth.type)}` : '未配置认证'}</span><span class="source-edit-label">编辑</span></summary>
    <form class="collector-setting" data-source-id="${source.id}">
      <label>链接<input name="url" type="url" value="${esc(source.url || '')}" placeholder="https://…"></label>
      <details class="form-advanced source-advanced"><summary>高级：平台配置与认证</summary><div class="collector-setting-grid"><label>平台配置 JSON<textarea name="config" rows="2">${esc(JSON.stringify(source.config || {}, null, 2))}</textarea></label><label>认证类型<select name="authType"><option value="none">不使用认证</option><option value="cookie">Cookie</option><option value="bearer">Bearer Token</option><option value="token">Token</option><option value="api_key">API Key</option><option value="basic">Basic</option><option value="headers">Headers</option><option value="fields">多字段凭据（JSON）</option></select></label><label>认证 JSON<textarea name="auth" rows="2" placeholder='{"cookies":{"session":"…"}}'></textarea></label></div></details>
      <div class="setting-actions"><button class="btn primary" type="submit">保存</button><button class="btn sm" type="button" data-source-rule="${source.id}">管理此来源规则</button><button class="btn sm danger" type="button" data-delete-source="${source.id}">删除</button><span class="tip">认证留空则保留现有密钥</span></div>
    </form>
  </details>`;
}

function scopedCollectionSources(sources, platform = '', sourceId = '') {
  return sources.filter((source) => (!platform || source.platform === platform) && (!sourceId || String(source.id) === String(sourceId)));
}

let pendingSourceId = '';
let collectorSettingsRequest = 0;

function manageSourceRules(sourceId, platform) {
  if (currentView !== 'collection-platform' || collectionState.platform !== platform) {
    pendingSourceId = String(sourceId);
    location.hash = `/collections/${encodeURIComponent(platform)}`;
    return;
  }
  collectionState.sourceId = String(sourceId);
  $('#platformManageSource').value = collectionState.sourceId;
  renderRuleSourceOptions(collectionState.sources);
  renderPlatformRules(collectionState.rules, collectionState.sources);
  switchPlatformTab('rules');
  $('#platformRuleList').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function openPlatformSourceForm() {
  switchPlatformTab('rules');
  await loadCollectorSettings();
  $('#collectorAddSection').open = true;
  $('#collectorAddName').focus();
}

function fillRuleSourceValue() {
  if (collectionState.platform !== 'github') return;
  const source = collectionState.sources.find((item) => String(item.id) === $('#platformRuleSource').value);
  const input = $('#platformRuleValue');
  if (!source || (input.value && input.value !== input.dataset.sourceValue)) return;
  try {
    const url = new URL(source.url);
    if (url.hostname !== 'github.com') return;
    const repo = url.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
    if (!repo.includes('/')) return;
    input.value = repo;
    input.dataset.sourceValue = repo;
  } catch {}
}

let collectorAdaptersCache = [];

function collectorAdapterById(id) {
  return collectorAdaptersCache.find((item) => item.id === id) || null;
}

function applyCollectorPlatformHint() {
  const adapter = collectorAdapterById($('#collectorAddPlatform').value);
  if (!adapter) return;
  $('#collectorAddConfig').placeholder = JSON.stringify(adapter.configExample || {}, null, 2);
  const hints = Object.entries(adapter.authHints || {})
    .map(([type, text]) => `<span class="tag-chip">${esc(type)}</span> ${esc(text)}`)
    .join(' ');
  $('#collectorAddConfigHint').innerHTML = [
    adapter.publicFallback ? `<span class="tag-chip">公开降级</span> ${esc(adapter.publicFallback)}` : '',
    hints,
  ].filter(Boolean).join(' · ') || '该平台未声明额外配置提示';
}

async function detectCollectorLink() {
  const url = $('#collectorDetectUrl').value.trim();
  if (!url) return toast('请先粘贴链接', 'err');
  const hint = $('#collectorDetectHint');
  hint.textContent = '识别中…';
  try {
    const result = await api('/collections/detect', { method: 'POST', body: JSON.stringify({ url, probe: true }) });
    if (currentView === 'collection-platform' && result.platform !== collectionState.platform) {
      hint.textContent = `这是 ${platformLabel(result.platform)} 链接，请在“全部来源”中添加，当前平台未改变。`;
      return;
    }
    const select = $('#collectorAddPlatform');
    if (![...select.options].some((option) => option.value === result.platform)) {
      select.insertAdjacentHTML('beforeend', `<option value="${esc(result.platform)}">${esc(result.label || result.platform)}</option>`);
    }
    select.value = result.platform;
    $('#collectorAddName').value = result.name || result.platform;
    $('#collectorAddUrl').value = result.url || url;
    $('#collectorAddConfig').value = JSON.stringify(result.config || {}, null, 2);
    applyCollectorPlatformHint();
    const messages = [
      `平台 ${result.platform} / 规则 ${result.kind}${result.value ? ` / 值 ${result.value}` : ''}`,
      result.probe?.message ? `探活：${result.probe.message}` : '',
      ...(result.warnings || []),
    ].filter(Boolean);
    hint.textContent = messages.join(' · ');
    toast('已识别并填充来源草稿');
  } catch (error) {
    hint.textContent = error.message;
    toast(error.message, 'err');
  }
}

function renderSourceTemplates() {
  const container = $('#sourceTemplates');
  if (!container) return;
  const marks = { github: 'GH', arxiv: 'AR', google: 'GG', reddit: 'RD' };
  const goals = Object.values(QUICK_START_GOALS).filter((goal) => currentView !== 'collection-platform' || goal.platform === collectionState.platform);
  container.closest('.template-panel').hidden = !goals.length;
  container.innerHTML = goals.map((goal) => `
    <button class="template-card" type="button" data-source-template="${goal.id}">
      <span class="template-mark">${marks[goal.platform] || goal.platform.slice(0, 2).toUpperCase()}</span>
      <strong>${esc(goal.label)}</strong>
      <span>${esc(goal.desc)}</span>
    </button>`).join('');
  $$('#sourceTemplates [data-source-template]').forEach((button) => {
    button.onclick = () => applySourceTemplate(button.dataset.sourceTemplate);
  });
}

function applySourceTemplate(id) {
  const goal = QUICK_START_GOALS[id];
  if (!goal) return;
  const select = $('#collectorAddPlatform');
  if (select && ![...select.options].some((option) => option.value === goal.platform)) {
    select.insertAdjacentHTML('beforeend', `<option value="${esc(goal.platform)}">${esc(platformLabel(goal.platform))}</option>`);
  }
  if (select) select.value = goal.platform;
  $('#collectorAddName').value = goal.sourceName(goal.defaultValue);
  $('#collectorAddUrl').value = goal.sourceUrl(goal.defaultValue);
  const config = goal.sourceConfig || {};
  $('#collectorAddConfig').value = Object.keys(config).length ? JSON.stringify(config, null, 2) : '';
  const advanced = $('#collectorAdvanced');
  if (advanced) advanced.open = Object.keys(config).length > 0;
  applyCollectorPlatformHint();
  const ruleHint = goal.platform === 'github'
    ? `保存后到 GitHub 规则里勾选“分支提交 / 代码改动”，分支留空表示默认分支。`
    : `保存后到 ${platformLabel(goal.platform)} 的规则里填写“${goal.ruleValue(goal.defaultValue)}”。`;
  $('#collectorTemplateHint').innerHTML = `<strong>${esc(goal.label)}：</strong>${esc(ruleHint)} 示例值可以修改。`;
  toast(`已填入「${goal.label}」模板`);
}

async function loadCollectorSettings() {
  const request = ++collectorSettingsRequest;
  const platform = currentView === 'collection-platform' ? collectionState.platform : '';
  const sourceId = platform ? collectionState.sourceId || '' : '';
  const [sourcesRes, adaptersRes] = await Promise.all([api('/collections/sources'), api('/collections/adapters')]);
  if (request !== collectorSettingsRequest || (currentView !== 'collector-settings' && currentView !== 'collection-platform') || platform !== (currentView === 'collection-platform' ? collectionState.platform : '')) return;
  if ($('#collectorSettingsWorkspace').dataset.platform !== platform) {
    $('#collectorAddForm').reset();
    $('#collectorAddSection').open = false;
    $('#collectorAdvanced').open = false;
    $('#collectorSettingsWorkspace').dataset.platform = platform;
  }
  const items = scopedCollectionSources(sourcesRes.items || [], platform, sourceId);
  const adapters = adaptersRes.items || [];
  collectorAdaptersCache = adapters;
  const select = $('#collectorAddPlatform');
  const current = select.value;
  select.innerHTML = adapters.map((item) => `<option value="${esc(item.id)}">${esc(item.label || item.id)}</option>`).join('');
  if (platform) select.value = platform;
  else if (adapters.some((item) => item.id === current)) select.value = current;
  select.disabled = !!platform;
  $('#collectorSettingsWorkspace').dataset.context = `${platform}:${sourceId}`;
  applyCollectorPlatformHint();
  renderSourceTemplates();
  $('#collectorSettingsCount').textContent = `${items.length} 个来源`;
  $('#collectorSettingsList').innerHTML = items.length ? items.map(renderCollectorSetting).join('') : '<div class="empty compact"><strong>还没有来源</strong><span>展开下方“手动添加来源”，或使用“新增采集”向导。</span></div>';
  $$('#collectorSettingsList .collector-setting').forEach((form) => {
    const source = items.find((item) => String(item.id) === form.dataset.sourceId);
    form.querySelector('[name="authType"]').value = source?.auth?.type || 'none';
    form.onsubmit = async (event) => {
      event.preventDefault();
      try {
        const body = { url: form.querySelector('[name="url"]').value.trim(), config: parseJsonInput(form.querySelector('[name="config"]').value, {}) };
        const authText = form.querySelector('[name="auth"]').value.trim();
        const authType = form.querySelector('[name="authType"]').value;
        if (authText) body.auth = { ...parseJsonInput(authText, {}), type: authType };
        else if (authType === 'none') body.auth = { type: 'none' };
        await api(`/collections/sources/${source.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast(`${source.name} 已保存`);
        await loadCollectorSettings();
        if (platform) await loadCollectionPlatform(platform);
      } catch (error) { toast(error.message, 'err'); }
    };
    form.querySelector('[data-delete-source]').onclick = async () => {
      if (!confirm(`确认删除采集源「${source.name}」及其规则？`)) return;
      try {
        await api(`/collections/sources/${source.id}`, { method: 'DELETE' });
        toast('已删除');
        if (platform) {
          collectionState.sourceId = '';
          await loadCollectionPlatform(platform);
        }
        await loadCollectorSettings();
      } catch (error) { toast(error.message, 'err'); }
    };
    form.querySelector('[data-source-rule]').onclick = () => manageSourceRules(source.id, source.platform);
  });
  $('#collectorAddForm').onsubmit = async (event) => {
    event.preventDefault();
    try {
      const authType = $('#collectorAddAuthType').value;
      const authText = $('#collectorAddAuth').value.trim();
      const body = {
        platform: $('#collectorAddPlatform').value,
        name: $('#collectorAddName').value.trim(),
        url: $('#collectorAddUrl').value.trim(),
        config: parseJsonInput($('#collectorAddConfig').value, {}),
      };
      if (authText) body.auth = { ...parseJsonInput(authText, {}), type: authType };
      else if (authType !== 'none') throw new Error('已选择认证类型，请填写认证 JSON');
      const source = await api('/collections/sources', { method: 'POST', body: JSON.stringify(body) });
      toast(`已新增「${source.name}」`);
      event.target.reset();
      $('#collectorAddSection').open = false;
      if (platform) collectionState.sourceId = String(source.id);
      if (platform) await loadCollectionPlatform(platform);
      await loadCollectorSettings();
    } catch (error) { toast(error.message, 'err'); }
  };
}

$('#collectorAddPlatform').addEventListener('change', applyCollectorPlatformHint);
$('#btnCollectorDetect').addEventListener('click', detectCollectorLink);
$('#advancedToggle')?.addEventListener('change', (event) => applyAdvancedMode(event.target.checked));
initAdvancedMode();

async function exportCollectionConfig() {
  try {
    const result = await api('/collections/config/export', { method: 'POST' });
    $('#configFileStatus').textContent = `已导出 ${result.sources || 0} 个来源、${result.rules || 0} 条规则到 ${result.dir || 'data/collector'}`;
    toast('配置已导出');
  } catch (error) { toast(error.message, 'err'); }
}

async function importCollectionConfig() {
  if (!confirm('从 data/collector/ 导入会更新同名的来源和规则，继续？')) return;
  try {
    const result = await api('/collections/config/import', { method: 'POST' });
    $('#configFileStatus').textContent = `已导入 ${result.sources || 0} 个来源、${result.rules || 0} 条规则`;
    toast('配置已导入');
    await loadCollectorSettings();
  } catch (error) { toast(error.message, 'err'); }
}

$('#collectionPlatformCards')?.addEventListener('click', (event) => {
  const row = event.target.closest('.platform-row');
  if (!row) return;
  const href = row.getAttribute('href');
  if (location.hash === href) {
    event.preventDefault();
    applyHashRoute();
  }
});
$('#btnPlatformSettings').addEventListener('click', () => switchPlatformTab('rules'));
$('#platformManageSource').addEventListener('change', (event) => {
  collectionState.sourceId = event.target.value;
  renderRuleSourceOptions(collectionState.sources);
  renderPlatformRules(collectionState.rules, collectionState.sources);
  loadCollectorSettings().catch((error) => toast(error.message, 'err'));
});
$('#platformRuleSource').addEventListener('change', fillRuleSourceValue);
$('#platformRuleEditor').addEventListener('toggle', () => {
  if ($('#platformRuleEditor').open) fillRuleSourceValue();
});
$('#btnPlatformRun').addEventListener('click', async () => {
  const sources = (collectionState.sources || []).filter((source) => source.enabled);
  if (!sources.length) return toast('请先在来源与规则里添加来源', 'err');
  try {
    await Promise.all(sources.map((source) => api('/collections/runs', { method: 'POST', body: JSON.stringify({ mode: 'emergency', sourceId: source.id }) })));
    toast('已入队采集任务');
    startPlatformPolling();
    await loadCollectionPlatform(collectionState.platform);
  } catch (error) { toast(error.message, 'err'); }
});
$$('#platformTabs .tab').forEach((button) => button.addEventListener('click', () => switchPlatformTab(button.dataset.platformTab)));
$('#platformItemSearch').addEventListener('input', (event) => {
  collectionState.q = event.target.value.trim();
  collectionState.page = 1;
  clearTimeout(window.__collectionSearchTimer);
  window.__collectionSearchTimer = setTimeout(() => loadCollectionPlatform(collectionState.platform), 300);
});
$('#platformTagFilter').addEventListener('input', (event) => {
  collectionState.tag = event.target.value.trim();
  collectionState.page = 1;
  clearTimeout(window.__collectionTagTimer);
  window.__collectionTagTimer = setTimeout(() => loadCollectionPlatform(collectionState.platform), 300);
});
$('#platformCategoryFilter').addEventListener('change', (event) => {
  collectionState.categoryId = event.target.value;
  collectionState.page = 1;
  loadCollectionPlatform(collectionState.platform);
});
$('#btnPlatformClearFilters').addEventListener('click', () => {
  collectionState.q = '';
  collectionState.categoryId = '';
  collectionState.tag = '';
  collectionState.page = 1;
  $('#platformItemSearch').value = '';
  $('#platformCategoryFilter').value = '';
  $('#platformTagFilter').value = '';
  loadCollectionPlatform(collectionState.platform);
});
$('#platformRuleKind').addEventListener('change', updateRuleKindHints);

$('#platformRuleForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const sourceId = Number(form.querySelector('[name="source"]').value);
  const source = (collectionState.sources || []).find((item) => Number(item.id) === sourceId);
  if (!source) return toast('请先在来源与规则里添加来源', 'err');
  try {
    const options = parseJsonInput(form.querySelector('[name="options"]').value, {});
    const match = parseJsonInput(form.querySelector('[name="match"]').value, {});
    if (source.platform === 'github' && !['events', 'branches', 'includeCodeChanges', 'includeMergeCommits'].some((key) => Object.prototype.hasOwnProperty.call(options, key))) {
      const events = [...form.querySelectorAll('[name="ghEvents"]:checked')].map((input) => input.value);
      if (!events.length) return toast('至少选择一个 GitHub 监控内容', 'err');
      options.events = events;
      options.branches = splitBranches(form.querySelector('[name="ghBranches"]').value);
      options.includeCodeChanges = form.querySelector('[name="ghCodeChanges"]').checked;
      options.includeMergeCommits = form.querySelector('[name="ghMergeCommits"]').checked;
    }
    await api('/collections/rules', { method: 'POST', body: JSON.stringify({
      sourceId: source.id,
      name: form.querySelector('[name="name"]').value.trim(),
      kind: form.querySelector('[name="kind"]').value,
      value: form.querySelector('[name="value"]').value.trim(),
      intervalMin: Number(form.querySelector('[name="interval"]').value) || 0,
      options,
      match,
      notify: form.querySelector('[name="notify"]').checked,
      notifyUpdates: form.querySelector('[name="notifyUpdates"]').checked,
    }) });
    form.reset();
    renderRuleSourceOptions(collectionState.sources || []);
    updateRuleKindHints();
    updateGithubQuickFields(collectionState.platform);
    applyAdvancedMode(document.body.classList.contains('advanced-on'));
    toast('规则已创建');
    $('#platformRuleEditor').open = false;
    await loadCollectionPlatform(collectionState.platform);
  } catch (error) { toast(error.message, 'err'); }
});
$('#platformAutoLatest').addEventListener('change', (event) => setAutoLatest(event.target.checked));
$('#platformAutoInterval').addEventListener('change', (event) => setAutoLatestInterval(event.target.value));
$('#btnCollectorSettings').addEventListener('click', () => { location.hash = '/settings/collectors'; });
$('#btnCollectionScheduled').addEventListener('click', async () => {
  try { const result = await api('/collections/runs', { method: 'POST', body: JSON.stringify({ mode: 'scheduled' }) }); toast(result.message || '已检查定时规则'); } catch (error) { toast(error.message, 'err'); }
});
$('#btnExportConfig').addEventListener('click', exportCollectionConfig);
$('#btnImportConfig').addEventListener('click', importCollectionConfig);
$('#btnCreateFromMaterials').addEventListener('click', () => {
  materialFilter = 'approved';
  $$('#materialTabs .tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.status === 'approved'));
  navigateView('materials');
});

async function loadLogs() {
  const { items } = await api('/logs?limit=200');
  $('#logBody').innerHTML = items.map((l) => `
    <tr>
      <td style="white-space:nowrap;font-family:var(--mono);font-size:12px;color:var(--text3)">${esc(l.created_at)}</td>
      <td><span class="log-type">${esc(l.run_type)}</span></td>
      <td>${esc(l.detail)}</td>
      <td class="status-${l.status}">${l.status === 'ok' ? '正常' : l.status === 'warn' ? '警告' : '错误'}</td>
    </tr>`).join('');
}

// ---------- 设置 ----------
async function loadSettings() {
  const s = await api('/settings');
  const e = s.env;
  $('#setBaseUrl').value = e.LLM_BASE_URL || '';
  $('#setApiKey').value = e.LLM_API_KEY_SET ? '******' : '';
  $('#setApiKey').dataset.masked = e.LLM_API_KEY_SET ? '1' : '0';
  $('#setModel').value = e.LLM_MODEL || '';
  $('#setThreshold').value = e.ANALYZE_THRESHOLD;
  $('#setInterval').value = e.SCRAPE_INTERVAL_MIN;
  $('#setPerAccount').value = e.SCRAPE_PER_ACCOUNT;
  $('#setMode').value = e.SCRAPE_MODE;
  $('#setAccounts').value = e.MONITOR_ACCOUNTS || '';
}

$('#btnSaveSettings').addEventListener('click', async () => {
  const apiKeyField = $('#setApiKey');
  const body = {
    LLM_BASE_URL: $('#setBaseUrl').value.trim(),
    LLM_MODEL: $('#setModel').value.trim(),
    LLM_API_KEY: apiKeyField.dataset.masked === '1' && apiKeyField.value === '******' ? undefined : apiKeyField.value.trim(),
    ANALYZE_THRESHOLD: $('#setThreshold').value,
    SCRAPE_INTERVAL_MIN: $('#setInterval').value,
    SCRAPE_PER_ACCOUNT: $('#setPerAccount').value,
    SCRAPE_MODE: $('#setMode').value,
    MONITOR_ACCOUNTS: $('#setAccounts').value,
  };
  // 移除 undefined 字段
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  try {
    const r = await api('/settings', { method: 'PUT', body: JSON.stringify(body) });
    toast(`已保存 ${r.updated.length} 项设置`);
  } catch (e) { toast(e.message, 'err'); }
});

$('#btnTestLLM').addEventListener('click', async () => {
  toast('正在测试 LLM 连接…');
  try {
    const r = await api('/llm/ping', { method: 'POST' });
    toast(r.message, r.ok ? 'ok' : 'err');
  } catch (e) { toast(e.message, 'err'); }
});

// ---------- 顶部操作 ----------
$('#btnRunNow').addEventListener('click', async () => {
  try {
    const r = await api('/run/now', { method: 'POST' });
    toast(r.message);
    setTimeout(refresh, 1500);
  } catch (e) { toast(e.message, 'err'); }
});
$('#btnScrapeOnly').addEventListener('click', async () => {
  try {
    const r = await api('/run/scrape', { method: 'POST' });
    toast(r.message);
  } catch (e) { toast(e.message, 'err'); }
});

// 素材筛选
$$('#materialTabs .tab').forEach((t) => t.addEventListener('click', () => {
  $$('#materialTabs .tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  materialFilter = t.dataset.status;
  materialLimit = 60;
  loadMaterials();
}));
let searchTimer;
$('#materialSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { materialQ = e.target.value.trim(); loadMaterials(); }, 350);
});
let tweetSearchTimer;
$('#tweetSearch').addEventListener('input', (e) => {
  clearTimeout(tweetSearchTimer);
  tweetSearchTimer = setTimeout(() => { tweetQ = e.target.value.trim(); loadTweets(); }, 350);
});
$('#btnRefreshCreations').addEventListener('click', loadCreations);
$('#btnMoreMaterials').addEventListener('click', () => { materialLimit += 60; loadMaterials(); });
$('#btnMoreTweets').addEventListener('click', () => { tweetLimit += 60; loadTweets(); });
$('#topbarRefresh').addEventListener('click', async () => {
  try { await refresh(); toast('已刷新'); } catch (error) { toast(error.message, 'err'); }
});


// ---------- 通知中心 ----------
const notificationState = { filter: 'all', platform: '', items: [], unread: 0, loaded: false };
let notificationPollTimer = null;

function renderNotificationBadge(total) {
  notificationState.unread = Number(total) || 0;
  const badge = $('#notificationBadge');
  if (!badge) return;
  badge.textContent = notificationState.unread > 99 ? '99+' : String(notificationState.unread);
  badge.classList.toggle('hidden', notificationState.unread <= 0);
  const hint = $('#notificationUnreadHint');
  if (hint) hint.textContent = notificationState.unread ? `${notificationState.unread} 条未读` : '暂无未读';
}

async function refreshNotificationBadge() {
  if (document.hidden) return;
  try {
    const data = await api('/collections/notifications/unread-count');
    renderNotificationBadge(data.total);
  } catch (error) {
    console.warn('notification badge', error.message);
  }
}

async function refreshNotificationPlatforms() {
  const select = $('#notificationPlatform');
  if (!select || select.dataset.loaded === '1') return;
  try {
    const data = await api('/collections/notifications?limit=500');
    const platforms = [...new Set((data.items || []).map((item) => item.platform))].sort();
    select.innerHTML = '<option value="">全部平台</option>' + platforms
      .map((platform) => `<option value="${esc(platform)}">${esc(platformLabel(platform))}</option>`).join('');
    select.dataset.loaded = '1';
  } catch {}
}

function renderNotificationList() {
  const list = $('#notificationList');
  if (!list) return;
  const items = notificationState.items || [];
  if (!items.length) {
    list.innerHTML = '<div class="empty compact"><strong>没有通知</strong><span>新建规则并开启“新内容”通知后，命中内容会出现在这里。</span><div class="empty-actions"><button class="btn sm primary" type="button" onclick="openNotificationDrawer(false); navigateView(\'collections\')">去采集</button></div></div>';
    return;
  }
  list.innerHTML = items.map((item) => `
    <article class="notif-item ${item.unread ? 'unread' : ''}" data-notif-id="${item.id}" data-item-id="${item.item_id}" data-platform="${esc(item.platform)}" role="button" tabindex="0">
      <div class="notif-item-title">${esc(item.title || '(无标题)')}<span class="tag-chip">${esc(platformLabel(item.platform))}</span></div>
      <div class="notif-item-meta">${esc(item.rule_name || item.source_name || '')} · ${esc(formatRunTime(item.created_at))}</div>
      ${item.body ? `<div class="notif-item-body">${esc(item.body)}</div>` : ''}
    </article>`).join('');
}

async function loadNotifications() {
  const params = new URLSearchParams({ limit: '100' });
  if (notificationState.filter === 'unread') params.set('unread', 'true');
  if (notificationState.platform) params.set('platform', notificationState.platform);
  try {
    const data = await api(`/collections/notifications?${params.toString()}`);
    notificationState.items = data.items || [];
    notificationState.loaded = true;
    renderNotificationList();
    renderNotificationBadge(data.unreadTotal ?? notificationState.unread);
  } catch (error) {
    notificationState.items = [];
    renderNotificationList();
    toast(error.message, 'err');
  }
}

async function openNotificationDrawer(open = true) {
  const drawer = $('#notificationDrawer');
  const overlay = $('#notificationOverlay');
  const bell = $('#notificationBell');
  if (!drawer || !overlay) return;
  drawer.hidden = !open;
  overlay.hidden = !open;
  document.body.classList.toggle('notif-open', open);
  bell?.setAttribute('aria-expanded', String(open));
  if (open) {
    await refreshNotificationPlatforms();
    await loadNotifications();
    setTimeout(() => drawer.querySelector('#notificationClose')?.focus(), 0);
  } else {
    bell?.focus();
  }
}

async function markNotificationRead(id) {
  try {
    await api(`/collections/notifications/${id}/read`, { method: 'POST', body: JSON.stringify({}) });
    await refreshNotificationBadge();
    await loadNotifications();
  } catch (error) {
    if (!/404/.test(error.message)) toast(error.message, 'err');
  }
}

async function markAllNotificationsRead() {
  try {
    const platform = notificationState.platform || undefined;
    await api('/collections/notifications/read-all', { method: 'POST', body: JSON.stringify({ platform }) });
    toast('已全部标记为已读');
    await refreshNotificationBadge();
    await loadNotifications();
  } catch (error) {
    toast(error.message, 'err');
  }
}

function startNotificationPolling() {
  if (notificationPollTimer) clearInterval(notificationPollTimer);
  notificationPollTimer = setInterval(refreshNotificationBadge, 30_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshNotificationBadge();
  });
  refreshNotificationBadge();
}

$('#notificationBell')?.addEventListener('click', () => openNotificationDrawer(true));
$('#notificationClose')?.addEventListener('click', () => openNotificationDrawer(false));
$('#notificationOverlay')?.addEventListener('click', () => openNotificationDrawer(false));
$('#notificationReadAll')?.addEventListener('click', markAllNotificationsRead);
$('#notificationPlatform')?.addEventListener('change', (event) => {
  notificationState.platform = event.target.value;
  loadNotifications();
});
$$('[data-notif-filter]').forEach((button) => button.addEventListener('click', () => {
  $$('[data-notif-filter]').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  notificationState.filter = button.dataset.notifFilter;
  loadNotifications();
}));
async function openNotificationTarget(card) {
  if (!card) return;
  await markNotificationRead(Number(card.dataset.notifId));
  await openNotificationDrawer(false);
  location.hash = `/collections/${encodeURIComponent(card.dataset.platform)}/items/${card.dataset.itemId}`;
}
$('#notificationList')?.addEventListener('click', (event) => openNotificationTarget(event.target.closest('[data-notif-id]')));
$('#notificationList')?.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const card = event.target.closest('[data-notif-id]');
  if (!card) return;
  event.preventDefault();
  openNotificationTarget(card);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#notificationDrawer')?.hidden) openNotificationDrawer(false);
});

// ---------- 主题切换（日间 / 夜间） ----------
function initTheme() {
  const params = new URLSearchParams(location.search);
  const forced = params.get('theme');
  const saved = forced || localStorage.getItem('xmonitor-theme') || 'dark';
  document.documentElement.dataset.theme = saved;
  updateThemeBtn(saved);
}
function updateThemeBtn(theme) {
  const btn = $('#themeToggle');
  if (!btn) return;
  const next = theme === 'light' ? '深色' : '浅色';
  btn.textContent = `${next}模式`;
  btn.setAttribute('aria-label', `切换为${next}模式`);
  btn.setAttribute('aria-pressed', String(theme === 'light'));
}
$('#themeToggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = cur;
  localStorage.setItem('xmonitor-theme', cur);
  updateThemeBtn(cur);
  toast(cur === 'light' ? '已切换为浅色模式' : '已切换为深色模式');
});

// ---------- 轮询 ----------
setInterval(() => {
  refresh(true).catch(() => {});
}, 8000);

// 暴露给 onclick
window.switchView = switchView;
window.decideMaterial = decideMaterial;
window.openCreateModal = openCreateModal;
window.toggleCreation = toggleCreation;
window.retryCreation = retryCreation;
window.copyCreation = copyCreation;
window.copyText = copyText;
window.toggleAccount = toggleAccount;
window.removeAccount = removeAccount;
window.goCollectionPage = goCollectionPage;
window.setCollectionRuleInterval = setCollectionRuleInterval;
window.runCollectionRule = runCollectionRule;
window.toggleCollectionRule = toggleCollectionRule;
window.deleteCollectionRule = deleteCollectionRule;
window.retryCollectionJob = retryCollectionJob;
window.cancelCollectionJob = cancelCollectionJob;

// ---------- 启动 ----------
initTheme();
startNotificationPolling();
if (location.hash) applyHashRoute();
else switchView('dashboard');
