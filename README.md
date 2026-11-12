# 📡 X-Monitor · X 平台 AI 账号创意素材监控系统

定期抓取 X (Twitter) 上 AI 相关账号的最新推文，同时通过统一采集框架采集 Google、通用 Web、arXiv、Hugging Face / hf-mirror、linux.do、macos.do、V2EX、Reddit、Discord、GitHub、Telegram 等来源 → **规则匹配 + 站内通知** → **LLM 自动分析**是否可作为创意素材 → 进入素材库等待**人工确认** → 点击按钮**一键自动创作**（文章 / 配图方案 / 视频脚本）。

采集器支持“采什么（规则）+ 留什么（匹配条件）+ 提醒什么（通知）”的统一模型；完整平台说明见 [docs/collectors/README.md](docs/collectors/README.md)。

## 核心流程

```
定时抓取 X 推文 (twscrape / 演示数据)
      │
      ▼
LLM 分析创意价值 (评分/分类/标签/建议创作类型)
      │  评分 ≥ 阈值
      ▼
素材库 (待确认) ──人工确认──► 已确认素材
                                   │
                                   ▼
              ✨ 一键创作 ──► 文章 📄 / 配图方案 🖼 / 视频脚本 🎬
```

## 快速开始

### 1. 启动（无需任何 X 凭据即可体验）

```bash
cd x-monitor
cp .env.example .env  # 首次使用；已有 .env 时不要覆盖
npm start            # 等价于 node src/index.js
```

打开 <http://localhost:3081>。首次启动会自动：

- 用内置演示数据（mock 模式）抓取一轮推文（无需登录 X）
- 点击「▶ 立即抓取并分析」触发流水线

> 未配置 LLM Key 时，抓取正常但分析会跳过；在 **设置** 页填入 LLM 配置后即可完整使用。

### 2. 配置 LLM（必填，用于分析与创作）

界面「设置」页填写后保存（写入 `.env`，重启生效），或直接编辑 `.env`：

```env
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-xxx
LLM_MODEL=deepseek-chat
```

保存后点「测试 LLM 连接」验证。

### 3. 接入真实 X 数据（可选）

```bash
cd python
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 登录账号在项目根目录 .env 的 X_ACCOUNTS_JSON 中配置
```

- **方式 A · 账号密码登录**：填写 `username/password/email/email_password`。注意 X 风控严格，密码登录可能被验证码/二次验证拦截；要求账号未开启 2FA，建议先用浏览器手动登录一次该账号。
- **方式 B · 浏览器 Cookie（推荐）**：浏览器登录 x.com 后，F12 开发者工具 → 应用 → Cookie → https://x.com，复制 `auth_token` 与 `ct0` 两个值。**推荐写成 JSON 对象**（cookie 值可能含 `"` 引号等特殊字符，对象格式无需转义）：

  ```json
  {
    "username": "你的X用户名",
    "password": "",
    "email": "",
    "email_password": "",
    "cookies": { "auth_token": "复制的值", "ct0": "复制的值" }
  }
  ```

  将账号对象放进 `.env` 的单行数组 `X_ACCOUNTS_JSON=[{...}]`。也支持 Cookie 字符串写法 `"auth_token=xxx; ct0=yyy"`（值两端的引号会自动清理）。完整格式见 [统一配置说明](docs/security/env-configuration.md)。

- **代理配置（必需）**：若本机无法直连 x.com（网络被拦截），请求会挂起。请在 `.env` 配置代理地址：

  ```env
  X_PROXY=http://127.0.0.1:10808   # Clash 常用 7890，v2rayN HTTP 常用 10808
  ```

  `X_ACCOUNTS_JSON` 也支持 `{"proxy":"...","accounts":[...]}` 格式或为单个账号加 `"proxy"` 字段。验证代理是否生效：`curl -x http://127.0.0.1:10808 -I https://x.com`。

