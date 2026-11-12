# Spec Delta

## Purpose

定义 X（Twitter）采集：复用现有 twscrape 登录账号，持续采集指定账号的最新推文，并按关键词搜索公开推文，统一写入采集内容库。

## ADDED Requirements

### Requirement: Account timeline collection

`x` 适配器 SHALL 支持 `account` 规则，值为用户名或 `@用户名`；每次运行采集该账号的最新推文，按配置的每账号条数截断，并保存作者、正文、发布时间、互动指标、媒体和规范链接。

#### Scenario: Collect monitored account

- **WHEN** 规则类型为 `account`、值为 `karpathy`，且 twscrape 至少有一个可用登录账号
- **THEN** 系统采集该账号最新推文并写入 `platform=x` 的内容，重复推文按推文 ID 幂等合并

#### Scenario: Invalid account name

- **WHEN** 规则值为空、包含空格或不是合法的 X 用户名
- **THEN** 保存规则时返回 400，不创建无效规则

### Requirement: Keyword search collection

`x` 适配器 SHALL 支持 `keyword` 或 `search` 规则，调用 X 搜索并按最新或热门排序返回结果；查询选项 SHALL 支持结果数量、搜索类型、最低点赞/回复数、语言和时间范围。

#### Scenario: Search recent posts

- **WHEN** 规则为关键词 `"AI agent"`、搜索类型为 `latest`、数量为 50
- **THEN** 系统返回搜索结果中最新的一批推文，并按本地匹配条件再次过滤

#### Scenario: Search returns no results

- **WHEN** 搜索没有命中任何推文
- **THEN** 任务以成功状态结束，采集数为 0，并在运行详情中记录查询词和搜索类型

### Requirement: Credential reuse and failure behavior

`x` 适配器 MUST 复用项目现有的 `python/accounts.json` 登录配置（Cookie 或账号密码），不得要求重复录入；没有可用账号时 MUST 返回可操作的错误，而不是返回空结果。

#### Scenario: No X account configured

- **WHEN** 没有任何可用登录账号且采集模式不是 mock
- **THEN** 任务失败并提示配置 Cookie 或账号密码，以及可选代理

#### Scenario: Mock mode for local development

- **WHEN** 采集模式为 `mock`
- **THEN** 适配器返回内置演示推文并标记为演示数据，不访问 X 网络

### Requirement: Incremental collection

`x` 适配器 SHALL 为每个来源和规则保存最近一次成功采集的推文游标，并在后续运行中跳过已见过的推文；单次运行条数 MUST 有上限，避免一次拉取过多历史内容。

#### Scenario: Resume from last tweet

- **WHEN** 上次采集到推文 ID `1000`，本次返回 `1005` 到 `995`
- **THEN** 只入库 ID 大于 `1000` 的新推文，并推进游标

#### Scenario: Limit per run

- **WHEN** 来源配置每次最多 100 条，而账号有更多新推文
- **THEN** 本次只采集最多 100 条，剩余内容留待下次运行

### Requirement: Rate limit and normalization

`x` 适配器 MUST 限制并发和请求频率，遇到限流时按退避策略重试或推迟下次运行；所有推文 MUST 规范化为统一内容模型，链接 MUST 只接受 HTTP(S) 并去除跟踪参数。

#### Scenario: Rate limited by X

- **WHEN** X 返回限流或登录失效
- **THEN** 任务按可重试错误处理，记录脱敏后的错误原因，并推迟后续运行

#### Scenario: Normalize tweet media and links

- **WHEN** 推文包含图片、视频和 t.co 外链
- **THEN** 内容记录包含媒体 URL、展开后的外链和原始推文快照，规范链接指向 `x.com` 状态页
