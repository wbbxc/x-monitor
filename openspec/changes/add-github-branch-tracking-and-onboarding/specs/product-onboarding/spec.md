# Spec Delta

## Purpose

让第一次接触采集器的用户能在应用内完成“选目标、填最少信息、创建来源和规则、试跑、看结果”，不必先读完整 README、理解内部数据模型或手写 JSON。

## ADDED Requirements

### Requirement: First-run quick start wizard

系统 SHALL 在首次使用时提供三步快速开始向导：选择目标、填写最少信息、确认并试跑。向导 MUST 支持 GitHub 分支代码、arXiv 论文、Google 关键词（全网）和 Reddit 社区四类目标，并在确认前展示将要创建的来源与规则。

#### Scenario: Create GitHub branch tracking from the wizard

- **WHEN** 用户选择“GitHub 分支代码”，填写 `openai/openai-node` 并确认
- **THEN** 向导创建 GitHub 来源和仓库规则，规则包含 `branches` 事件与默认的代码改动采集，并可在确认页勾选立即试跑

#### Scenario: Missing required value

- **WHEN** 用户未填写仓库、关键词或 subreddit 就点击下一步
- **THEN** 向导在当前步骤显示具体字段错误，不创建来源或规则，也不跳转到下一步

#### Scenario: Partial creation failure

- **WHEN** 来源创建成功但规则创建失败
- **THEN** 向导保留已填内容，标明“来源已创建、规则未创建”，并提供重试创建规则或返回来源设置的入口

#### Scenario: Cancel without writing

- **WHEN** 用户在确认前关闭向导
- **THEN** 不创建任何来源或规则；已填写内容只保留在当前会话，不写入数据库

### Requirement: Guided dashboard checklist

仪表盘 SHALL 展示“开始使用”任务清单，覆盖配置 LLM、添加采集来源、创建规则、运行采集和查看通知五个步骤；每一步 MUST 显示完成状态和下一步操作，全部完成后清单 MAY 收起。清单 MUST 提供进入快速开始向导的入口。

#### Scenario: First visit with no sources

- **WHEN** 用户第一次打开仪表盘且没有采集来源
- **THEN** 清单高亮“添加采集来源”，提供“快速开始”和“去来源与规则”两个入口，并说明来源和规则的区别

#### Scenario: Step completion advances

- **WHEN** 用户完成配置 LLM 并保存
- **THEN** 下一次刷新后该步骤显示完成，下一步切换到“添加采集来源”

#### Scenario: All steps complete

- **WHEN** 五个步骤都已完成
- **THEN** 清单显示完成摘要并允许收起，不影响正常仪表盘内容

### Requirement: In-app usage guide

系统 SHALL 提供“使用指南”页面，包含产品用途、来源/规则/匹配/通知四个概念的通俗解释、三分钟上手步骤、平台选择表和常见问题；页面 MUST 可从主导航直接进入。

#### Scenario: Open guide from navigation

- **WHEN** 用户点击侧边栏“使用指南”
- **THEN** 页面展示可执行的配置步骤，并提供“快速开始”“去配置 LLM”“去来源与规则”“去采集”等跳转

#### Scenario: Choose a platform

- **WHEN** 用户想知道“监控 GitHub 分支代码该选哪个平台”
- **THEN** 平台选择表说明选择 GitHub、规则值填 `owner/repo`、勾选分支提交，并说明代码改动默认采集变更文件摘要与 patch

### Requirement: Recommended source templates

采集设置和快速开始 SHALL 共用至少四个模板：GitHub 发布与分支代码、arXiv 关键词、Google 关键词（全网）、Reddit 社区；选择模板 MUST 预填平台、名称、链接、推荐配置和推荐规则，并允许用户修改后再保存。

#### Scenario: Apply GitHub template

- **WHEN** 用户点击“GitHub 发布与分支代码”模板
- **THEN** 表单填入 `github` 平台、示例仓库、包含 releases / branches / 代码改动的配置，并提示将规则值改为实际仓库

