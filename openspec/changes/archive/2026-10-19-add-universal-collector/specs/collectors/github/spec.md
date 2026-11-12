# Spec Delta

## Purpose

定义 GitHub 仓库更新采集：监控 Releases/Tags、Issues、Pull Requests 和 Discussions，把版本发布与协作动态统一写入内容库，并在有新事件时生成站内通知。

## ADDED Requirements

### Requirement: Repository rule and event selection

`github` 适配器 SHALL 支持 `repo` 规则，值为 `owner/repo` 或仓库 URL；来源配置 SHALL 选择要监控的事件集合（releases、issues、pulls、discussions）以及是否包含预发布版本、标签过滤和状态过滤。

#### Scenario: Watch selected events

- **WHEN** 规则为 `openai/openai-node`，事件集合为 `releases` 和 `pulls`
- **THEN** 系统只采集该仓库的 Release 和 Pull Request，不请求 Issues 或 Discussions

#### Scenario: Invalid repository value

- **WHEN** 规则值不是合法的 `owner/repo` 或 GitHub 仓库 URL
- **THEN** 保存规则时返回 400，不创建规则

### Requirement: Release and tag collection

GitHub 适配器 SHALL 采集仓库 Release 的标签、标题、正文、作者、发布时间、预发布状态、资源和规范链接；当仓库没有 Release 时 MAY 回退到 Tags，并按 Release/Tag 标识幂等去重。

#### Scenario: New release detected

- **WHEN** 仓库发布新版本 `v2.0.0`
- **THEN** 系统采集 Release 正文和资源链接，首次入库时生成通知

#### Scenario: Prerelease filtered

- **WHEN** 来源配置排除预发布版本，而最新 Release 标记为 prerelease
- **THEN** 该 Release 被过滤，运行详情记录过滤原因

### Requirement: Issue and pull request collection

GitHub 适配器 SHALL 采集 Issues 和 Pull Requests 的标题、正文、作者、状态、标签、指派人、评论数、更新时间、创建时间和规范链接；支持按 `since` 增量更新和按标签过滤，并区分 Issue 与 PR。

#### Scenario: Incremental issue updates

- **WHEN** 上次采集时间为 `2026-01-01T00:00:00Z`，仓库有在此之后更新的 Issue
- **THEN** 系统只请求并更新这些 Issue，已有内容按 URL/ID 合并而不重复入库

#### Scenario: Label filter

- **WHEN** 来源配置只保留 `bug` 标签的 Issue
- **THEN** 没有该标签的 Issue 被过滤，运行详情记录过滤数量

### Requirement: Discussion collection

GitHub 适配器 SHALL 通过 GraphQL 采集 Discussions 的标题、正文、作者、分类、评论数、更新时间、创建时间和规范链接，使用游标分页；没有 Token 时 MUST 明确提示 Discussions 需要认证，而不是静默返回空结果。

#### Scenario: Collect discussions with token

- **WHEN** 来源配置了 GitHub Token 且事件集合包含 `discussions`
- **THEN** 适配器按游标分页采集讨论，直到达到上限或没有下一页

#### Scenario: Missing token for discussions

- **WHEN** 事件集合包含 `discussions` 但没有配置 Token
- **THEN** 该部分采集被标记为跳过并提示需要 Token，其他事件仍正常采集

### Requirement: GitHub authentication and rate limits

`github` 适配器 SHALL 支持无 Token 的公开采集和 Token 认证；Token MUST 加密保存；遇到 401/403/429 时 MUST 区分鉴权失败、权限不足和限流，并遵守 `Retry-After` 与 `X-RateLimit-Reset`。

#### Scenario: Anonymous rate limit

- **WHEN** 匿名请求达到 GitHub 速率上限
- **THEN** 任务记录重置时间并推迟后续运行，提示配置 Token 提高限额

#### Scenario: Invalid token

- **WHEN** GitHub 返回 401
- **THEN** 任务失败并提示 Token 无效或已过期，不进行无休止重试

### Requirement: GitHub incremental cursor and notifications

GitHub 适配器 SHALL 为每个仓库和事件类型维护增量游标，支持最大页数和中断恢复；新 Release、Issue、Pull Request、Discussion MUST 在首次入库时产生通知，已存在条目的状态变化默认只更新内容，除非规则开启更新通知。

#### Scenario: Resume after interruption

- **WHEN** Pull Request 同步在第二页后中断，随后再次运行
- **THEN** 适配器从已提交游标继续，不重复请求第一页

#### Scenario: State change without duplicate notification

- **WHEN** 已通知过的 Issue 从 open 变为 closed
- **THEN** 内容记录更新为 closed，通知不重复创建；若规则开启更新通知则新增一条更新通知
