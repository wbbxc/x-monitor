# Tasks

## 1. 内核契约与数据迁移

- [x] 1.1 扩展 SQLite 迁移：为 `collection_rules` 增加 `options_json`、`match_json`、`notify`、`notify_updates`，为 `collection_runs` 增加 `filtered_count`，新增 `collection_notifications` 表与索引，并写入 schema version 2；用旧数据库副本启动验证迁移幂等且旧规则默认 `notify=0`。
- [x] 1.2 扩展适配器契约：新增 `ruleKinds`、`detect`、`publicFallback`、`authHints`，并在 `publicAdapter` 中安全暴露；运行契约单测，验证缺少 `collect`/`collectPages`、非法规则类型和非法认证类型都会被拒绝。
- [x] 1.3 新增 `fields` 认证类型：支持多字段凭据的校验、AES-256-GCM 加密、解密和 `buildAuthHeaders` 空头返回；用单测验证密文往返、非法字段名和日志脱敏。
- [x] 1.4 实现平台别名解析（`twitter`/`x.com`→`x`、`hf-mirror`→`huggingface`、`macosdo`→`macos.do`）并接入来源创建/查询，同时更新 server 与 collection-engine 的 URL 域名推断（x、github、reddit、discord、hf-mirror、macos.do、t.me）；用 API 单测验证存储为规范平台 ID。
- [x] 1.5 实现 `POST /api/collections/detect` 与适配器 `detect` 兜底链；用单测覆盖 x、github、hf-mirror、macos.do、t.me 和未知博客，验证无网络时也能返回建议，非法 URL 返回 400。
- [x] 1.6 更新现有适配器列表测试，断言新增平台条目和 `ruleKinds`；运行 `npm test`，确认旧 linux.do/V2EX/Telegram/web 测试仍通过。

## 2. 统一匹配器

- [x] 2.1 实现 `src/collectors/match.js`：关键词、包含全部/任一、排除、作者、标签、媒体、全词、大小写和正则编译；用单测覆盖中文子串、英文全词、`@` 作者归一化、排除优先和空条件放行。
- [x] 2.2 在规则保存路径校验 `match`：非法正则、超长表达式、过多表达式、未知字段返回 400；用 API 单测验证非法规则不落库。
- [x] 2.3 将匹配器接入 `createContext`、`createIngestor` 和 runner，入库前统一执行并累计 `filtered`；用集成测试验证适配器预过滤与入库前过滤结果一致、被过滤内容不入库不通知。
- [x] 2.4 保留 `matchesRule` 兼容导出，旧规则 `match_json={}` 继续按 kind/value 工作；用旧规则 fixture 验证行为不变。
- [x] 2.5 在运行详情和平台工作台返回并展示“采集 / 入库 / 过滤 / 不完整”；用 API 断言 `filtered_count` 和详情字段。

## 3. 站内通知中心

- [x] 3.1 实现 `collectionNotifications` 数据访问：创建、去重创建、列表/筛选、未读计数、单条已读、全部已读、按内容级联删除和过期清理；用单测覆盖幂等和未读计数。
- [x] 3.2 在入库事务内接入 `onItemSaved` 通知钩子：仅新内容 + 规则开启通知时创建，支持适配器 `metadata.notification` 的标题/事件/更新键；用单测验证重复采集不重复通知、关闭通知不生成、更新通知受 `notify_updates` 控制。
- [x] 3.3 新增通知 API：列表、未读数（含按平台分组）、单条已读、全部已读；用 HTTP 测试验证筛选、分页、404 和幂等。
- [x] 3.4 实现通知保留策略（已读过期清理、内容删除级联）并在启动维护中调用；用数据库测试验证未读不受清理影响。

## 4. 前端采集体验

- [x] 4.1 增加全局 topbar、通知铃铛、未读徽标和通知抽屉，接入 30 秒轮询、页面隐藏暂停、全部已读和点击跳转；手动加载页面验证徽标出现/消失、抽屉筛选和详情跳转。
- [x] 4.2 采集设置页接入平台识别：输入 URL 调用 detect，自动填充平台/名称/配置，展示 `configExample`、认证提示和 `fields` 认证类型；手动验证 x、github、hf-mirror、macos.do、t.me 五类链接。
- [x] 4.3 规则表单按适配器 `ruleKinds` 渲染类型和值占位符，新增 `options`、`match`、`notify`、`notifyUpdates` 字段并做 JSON 解析提示；手动创建 GitHub repo 规则和带排除词的 web 规则，确认 API 返回值回填正确。
- [x] 4.4 平台工作台适配新平台：补充平台标签、隐藏非 Discourse 的分类筛选和“最新话题”快捷行、修复重复的 `platformQueueList` id；手动检查 x/github/reddit/discord 工作台无残留 linux.do 控件。
- [x] 4.5 内容列表和详情展示提供方、采集模式、降级标记和 GitHub 事件类型；手动验证通知点击进入详情并高亮未读状态。
- [x] 4.6 补充 CSS：topbar、铃铛、抽屉、移动端和深色模式；手动在 1440px 和窄屏切换验证不遮挡页面头、不出现横向滚动。

