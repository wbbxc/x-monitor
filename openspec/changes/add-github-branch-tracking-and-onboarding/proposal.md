# Proposal

## Why

GitHub 适配器目前只采集 Releases、Issues、Pull Requests 和 Discussions；即使新增了分支提交，也只能看到 commit message，无法看到“这次提交改了哪些文件、增删多少行、具体 patch 是什么”。用户需要的是分支的代码更新内容，而不是一条提交标题。

同时，采集器虽然功能完整，但第一次使用时仍要理解来源、规则、查询选项、匹配条件、通知、平台工作台和多个 JSON 字段。导航有 10 个入口，采集总览、采集设置、平台工作台之间来回跳转，模板只填一半表单，用户仍然不知道下一步该做什么。上手门槛不是靠再加一篇文档解决，而是要把首次使用做成一条可执行路径。

本次变更把两件事一起做完整：

1. GitHub 分支采集从“提交元数据”升级为“提交 + 代码改动内容”。
2. 把采集器整理成“快速开始 → 推荐配置 → 试跑 → 查看结果”的新手路径，并简化导航与术语。

## What Changes

### GitHub 分支代码更新

- `github` 适配器新增 `branches` 事件，支持默认分支、指定分支列表和全部分支。
- 分支采集按 `since` / `lastSha` 增量拉取提交，按 SHA 幂等去重。
- 对本次运行的新提交读取单提交详情，采集变更文件：
  - 文件名、变更状态（added / modified / removed / renamed）、增删行数、变更总数。
  - patch 片段（可关闭、可截断）。
  - commit 链接与 compare 链接。
- 提交内容（`content` / `summary`）包含提交说明和变更文件摘要；结构化变更写入 `metadata.codeChanges`。
- 代码改动默认开启，但有硬限制：
  - `maxDiffCommitsPerRun`：每轮最多补丁多少个提交，默认 10。
  - `maxFilesPerCommit`：每个提交最多保留多少个文件，默认 20。
  - `maxPatchCharsPerFile`：每个文件 patch 最大字符数，默认 2000。
  - `includePatch`：是否保留 patch 片段，默认 true。
- 遇到 403/429 或单提交详情请求失败时，停止本轮补丁增强，保留已采集的提交并标记 `codeChangesUnavailable`，不让整次采集失败。
- 用分支游标记录最近已补丁的 SHA，避免对同一提交重复请求详情。

### GitHub 快捷规则表单

- 规则表单新增仅 GitHub 可见的快捷区：
  - 监控内容：Releases、Issues、PRs、Discussions、分支提交。
  - 监控分支：逗号分隔，留空表示默认分支。
  - 采集代码改动：默认开启。
  - 包含 merge commit：默认关闭。
- 常用 GitHub 规则不再需要手写 `options` JSON；高级 JSON 仍保留，用于 labels、state、补丁上限等。
- 保存时快捷字段合并进 `options.events`、`options.branches`、`options.includeCodeChanges`、`options.includeMergeCommits`；高级 JSON 优先。

### 新手快速开始

- 仪表盘新增“快速开始”三步向导：
  1. 选择目标：GitHub 分支代码、arXiv 论文、全网关键词、Reddit 社区。
  2. 填写最少信息：仓库 `owner/repo`、arXiv 关键词、搜索关键词或 subreddit。
  3. 确认并试跑：展示将创建的来源和规则，用户确认后创建，并可立即试跑。
- 向导通过现有 `/api/collections/sources`、`/api/collections/rules` 和运行接口完成，不新增数据库表；创建失败保留表单并指出失败步骤。
- 新手任务清单继续保留，作为向导之外的常驻检查表。
- 使用指南页面解释“来源、规则、匹配条件、通知”，提供平台选择表、三分钟上手步骤和常见问题。
- 推荐模板与快速开始共用同一组配置，避免“模板填一半、还要自己猜规则”。

### 导航与术语整理

- 侧边栏改为四组：
  - **开始**：仪表盘、使用指南。
  - **内容**：素材库、抓取推文、创作记录、监控账号。
  - **采集**：采集、来源与规则。
  - **系统**：运行日志、设置。
- “采集总览”更名为“采集”，“采集设置”更名为“来源与规则”，“平台工作台”在页内称为“采集详情”。
- 移除侧边栏 linux.do 快捷入口；linux.do 仍可从“采集”进入。
- 高级 JSON、匹配条件、低频选项默认收起，提供“显示高级选项”开关。
- 空状态改为“标题 + 原因 + 下一步按钮”，无来源、无规则、无内容、无通知都不再只显示“暂无”。

## Capabilities

### New Capabilities

- `product-onboarding`: 首次使用的快速开始向导、任务清单、使用指南、推荐模板、简化导航、行动化空状态和术语说明。

### Modified Capabilities

- `collectors/github`: 新增分支/提交采集与提交代码改动内容，包括变更文件、patch、增量游标、限制与降级。

## Impact

- **代码**：
  - `src/collectors/github.js`：分支解析、提交采集、单提交详情、变更文件、patch 限制、游标、通知。
  - `web/app.js`：快速开始向导、任务清单、指南页、模板、GitHub 快捷字段、导航与空状态。
  - `web/index.html`：向导、指南页、快捷字段、空状态、导航分组。
  - `web/style.css`：向导、指南、模板、代码改动摘要样式。
- **API**：现有 `/api/collections/*` 路由不变；GitHub 规则 `options` 新增：
  - `branches`、`includeDefaultBranch`、`allBranches`
  - `includeMergeCommits`、`maxBranches`、`maxCommitsPerBranch`
  - `includeCodeChanges`、`includePatch`、`maxDiffCommitsPerRun`、`maxFilesPerCommit`、`maxPatchCharsPerFile`
- **数据**：不新增表；代码改动写入现有 `metadata_json` / `raw_json`，游标写入 `collection_cursors`。patch 有字符上限，避免单条内容过大。
- **文档**：更新 `docs/collectors/github.md`、`docs/collectors/README.md`、`README.md` 的分支代码更新示例与新手路径。
- **兼容性**：无 BREAKING。已有 GitHub 规则未设置 `branches` 时行为不变；只有显式开启分支事件的规则才会请求提交和代码改动。旧版本会忽略新增选项。
- **非目标**：不拉取完整提交历史；不为已存在的历史提交补 diff；不采集 commit 评论、审查线程或逐行 review 评论；不新增外部通知通道；不做代码语义分析或漏洞扫描。
