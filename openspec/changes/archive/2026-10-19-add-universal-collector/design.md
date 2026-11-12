# Design

## Context

现有采集内核已经具备适配器契约 v2（`collect` 或 `collectPages`）、注册表、SQLite 任务队列、规则调度、加密认证、限流/冷却、分页游标和统一内容模型。当前内置适配器为 `web`、`google`（Google News 别名）、`arxiv`、`huggingface`、`linux.do`、`v2ex`、`telegram`，规则只有 `kind` + `value`，过滤逻辑分散在各适配器内，且没有通知能力。

本次设计在现有内核上扩展，而不是新建第二套框架。需求见 `proposal.md`，行为契约见 `specs/`。现有平台 ID、数据表和接口必须继续可用。

## Goals / Non-Goals

**Goals:**

- 用一套 `kind + options + match + notify` 模型表达“采什么、留什么、提醒什么”。
- 让新增平台只需实现适配器差异，复用任务、限流、游标、去重、认证、通知和 UI。
- 为每个平台提供“有凭据走官方接口、无凭据走公开降级”的可预测路径。
- 让通用 `web` 适配器覆盖大部分无专属适配器的站点：RSS/JSON、站点搜索、列表全量、sitemap、详情补全。
- 保持零 npm 依赖；可选 Python 能力（X、Telegram MTProto）缺失时明确降级。

**Non-Goals:**

- 不实现外部通知通道（Webhook、邮件、Telegram Bot 推送）。
- 不实现验证码绕过、Cloudflare 绕过、Discord self-bot、未授权私域抓取。
- 不实现评论/回复树的完整抓取；只采集内容主体和可配置的详情。
- 不实现分布式 Worker、代理池、浏览器渲染集群。
- 不改变现有 X 业务流水线（抓取 → LLM 分析 → 素材库 → 创作），采集内容仍独立存放在 `collection_*` 表。

## Decisions

### 1. 继续使用适配器契约 v2，扩展元数据而不是更换框架

保留 `validateAdapter`、`registerAdapter`、`collect`/`collectPages`、`createContext`、`executeJob` 的主干。契约新增可选的：

- `ruleKinds`: `[{ kind, label, requiresValue, valuePlaceholder, optionsExample }]`，供 UI 渲染规则类型和示例。
- `detect(url)`: 纯函数，返回 `{ platform, kind, value, config, name, confidence, warnings }`，用于链接识别；不发网络请求。
- `probe` / `validateSource` / `validateRule`: 继续负责连通性和保存前校验。
- `publicFallback`: `boolean` 或简短说明，供 UI 提示无凭据时的行为。

`publicAdapter()` 只暴露上述元数据和认证类型，不暴露函数或密钥。别名在注册表层统一解析：`twitter`/`x.com` → `x`，`hf-mirror` → `huggingface`，`macosdo` → `macos.do`，`discourse` → 对应站点由 URL 决定。存储时只写规范 ID。

**替代方案**：为每个平台写独立页面和 API（现状的 linux.do 模式）。放弃，因为会重复任务、调度、认证和通知逻辑。

### 2. 规则模型：查询与过滤分离

`collection_rules` 增加列（全部有默认值，幂等迁移）：

```sql
ALTER TABLE collection_rules ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE collection_rules ADD COLUMN match_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE collection_rules ADD COLUMN notify INTEGER NOT NULL DEFAULT 1;
ALTER TABLE collection_rules ADD COLUMN notify_updates INTEGER NOT NULL DEFAULT 0;
```

语义：

- `kind` + `value` + `options_json`：告诉适配器“采什么”。例如 GitHub `repo` + `{"events":["releases","pulls"]}`，Discord `channel` + `{"channelId":"123"}`。
- `match_json`：告诉统一匹配器“留什么”。例如 `{"includeAny":["agent","大模型"],"excludeAny":["招聘"],"regex":["\\bGPT-?[45]\\b"]}`。
- `notify`：新内容首次入库时是否生成通知；`notify_updates`：已有内容发生状态变化时是否再通知（默认关闭）。

规则保存时，适配器 `validateRule` 校验 `kind` 与 `options`，匹配器校验 `match`。旧规则 `options_json={}`、`match_json={}`，行为与现在一致（keyword/account/full 的本地包含匹配）。

