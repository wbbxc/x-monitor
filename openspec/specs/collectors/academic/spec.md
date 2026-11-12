# collectors/academic Specification

## Purpose

定义 arXiv 与 Hugging Face Daily Papers 的学术内容采集，支持分页全量同步、关键词筛选和 hf-mirror 镜像访问，并把论文归一化为统一内容模型。

## Requirements

### Requirement: arXiv query collection

`arxiv` 适配器 SHALL 支持关键词、作者、分类和组合查询，支持排序方式、最大结果数和查询前缀；结果 MUST 解析 Atom 中的标题、摘要、作者、发布时间、arXiv ID 以及 abs/pdf 链接。

#### Scenario: Search recent papers

- **WHEN** 规则关键词为 `large language model`，排序为 `submittedDate`
- **THEN** 系统返回最新提交的匹配论文，并按 arXiv ID 幂等入库

#### Scenario: Author or category query

- **WHEN** 规则使用 `au:` 作者前缀或 `cat:` 分类前缀
- **THEN** 适配器把查询原样传给 arXiv API，并在运行详情中记录最终查询表达式

### Requirement: arXiv pagination and rate limit

`arxiv` 适配器 SHALL 支持 `start`/`max_results` 分页和全量同步上限；请求 MUST 遵守 arXiv 的访问频率要求，连续请求之间保持间隔，并支持配置镜像 API 地址。

#### Scenario: Paginated full sync

- **WHEN** 来源配置最大结果数 500、每页 100
- **THEN** 适配器逐页推进 `start`，直到达到上限或无更多结果，并保存下一页游标

#### Scenario: Rate limit response

- **WHEN** arXiv 返回 429 或要求稍后重试
- **THEN** 任务按退避策略重试，不立即重复请求

### Requirement: Hugging Face Daily Papers sync

`huggingface` 适配器 SHALL 通过 Daily Papers API 分页同步论文，优先跟随 `Link: rel="next"`，在没有该响应头时按页大小推断下一页；支持页大小、最大页数和中断后从游标恢复。

#### Scenario: Follow Link header

- **WHEN** 第一页响应包含 `Link: rel="next"`
- **THEN** 适配器请求该链接继续同步，直到没有 next 或达到最大页数

#### Scenario: Resume after interruption

- **WHEN** 同步在某一页后中断
- **THEN** 下次运行从已提交的下一页游标继续，而不是重复已完成页面

### Requirement: Hugging Face mirror support

`huggingface` 适配器 SHALL 支持 `baseUrl` 配置，以 `https://huggingface.co` 或 `https://hf-mirror.com` 作为 API 与论文链接的基础地址；镜像不可用且允许回退时 MUST 切换到官方地址并记录警告。

#### Scenario: Collect through hf-mirror

- **WHEN** 来源配置 `baseUrl=https://hf-mirror.com`
- **THEN** API 请求和论文规范链接都使用 hf-mirror 地址

#### Scenario: Mirror failure falls back

- **WHEN** hf-mirror 请求失败而官方地址可访问
- **THEN** 本次采集使用官方地址完成，运行详情标记镜像回退和原因

### Requirement: Academic normalization and filtering

论文 MUST 归一化为统一内容模型，保留标题、摘要、AI 摘要、作者、关键词、发布时间、点赞/评论数、GitHub/项目/缩略图链接和原始 JSON；关键词与作者筛选 SHALL 复用统一匹配器在本地执行。

#### Scenario: Normalize paper metadata

- **WHEN** Daily Papers 返回包含 `ai_keywords`、`githubRepo` 和 `upvotes` 的记录
- **THEN** 内容记录包含对应元数据和可用链接，去重键基于论文 ID

#### Scenario: Local keyword filter

- **WHEN** 来源规则匹配词为 `agent`，同步到一篇标题含 `Agent` 的论文
- **THEN** 该论文入库；不匹配的论文被过滤并在运行详情中计数
