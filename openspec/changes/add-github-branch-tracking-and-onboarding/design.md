# Design

## Context

现有 GitHub 适配器支持 Releases、Issues、Pull Requests 和 Discussions，并为每个仓库/事件保存游标。分支提交本身只能回答“什么时候提交了什么说明”，不能回答“改了哪些文件、增删多少行、patch 是什么”。采集器 UI 已有来源、规则、匹配和通知，但导航入口多、术语分散、常用 GitHub 规则仍依赖 JSON，首次使用者很难判断下一步。

归档的 `add-universal-collector` 已把 9 个能力写入主 specs，本变更在其上做增量。

## Goals / Non-Goals

**Goals:**

- 让 GitHub 规则能监控默认分支、指定分支或全部分支的提交。
- 对本次运行的新提交采集代码改动内容：变更文件、状态、增删行数、patch 片段和链接。
- 让提交采集具备增量游标、SHA 去重、代码改动上限和限流降级。
- 让首次使用者通过三步向导完成第一个来源和规则，不写 JSON。
- 用简化导航、任务清单、指南、模板和行动化空状态把路径固定下来。

**Non-Goals:**

- 不拉取完整提交历史，不为已存在的历史提交补 diff。
- 不采集 commit 评论、review 线程或逐行 review 评论。
- 不新增外部通知通道、账号体系或数据库表。
- 不做代码语义分析、漏洞扫描或仓库全量索引。
- 不重写采集内核；只扩展 GitHub 适配器和前端引导层。

## Decisions

### 1. 分支采集使用 branches 事件

`github` 的 `events` 增加 `branches`。规则选项：

```json
{
  "events": ["releases", "pulls", "branches"],
  "branches": ["main", "dev"],
  "includeDefaultBranch": false,
  "includeMergeCommits": false,
  "allBranches": false,
  "maxBranches": 10,
  "maxCommitsPerBranch": 50,
  "includeCodeChanges": true,
  "includePatch": true,
  "maxDiffCommitsPerRun": 10,
  "maxFilesPerCommit": 20,
  "maxPatchCharsPerFile": 2000
}
```

- `branches` 为空：只采集仓库默认分支，不论 `includeDefaultBranch` 的值。
- `branches` 非空：只采集列出的分支；`includeDefaultBranch: true` 时再合并默认分支。
- `allBranches: true`：读取 `/branches` 列表，最多 `maxBranches` 个，默认关闭。
- 每个分支最多 `maxCommitsPerBranch` 条，整体仍受 `maxItems` 限制。
- 默认事件集合保持 `releases/issues/pulls` 不变；快捷表单勾选“分支提交”后才加入 `branches`。
- 代码改动默认开启，只对分支事件生效。

### 2. 分支/提交 API 与游标

- 默认分支：`GET /repos/{owner}/{repo}` 读取 `default_branch`。
- 分支列表：`GET /repos/{owner}/{repo}/branches?per_page=100`。
- 提交列表：`GET /repos/{owner}/{repo}/commits?sha={branch}&since={since}&per_page=100&page={page}`。
- 单提交详情：`GET /repos/{owner}/{repo}/commits/{sha}`，读取 `files[]`。
- 游标结构：

```json
{
  "repos": {
    "owner/repo": {
      "branches": {
        "main": {
          "since": "2026-10-01T00:00:00Z",
          "lastSha": "abc...",
          "diffedShas": ["abc...", "def..."]
        }
      }
    }
  }
}
```

- 首次运行没有 `since`，只取第一页最新提交；后续用 `since` 增量。
- 每个分支独立推进 `since`；失败不推进该分支游标。
- 提交归一化：`external_id=commit:<sha>`，`canonical_url=https://github.com/owner/repo/commit/<sha>`，`title=提交信息首行`，`content=提交信息 + 变更摘要`，`metadata={event:'commit', branch, sha, authorLogin, parents, mergeCommit, codeChanges}`。
- merge commit 通过 `parents.length >= 2` 判断；`includeMergeCommits=false` 时过滤。
- 通知：`metadata.notification.event='commit'`，标题 `owner/repo branch: <首行>`，正文为提交信息摘要；代码改动可用时附变更文件数。