**替代方案**：把查询参数塞进 `value` 的 JSON 字符串。放弃，因为不可查询、UI 难校验、与现有 UNIQUE 约束冲突。

### 3. 统一匹配器：纯函数、编译一次、入库前强制执行

新增 `src/collectors/match.js`：

```js
compileMatcher({ match, defaults, rule })
  -> { predicate(item), summary(), validate() }
```

规则：

- 文本先做 Unicode NFKC、大小写折叠、空白折叠。
- 字段集合：`title`、`content`、`summary`、`author`、`metadata.keywords`、`metadata.tags`、`metadata.category`。
- `includeAny` 任一命中；`includeAll` 全部命中；`excludeAny` 任一命中即拒绝；`regex` 任一命中（`i/m/u`）；`authors` 去掉 `@` 后比较；`tags` 比较标签；`requireMedia` 要求 `metadata.media` 非空。
- 中文按子串；拉丁文本启用 `wholeWord` 时使用 `(?<![\p{L}\p{N}])...` 边界。
- 空 `match` 接受全部。
- 正则限制：单条 ≤ 200 字符、最多 20 条、待匹配文本截断到 20,000 字符；保存时编译失败返回 400。这不能完全消除 ReDoS，但能把风险限制在本地工具的可接受范围。

集成方式：

- `createContext` 增加 `ctx.matches(item)` 和 `ctx.matcher`。
- 适配器可以在翻页/抓详情前用 `ctx.matches` 预过滤，减少请求。
- `createIngestor` 在写库前再次执行 `ctx.matches`，保证所有适配器行为一致；被过滤条目不写库、不通知，计数为 `filtered`。
- `collection_runs` 增加 `filtered_count`，运行详情展示“采集 / 入库 / 过滤 / 不完整”。

**替代方案**：继续在每个适配器里各写一份 `matchesRule`。放弃，因为规则语义会漂移，无法统一通知和统计。

### 4. 通知中心：入库事务内写通知，站内轮询

新增表：

```sql
CREATE TABLE collection_notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key  TEXT NOT NULL UNIQUE,
  item_id     INTEGER NOT NULL REFERENCES collection_items(id) ON DELETE CASCADE,
  source_id   INTEGER REFERENCES collection_sources(id) ON DELETE SET NULL,
  rule_id     INTEGER REFERENCES collection_rules(id) ON DELETE SET NULL,
  platform    TEXT NOT NULL,
  source_name TEXT NOT NULL DEFAULT '',
  rule_name   TEXT NOT NULL DEFAULT '',
  event       TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  read_at     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_collection_notifications_unread
  ON collection_notifications(read_at, created_at DESC);
CREATE INDEX idx_collection_notifications_platform
  ON collection_notifications(platform, created_at DESC);
```

生成规则：

- `createIngestor` 新增 `onItemSaved({ item, saved, rule, source })` 回调，在同一 SQLite 事务内调用 `collectionNotifications.create()`。
- 仅当 `saved.isNew` 且规则 `notify=1` 时创建；通知键为 `item:<itemId>:rule:<ruleId>:<eventKey>`。
- GitHub 等适配器可在 `metadata.notification` 提供 `{ title, body, event, updateKey }`；当 `notify_updates=1` 且 `updateKey` 变化时创建更新通知。默认 `updateKey=''`，因此不会重复。
- 通知标题优先用适配器提供的 `metadata.notification.title`，否则用内容标题；正文截断到 500 字符。
- 删除内容时外键级联删除通知；保留策略删除超过 N 天的已读通知，未读不清理。

API：

- `GET /api/collections/notifications?platform=&unread=true&limit=&offset=`
- `GET /api/collections/notifications/unread-count` → `{ total, byPlatform }`
- `POST /api/collections/notifications/:id/read`
- `POST /api/collections/notifications/read-all`

UI：在 `.main` 顶部新增全局 topbar，右侧铃铛 + 未读徽标；点击打开右侧抽屉。抽屉支持“全部/未读”、按平台筛选、全部已读；点击通知先标记已读再跳转 `#/collections/<platform>/items/<id>`。前端每 30 秒轮询未读数，页面隐藏时暂停，操作后立即刷新。

**替代方案**：把未读状态放在 `collection_items.metadata`。放弃，因为同一内容可命中多条规则，且已读/删除/保留策略需要独立生命周期。