## 5. X 采集

- [x] 5.1 扩展 `python/worker.py`：抽出登录复用逻辑，新增 `search` 子命令（query、per、type、min-likes、lang、since、until），并让 mock 模式按关键词过滤；运行 `python3 python/worker.py search --query agent --per 5 --mode mock` 验证输出 JSONL。
- [x] 5.2 新增 Python JSONL 桥 `src/collectors/python.js`，支持超时、abort、stderr 诊断和逐行解析；用假 Python 脚本单测成功、失败、超时和取消。
- [x] 5.3 实现 `x` 适配器：`account` 走 fetch、`keyword/search` 走 search，归一化推文、媒体、互动数据和规范链接；用固定 JSONL fixture 单测两种规则。
- [x] 5.4 实现 X 游标（`lastId`）、每轮上限、无账号错误、mock 标记和限流；用单测验证增量跳过旧推文、失败不推进游标。
- [x] 5.5 编写 `docs/collectors/x.md`：Cookie/密码、代理、mock 模式、限流和常见失败；按文档命令实际执行一次 mock 采集。

## 6. Google 与通用 Web

- [x] 6.1 拆分 `google.js`：Google News RSS 默认提供方、CSE（api key + cx）翻页、`site:`/日期/安全搜索和降级链；用 RSS/CSE fixture 单测提供方选择、去重和 degraded 标记。
- [x] 6.2 新增 `html.js`：链接提取、JSON-LD、OpenGraph、正文/作者/时间提取、sitemap 解析和基础 robots 解析；用 HTML fixture 单测各提取器和异常回退。
- [x] 6.3 扩展 `web` 适配器的 `search` 模式：搜索模板翻页、结果链接规则、详情补全、停止条件；用本地 HTML fixture 模拟两页结果并验证去重和上限。
- [x] 6.4 扩展 `web` 适配器的 `full`/`sitemap` 模式：列表模板或 next 链接、包含/排除规则、连续无新内容停止、sitemap index；用 fixture 验证全量快照和 robots 跳过。
- [x] 6.5 验证通用网页回退：结构化数据缺失时保留列表摘要和原始 HTML，字段不完整但内容不丢；用单测断言 `required_complete=false` 且正文非空。
- [x] 6.6 编写 `docs/collectors/google-web.md`：CSE 配置、`site:`、站点搜索模板、全量列表、sitemap、robots 与限速；按文档示例跑通一个本地 fixture。

## 7. 学术平台

- [x] 7.1 扩展 `arxiv`：`collectPages` 分页、`baseUrl` 镜像、游标、3 秒限流和空页清理；用 Atom fixture 单测两页增量与上限。
- [x] 7.2 扩展 `huggingface`：`baseUrl` 支持官方与 hf-mirror，API/论文链接重写，镜像失败回退官方并警告；用 fixture 单测两种 baseUrl 和回退。
- [x] 7.3 验证论文归一化和本地匹配：关键词/作者过滤、GitHub/项目/缩略图链接、去重键和元数据；用单测断言匹配与过滤计数。
- [x] 7.4 编写 `docs/collectors/academic.md`：arXiv 查询语法、HF Daily Papers、hf-mirror、分页上限和常见错误；按文档执行一次 mock/HTTP fixture 采集。

## 8. 论坛与社区

- [x] 8.1 将 linux.do 适配器抽成 `createDiscourseAdapter` 工厂并注册 `linux.do`、`macos.do`，保留现有导出兼容；用现有 linux.do 测试和新增 macos.do fixture 验证 latest/search/分类/详情。
- [x] 8.2 扩展分类 API 和缓存为按 Discourse 平台隔离；用 API 测试验证 macos.do 分类不会命中 linux.do 缓存。
- [x] 8.3 扩展 `v2ex`：节点规则、API/RSS 分页、sov2ex 搜索和失败回退；用 fixture 验证节点、搜索、RSS 回退和 degraded 标记。
- [x] 8.4 实现 `reddit`：公开 JSON（subreddit/搜索/用户投稿、after 游标）、OAuth app-only token 缓存、公开降级、429 退避和内容归一化；用 fixture 单测两种认证路径和分页。
- [x] 8.5 编写 `docs/collectors/forums.md`：linux.do/macos.do 的 Cookie、V2EX 搜索后端、Reddit OAuth 创建步骤、限流和公开降级；按文档执行一次无凭据 Reddit/V2EX fixture 采集。