### 3. 代码改动内容

提交列表 API 不返回文件变更，因此只对“本次运行需要增强”的新提交调用单提交详情：

1. 先合并分支提交列表并过滤 merge commit。
2. 按提交时间倒序，取前 `maxDiffCommitsPerRun` 个未在 `diffedShas` 中的提交。
3. 对每个提交请求单提交详情，读取 `files[]`。
4. 每个文件保留：
   - `filename`、`previousFilename`（重命名时）
   - `status`（added / modified / removed / renamed / copied / changed / unchanged）
   - `additions`、`deletions`、`changes`
   - `patch`（若 `includePatch` 且非二进制），超过 `maxPatchCharsPerFile` 截断
   - `binary`、`patchUnavailable`
5. 文件数超过 `maxFilesPerCommit` 时截断，设置 `truncated: true`。

`content` 格式：

```text
<提交信息>

变更文件 3 个：
- M src/collector.js +18 -4
- A docs/github.md +42 -0
- R old-name.js -> new-name.js +2 -2

提交：https://github.com/owner/repo/commit/<sha>
对比：https://github.com/owner/repo/compare/<parent>...<sha>
```

- `metadata.codeChanges.files` 保存结构化文件列表和 patch 片段。
- `metadata.codeChanges.totalFiles` 为原始文件数，`returnedFiles` 为保留数。
- `metadata.codeChangesUnavailable` 在详情请求失败/限流时为 true；不生成空 patch 字段。
- `diffedShas` 每个分支最多保留 50 个，避免游标无限增长；同一 SHA 不重复请求详情。

### 4. 代码改动的限流与降级

- 单提交详情按分支串行请求，沿用 GitHub 1 req/s 限流。
- 单提交详情返回 403/429：停止本轮所有后续补丁增强，已采集提交照常入库，`meta.degraded=true`，`metadata.codeChangesUnavailable=true`。
- 单提交详情返回 404/410：该提交标记 `codeChangesUnavailable`，继续处理后续提交。
- 网络错误：按现有重试策略重试；重试耗尽后同 403/429 处理，不让整次采集失败。
- 代码改动失败不影响提交标题、作者、时间、分支和通知；通知正文标注“代码改动暂不可用”。

### 5. GitHub 快捷字段与高级 JSON

规则表单新增仅 GitHub 可见的快捷区：

- 监控内容复选框：Releases、Issues、PRs、Discussions、分支提交。
- 监控分支输入：逗号分隔，留空表示默认分支。
- 采集代码改动开关，默认开启。
- 包含 merge commit 开关，默认关闭。

保存时：

1. 解析高级 JSON（如果有）。
2. 若快捷区可见，写入 `options.events`、`options.branches`、`options.includeCodeChanges`、`options.includeMergeCommits`。
3. 若高级 JSON 中显式包含这些键，以高级 JSON 为准，并在表单提示“快捷字段已被高级 JSON 覆盖”。
4. 后端执行 `githubAdapter.validateRule`，非法分支名/事件返回 400。

高级 JSON 仍负责 `maxDiffCommitsPerRun`、`maxFilesPerCommit`、`maxPatchCharsPerFile`、`labels`、`state` 等低频选项。

### 6. 新手快速开始

仪表盘“快速开始”是一个三步向导，不引入后端状态：

- **Step 1 选目标**：GitHub 分支代码、arXiv 论文、全网关键词、Reddit 社区。
- **Step 2 填最少信息**：仓库 `owner/repo`、arXiv 关键词、Google 关键词、subreddit。
- **Step 3 确认并试跑**：展示将创建的来源和规则摘要；用户确认后创建来源、创建规则，可选“创建后立即试跑”。

目标预设对象：

```js
{
  id: 'github-branches',
  platform: 'github',
  name: 'owner/repo',
  url: 'https://github.com/owner/repo',
  ruleKind: 'repo',
  ruleValue: 'owner/repo',
  ruleOptions: {
    events: ['releases', 'pulls', 'branches'],
    includeCodeChanges: true,
    includeMergeCommits: false
  }
}
```