### 5. 认证：新增 `fields` 类型承载多字段凭据

现有 `none/cookie/bearer/token/api_key/basic/headers` 继续使用。新增：

```js
{ type: 'fields', fields: { clientId: '...', clientSecret: '...' } }
```

- `normalizeAuth` 校验字段名（`/^[a-zA-Z][a-zA-Z0-9_]*$/`）和字符串值，整体 AES-256-GCM 加密。
- `buildAuthHeaders` 对 `fields` 返回 `{}`，由适配器读取 `ctx.auth.fields` 自行构造请求。
- 契约的 `AUTH_TYPES` 增加 `fields`；UI 认证类型下拉增加“多字段凭据（JSON）”。
- 适配器映射：
  - Reddit：`fields.clientId` + `fields.clientSecret`（app-only OAuth）。
  - Telegram MTProto：`fields.apiId` + `fields.apiHash` + 可选 `fields.session`。
  - Google CSE：`api_key` 存 API Key，`cx` 非密钥放来源 `config`。
  - Discord/GitHub：`token`，适配器按需加 `Bot ` 前缀。
  - X：继续复用 `python/accounts.json`，不改动现有凭据文件。

适配器可以读取 `ctx.auth` 自行构造请求头或查询参数：Google CSE 把 `api_key` 放到 `key` 查询参数，Discord 使用 `Authorization: Bot <token>`，GitHub 使用 `Bearer <token>`，Reddit 使用 Basic + `client_credentials`。`buildAuthHeaders` 只作为通用默认值，不强制所有平台使用同一套头。

**替代方案**：用 `basic` 的 username/password 冒充 client id/secret。放弃，语义混乱且 UI 无法提示字段。

### 6. 适配器矩阵

| 平台 | 文件 | 规则类型 | 认证 | 公开降级 |
|---|---|---|---|---|
| `x` | `collectors/x.js` + `python/worker.py` | `account`, `keyword`, `search` | 复用 `accounts.json`（Cookie/密码） | 无（必须登录）；`mock` 仅开发 |
| `google` | `collectors/google.js` | `keyword`, `site`, `full` | `api_key`（CSE） | Google News/Bing News RSS |
| `web` | `collectors/web.js` + `html.js` | `keyword`, `search`, `full`, `sitemap` | 任意请求头/Cookie | 站点自身公开页 |
| `arxiv` | `collectors/arxiv.js` | `keyword`, `author`, `category`, `full` | 无 | arXiv 公开 API |
| `huggingface` | `collectors/huggingface.js` | `full`, `keyword`（本地过滤） | `token` 可选 | 官方 / hf-mirror |
| `linux.do` | `collectors/discourse.js` | `full`, `keyword`, `category`, `tag` | Cookie/Token | 公开 latest/top 扫描 |
| `macos.do` | `collectors/discourse.js` | 同上 | Cookie/Token | 同上 |
| `v2ex` | `collectors/v2ex.js` | `full`, `node`, `keyword` | 无 | API/RSS + sov2ex 搜索 |
| `reddit` | `collectors/reddit.js` | `subreddit`, `account`, `keyword`, `full` | `fields`（OAuth） | 公开 JSON |
| `discord` | `collectors/discord.js` | `channel`, `guild`, `search` | `token`（Bot） | 仅邀请信息 |
| `telegram` | `collectors/telegram.js` + 可选 `python/telegram_worker.py` | `channel`, `keyword`, `feed`, `full` | `token`（Bot）或 `fields`（MTProto） | `t.me/s/` 公开预览 |
| `github` | `collectors/github.js` | `repo`, `search` | `token` 可选 | 公开 REST；Discussions 需 Token |

`web.js` 不再导出 `googleAdapter`；`google` 独立文件。`linuxdo.js` 保留兼容导出（`collectLinuxdo`、`fetchLinuxdoCategories`、`buildLinuxdoUrl`），内部改为调用 `discourse.js` 工厂，避免现有测试和 API 断裂。

### 7. X：Node 适配器 + Python JSONL 桥

新增 `src/collectors/python.js`：

- `runPythonJsonl({ script, args, input, timeoutMs, signal, env })`：spawn Python，读取 stdout 的逐行 JSON，收集 stderr 中以 `#` 开头的诊断；超时或 abort 时 kill 子进程。
- 不把 Cookie/Token 放到命令行参数；X 继续由 worker 读取 `accounts.json`。

