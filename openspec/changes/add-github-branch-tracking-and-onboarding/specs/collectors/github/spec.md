# Spec Delta

## ADDED Requirements

### Requirement: Branch selection and commit collection

`github` 适配器 SHALL 支持 `branches` 事件；规则选项 SHALL 支持指定分支列表、是否包含默认分支、是否包含 merge commit、全部分支和最大分支数。未指定分支时 MUST 监控仓库默认分支，并按分支采集提交的 SHA、提交信息、作者、时间和规范链接。

#### Scenario: Monitor the default branch

- **WHEN** 用户创建 GitHub 规则并勾选“分支提交”，未填写分支列表
- **THEN** 适配器读取仓库默认分支，采集该分支的最新提交，并在内容元数据中标记分支名和 commit SHA

#### Scenario: Monitor selected branches

- **WHEN** 规则配置 `branches: ["main", "dev"]` 且 `includeDefaultBranch: false`
- **THEN** 适配器只采集 `main` 和 `dev` 的提交，不请求默认分支

#### Scenario: Filter merge commits

- **WHEN** 规则配置 `includeMergeCommits: false`
- **THEN** 有两个及以上父提交的 merge commit 被过滤，并在运行详情记录过滤数量

#### Scenario: Monitor all branches

- **WHEN** 规则配置 `allBranches: true` 且仓库有超过 `maxBranches` 个分支
- **THEN** 适配器按 `maxBranches` 截断分支列表，并在运行详情标记被截断的分支数量

### Requirement: Commit code change content

GitHub 分支采集 SHALL 在 `includeCodeChanges` 未显式关闭时，为本次运行的新提交读取变更文件；MUST 归一化文件名、变更状态、增删行数、变更总数、patch 片段、commit 链接和 compare 链接。提交的 `content` / `summary` MUST 包含变更文件摘要，结构化变更 MUST 写入 `metadata.codeChanges`。

#### Scenario: Commit with changed files

- **WHEN** 默认分支出现一个新提交，提交详情返回两个变更文件
- **THEN** 内容正文包含提交说明和两个文件的增删摘要，`metadata.codeChanges.files` 包含文件名、状态、增删行数和 patch，且包含 commit 与 compare 链接

#### Scenario: Patch is truncated

- **WHEN** 单个文件 patch 超过 `maxPatchCharsPerFile`
- **THEN** patch 被截断到上限，`metadata.codeChanges.truncated` 为 true，内容仍保留文件名和增删行数

#### Scenario: Code changes disabled

- **WHEN** 规则配置 `includeCodeChanges: false`
- **THEN** 适配器不请求单提交详情，不产生 `metadata.codeChanges`，提交内容和通知仍正常生成

#### Scenario: Commit has no file changes

- **WHEN** 单提交详情返回空文件列表
- **THEN** 内容摘要标记“无文件变更”，不生成空 patch 字段，也不使采集失败

### Requirement: Commit cursor, limits and notifications

GitHub 分支采集 SHALL 为每个仓库和分支保存增量游标，使用提交时间或 `since` 参数跳过已采集提交；提交按 SHA 幂等去重。代码改动 SHALL 受每轮补丁提交数、每提交文件数和每文件 patch 字符数限制；单提交详情请求失败或触发限流时 MUST 保留提交条目、标记 `codeChangesUnavailable` 并停止本轮补丁增强，不得使整次采集失败。首次入库的提交 MUST 生成站内通知，通知包含仓库、分支和提交标题。

#### Scenario: Resume after interruption

- **WHEN** 某一分支的提交采集在翻页后中断
- **THEN** 下次运行从该分支已提交的游标继续，不重复请求已完成的页

#### Scenario: New commit notification

- **WHEN** 默认分支出现一个新的首次入库提交
- **THEN** 系统生成一条通知，标题包含仓库、分支和提交标题，并标记为未读

#### Scenario: Duplicate commit

- **WHEN** 两次运行返回同一个 commit SHA
- **THEN** 只保留一条内容记录和一条通知，不重复计数，也不重复请求该提交的代码改动

#### Scenario: Rate limit during code enrichment

- **WHEN** 读取某个提交详情时 GitHub 返回 403 或 429
- **THEN** 已采集的提交仍入库并生成通知，`metadata.codeChangesUnavailable` 为 true，后续提交不再请求详情，运行状态标记为降级而不是失败

#### Scenario: Code change limits

- **WHEN** 本次运行有超过 `maxDiffCommitsPerRun` 个新提交，或单个提交超过 `maxFilesPerCommit` 个文件
- **THEN** 只增强上限内的提交/文件，其余保留提交摘要并标记被截断