#### Scenario: Apply Reddit template

- **WHEN** 用户点击“Reddit 社区”模板
- **THEN** 表单填入 `reddit` 平台和示例 subreddit，并提示公开 API 无需认证

### Requirement: Beginner-first navigation

侧边栏 SHALL 按“开始 / 内容 / 采集 / 系统”四组组织；首次使用 MUST 直接看到仪表盘、使用指南、采集、来源与规则和设置。linux.do 快捷入口 MUST 从主导航移除，但 linux.do 仍可从“采集”进入。

#### Scenario: First visit navigation

- **WHEN** 用户第一次打开应用
- **THEN** 侧边栏显示四组导航，不显示 linux.do 快捷项，“使用指南”位于“开始”组

#### Scenario: Reach linux.do

- **WHEN** 用户在“采集”页选择 linux.do
- **THEN** 进入 linux.do 采集详情，功能和路由保持不变

### Requirement: Advanced options disclosure

高级 JSON、匹配条件和低频限制项 MUST 默认收起；页面 SHALL 提供“显示高级选项”开关，用户开启后才显示完整字段。常用 GitHub 任务 MUST 不依赖该开关。

#### Scenario: Beginner creates GitHub rule

- **WHEN** 用户未开启“显示高级选项”
- **THEN** 只显示来源、规则名称、规则类型、分支、监控内容和通知等常用字段，不显示 JSON 文本框

#### Scenario: Advanced user opens options

- **WHEN** 用户开启“显示高级选项”
- **THEN** 展开查询选项 JSON、匹配条件 JSON 和补丁限制字段，并保留已填写的快捷字段值

### Requirement: Actionable empty states

无来源、无规则、无内容和无通知时，界面 MUST 说明“为什么为空”和“下一步做什么”，并提供直达操作的按钮，而不是只显示“暂无”。

#### Scenario: Empty platform workbench

- **WHEN** 平台还没有采集源
- **THEN** 内容区显示“先添加来源”说明和“打开来源与规则”按钮

#### Scenario: Empty rule list

- **WHEN** 来源已存在但还没有规则
- **THEN** 规则区显示推荐规则模板和“新建规则”表单，并解释“规则决定采集什么”

### Requirement: GitHub quick rule fields

GitHub 规则表单 SHALL 提供“监控内容”复选组、“监控分支”输入、“采集代码改动”开关和“包含 merge commit”开关，使用户无需手写 JSON 即可开启分支代码采集；分支留空 MUST 表示默认分支。

#### Scenario: Select branches and code changes without JSON

- **WHEN** 用户勾选“分支提交”、填写 `main, dev` 并保留“采集代码改动”开启
- **THEN** 保存的规则 `options.events` 包含 `branches`，`options.branches` 为 `["main","dev"]`，`options.includeCodeChanges` 为 true

#### Scenario: Keep default branch

- **WHEN** 用户勾选“分支提交”但分支输入留空
- **THEN** 规则保存后由适配器采集仓库默认分支

#### Scenario: Disable code changes

- **WHEN** 用户关闭“采集代码改动”
- **THEN** 规则保存后 `options.includeCodeChanges` 为 false，采集只保留提交信息，不请求单提交详情

### Requirement: Plain-language terminology

采集相关页面 SHALL 在首次出现时用一句话解释“来源、规则、匹配条件、通知”的含义，并统一使用“采集”“来源与规则”“采集详情”等术语；JSON 高级项 MUST 放在折叠区。

#### Scenario: Explain concepts in settings

- **WHEN** 用户打开来源与规则
- **THEN** 页面说明“来源=从哪里采，规则=采什么，匹配=留下什么，通知=提醒什么”

#### Scenario: Avoid raw JSON for common GitHub task

- **WHEN** 用户只想监控 GitHub 仓库的发布和分支代码
- **THEN** 通过复选组、分支输入和代码改动开关即可完成，不需要打开高级选项