`python/worker.py` 增加 `search` 子命令：

```
python3 worker.py search --query "AI agent" --per 50 --type latest --mode auto [--min-likes 10] [--lang en] [--since 2026-01-01]
```

- 复用现有登录逻辑（Cookie/密码/代理）。
- `search` 用 `api.search` 拉取，输出与 `fetch` 相同的 JSON 字段。
- mock 模式按关键词过滤 `mock_tweets.json`，保证离线测试可跑。
- 输出字段：`id`、`author_username`、`author_name`、`text`、`tweet_created_at`、互动数、`media`、`url`、`is_mock`。

`x` 适配器：

- `account` → `worker.py fetch --accounts <value>`；`keyword`/`search` → `worker.py search`。
- 来源配置：`mode`（auto/real/mock）、`perRun`、`searchType`、`minLikes`、`lang`、`since`、`until`、`proxy`（可选，透传 `X_PROXY` 环境变量）。
- 游标：`{ lastId }`；对结果按 ID 降序过滤 `id > lastId`，再按 `maxItems` 截断；失败不推进游标。
- 归一化：`external_id=tweet.id`，`canonical_url=https://x.com/<author>/status/<id>`，`metadata={likes,retweets,replies,views,media,isMock}`。
- 没有可用账号且非 mock：抛 `CollectorError('X 需要登录账号', { code:'AUTH_REQUIRED' })`，提示配置 Cookie/密码和代理。

**替代方案**：接入 X API v2 OAuth。放弃，因为需要额外开发者账号和付费额度；现有 twscrape 已能覆盖账号时间线和搜索。

### 8. Google 与通用 Web

`google.js` 采用 provider 链：

1. 配置了 `api_key + cx`：Google Custom Search JSON API，`start` 1..91 翻页，支持 `site:`、`dateRestrict`、`safe`。
2. 否则 Google News RSS（现有 `parseFeed`），可选 `site:` 和 `hl/gl/ceid`。
3. CSE 失败且允许回退：Bing News RSS `site:`，运行详情记录 `degraded`、`provider` 和原因。

`web.js` 支持三种来源模式（`config.mode`）：

- `feed`：RSS/Atom/JSON，沿用现有 `parseFeed` 和 JSON 数组解析。
- `search`：`searchUrlTemplate` 含 `{query}`/`{page}`；`resultLinkPattern` 或通用链接提取；`maxPages`、`pageStart`、`stopAfterSeenPages`；可选 `fetchDetails`。
- `full`：`listUrlTemplate` 含 `{page}`，或 `nextLinkPattern` 跟随下一页；`itemLinkIncludes`/`itemLinkExcludes` 过滤条目；`maxPages`；`sitemapUrl` 或自动 `/sitemap.xml`。

新增 `src/collectors/html.js`：

- `extractLinks(html, { pattern, include, exclude, baseUrl })`
- `extractJsonLd(html)`：支持 `@graph`、`Article`、`NewsArticle`、`BlogPosting`。
- `extractOpenGraph(html)`
- `extractArticleText(html)`：去 script/style/nav/footer，优先 `<article>`/`<main>`，否则取最长文本块。
- `parseSitemap(xml)`：`<url><loc>` 与 sitemap index。
- `parseRobots(text, ua)`：基础 `Disallow`/`Allow`/`Crawl-delay` 解析。

通用采集流程：列表页 → 提取链接 → 规范化去重 → 可选详情页 → `extractJsonLd`/OG/article → 归一化。详情失败保留列表摘要并标记 `required_complete=false`，原始 HTML 写入 `raw_json`。默认遵守 robots.txt，请求间隔 ≥ 1s/主机；`config.respectRobots=false` 不提供，避免误用。

**替代方案**：引入 `cheerio` 或 Playwright。放弃，前者破坏零依赖，后者部署成本高；先用可配置正则 + 结构化数据覆盖大部分站点，后续可插拔渲染器。

### 9. 学术平台