支持多账号轮换，降低风控概率。配置后 `SCRAPE_MODE` 设为 `auto`（默认），系统自动切换为真实抓取；若登录失败，运行日志会显示每个账号的登录详情与失败原因。

## 第一次使用（3 分钟）

1. 启动后打开终端显示的地址。
2. 在 **仪表盘** 点 **快速开始**，选一个目标：GitHub 分支代码、arXiv 论文、Google 关键词或 Reddit 社区。
3. 填最少信息（仓库 `owner/repo`、关键词或 subreddit），确认后会自动创建来源和规则；可以勾选“创建后立即试跑”。
4. 到 **设置** 配置 LLM（只采集可以先跳过），到 **采集** 查看内容，到右上角 **通知** 查看命中提醒。

不确定选哪个平台时，打开 **使用指南** 的“平台怎么选”表；需要高级参数时再打开“显示高级选项”。

## 使用指南

| 页面 | 功能 |
|------|------|
| **仪表盘** | 开始使用清单、统计卡片、快速开始、一键触发抓取与分析 |
| **使用指南** | 四概念解释、3 分钟上手、平台选择表、常见问题 |
| **素材库** | LLM 自动筛选的素材；**确认**后即可点「开始创作」选择产出类型；可拒绝/恢复/搜索 |
| **创作记录** | 展开查看生成的文章（Markdown）、配图方案（中英文提示词）、视频分镜脚本；一键复制、失败重试 |
| **监控账号** | 增删要跟踪的 X 账号、暂停/启用 |
| **运行日志** | 抓取/分析/创作流水线历史 |
| **设置** | LLM 服务、筛选阈值、抓取间隔、抓取模式等 |
| **采集** | 平台状态：来源/内容/今日运行/下次运行/未读通知，点击进入采集详情 |
| **站内通知** | 顶栏“通知” + 未读徽标；全部/未读、按平台筛选、单条/全部已读，点击跳转内容详情 |
| **采集详情** | 内容 / 规则 / 运行三个标签：搜索、分类标签筛选、50 条分页、规则新建与定时、运行统计 |
| **内容详情** | 单条采集内容、代码改动文件与 patch、分类标签、全部来源链接和原始快照 |
| **来源与规则** | 从模板新增来源，配置链接、平台参数、加密认证和配置 YAML 导入/导出；规则在采集详情里创建 |
| **linux.do** | 从 **采集** 页选择 linux.do；分类/标签筛选，无 Cookie 时关键词采集自动降级公开页过滤 |

### 关键设计

- **全量收录（keep-all 分支）**：所有分析过的推文**全部进入素材库**（pending 状态），LLM 的分析（评分/分类/标签/建议类型）仅作为**参考信息**供排序与判断，最终由人工确认是否使用；只有重复内容才会跳过
- **人工决断**：只有 `approved` 素材才能触发创作，符合「人工把关 → 自动创作」的工作流
- **多类型创作**：同一素材可分别生成 深度长文 / 文生图提示词 / 60s 短视频分镜脚本
- **零依赖后端**：Node 内置 `node:sqlite` + `node:http`，无需 npm install
- **数据本地化**：SQLite 存储于 `data/`，推文、素材、创作记录、日志全部可追溯
- **统一采集不丢原文**：跨平台内容写入 `collection_items`；按规范 URL / 外部 ID 幂等合并，重复内容只追加新链接和原始快照；字段不完整的记录标记为 `required_complete=false` 但不会被静默丢弃
- **认证隔离**：采集源认证写入 `collection_auth` 的 AES-256-GCM 密文，API、前端和运行日志只返回认证类型/状态；建议生产环境设置 `COLLECTOR_MASTER_KEY`
- **单一采集核心**：所有平台共用 SQLite 的 sources/rules/items/runs 与一个调度器；linux.do 只是采集详情的一个入口，不再有独立 API、YAML 规则或第二套调度
- **规则与自动采集**：规则有名称、类型、值、查询选项、匹配条件、通知开关、间隔、上次/下次时间；`interval_min=0` 表示仅手动。「自动采集最新话题」就是一条 `kind=full` 的规则，不再有独立全局开关。GitHub 规则可勾选分支提交和代码改动，采集变更文件与 patch 片段
- **统一匹配器**：支持关键词、包含全部/任一、排除词、正则、作者/账号、标签和媒体条件；来源可提供默认匹配，规则级条件覆盖同名字段。被过滤内容不入库、不通知，运行详情记录过滤数量
- **站内通知**：新内容首次入库且规则开启通知时写入通知表；重复采集和普通更新不重复通知，GitHub 等平台可用 `notifyUpdates` 生成状态更新通知。通知保留天数可配置，内容删除时级联删除
- **链接识别**：来源与规则页粘贴 x/github/hf-mirror/macos.do/t.me 等链接即可推荐平台、规则类型和配置
- **采集入口分工**：采集只展示平台状态和最近运行；采集详情负责内容/规则/运行；来源与规则负责来源、认证和配置文件
- **去重**：内容按规范 URL / 外部 ID 生成 `dedupe_key`，重复采集只合并链接和原始快照，不产生重复行
- **配置镜像**：运行态以 SQLite 为准；YAML 仅用于导入/导出备份（`data/collector/`），直接改文件后需在来源与规则页点「导入 YAML」

