# 本次任务变更报告

- 基线：`unified-collector-20260929`
- 创建时间：`2026-09-29T04:20:14.387995+00:00`
- 范围：仅包含基线创建之后发生的文件变化。

## 文件变化

| 状态 | 新增 | 删除 | 文件 |
| --- | ---: | ---: | --- |
| 修改 | 43 | 2 | `README.md` |
| 修改 | 181 | 179 | `docs/architecture/x-monitor-architecture-change-report.md` |
| 修改 | 17 | 17 | `docs/architecture/x-monitor-framework.architecture.json` |
| 修改 | 2 | 2 | `docs/architecture/x-monitor-framework.architecture.visual-check.json` |
| 修改 | 22 | 21 | `docs/architecture/x-monitor-runtime.dataflow.json` |
| 修改 | 2 | 2 | `docs/architecture/x-monitor-runtime.dataflow.visual-check.json` |
| 修改 | 1 | 1 | `python/.mock_state.json` |
| 新增 | 143 | 0 | `src/collection-engine.js` |
| 新增 | 78 | 0 | `src/collectors/arxiv.js` |
| 新增 | 140 | 0 | `src/collectors/auth.js` |
| 新增 | 316 | 0 | `src/collectors/framework.js` |
| 修改 | 9 | 4 | `src/collectors/huggingface.js` |
| 修改 | 4 | 3 | `src/collectors/web.js` |
| 修改 | 5 | 0 | `src/config.js` |
| 修改 | 324 | 1 | `src/db.js` |
| 修改 | 22 | 1 | `src/scheduler.js` |
| 修改 | 191 | 2 | `src/server.js` |
| 新增 | 37 | 0 | `test/collection-engine.test.js` |
| 新增 | 121 | 0 | `test/collection-framework.test.js` |
| 修改 | 151 | 0 | `web/app.js` |
| 修改 | 83 | 2 | `web/index.html` |
| 修改 | 46 | 2 | `web/style.css` |

## 代表性差异

