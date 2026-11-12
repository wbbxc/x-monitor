# Proposal

## Why

现有采集内核已经具备统一的适配器契约、SQLite 规则/任务/游标和平台工作台，但只覆盖 Web 关键词、Google News、arXiv、Hugging Face Daily Papers、linux.do、V2EX 和通用 Telegram feed。平台形态、查询方式、认证方式和内容结构各不相同，用户无法用一个入口持续监控 X、Google 网页搜索、hf-mirror、macos.do、Reddit、Discord、GitHub、Telegram 频道等来源，也缺少统一的命中规则和站内通知。

本次变更把“能接几个站”升级为“按同一套规则接入大部分站”：以来源 + 规则描述“采什么”，以匹配器描述“留什么”，以通知中心描述“提醒什么”，并为指定平台提供可用的认证接入与公开降级路径。

## What Changes

- **通用采集模型扩展**：规则新增 `options`（平台查询参数）和 `match`（命中过滤），新增 `notify` 开关；适配器对外暴露规则类型、配置示例和认证字段提示；新增 URL 识别/探测接口，粘贴链接即可推荐平台、模式和配置。
- **统一匹配器**：支持关键词包含、全词匹配、包含全部/任一、排除词、正则、作者/账号、标签和媒体条件；规则级匹配覆盖来源级默认值；保留现有 `kind=keyword|account|full` 行为。
- **站内通知中心**：新采集且命中规则的条目写入通知表；顶栏铃铛展示未读数，通知列表支持单条/全部已读、按平台筛选和跳转内容详情。仅站内通知，不引入外部推送通道。
- **新增/增强平台适配器**：
  - `x`：复用现有 twscrape 账号/Cookie，支持监控账号时间线和关键词搜索。
  - `google`：Google News RSS 默认可用，Google Custom Search JSON API 支持网页搜索与 `site:` 整站搜索。
  - `arxiv`：支持分页、日期/分类查询和镜像地址。
  - `huggingface`：支持 `huggingface.co` 与 `hf-mirror.com` 镜像、Daily Papers 全量分页和关键词搜索。
  - `macos.do`：与 linux.do 共用 Discourse 适配能力，支持最新、分类、标签和站内搜索。
  - `reddit`：公开 JSON 降级 + OAuth app-only 接入，支持 subreddit、账号、关键词和分页。
  - `discord`：Bot Token 读取频道消息与搜索，支持 guild/channel 级规则；无 Token 时仅做邀请信息探测并明确告警。
  - `telegram`：支持 `t.me/s/` 公开频道预览、Bot Token 和可选 MTProto（api_id/api_hash），提供频道可访问性检测。
  - `v2ex`：支持节点、主题分页和关键词搜索。
  - `web`：通用站点采集支持 RSS/Atom/JSON、站点搜索模板分页、列表页全量快照、sitemap 和详情补全；无站点搜索模板时回退 Google/Bing `site:` 搜索。
- **平台工作台适配**：规则表单按适配器的规则类型渲染，新增匹配条件与通知开关；采集设置页支持平台识别、配置示例和认证类型提示；平台卡片自动展示新增平台。
- **文档与测试**：补充各平台凭据获取、配置示例、降级行为和限流说明；新增适配器 fixture、匹配器、通知 API、迁移和端到端采集测试。
- **BREAKING**：无。现有平台 ID、规则和采集数据保持兼容；新字段均有默认值，旧规则继续按原语义工作。

## Capabilities

### New Capabilities

- `collection-kernel`: 通用来源/规则模型、适配器元数据、URL 识别、认证与公开降级、分页游标和任务调度契约。
- `collection-matching`: 采集内容的统一命中规则，包括关键词、账号、正则、包含/排除、标签和媒体条件。
- `collection-notifications`: 站内通知的生成、未读状态、列表查询和已读操作。
- `collectors/x`: X 账号时间线与关键词搜索采集。
- `collectors/web-search`: Google 网页搜索和通用网站的关键词搜索/全量快照采集。
- `collectors/academic`: arXiv 与 Hugging Face / hf-mirror 论文采集。
- `collectors/forums`: linux.do、macos.do 等 Discourse 站点、V2EX 与 Reddit 的论坛内容采集。
- `collectors/github`: GitHub 仓库 Releases/Tags、Issues、Pull Requests、Discussions 更新采集。
- `collectors/chat`: Discord 频道和 Telegram 频道/群的社区内容采集与频道检测。

### Modified Capabilities

无。当前仓库尚未建立主 specs，本次变更以新能力形式建立采集领域的行为契约。

## Impact

- **代码**：`src/collectors/`（适配器、匹配器、契约、Registry、上下文）、`src/db.js`（规则字段与通知表）、`src/collection-engine.js`、`src/server.js`、`src/config.js`、`web/app.js`、`web/index.html`、`web/style.css`、`python/worker.py`（X 搜索）、可选的 `python/telegram_worker.py`。
- **API**：新增 URL 探测与通知接口；`/api/collections/rules` 接受 `match`、`options`、`notify`；`/api/collections/sources` 支持平台别名与更多认证类型。
- **数据**：`collection_rules` 新增 `match_json`、`options_json`、`notify`；新增 `collection_notifications` 表；旧数据无需回填即可运行。
- **依赖**：核心仍为零 npm 依赖；X 依赖现有 Python/twscrape；MTProto 为可选 Python 依赖（Telethon），未安装时自动降级为公开预览/Bot 模式。
- **安全与合规**：采集设置中的认证继续加密存储，X 复用权限受限的 `python/accounts.json`；匿名降级只访问公开页面；站点全量采集默认遵守 robots.txt、限速并支持排除路径；不实现验证码绕过、自建 Discord 用户令牌或未授权私域抓取。
- **非目标**：外部 Webhook/邮件/Telegram 推送、LLM 分析采集内容、评论区完整抓取、历史全量回填、分布式多机 Worker、X 官方 API OAuth 登录流程。