> 分支说明：`main` 分支为「自动筛选」行为（评分低于阈值不入库）；`keep-all` 分支为「全量收录、人工决断」。切换分支：`git checkout main` / `git checkout keep-all`（切换后需重启服务生效）。

## 配置项（.env）

真实配置只保留在本机，仓库只提交无密钥模板：

```bash
test -f .env || cp .env.example .env
```

- `.env`：LLM、X 登录账号/Cookie、各平台认证、主密钥、代理、服务和调度参数；所有可配置项见 `.env.example`，具体结构见 [统一配置说明](docs/security/env-configuration.md)。不要在模板中填写真实值。
- `X_ACCOUNTS_JSON` 优先于旧 `python/accounts.json`；模板中的 `[]` 表示不配置登录账号。旧账号文件仅为兼容保留，不再要求创建。
- `COLLECTOR_AUTH_JSON` 启用后，来源 URL 的认证优先于平台默认值，再回退旧加密数据库；界面保存/清除认证自动写回 `.env`。
- `data/` 是运行数据而不是可发布配置；数据库、旧密钥和配置 YAML 仍可能含认证信息，只做私有备份。
- `.gitignore` 排除上述文件、环境变体、账号备份、会话、认证导出和私钥。已被 Git 跟踪的文件与历史提交不受忽略规则保护。
- 推送前运行 `node --test test/git-safety.test.js`，并使用 Gitleaks 扫描暂存区及全部历史；检查报告不要存入仓库。账号公开用户名、Git 作者姓名和邮箱并非登录凭据，但仍会随提交公开。