```diff
--- baseline/README.md
+++ current/README.md
@@ -1,5 +1,5 @@
 # 📡 X-Monitor · X 平台 AI 账号创意素材监控系统
 
-定期抓取 X (Twitter) 上 AI 相关账号的最新推文 → **LLM 自动分析**是否可作为创意素材 → 进入素材库等待**人工确认** → 点击按钮**一键自动创作**（文章 / 配图方案 / 视频脚本）。
+定期抓取 X (Twitter) 上 AI 相关账号的最新推文，同时通过统一采集框架采集 Web 关键词、Hugging Face Daily Papers、arXiv、V2EX、linux.do 和可扩展的 Telegram feed/API → **LLM 自动分析**是否可作为创意素材 → 进入素材库等待**人工确认** → 点击按钮**一键自动创作**（文章 / 配图方案 / 视频脚本）。
 
 ## 核心流程
@@ -92,4 +92,5 @@
 | **运行日志** | 抓取/分析/创作流水线历史 |
 | **设置** | LLM 服务、筛选阈值、抓取间隔、抓取模式等 |
+| **统一采集** | 添加平台链接、保存 Cookie/Token/Basic 等加密认证、配置关键词/账号规则、定时检查、紧急采集、查看采集内容与运行记录 |
 
 ### 关键设计
@@ -100,4 +101,6 @@
 - **零依赖后端**：Node 内置 `node:sqlite` + `node:http`，无需 npm install
 - **数据本地化**：SQLite 存储于 `data/`，推文、素材、创作记录、日志全部可追溯
+- **统一采集不丢原文**：跨平台内容写入 `collection_items`；按规范 URL / 外部 ID 幂等合并，重复内容只追加新链接和原始快照；字段不完整的记录标记为 `required_complete=false` 但不会被静默丢弃
+- **认证隔离**：采集源认证写入 `collection_auth` 的 AES-256-GCM 密文，API、前端和运行日志只返回认证类型/状态；建议生产环境设置 `COLLECTOR_MASTER_KEY`
 
 > 分支说明：`main` 分支为「自动筛选」行为（评分低于阈值不入库）；`keep-all` 分支为「全量收录、人工决断」。切换分支：`git checkout main` / `git checkout keep-all`（切换后需重启服务生效）。
@@ -117,4 +120,15 @@
 | `SCRAPE_MODE` | auto | `auto` 有登录账号则真实抓取否则演示数据；`mock` 强制演示数据；`real` 强制真实抓取 |
 | `PYTHON_BIN` | 自动 | 自动优先使用 `python/.venv/bin/python`（含 twscrape），否则回退 `python3` |
+| `WEB_DEFAULT_KEYWORDS` | - | 首次启动创建 Web 关键词规则，逗号分隔 |
+| `WEB_COLLECT_INTERVAL_MIN` | 360 | Web 关键词规则默认间隔（分钟） |
+| `HF_SYNC_INTERVAL_HOURS` | 24 | Hugging Face Daily Papers 全量同步间隔（小时） |
+| `HF_SYNC_ENABLED` | true | 是否启用 Hugging Face Daily Papers 自动全量同步 |
+| `HF_PAGE_SIZE` | 100 | Hugging Face 分页大小 |
+| `HF_MAX_PAGES_PER_RUN` | 0 | 0 表示沿分页链接同步到末页；正数用于限量分批 |
+| `COLLECTOR_PROXY` | - | Web/HF/arXiv/论坛等 Node 采集请求代理 |
+| `COLLECTOR_TIMEOUT_MS` | 30000 | 单次采集请求超时 |
+| `COLLECTOR_RETRIES` | 2 | 单次采集请求重试次数 |
+| `COLLECTOR_POLL_INTERVAL_MIN` | 1 | 统一采集调度器检查到期规则的轮询间隔 |
+| `COLLECTOR_MASTER_KEY` | - | 认证密文主密钥；未设置时在 `data/.collector-key` 生成本机密钥 |
 
 ## 目录结构
@@ -131,5 +145,12 @@
 │   ├── scraper.js        # 调度 Python worker
 │   ├── scheduler.js      # 定时流水线
-│   └── server.js         # HTTP API + 静态资源
+│   ├── collection-engine.js # 统一采集调度、紧急任务与入库编排
+│   ├── server.js         # HTTP API + 静态资源
+│   └── collectors/
+│   │   ├── framework.js  # 适配器注册、规范化、去重和平台实现
+│   │   ├── auth.js       # Cookie / Token / Basic 加密认证
+│   │   ├── arxiv.js      # arXiv Atom 适配器
+│   │   ├── web.js        # Google/Bing RSS 与普通网页
+│   │   └── huggingface.js # Daily Papers 全量分页
 ├── python/
 │   ├── worker.py         # twscrape 抓取 / mock 数据生成
@@ -150,4 +171,24 @@
 - **如何换端口？** `PORT=8080 npm start`
 
+### 统一采集 API
+
+- `GET /api/collections/adapters`：查看已注册平台及能力
+- `GET/POST /api/collections/sources`：查看或添加采集源；平台可省略，服务会按链接主机推断
+- `GET/POST /api/collections/rules`：创建关键词、账号或全量规则并设置分钟间隔
+- `POST /api/collections/runs`：`{"mode":"scheduled"}` 检查到期规则；`{"mode":"emergency","sourceId":1,"keyword":"agent"}` 立即采集
+- `GET /api/collections/items`：查看统一内容（标题、正文、作者、链接、原始快照状态）
+- `GET /api/collections/runs`：查看运行、失败、字段不完整统计
+
+认证示例（只提交给 `auth` 字段，服务端加密保存）：
+
+```json
+{"type":"cookie","cookies":{"session":"...","csrftoken":"..."}}
+{"type":"bearer","token":"..."}
+{"type":"basic","username":"user","password":"..."}
+{"type":"headers","headers":{"X-API-Key":"..."}}
+```
+
+新增平台时只需在 `src/collectors/framework.js` 注册一个 `collect({source, rule, auth, fetchImpl, ...})` 适配器，返回统一记录字段；认证、去重、原始内容留存、定时/紧急入口和 API/UI 无需重复实现。Telegram 当前提供 JSON/RSS/Bot API 适配器契约，真实频道读取仍取决于频道链接和 Bot/客户端权限。
+
 ## 免责声明
 
--- baseline/docs/architecture/x-monitor-architecture-change-report.md
+++ current/docs/architecture/x-monitor-architecture-change-report.md
@@ -1,6 +1,6 @@
 # 本次任务变更报告
 
-- 基线：`x-monitor-architecture-20260912`
-- 创建时间：`2026-09-12T09:19:59.325929+00:00`
+- 基线：`unified-collector-20260929`
+- 创建时间：`2026-09-29T04:20:14.387995+00:00`
 - 范围：仅包含基线创建之后发生的文件变化。
 
@@ -9,186 +9,188 @@
 | 状态 | 新增 | 删除 | 文件 |
 | --- | ---: | ---: | --- |
-| 新增 | 261 | 0 | `docs/architecture/x-monitor-framework.architecture.json` |
-| 新增 | 32 | 0 | `docs/architecture/x-monitor-framework.architecture.visual-check.html` |
-| 新增 | 548 | 0 | `docs/architecture/x-monitor-framework.architecture.visual-check.json` |
-| 新增 | 205 | 0 | `docs/architecture/x-monitor-runtime.dataflow.json` |
-| 新增 | 32 | 0 | `docs/architecture/x-monitor-runtime.dataflow.visual-check.html` |
-| 新增 | 548 | 0 | `docs/architecture/x-monitor-runtime.dataflow.visual-check.json` |
+| 修改 | 43 | 2 | `README.md` |
+| 修改 | 17 | 17 | `docs/architecture/x-monitor-framework.architecture.json` |
+| 修改 | 2 | 2 | `docs/architecture/x-monitor-framework.architecture.visual-check.json` |
+| 修改 | 22 | 21 | `docs/architecture/x-monitor-runtime.dataflow.json` |
+| 修改 | 2 | 2 | `docs/architecture/x-monitor-runtime.dataflow.visual-check.json` |
+| 修改 | 1 | 1 | `python/.mock_state.json` |
+| 新增 | 143 | 0 | `src/collection-engine.js` |
+| 新增 | 78 | 0 | `src/collectors/arxiv.js` |
+| 新增 | 140 | 0 | `src/collectors/auth.js` |
+| 新增 | 316 | 0 | `src/collectors/framework.js` |
+| 修改 | 9 | 4 | `src/collectors/huggingface.js` |
+| 修改 | 4 | 3 | `src/collectors/web.js` |
+| 修改 | 5 | 0 | `src/config.js` |
+| 修改 | 324 | 1 | `src/db.js` |
+| 修改 | 22 | 1 | `src/scheduler.js` |
+| 修改 | 190 | 2 | `src/server.js` |
+| 新增 | 37 | 0 | `test/collection-engine.test.js` |
+| 新增 | 121 | 0 | `test/collection-framework.test.js` |
+| 修改 | 151 | 0 | `web/app.js` |
+| 修改 | 83 | 2 | `web/index.html` |
+| 修改 | 46 | 2 | `web/style.css` |
 
 ## 代表性差异
 
 ```diff
