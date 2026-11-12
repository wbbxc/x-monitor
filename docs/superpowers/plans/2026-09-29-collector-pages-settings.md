# 采集器独立页面与配置刷新 Implementation Plan

> **For agentic workers:** Execute the steps in order and verify each slice before continuing.

**Goal:** 把统一采集控制台拆为平台工作页、内容详情页和采集设置页，并将采集执行改为来源级隔离。

**Architecture:** 保持 Node/SQLite/原生 JS 架构。后端以 `source.id` 为并发隔离键，前端以 hash 路由复用现有静态入口。

**Tech Stack:** Node.js 22 `node:sqlite`, Node `http`, 原生 HTML/CSS/JS, Node test runner, Playwright CLI。

---

### Task 1: 来源级并发隔离

**Files:**
- Modify: `src/collection-engine.js`
- Modify: `src/server.js`
- Test: `test/collection-engine.test.js`

- [x] 为同一来源并发运行返回 skipped，为不同来源允许同时执行。
- [x] 定时采集按来源分组并发，单来源内部顺序运行。
- [x] 移除 API 对全局运行锁的 409 限制（仅保留流水线自身的 409）。
- [x] 运行采集引擎测试。

### Task 2: 认证保存后刷新

**Files:**
- Modify: `src/server.js`
- Modify: `src/collectors/auth.js`
- Modify: `web/app.js`
- Modify: `web/index.html`
- Test: `test/collection-framework.test.js`

- [x] 新增来源认证刷新接口，验证来源存在并返回脱敏状态。
- [x] 保存认证后前端立即刷新来源状态。
- [x] 认证仍只从数据库读取，不在长生命周期缓存密钥。

### Task 3: 平台和详情路由

**Files:**
- Modify: `src/server.js`
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/style.css`

- [x] 增加平台列表和单条内容查询 API。
- [x] 增加总览、平台工作页、内容详情页和采集设置页。
- [x] 保留 `#/collections` 作为采集总览兼容路径；新增源/规则表单迁至采集设置，避免双入口。

### Task 4: 视觉和浏览器验证

**Files:**
- Modify: `web/style.css`
- Modify: `README.md`

- [x] 沿用现有深色石墨主题与青色强调（`--accent2`），补齐列表/详情/设置布局和移动端断点。
- [x] 运行所有 Node 测试、语法检查和差异检查。
- [x] 启动本地服务，用 Playwright 验证桌面/移动端页面和配置保存流程。
- [x] 更新 README 的页面和 API 说明。

## 完成记录（2026-10-17）

- 来源级隔离：`src/collection-engine.js` 按 `source.id` 建槽位；`test/collection-engine.test.js` 覆盖同源跳过、异源并发。
- 认证刷新：`POST /api/collections/sources/:id/refresh` 只回脱敏状态；`test/collections-api.test.js` 覆盖刷新、404、密钥不外泄。
- 页面入口：`#/collections` 采集总览、`#/collections/:platform` 平台页、`#/collections/:platform/items/:id` 详情、`#/settings/collectors` 设置；总览旧表单迁至设置页，`refresh()` 统一刷新当前路由。
- 采集网络：修复 `src/collectors/http.js` HTTPS 代理路径（CONNECT + 显式 TLS，移除会退回直连的 `agent:false`），并处理 IP 目标不能作为 SNI 的边界；`test/collector-proxy.test.js` 回归。
- 真实采集：2026-10-17 通过本机代理采集成功，`collection_items` 现有 arXiv 50 条、Hugging Face 200 条、Web 12 条。
- 视觉验收：`docs/verification/2026-10-17/`（8 张桌面/移动截图 + `ui-verification.json`）。桌面 1440x900、移动 390x844 横向溢出均为 0，控制台错误 0；新增源→写认证→加规则→平台页可见→暂停状态刷新流程全部通过。
- 全量验证：`node --test test/*.test.js test/keep-all-test.js` → 19/19 通过。

## 追加：linux.do 独立侧边栏与采集器抽取（2026-10-17）