安全检查记录与历史凭据处理步骤见 [docs/security/git-publish.md](docs/security/git-publish.md)。

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | 3081 | 服务端口 |
| `X_ACCOUNTS_JSON` | `[]` | X 登录账号数组，支持 Cookie 与密码、多账号 |
| `COLLECTOR_AUTH_JSON` | 空 sources/platforms | 各平台与具体来源的认证，界面修改同步写回 `.env` |
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容接口地址 |
| `LLM_API_KEY` | - | API Key（必填启用分析/创作） |
| `LLM_MODEL` | `deepseek-chat` | 模型名 |
| `ANALYZE_THRESHOLD` | 60 | 素材筛选评分阈值 |
| `SCRAPE_INTERVAL_MIN` | 30 | 定时抓取间隔（分钟） |
| `SCRAPE_PER_ACCOUNT` | 10 | 每账号每次抓取条数 |
| `MONITOR_ACCOUNTS` | karpathy,sama,ylecun,… | 默认监控账号（逗号分隔） |
| `SCRAPE_MODE` | auto | `auto` 有登录账号则真实抓取否则演示数据；`mock` 强制演示数据；`real` 强制真实抓取 |
| `PYTHON_BIN` | 自动 | 自动优先使用 `python/.venv/bin/python`（含 twscrape），否则回退 `python3` |
| `WEB_DEFAULT_KEYWORDS` | - | 首次启动创建 Web 关键词规则，逗号分隔 |
| `WEB_COLLECT_INTERVAL_MIN` | 360 | Web 关键词规则默认间隔（分钟） |
| `HF_SYNC_INTERVAL_HOURS` | 24 | Hugging Face Daily Papers 全量同步间隔（小时） |
| `HF_SYNC_ENABLED` | true | 是否启用 Hugging Face Daily Papers 自动全量同步 |
| `HF_PAGE_SIZE` | 100 | Hugging Face 分页大小 |
| `HF_MAX_PAGES_PER_RUN` | 0 | 0 表示沿分页链接同步到末页；正数用于限量分批 |
| `COLLECTOR_PROXY` | - | Web/HF/arXiv/论坛等 Node 采集请求代理，未设置时复用 `X_PROXY`；HTTPS 走 CONNECT 隧道 |
| `COLLECTOR_TIMEOUT_MS` | 30000 | 单次采集请求超时 |
| `COLLECTOR_RETRIES` | 2 | 单次采集请求重试次数 |
| `COLLECTOR_POLL_INTERVAL_MIN` | 1 | 统一采集调度器检查到期规则的轮询间隔 |
| `COLLECTOR_MASTER_KEY` | - | 认证密文主密钥；未设置时在 `data/.collector-key` 生成本机密钥 |
| `COLLECTOR_DEFAULT_MAX_ITEMS` | 100 | 单条规则默认最大条数 |
| `COLLECTOR_NOTIFICATION_RETENTION_DAYS` | 30 | 已读通知保留天数；未读不清理 |
| `COLLECTOR_WEB_CRAWL_DELAY_MS` | 1000 | 通用 Web 抓取间隔（毫秒） |
| `HF_BASE_URL` | `https://huggingface.co` | 默认 Hugging Face 地址，可改为 hf-mirror |
| `GOOGLE_CSE_CX` | - | Google 自定义搜索引擎 ID（API Key 在来源与规则页保存） |

## 目录结构

```
x-monitor/
├── src/                  # Node 后端
│   ├── index.js          # 入口
│   ├── config.js         # .env 加载与配置
│   ├── db.js             # SQLite 存储层 (node:sqlite)
│   ├── llm.js            # OpenAI 兼容 LLM 客户端
│   ├── analyzer.js       # 素材创意分析器
│   ├── creator.js        # 多类型创作器
│   ├── scraper.js        # 调度 Python worker
│   ├── scheduler.js      # 定时流水线
│   ├── collection-engine.js # 统一采集调度、紧急任务与入库编排
│   ├── collector-config.js  # 配置 YAML 导入/导出
│   ├── collector-migrate.js # 旧 linux.do YAML → SQLite 一次性迁移
│   ├── server.js         # HTTP API + 静态资源
│   └── collectors/
│   │   ├── framework.js  # 适配器注册与单次采集入口
│   │   ├── contract.js   # 适配器契约与公开元数据
│   │   ├── match.js      # 统一匹配器
│   │   ├── notifications.js # 站内通知构建
│   │   ├── aliases.js / detect.js # 平台别名与链接识别
│   │   ├── web.js / google.js / html.js # 通用 Web 与 Google
│   │   ├── discord.js / telegram.js / x.js # 社区与 X
│   │   ├── github.js / reddit.js # GitHub 与 Reddit
│   │   ├── discourse.js / linuxdo.js / v2ex.js # 论坛
│   │   └── arxiv.js / huggingface.js # 学术
├── python/
│   ├── worker.py         # twscrape 抓取 / mock 数据生成
│   ├── mock_tweets.json  # 内置演示推文
│   ├── accounts.json     # twscrape 登录账号（真实模式）
│   └── requirements.txt
├── web/                  # 前端（原生 JS，无框架）
│   ├── index.html
│   ├── app.js
│   └── style.css
└── test/mock-llm.js      # 无 Key 时的端到端联调工具
```