- `arxiv.js`：保留现有 `parseArxivFeed`；新增 `collectPages`，按 `start += pageSize` 翻页；`baseUrl` 可配置（默认 `https://export.arxiv.org/api/query`）；请求间隔 3s；游标 `{ start }`；到上限或空页清理游标。
- `huggingface.js`：`baseUrl` 支持 `https://huggingface.co` / `https://hf-mirror.com`；API 和论文链接都基于 `baseUrl`；现有 `Link: rel="next"` 逻辑保留；镜像失败且 `fallbackToOfficial !== false` 时切官方并警告；游标 `{ nextUrl }`。
- 关键词筛选统一走匹配器，不新增 HF 搜索接口，避免依赖未公开端点。

### 10. 论坛与社区

- `discourse.js` 工厂：`createDiscourseAdapter({ id, label, origin })`，复用现有 linux.do 的 latest/top/search/categories、RSS 兜底、详情补全、Cloudflare 错误描述和限流（1/5s）。注册 `linux.do` 与 `macos.do`；分类缓存按平台分文件（`data/collector/categories-<platform>.json`），API `GET /api/collections/categories?platform=` 不再只允许 linux.do。
- `v2ex.js`：保留 API/RSS；新增 `node` 规则（`/api/topics/show.json?node_name=` 或 RSS 节点页）；关键词搜索用 `https://www.sov2ex.com/api/search?q=&size=&from=`，失败时回退公开最新主题 + 本地匹配，并在 meta 标记 `degraded`。
- `reddit.js`：
  - 公开：`https://www.reddit.com/r/<sub>/new.json?limit=100&after=<fullname>`、`/search.json?q=&restrict_sr=1&sort=new`、`/user/<name>/submitted.json`；自定义 User-Agent。
  - OAuth：`POST https://www.reddit.com/api/v1/access_token`（`grant_type=client_credentials`，Basic client id/secret），token 缓存到进程内，过期前 60s 刷新；请求 `https://oauth.reddit.com/...`。
  - 游标 `{ after }`；OAuth 失败且 `fallbackPublic !== false` 时切公开并警告；429 按 `Retry-After` 退避。
  - 归一化：`external_id=t3_<id>`，`canonical_url=https://www.reddit.com<permalink>`，`metadata={subreddit, score, comments, flair, nsfw, isSelf}`。

### 11. Discord 与 Telegram

**Discord**：

- 探活：`GET /api/v10/users/@me`，再校验 `guildId` 和每个 `channelId`；权限不足时返回缺失权限列表。
- 采集：`GET /api/v10/channels/<id>/messages?limit=100&before=<id>`；线程通过 `GET /api/v10/channels/<id>/threads/active` 或 `guilds/<id>/threads/active` 获取；服务器搜索 `GET /api/v10/guilds/<id>/messages/search?content=<q>`。
- 游标 `{ before, channelCursors: { [channelId]: messageId } }`；首次从最新开始，后续只取更新消息。
- 归一化：`external_id=<channelId>:<messageId>`，`canonical_url=https://discord.com/channels/<guildId>/<channelId>/<messageId>`，`metadata={attachments,embeds,reactions,authorId,thread}`。
- 无 Token：仅 `GET /api/v10/invites/<code>?with_counts=true` 返回服务器名称/成员数；来源配置 `mode=invite` 时允许，否则 `validateSource` 拒绝。
- 需要在 Discord Developer Portal 开启 **Message Content Intent**；未开启时正文可能为空，适配器在 meta 中警告并保留附件/嵌入信息。

**Telegram**：

- 检测：解析 `t.me/<channel>`、`t.me/s/<channel>`、`t.me/+<hash>`、`t.me/joinchat/<hash>`、`t.me/<channel>/<id>`；公开频道请求 `https://t.me/s/<channel>` 提取标题、订阅数、描述、首屏消息；私有邀请只从 URL 判断，不做未授权探测。
- 公开预览：解析 `div.tgme_widget_message[data-post]`，提取文本、时间、作者、媒体、浏览数、链接；`?before=<id>` 翻页；游标 `{ before }`。
- Bot：`GET /bot<token>/getChat?chat_id=@channel` 检测；`getUpdates?offset=&timeout=0` 拉取更新，只处理 `channel_post`；游标 `{ updateId }`。Bot 只能收到加入后的新消息，不能读历史，运行详情明确标注。
- MTProto（可选）：`python/telegram_worker.py` 使用 Telethon，凭据 JSON 从 stdin 传入，输出 JSONL；参数 `--channel --limit --min-id --session`；未安装 Telethon 返回 `MTPROTO_UNAVAILABLE`，适配器回退公开预览或 Bot。
- 保留现有 `feed` 模式：JSON/RSS/Bot API feed 原样解析。

