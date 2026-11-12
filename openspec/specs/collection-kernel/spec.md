# collection-kernel Specification

## Purpose

定义所有采集器共享的来源/规则模型、适配器发现与元数据、链接识别、认证与公开降级、分页游标和调度契约，使新增平台只需要实现平台差异。

## Requirements

### Requirement: Adapter discovery and metadata

系统 SHALL 通过统一注册表暴露每个采集适配器的标识、名称、能力、认证类型、支持的规则类型、配置示例和是否存在公开降级路径；未注册的平台 MUST 被拒绝。

#### Scenario: List supported platforms

- **WHEN** 客户端请求采集适配器列表
- **THEN** 返回至少包含 `web`、`google`、`arxiv`、`huggingface`、`linux.do`、`macos.do`、`v2ex`、`x`、`github`、`reddit`、`discord`、`telegram` 的条目，并为每项返回规则类型和认证类型

#### Scenario: Reject unknown platform

- **WHEN** 客户端用未注册的平台标识创建采集源
- **THEN** 系统返回 400 和可读的错误信息，且不写入任何来源或规则

### Requirement: Source and rule configuration

采集源 SHALL 保存平台、名称、链接、平台配置和启用状态；采集规则 SHALL 保存规则类型、值、查询选项、匹配条件、通知开关和调度间隔；`interval_min=0` MUST 表示仅手动执行。

#### Scenario: Create rule with platform options

- **WHEN** 用户为一个 GitHub 来源创建 `repo` 规则并指定要监控的事件类型
- **THEN** 规则连同查询选项和通知开关一起保存，并在后续任务中原样传给适配器

#### Scenario: Invalid rule value rejected

- **WHEN** 用户提交适配器不接受的规则值或查询选项
- **THEN** 系统返回 400，且不创建或修改规则

### Requirement: Link detection

系统 SHALL 接受一个 URL 并返回推荐平台、规范化标识、建议的规则类型、所需认证、公开降级可用性和警告；已知域名 MUST 在无需网络请求的情况下完成识别，未知域名 MUST 回退为通用 `web`。

#### Scenario: Detect social and code links

- **WHEN** 用户提交 `https://x.com/karpathy`、`https://github.com/openai/openai-node` 或 `https://hf-mirror.com/papers/2601.00001`
- **THEN** 分别返回 `x` 账号规则、`github` 仓库规则和带镜像地址的 `huggingface` 配置建议

#### Scenario: Detect forum and unknown links

- **WHEN** 用户提交 `https://macos.do/t/example/123` 或一个未知博客链接
- **THEN** 前者返回 `macos.do` 的 Discourse 规则建议，后者返回 `web` 全量或搜索采集建议

#### Scenario: Invalid URL

- **WHEN** 用户提交空值、非 HTTP(S) 或无法解析的链接
- **THEN** 系统返回 400 和可读错误，不进行网络请求

### Requirement: Authentication and anonymous fallback

适配器 SHALL 声明支持的认证类型及公开降级能力；通过采集设置保存的认证信息 MUST 加密存储，复用外部凭据文件时 MUST 限制文件权限；API 和日志 MUST 只暴露认证类型与是否已配置；无凭据时系统 MUST 选择公开降级或返回可操作的错误。

#### Scenario: Anonymous fallback succeeds

- **WHEN** 未配置 Reddit OAuth 凭据但创建了公开 subreddit 规则
- **THEN** 采集使用公开 JSON 接口完成，并在运行详情中标记降级模式

#### Scenario: Missing credential blocks collection

- **WHEN** Discord 消息采集没有 Bot Token 且来源未声明为仅邀请信息模式
- **THEN** 任务失败并提示需要 Bot Token 和所需权限，而不是静默返回空结果

#### Scenario: Secrets never leak

- **WHEN** 采集任务失败或用户查询来源认证状态
- **THEN** 响应和日志中只出现认证类型与配置状态，不出现 Cookie、Token 或密码原文

### Requirement: Pagination and idempotent ingestion

分页适配器 SHALL 逐页提交内容与游标，单页写入和游标推进 MUST 在同一事务中完成；内容 MUST 按规范 URL 或平台外部 ID 生成稳定去重键；任务正常结束后 MUST 清理一次性游标。

#### Scenario: Resume interrupted full sync

- **WHEN** Hugging Face 全量同步在第三页后中断，随后同一来源再次运行
- **THEN** 任务从已提交游标继续，而不是从第一页重新开始

#### Scenario: Duplicate page does not duplicate items

- **WHEN** 两个规则或两次运行返回同一个规范 URL 或同一个平台外部 ID
- **THEN** 只保留一条内容记录，并合并链接、原始快照和来源关联

### Requirement: Scheduling and job execution

系统 SHALL 按规则的间隔和下次运行时间入队任务，对同一来源与规则的并发任务进行合并；失败任务 SHALL 按重试策略退避，遇到 429 MUST 遵守平台冷却时间；手动和紧急任务 MUST 可立即执行。

#### Scenario: Coalesce overlapping runs

- **WHEN** 同一规则的上一次任务仍在排队或执行，下一次定时触发到达
- **THEN** 系统合并任务并推进下次运行时间，不产生重复任务

#### Scenario: Respect rate-limit cooldown

- **WHEN** 平台返回 429 并给出重试等待时间
- **THEN** 规则的下次运行时间至少推迟到冷却结束，任务按退避策略重试

### Requirement: Platform aliases

系统 SHALL 将常见别名映射为规范平台标识并以规范标识存储，包括 `twitter`/`x.com` 到 `x`、`hf-mirror` 到 `huggingface`、`macosdo` 到 `macos.do`。

#### Scenario: Alias resolves to canonical platform

- **WHEN** 用户用 `hf-mirror` 作为平台标识创建来源
- **THEN** 来源以 `huggingface` 保存，并使用 hf-mirror 的接口地址作为平台配置的一部分