## 常见问题

- **分析一直失败？** 检查设置页 LLM 连接测试；确认模型支持 JSON 输出（response_format）
- **抓取为空？** mock 模式演示池有限，多跑几轮或清空 `python/.mock_state.json` 重置；真实模式确认 `accounts.json` 登录成功（运行日志会记录）
- **如何换端口？** `PORT=8080 npm start`

### 采集 API

- `GET /api/collections/adapters`：已注册平台与能力
- `GET /api/collections/platforms`：平台汇总（来源数、条目数、今日运行、下次运行）
- `GET/POST /api/collections/sources`：查看/新增采集源；支持 `?platform=`
- `POST/PATCH/DELETE /api/collections/sources/:id`：保存链接/配置、删除来源
- `GET/PUT/DELETE /api/collections/sources/:id/auth`：加密认证
- `GET/POST/PATCH/DELETE /api/collections/rules`：规则 CRUD；字段含 `name/kind/value/intervalMin/enabled/last_run_at/next_run_at`；支持 `?platform=`
- `POST /api/collections/runs`：`{"mode":"scheduled"}` 检查到期规则；`{"mode":"emergency","sourceId":1,"ruleId":2}` 立即采集
- `GET /api/collections/items`：内容列表；支持 `platform/q/categoryId/tag/limit/offset`，返回 `total`
- `GET /api/collections/items/:id`：内容详情
- `GET /api/collections/runs`、`GET /api/collections/runs/stats`：运行记录与统计
- `GET /api/collections/categories?platform=linux.do`：分类 id → 名称缓存
- `POST /api/collections/config/export` / `import`：SQLite ↔ `data/collector/` YAML

页面：`#/collections` 采集、`#/collections/:platform` 采集详情、`#/collections/:platform/items/:id` 内容详情、`#/settings/collectors` 来源与规则；`#/linuxdo` 会重定向到 `#/collections/linux.do`。

单一调度：服务端按 `COLLECTOR_POLL_INTERVAL_MIN` 检查到期规则，所有平台串行、来源级隔离；同一来源正在运行时跳过并下一轮重试，规则失败（含 429）按退避更新下一次时间。

本地文件（镜像，不参与运行时）：

```
data/collector/
├── sources/source-<id>.yaml
├── rules/rule-<id>.yaml
└── categories.json
```

旧版 `data/linuxdo/` 会在启动时一次性迁移到 SQLite（marker 防重复），迁移后保留作为备份。

> linux.do 由 Cloudflare 保护，采集需配置 `COLLECTOR_PROXY` 或 `X_PROXY`；请求会自动使用 HTTP/2 和浏览器请求头。短时间连续采集可能返回 HTTP 429，建议间隔 30–60 分钟。

认证示例（只提交给 `auth` 字段，服务端加密保存）：

```json
{"type":"cookie","cookies":{"session":"...","csrftoken":"..."}}
{"type":"bearer","token":"..."}
{"type":"basic","username":"user","password":"..."}
{"type":"headers","headers":{"X-API-Key":"..."}}
```

新增平台时在 `src/collectors/framework.js` 注册适配器即可复用认证、去重、原始内容留存、定时/紧急入口、匹配、通知和 API/UI。适配器需要声明 `ruleKinds`、`detect`、`authHints`/`publicFallback`，并实现 `collect` 或 `collectPages`。各平台凭据、配置和降级说明见 [docs/collectors/README.md](docs/collectors/README.md)。

## 免责声明

使用 twscrape 抓取 X 数据请遵守 X 平台服务条款与当地法律法规；本项目仅供学习研究使用。
