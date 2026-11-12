# collection-matching Specification

## Purpose

定义采集内容的统一命中规则，让同一套条件可以过滤不同平台的内容，并明确关键词、账号、正则、包含与排除条件的行为。

## Requirements

### Requirement: Match condition model

采集规则 SHALL 支持 `includeAny`、`includeAll`、`excludeAny`、`regex`、`authors`、`tags`、`requireMedia`、`caseSensitive` 和 `wholeWord` 条件；来源配置 MAY 提供默认匹配条件，规则级条件 MUST 覆盖同名字段。

#### Scenario: Rule inherits and overrides source defaults

- **WHEN** 来源默认排除词为 `spam`，某条规则把 `excludeAny` 设为 `广告`
- **THEN** 该规则使用 `广告` 作为排除词，其他未覆盖的默认条件继续生效

#### Scenario: No match conditions accepts everything

- **WHEN** 规则未配置任何匹配条件
- **THEN** 适配器返回的全部内容都进入入库流程，行为与现有规则一致

### Requirement: Keyword matching

关键词匹配 SHALL 在标题、正文、摘要、作者、标签和平台关键词字段中进行，MUST 先做 Unicode NFKC 规范化和大小写折叠；中文等无空格文本 MUST 使用子串匹配，拉丁文本 MAY 启用全词匹配。

#### Scenario: Case-insensitive keyword hit

- **WHEN** 规则关键词为 `Agent`，内容标题为 `Building an autonomous agent`
- **THEN** 该内容命中规则

#### Scenario: Chinese substring hit

- **WHEN** 规则关键词为 `大模型`，内容正文包含 `开源大模型发布`
- **THEN** 该内容命中规则，不要求空格分词

#### Scenario: Whole-word mode avoids partial hits

- **WHEN** 规则启用 `wholeWord`，关键词为 `AI`
- **THEN** `AI safety` 命中，而 `said` 或 `email` 不命中

### Requirement: Account and author matching

账号条件 SHALL 去掉用户名前缀 `@` 后比较，支持精确匹配和包含匹配，且 MUST 大小写不敏感；多条作者条件之间为“任一命中”。

#### Scenario: Match monitored account

- **WHEN** 规则作者条件为 `@karpathy`，内容作者为 `karpathy`
- **THEN** 该内容命中

#### Scenario: Reject different author

- **WHEN** 规则作者条件为精确匹配 `sama`，内容作者为 `sama_fan`
- **THEN** 该内容不命中

### Requirement: Regular expression matching

正则条件 SHALL 在保存规则时编译校验，支持 `i`、`m`、`u` 标志；非法表达式、超长表达式或过多表达式 MUST 被拒绝并返回可读错误。

#### Scenario: Valid regex filters content

- **WHEN** 规则正则条件为 `\bGPT-?[45]\b` 且内容包含 `GPT-5 released`
- **THEN** 该内容命中

#### Scenario: Invalid regex rejected

- **WHEN** 用户保存 `[unclosed` 作为正则条件
- **THEN** 系统返回 400，指出正则无效，且规则不被保存

### Requirement: Exclusion precedence

排除条件 SHALL 优先于包含条件；任一排除条件命中时内容 MUST 被过滤，即使同时满足包含条件；包含条件为空时只应用排除条件。

#### Scenario: Exclude wins over include

- **WHEN** 内容同时命中包含词 `AI` 和排除词 `招聘`
- **THEN** 该内容被过滤，不写入内容库，也不产生通知

#### Scenario: Exclude-only rule

- **WHEN** 规则只配置排除词 `抽奖`
- **THEN** 除包含 `抽奖` 的内容外，其余内容全部通过

### Requirement: Match observability

系统 SHALL 在运行结果中记录通过匹配和因匹配被过滤的条目数量；被过滤内容 MUST NOT 写入内容库或产生通知。

#### Scenario: Run reports filtered count

- **WHEN** 一次采集返回 100 条内容，其中 30 条被匹配条件过滤
- **THEN** 运行详情显示采集 100 条、入库 70 条、过滤 30 条和使用的匹配条件摘要