- [x] 新增侧边栏入口 `#/linuxdo` 与独立页面（配置 / 关键词采集 / 话题 / 运行记录）。
- [x] 抽取 `src/collectors/linuxdo.js`，实现 latest、搜索、RSS 兜底和正文补全。
- [x] 新增 `GET /api/linuxdo/overview`、`POST /api/linuxdo/collect`、`POST /api/linuxdo/source`。
- [x] 从采集总览/采集设置中移除 linux.do 入口，旧平台地址跳转到独立页。
- [x] 补充 `test/linuxdo.test.js`、`test/linuxdo-api.test.js`，并通过 Playwright 桌面/移动验收。
- [x] 通过本机代理跑通真实 latest 采集（30 条入库）；补充 HTTP/2 代理路径与作者/标签规范化。
- [x] 无 Cookie 关键词采集降级：扫描 `latest.json` + `top.json?period=weekly`，去重后本地过滤；实测关键词 `AI` 扫描 80 条话题命中 20 条。
- [ ] 带 Cookie 的站内搜索：未提供 Cookie 时接口返回 403 `not_logged_in`，待用户配置 Cookie 后验证。

## 追加：linux.do 列表 / 设置 / 采集次数拆分（2026-10-18）

- [x] 主页面只保留采集列表和临时关键词采集。
- [x] 设置弹窗：站点地址、最大条数、正文补全、降级开关、Cookie，保存到 `data/linuxdo/settings.yaml`。
- [x] 采集规则弹窗：新建/删除/立即执行，规则为 `data/linuxdo/rules/<slug>.yaml` 独立文件。
- [x] 采集次数弹窗：总运行、成功、警告、失败、运行中、今日和最近记录。
- [x] 新增 `src/linuxdo-store.js` 与设置/规则 API，并用 Playwright 验证弹窗与 YAML 落盘。

## 追加：linux.do 关键词列表与分页（2026-10-18）

- [x] 主页面新增「待采集关键词」面板，显示启用的关键词规则、上次触发时间和采集按钮。
- [x] 采集列表每页 50 条，提供上一页/下一页、页码与总数。
- [x] 规则触发时把 `lastRunAt` 写回对应 YAML，列表页刷新状态。

## 追加：linux.do 分类/标签查看与筛选（2026-10-18）

- [x] 分类 id 映射名称并缓存到 `data/linuxdo/categories.json`。
- [x] 列表卡片/详情页显示分类和标签；搜索同时匹配 `metadata_json`。
- [x] 列表支持分类下拉、标签输入筛选，分页总数按筛选结果计算。
- [x] 验证去重：同主题不产生重复行，重复采集只合并链接/快照。

## 追加：linux.do 自动采集（2026-10-18）

- [x] 全局「自动采集最新话题」开关 + 间隔，状态写入 `settings.yaml`。
- [x] 规则级 `intervalMin` 自动运行，支持设置弹窗内修改；`0` 为仅手动。
- [x] 服务端每分钟检查到期任务，串行执行并写回 `lastRunAt/nextRunAt`；同源运行中跳过重试。
- [x] 增加调度计划、推进时间和跳过不推进的测试。

## 追加：linux.do 页面框架重排（2026-10-18）

- [x] 主区域改为采集列表，右侧栏放待采集关键词和临时关键词。
- [x] 顶部四格摘要：已入库/字段不完整/今日运行/自动采集状态。
- [x] 设置弹窗拆为「基础设置 / 自动采集 / 采集规则」标签；保存按钮固定在底部。
- [x] 宽度 <=1100px 自动单列，移动端摘要两列、右栏堆叠。

## 追加：采集核心统一（2026-10-18）

- [x] `collection_rules.name` 迁移；规则间隔 0 表示手动。
- [x] 单一调度器；删除 linux.do YAML 调度与全局 autoLatest 特殊状态。
- [x] 通用 API：platforms / runs stats / categories / config export/import。
- [x] 平台工作台三标签；linux.do 快捷入口与别名路由。
- [x] 配置 YAML 导入导出；旧 YAML 一次性迁移。
- [x] 36 个测试与 Playwright 桌面/移动验收。
