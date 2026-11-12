# Spec Delta

## Purpose

定义 Google 搜索与通用网站采集：既支持关键词搜索翻页，也支持指定站点的列表全量快照、站点地图和详情补全，为未知站点提供统一的兜底采集能力。

## ADDED Requirements

### Requirement: Google News RSS provider

`google` 适配器 SHALL 在没有额外凭据时使用 Google News RSS 完成关键词采集，支持语言、地区和关键词模板，并按规范 URL 与“标题 + 日期”双重去重。

#### Scenario: Default Google keyword collection

- **WHEN** 用户创建关键词规则且未配置 Google API 凭据
- **THEN** 系统通过 Google News RSS 返回结果，并在运行详情中标记提供方为 `google_news`

#### Scenario: Duplicate story from multiple providers

- **WHEN** 同一新闻同时出现在 Google News 和 Bing News 的结果中
- **THEN** 只保留一条内容记录，并合并两个提供方的原始快照

### Requirement: Google Custom Search provider

`google` 适配器 SHALL 支持 Google Custom Search JSON API，使用加密保存的 API Key 与搜索引擎 ID，支持 `site:` 限定、结果数量、分页起始位置、日期范围和 safe search；配额耗尽或鉴权失败 MUST 返回可操作的错误。

#### Scenario: Site-restricted web search

- **WHEN** 规则关键词为 `AI`、平台配置限定站点 `example.com`，且 CSE 凭据有效
- **THEN** 系统返回该站点下的网页结果，并按 `start` 参数翻页直到达到上限

#### Scenario: CSE quota exceeded

- **WHEN** Google 返回配额耗尽或 403
- **THEN** 任务标记为失败或降级，并提示检查配额、API Key 和搜索引擎 ID

### Requirement: Provider fallback and provenance

当首选 Google 提供方不可用时，适配器 SHALL 按配置回退到 Google News/Bing News 的 `site:` 搜索或其他可用提供方；回退 MUST 在运行详情中记录原因和实际提供方，不得静默改变语义。

#### Scenario: Fallback after CSE failure

- **WHEN** CSE 请求失败但新闻 RSS 可用
- **THEN** 采集继续执行并返回结果，运行详情标记 `degraded=true` 和回退原因

#### Scenario: No provider can serve the query

- **WHEN** 所有提供方都失败或返回空结果
- **THEN** 任务给出明确状态和每个提供方的失败摘要，而不是只返回空列表

### Requirement: Site keyword search

`web` 适配器 SHALL 支持站点搜索模式：用包含 `{query}` 和可选 `{page}` 的搜索模板发起请求，按配置翻页并提取结果链接；未配置站点搜索模板时 MAY 回退到 Google/Bing 的 `site:` 搜索。

#### Scenario: Search a site with its own endpoint

- **WHEN** 来源配置了 `https://example.com/search?q={query}&page={page}` 和结果链接规则
- **THEN** 系统逐页采集搜索结果，去重后写入内容库，并可选择抓取每条结果的详情页

#### Scenario: Pagination ends

- **WHEN** 下一页没有新结果、达到最大页数或返回空页
- **THEN** 本次采集正常结束，游标和已采集数量被记录

### Requirement: Full listing and sitemap snapshot

`web` 适配器 SHALL 支持列表页全量快照：用 `{page}` 模板或“下一页”链接遍历列表，按链接包含/排除规则提取条目，支持最大页数、连续无新内容停止和 sitemap 模式。

#### Scenario: Full listing pagination

- **WHEN** 来源配置列表模板、最大 50 页和“连续 2 页无新内容停止”
- **THEN** 系统遍历列表直到满足停止条件，所有条目按规范 URL 幂等入库

#### Scenario: Sitemap collection

- **WHEN** 来源配置 sitemap 地址或允许自动发现 `/sitemap.xml`
- **THEN** 系统解析其中的 URL，按包含/排除规则筛选后采集条目

### Requirement: Article extraction and safety

通用网页采集 SHALL 优先从 JSON-LD、OpenGraph、`article`/`main` 区域提取标题、正文、作者、发布时间和规范链接；提取失败时 MUST 回退到列表页摘要并保留原始 HTML。采集 MUST 遵守 robots.txt、限制请求频率并拒绝非 HTTP(S)、登录/登出和明显无关的链接。

#### Scenario: Extract structured article

- **WHEN** 详情页包含 JSON-LD 的 `headline`、`datePublished` 和 `author`
- **THEN** 内容记录使用这些字段，并保留原始 HTML 快照

#### Scenario: Extraction falls back gracefully

- **WHEN** 详情页没有结构化数据且正文区域无法识别
- **THEN** 内容仍以列表页标题和摘要入库，标记字段不完整，不丢弃原始内容

#### Scenario: Robots disallows path

- **WHEN** robots.txt 禁止采集目标路径
- **THEN** 系统跳过该路径并在运行详情中记录跳过原因，不发起正文请求
