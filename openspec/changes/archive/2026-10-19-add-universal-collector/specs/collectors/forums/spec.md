# Spec Delta

## Purpose

定义 Discourse 论坛（linux.do、macos.do）、V2EX 和 Reddit 的采集：统一处理最新/热门/分类/标签/节点/账号/关键词查询，并在有凭据时使用官方接口、无凭据时使用公开接口降级。

## ADDED Requirements

### Requirement: Multi-site Discourse collection

`linux.do` 与 `macos.do` 适配器 SHALL 共用同一套 Discourse 采集能力，按来源配置的站点根地址访问最新、热门、分类、标签和站内搜索接口；结果 MUST 归一化为标题、正文/摘要、作者、分类、标签、回复数、浏览量和规范链接。

#### Scenario: Collect macos.do latest topics

- **WHEN** 创建 `macos.do` 来源并配置 `full` 规则
- **THEN** 系统访问 `https://macos.do/latest.json`，入库话题并按话题 ID 幂等去重

#### Scenario: Linux.do site search

- **WHEN** 创建 `linux.do` 关键词规则
- **THEN** 适配器优先调用该站点的 `/search.json`，并在无 Cookie 或搜索失败时按配置回退到公开话题扫描加本地过滤

### Requirement: Discourse authentication and failure handling

Discourse 适配器 SHALL 支持无认证、Cookie 和 Token 认证；遇到 403/429 时 MUST 给出区分“需要登录”“权限不足”“触发限流”的可操作错误；分类和标签信息 SHOULD 按站点缓存，避免重复请求。

#### Scenario: Cloudflare or login wall

- **WHEN** Discourse 返回 403
- **THEN** 任务提示检查 Cookie、登录状态或代理，而不是把它当作普通网络错误

#### Scenario: Categories are cached per site

- **WHEN** 用户打开 macos.do 平台工作台的分类筛选
- **THEN** 系统返回该站点的分类缓存；缓存缺失时才请求该站点的分类接口

### Requirement: V2EX topic collection

`v2ex` 适配器 SHALL 支持最新、热门和指定节点的主题采集，接受 V2EX API 或 RSS 地址，支持分页和最大条数，并保存节点、作者、回复数、发布时间和规范链接。

#### Scenario: Collect node topics

- **WHEN** 规则类型为节点、值为 `programming`
- **THEN** 系统采集该节点的主题并按主题 ID 去重

#### Scenario: RSS fallback

- **WHEN** 配置的 V2EX API 返回非 JSON 或不可用，但返回了 RSS/Atom
- **THEN** 适配器解析 RSS 并继续入库，在运行详情中记录格式回退

### Requirement: V2EX keyword search

`v2ex` 适配器 SHALL 支持关键词搜索，优先使用可配置的站内或第三方搜索接口，支持结果分页和正文摘要；搜索接口不可用时 MUST 返回明确警告并允许回退到公开主题扫描加本地匹配。

#### Scenario: Search V2EX by keyword

- **WHEN** 规则关键词为 `独立开发`
- **THEN** 系统返回匹配主题，保存搜索命中的标题、摘要、作者和主题链接

#### Scenario: Search backend unavailable

- **WHEN** 搜索接口超时或返回错误
- **THEN** 任务按配置回退并记录警告，不把搜索失败误报为“没有结果”

### Requirement: Reddit public JSON collection

`reddit` 适配器 SHALL 在无 OAuth 凭据时使用公开 JSON 接口，支持 subreddit 最新/热门、关键词搜索和用户投稿，使用 `after` 游标分页，并保存标题、正文、作者、subreddit、分数、评论数、flair 和 permalink。

#### Scenario: Collect subreddit posts

- **WHEN** 规则类型为 subreddit、值为 `programming`
- **THEN** 系统通过公开接口采集最新帖子，按帖子 fullname 去重并保存分页游标

#### Scenario: Public API rate limited

- **WHEN** Reddit 返回 429 或要求自定义 User-Agent
- **THEN** 任务按退避策略重试，并提示配置 OAuth 或检查 User-Agent

### Requirement: Reddit OAuth collection

`reddit` 适配器 SHALL 支持 OAuth app-only 凭据（client id / client secret），自动获取并缓存访问令牌，通过 `oauth.reddit.com` 采集；OAuth 失败且允许回退时 MUST 使用公开接口并记录降级原因。

#### Scenario: Use OAuth when configured

- **WHEN** 来源配置了有效的 client id 和 client secret
- **THEN** 适配器先获取 app-only token，再通过 OAuth 域名采集，并在认证状态中显示已配置

#### Scenario: OAuth failure falls back

- **WHEN** OAuth 凭据失效但公开接口可用
- **THEN** 本次采集使用公开接口完成，运行详情标记 OAuth 失败和公开降级

### Requirement: Forum rule kinds and local filtering

论坛适配器 SHALL 支持 `full`、`keyword`/`search`、`category`、`tag`、`node`、`account` 和 `subreddit` 规则类型；平台查询负责“采什么”，统一匹配条件负责“留什么”，两者 MUST 可同时使用。

#### Scenario: Query then filter

- **WHEN** 规则采集 `linux.do` 最新话题，同时配置排除词 `招聘`
- **THEN** 适配器采集最新话题，匹配器过滤招聘类内容后再入库和通知

#### Scenario: Unsupported rule kind

- **WHEN** 用户给 V2EX 来源创建 `subreddit` 规则
- **THEN** 保存时返回 400 并列出该平台支持的规则类型