+--- baseline/README.md
++++ current/README.md
+@@ -1,5 +1,5 @@
+ # 📡 X-Monitor · X 平台 AI 账号创意素材监控系统
+ 
+-定期抓取 X (Twitter) 上 AI 相关账号的最新推文 → **LLM 自动分析**是否可作为创意素材 → 进入素材库等待**人工确认** → 点击按钮**一键自动创作**（文章 / 配图方案 / 视频脚本）。
++定期抓取 X (Twitter) 上 AI 相关账号的最新推文，同时通过统一采集框架采集 Web 关键词、Hugging Face Daily Papers、arXiv、V2EX、linux.do 和可扩展的 Telegram feed/API → **LLM 自动分析**是否可作为创意素材 → 进入素材库等待**人工确认** → 点击按钮**一键自动创作**（文章 / 配图方案 / 视频脚本）。
+ 
+ ## 核心流程
+@@ -92,4 +92,5 @@
+ | **运行日志** | 抓取/分析/创作流水线历史 |
+ | **设置** | LLM 服务、筛选阈值、抓取间隔、抓取模式等 |
++| **统一采集** | 添加平台链接、保存 Cookie/Token/Basic 等加密认证、配置关键词/账号规则、定时检查、紧急采集、查看采集内容与运行记录 |
+ 
+ ### 关键设计
+@@ -100,4 +101,6 @@
+ - **零依赖后端**：Node 内置 `node:sqlite` + `node:http`，无需 npm install
+ - **数据本地化**：SQLite 存储于 `data/`，推文、素材、创作记录、日志全部可追溯
++- **统一采集不丢原文**：跨平台内容写入 `collection_items`；按规范 URL / 外部 ID 幂等合并，重复内容只追加新链接和原始快照；字段不完整的记录标记为 `required_complete=false` 但不会被静默丢弃
++- **认证隔离**：采集源认证写入 `collection_auth` 的 AES-256-GCM 密文，API、前端和运行日志只返回认证类型/状态；建议生产环境设置 `COLLECTOR_MASTER_KEY`
+ 
+ > 分支说明：`main` 分支为「自动筛选」行为（评分低于阈值不入库）；`keep-all` 分支为「全量收录、人工决断」。切换分支：`git checkout main` / `git checkout keep-all`（切换后需重启服务生效）。
+@@ -117,4 +120,15 @@
+ | `SCRAPE_MODE` | auto | `auto` 有登录账号则真实抓取否则演示数据；`mock` 强制演示数据；`real` 强制真实抓取 |
+ | `PYTHON_BIN` | 自动 | 自动优先使用 `python/.venv/bin/python`（含 twscrape），否则回退 `python3` |
++| `WEB_DEFAULT_KEYWORDS` | - | 首次启动创建 Web 关键词规则，逗号分隔 |
++| `WEB_COLLECT_INTERVAL_MIN` | 360 | Web 关键词规则默认间隔（分钟） |
++| `HF_SYNC_INTERVAL_HOURS` | 24 | Hugging Face Daily Papers 全量同步间隔（小时） |
++| `HF_SYNC_ENABLED` | true | 是否启用 Hugging Face Daily Papers 自动全量同步 |
++| `HF_PAGE_SIZE` | 100 | Hugging Face 分页大小 |
++| `HF_MAX_PAGES_PER_RUN` | 0 | 0 表示沿分页链接同步到末页；正数用于限量分批 |
++| `COLLECTOR_PROXY` | - | Web/HF/arXiv/论坛等 Node 采集请求代理 |
++| `COLLECTOR_TIMEOUT_MS` | 30000 | 单次采集请求超时 |
++| `COLLECTOR_RETRIES` | 2 | 单次采集请求重试次数 |
++| `COLLECTOR_POLL_INTERVAL_MIN` | 1 | 统一采集调度器检查到期规则的轮询间隔 |
++| `COLLECTOR_MASTER_KEY` | - | 认证密文主密钥；未设置时在 `data/.collector-key` 生成本机密钥 |
+ 
+ ## 目录结构
```