### 12. GitHub

- 规则 `repo`：值为 `owner/repo` 或 URL；`options.events` 默认 `["releases","issues","pulls","discussions"]`；`options.includePrereleases`、`options.labels`、`options.state`、`options.since`。
- REST：
  - `GET /repos/{owner}/{repo}/releases?per_page=100&page=`
  - `GET /repos/{owner}/{repo}/issues?state=all&sort=updated&direction=desc&since=&per_page=100&page=`（返回中带 `pull_request` 的归为 PR）
  - `GET /repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=`
- GraphQL Discussions：`repository(owner,name){ discussions(first:100, after:) { pageInfo { hasNextPage endCursor } nodes { ... } } }`；无 Token 时跳过并 warning。
- 增量：每个 repo + event 类型保存 `{ since, page, etag, lastUpdatedAt }`；优先 `since`，其次 `If-None-Match`；`304` 视为无更新。
- 归一化：
  - Release：`external_id=release:<id>`，`canonical_url=html_url`，`metadata={tag, prerelease, assets}`，`notification.event='release'`。
  - Issue/PR：`external_id=<issue|pull>:<id>`，`metadata={state, labels, assignees, comments, isPullRequest}`，`notification.event='issue'|'pull'`。
  - Discussion：`external_id=discussion:<id>`，`metadata={category, comments, state}`，`notification.event='discussion'`。
- 限流：匿名 60/h、Token 5000/h；读取 `X-RateLimit-Remaining/Reset` 和 `Retry-After`；接近耗尽时主动推迟。
- 更新通知：适配器在状态/标题/正文变化时设置 `metadata.notification.updateKey = <state|updated_at|comments>`；仅 `notify_updates=1` 时由通知层创建。

### 13. API 与 UI

新增/调整 API：

- `POST /api/collections/detect` `{ url, probe? }` → `{ platform, kind, value, config, name, authRequired, publicFallback, warnings, probed? }`。先调用适配器 `detect`，`probe=true` 时再尝试轻量探活；网络失败仍返回离线建议。
- `GET/POST /api/collections/notifications...` 见上。
- `GET /api/collections/categories?platform=` 支持任意 Discourse 平台。
- `POST/PATCH /api/collections/rules` 接受 `options`、`match`、`notify`、`notifyUpdates`，并返回完整字段。
- `POST /api/collections/sources` 接受平台别名和 `fields` 认证；`GET /api/collections/adapters` 返回 `ruleKinds`、`configExample`、`authHints`、`publicFallback`。
- `GET /api/collections/platforms` 增加 `unreadCount`（可选，便于卡片展示）。

UI：

- 全局 topbar + 通知铃铛/抽屉（新 DOM、CSS、轮询）。
- 采集设置：平台选择后显示配置示例和认证提示；“识别链接”输入 + 按钮调用 detect，自动填充平台/名称/URL/配置。
- 规则表单：根据 `ruleKinds` 渲染类型下拉；新增 `value` 占位符、`options` JSON、`match` JSON、`notify`/`notifyUpdates` 开关；保存前做 JSON 解析和错误提示。
- 平台工作台：去掉硬编码“最新话题”行对非 Discourse 平台的显示；分类筛选仅对 `linux.do`/`macos.do` 显示；平台标签映射补充新平台。
- 内容列表/详情：展示 `metadata.provider`、`mode`、`degraded`、GitHub 事件类型等标签；通知跳转复用现有详情页。
- 修复 `web/index.html` 中重复的 `platformQueueList` id。

### 14. 配置与默认值

- 新增非密钥配置项（`.env.example`）：`GOOGLE_CSE_CX`、`HF_BASE_URL`、`COLLECTOR_DEFAULT_MAX_ITEMS`、`COLLECTOR_NOTIFICATION_RETENTION_DAYS`、`COLLECTOR_WEB_CRAWL_DELAY_MS`。
- 密钥仍优先通过采集设置的加密认证保存；`.env` 只提供可选的首次启动默认值，不写入日志。
- 适配器默认限流：X 1/2s source；Google 2/s；Web 1/s/host；arXiv 1/3s；Discourse 1/5s；V2EX 1/s；Reddit 1/s；Discord 2/s；Telegram 1/s；GitHub 1/s；HF 1/s。来源可用 `config.rateLimit` 覆盖。