## 9. GitHub 采集

- [x] 9.1 实现 `github` 适配器的 `repo` 规则校验、URL 解析和事件选项（releases/issues/pulls/discussions、预发布、标签、状态）；用单测验证合法/非法仓库和选项。
- [x] 9.2 实现 Releases/Tags 采集、预发布过滤、资源链接和幂等键；用 REST fixture 单测新版本、预发布过滤和无 Release 回退 Tags。
- [x] 9.3 实现 Issues/PRs 增量采集：`since`、状态/标签过滤、Issue/PR 区分、更新合并；用 fixture 验证只请求增量并正确归类。
- [x] 9.4 实现 Discussions GraphQL：游标分页、无 Token 跳过并警告、有 Token 采集；用 GraphQL fixture 单测两种路径。
- [x] 9.5 实现 GitHub 游标、ETag/If-None-Match、304 处理、401/403/429 分类和限流推迟；用单测验证 304 不写内容、401 不重试。
- [x] 9.6 接入 GitHub 通知事件和 `notifyUpdates` 更新键；用集成测试验证新 Release 生成通知、状态变化默认不重复通知、开启后生成更新通知。
- [x] 9.7 编写 `docs/collectors/github.md`：Token 权限、事件选择、Discussions 限制、速率限制和通知配置；按文档用公开仓库和 fixture 各跑一次。

## 10. Discord 与 Telegram

- [x] 10.1 实现 Discord Bot 探活：校验 Token、服务器和频道访问、权限清单；用 mock HTTP 单测 401、403 和成功路径。
- [x] 10.2 实现 Discord 频道消息/线程/服务器搜索、`before` 游标和内容归一化；用 fixture 验证分页、附件、嵌入和去重。
- [x] 10.3 实现 Discord 无 Token 的邀请信息模式，并在消息模式下返回可操作错误；用单测验证两种模式的来源校验。
- [x] 10.4 实现 Telegram 频道识别：公开频道、公开预览、私有邀请、帖子链接和探活信息；用 HTML fixture 和 URL 表单测各类型。
- [x] 10.5 实现 Telegram 公开预览采集：消息解析、`before` 游标、媒体/链接/浏览数和去重；用 fixture 验证两页增量。
- [x] 10.6 实现 Telegram Bot 模式：`getChat` 检测、`getUpdates` 游标和 channel_post 归一化；用 mock 单测游标推进和重复更新跳过。
- [x] 10.7 实现可选 MTProto worker：Telethon 历史读取、凭据经 stdin、`min_id` 增量、未安装降级；用假 worker 单测成功和 `MTPROTO_UNAVAILABLE`，Telethon 缺失环境下手动验证降级。
- [x] 10.8 保留 Telegram JSON/RSS/Bot API feed 兼容并补充限流；用现有 feed 测试验证不迁移配置也能采集。
- [x] 10.9 编写 `docs/collectors/chat.md`：Discord Bot/Intent/权限、Telegram 公开预览/Bot/MTProto、隐私和限流；按文档执行一次公开预览 fixture 和一次 Bot mock。

## 11. 集成、文档与验收

- [x] 11.1 更新 `README.md`、`.env.example` 和 `docs/collectors/README.md` 索引，补充新平台、配置项、认证、降级和兼容说明；逐条执行文档中的命令，确保可复制运行。
- [x] 11.2 运行完整测试套件 `npm test` 并修复失败；确认测试不访问真实外网、不依赖真实凭据。
- [x] 11.3 启动服务做端到端冒烟：detect 五类链接 → 创建来源/规则 → 手动采集 → 查看内容/过滤计数 → 打开通知铃铛并已读 → 重启后游标继续；记录实际输出。
- [x] 11.4 安全验收：用 API 查询来源认证状态、运行日志和错误响应，确认没有 Cookie/Token/密码原文；用 `git diff` 检查 `.env` 和 `data/` 未被提交。
- [x] 11.5 兼容验收：用迁移前数据库副本启动，确认旧来源、旧规则、旧 feed 来源可查询和手动采集；确认通知默认关闭不产生历史洪泛。
- [x] 11.6 并发与限流验收：以默认并发 3 同时触发多个平台任务，确认无 SQLite busy、无未处理 Promise 拒绝、429 规则被推迟；检查队列和运行记录。

## Workflow follow-up

- 在实现和验收完成后，运行 `/openspec-archive-change` 归档本变更。
- 归档后检查 `openspec/specs/` 下的新能力 spec 和 `openspec/changes/archive/` 中的变更副本完整。