- 预设按平台选择，不在前端拼后端不支持的规则类型。
- 创建流程使用现有 `POST /api/collections/sources`、`POST /api/collections/rules` 和来源运行接口。
- 来源创建成功、规则失败时保留来源 id 和表单，显示“来源已创建、规则未创建”，允许只重试规则。
- 向导失败不删除已创建来源；用户可在“来源与规则”里继续。
- 关闭向导不写库；已填内容只保留在当前会话。
- 不默认自动试跑，确认页提供复选框，默认关闭，避免首次使用就消耗额度。

### 7. 任务清单、指南与模板

- **任务清单**：根据 `/api/stats`、`/api/collections/platforms`、`/api/collections/rules`、通知未读数计算，不新增表；`localStorage` 保存收起状态。
- **使用指南**：新视图 `view-guide`，内容按“这是什么 → 3 分钟上手 → 平台怎么选 → 常见问题”组织；提供快速开始、去配置 LLM、去来源与规则、去采集的跳转。
- **模板**：与快速开始共用预设；在来源与规则页点击只填表单，不直接创建；与向导的区别是模板给高级用户复用，向导给首次使用者走完整流程。
- **导航**：四组“开始 / 内容 / 采集 / 系统”；“采集总览”改名“采集”，“采集设置”改名“来源与规则”；linux.do 快捷项移除，仍可从采集页进入。
- **高级选项**：`localStorage` 键 `xmonitor-advanced` 控制“显示高级选项”，默认关闭；开启后显示 JSON、匹配条件和补丁限制，快捷字段保留。

### 8. 空状态行动化

- 无来源：解释“来源=从哪里采”，按钮“快速开始”和“打开来源与规则”。
- 无规则：解释“规则=采什么”，按钮“使用 GitHub 推荐规则”并聚焦新建规则表单。
- 无内容：按钮“立即采集”和“查看规则”。
- 无通知：说明“开启规则通知后才会出现”，按钮“去采集”。

按钮只做导航、聚焦或打开向导，不自动写库。

## Risks / Trade-offs

- **代码改动请求量**：每个新提交多一次详情请求。用 `maxDiffCommitsPerRun`、`diffedShas` 和串行限流控制；默认 10 个/轮。
- **patch 体积**：大文件/生成文件会撑大数据库。用 `maxFilesPerCommit` 和 `maxPatchCharsPerFile` 截断，二进制不保留 patch。
- **分支噪声**：分支提交可能很多；默认不采集分支，用户勾选后才启用，并提供 merge commit 过滤和每分支上限。
- **限流降级**：代码改动失败不阻塞提交入库，但用户可能看不到 patch；用 `codeChangesUnavailable` 和运行详情明确标记。
- **快捷字段与 JSON 冲突**：高级 JSON 优先，界面提示覆盖关系；避免保存时静默丢配置。
- **快速开始部分失败**：来源创建成功、规则失败时保留来源并允许只重试规则；不自动回滚，避免误删用户来源。
- **导航改名**：路由保持不变，只改显示文案；旧书签仍可用。
- **Google 模板依赖 CSE**：缺少 Google CSE 配置时，模板给出明确提示并引导改用 Web 关键词，不假装可用。

## Migration Plan

1. 部署后已有 GitHub 规则无需修改；未设置 `branches` 的规则行为不变。
2. 新建或编辑 GitHub 规则时，快捷区默认勾选 Releases、PRs；分支提交默认不勾选，代码改动开关默认开启但仅在分支事件启用时生效。
3. 需要分支代码更新时，勾选“分支提交”，填写 `main, dev` 或留空使用默认分支；首次运行只取最新一页并采集代码改动。
4. 旧版本会忽略新增选项；回滚不会破坏已有规则、游标或内容。
5. 导航改名不改变 hash 路由；`/settings/collectors` 等旧路径继续有效。

## Open Questions

无。代码改动默认开启、补丁上限、快捷字段优先级、向导不自动试跑已在本设计确定。Google CSE 缺失时的提示属于实现细节，不阻塞设计。