### 15. 迁移与兼容

启动时按现有 `addColumn` 模式幂等添加列和表：

1. `collection_rules.options_json/match_json/notify/notify_updates`
2. `collection_runs.filtered_count`
3. `collection_notifications` 表与索引
4. `INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ...)`

迁移策略：

- `notify` 列默认 `1`；迁移时若该列在本次启动前不存在，则在加列后执行一次 `UPDATE collection_rules SET notify = 0`，避免升级后首次全量同步产生大量历史通知。该回填只在首次加列时执行，重启不会再次关闭用户已开启的通知；新建规则默认 `1`。UI 中明确显示通知开关。
- 旧规则 `match_json={}`，继续按 `kind` 的旧语义过滤；旧适配器的 `matchesRule` 行为保留为匹配器的兼容分支。
- 旧 `google` 来源 ID 和 URL 不变；`web` 来源不再推断为 `google`，但已有 `google` 来源继续工作。
- 旧 `telegram` feed 来源继续按 `feed` 模式解析；`linux.do` 的 API、分类缓存和测试导出保持兼容。
- 回滚：代码回滚后新增列/表不被读取，SQLite 数据保留，无需 down migration。

## Risks / Trade-offs

- **平台反爬/登录墙**（X、Reddit、Discord、Cloudflare）→ 使用用户自己的凭据、明确的错误分类、公开降级和限流；不实现绕过。X 仍可能因账号风控失败，保留 mock 模式用于开发。
- **Discord Message Content Intent 未开启** → 正文为空但附件/嵌入仍在；适配器在 meta 和 UI 中提示，文档说明开启方式。
- **Telegram MTProto 依赖 Telethon** → 可选安装；缺失时返回 `MTPROTO_UNAVAILABLE` 并回退公开预览/Bot，不影响其他平台。
- **通用 Web 解析脆弱** → 优先 JSON-LD/OG，列表页摘要兜底，原始 HTML 全量保留；解析失败只标记不完整，不丢数据。站点改版后需要调整配置模板。
- **通知洪泛** → 迁移规则默认关闭通知；按规则开关；保留策略清理已读；UI 支持按平台/未读筛选。
- **正则拒绝服务** → 限制表达式长度/数量、截断匹配文本、保存时编译；仍建议用户使用简单表达式。
- **API 配额** → Google CSE 免费额度有限、GitHub 匿名 60/h、Reddit 公开限流；提供 provider 回退、条件请求、OAuth/Token 提升额度。
- **SQLite 写竞争** → 单页事务、WAL、默认 3 个 Worker；通知与内容同事务，避免“有内容无通知”。
- **密钥泄露** → AES-256-GCM、`fields` 认证、日志脱敏、API 只返回状态；MTProto 凭据经 stdin 传入，不出现在命令行。
- **robots/ToS 合规** → 默认遵守 robots.txt、限速、只采公开页；不提供验证码/Cloudflare 绕过；凭据仅用于用户自己的账号。
- **破坏兼容** → 新字段全部有默认值；保留旧导出函数和平台 ID；新增测试覆盖旧规则和旧 feed 来源。

## Migration Plan

1. 合并代码后重启服务；启动迁移自动加列/建表，记录 schema version 2。
2. 现有来源和规则无需修改；旧规则通知默认关闭，用户可在平台工作台逐条开启。
3. 可选：为 X 配置 `python/accounts.json`；为 Reddit/Google/GitHub/Discord/Telegram 在采集设置中录入 `fields`/`token`/`api_key`。
4. 可选：`pip install telethon` 启用 Telegram MTProto；不安装则使用公开预览/Bot。
5. 验证顺序：适配器列表 → 链接识别 → 创建来源/规则 → 手动采集 → 通知铃铛 → 重启后游标恢复。
6. 回滚：停止服务、回退代码、重启；新增列/表保留但不影响旧逻辑。若需彻底回滚数据，使用迁移前备份的 `data/xmonitor.db`。

## Open Questions

- 通用 Web 的链接提取是否需要提供可视化选择器？首版用配置化正则/包含排除；若实际站点覆盖率不足，再评估引入 HTML 解析依赖。该问题不改变首版接口和任务拆分。
