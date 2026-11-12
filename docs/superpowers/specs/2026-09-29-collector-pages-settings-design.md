# 采集器独立页面与配置刷新设计

## 目标

将统一采集入口拆成平台独立工作页和内容详情页，并让不同采集源彼此隔离运行；认证配置保存后可立即被下一次采集读取，不需要重启服务。

## 保持不变

- 保留现有 X 账号、推文、素材和创作流程。
- 保留现有 `/api/collections/sources`、`/rules`、`/items`、`/runs` API 兼容行为。
- 继续使用 Node 原生 HTTP、SQLite 和原生前端，不引入新依赖。
- 认证密文不出现在 API 响应、日志和前端状态。

## 后端边界

`src/collection-engine.js` 使用来源级运行槽位，而不是单一全局锁。定时任务按来源分组并发运行，每个来源内部保持顺序；单个来源失败只影响自己的运行记录。紧急采集只跳过同一来源的并发任务。

采集器无长期认证缓存。每次运行从 `collectionAuth.get(source.id)` 读取当前密文并在请求前解密，因此保存认证后下一次定时或紧急采集立即使用新配置。新增刷新接口只负责验证来源和认证状态，并返回新的更新时间。

## 页面与路由

- `/collections`：跨平台状态总览，只保留状态、平台入口、紧急采集和运行/内容速览。
- `/collections/:platform`：单个平台的采集源、规则、运行记录、内容列表和采集动作。
- `/collections/:platform/items/:id`：单条内容详情、原始快照和全部来源链接。
- `/settings/collectors`：新增采集源，并按来源配置链接、规则、Cookie/Token/Basic/Headers 和刷新状态。

前端继续使用 hash 路由，避免改变本地静态服务和现有页面入口。

## 视觉系统

- 深色石墨工作台，单一青绿色强调色，避免紫色渐变和装饰性玻璃卡片。
- 平台导航与内容阅读分离，列表使用结构化行和少量边界线，不堆叠卡片。
- 详情页采用窄阅读列，原始 JSON 使用可折叠区域。
- 移动端平台导航横向滚动，内容和设置表单单列布局。
- 交互动画仅用于页面切换、状态反馈和按钮按压，尊重 reduced-motion。

## 验证

- 新增采集器隔离并发测试。
- 保留并运行现有统一采集测试。
- 运行 JS 语法检查和 `git diff --check`。
- 使用 Playwright 验证平台页面、详情页、设置保存和移动端无横向溢出。

## 入口收敛决策（2026-10-17）

`#/collections` 保留为采集总览与兼容入口，但不重复配置能力：新增采集源、规则和认证统一放在 `#/settings/collectors`，平台页负责运行与阅读。旧总览页的「添加采集源 / 定时规则」表单已迁至采集设置，避免同一操作存在两个入口；`#/collections` 的 hash 和历史链接保持可用。

采集请求统一经 `src/collectors/http.js` 发出：HTTPS 代理目标必须先完成 CONNECT 隧道和 TLS 握手，再交给 `https.request`，不得使用会退化为直连的 `agent:false`。

## linux.do 独立入口（2026-10-17）

linux.do 从统一采集控制台抽出，成为侧边栏独立功能：

- 页面：`#/linuxdo`，包含采集配置（站点 JSON/RSS 地址、最大条数、正文补全、Cookie）、关键词采集、话题列表、运行记录和统计。
- 采集器：`src/collectors/linuxdo.js`，支持 Discourse latest、公开话题扫描、关键词搜索、RSS 降级和正文补全，不再依赖统一采集框架的论坛实现。
- 关键词降级：无 Cookie 或站内搜索失败时，自动扫描 `latest.json` 与 `top.json?period=weekly`，去重后本地过滤；`config.keywordFallback=false` 可关闭，`config.publicFeeds` 可追加公开地址。
- 网络：linux.do 由 Cloudflare 保护，采集经代理使用 HTTP/2 + 浏览器请求头；HTTP/1.1 仅作兼容回退。
- API：`GET /api/linuxdo/overview`、`POST /api/linuxdo/collect`、`POST /api/linuxdo/source`。
- 入口唯一：linux.do 不出现在采集总览、平台链接和采集设置中；旧地址 `#/collections/linux.do` 自动跳转到 `#/linuxdo`，单条内容详情仍复用通用详情页。
- 页面拆分：主视图只保留采集列表；设置和采集次数为弹窗。设置与每条采集规则写入本地 `data/linuxdo/settings.yaml` 和 `data/linuxdo/rules/<slug>.yaml`，Cookie 仍只存数据库加密表。
- 规则执行：弹窗中的规则可立即采集；规则 YAML 由 `src/linuxdo-store.js` 读写，slug 只允许小写字母、数字和连字符。
- 主列表：顶部展示「待采集关键词」（来自启用的关键词规则 YAML，含上次触发时间），下方采集列表每页 50 条，提供上一页/下一页和页码信息。
- 分类与标签：`category_id` 通过 `GET /api/linuxdo/categories` 映射为名称（缓存在 `data/linuxdo/categories.json`）；列表卡片和详情页显示分类/标签；列表支持分类下拉、标签输入筛选，搜索同时匹配标签；分页总数按筛选结果计算。
- 页面框架：主区域为采集列表（搜索、分类/标签筛选、分页），右侧栏放「待采集关键词」和「临时关键词」；窄屏自动堆叠。设置弹窗拆为「基础设置 / 自动采集 / 采集规则」三个标签，避免单页过长；采集次数独立弹窗。
- 自动采集：服务端每分钟检查一次。全局 `autoLatestEnabled/autoLatestIntervalMin` 控制最新话题；规则级 `intervalMin` 控制关键词规则，`0` 表示仅手动。到期任务串行执行，`runCollections` 返回 skipped 时不推进下一次时间；执行后把 `lastRunAt/nextRunAt` 写回 YAML。`settings.yaml` 与规则文件是调度状态的来源。

## 采集核心统一（2026-10-18）

- SQLite 成为唯一运行态：sources/rules/auth/items/runs；YAML 只做 `data/collector/` 导入导出。
- 删除 linux.do 专属 overview/settings/rules/collect/source API 与第二套调度；`#/linuxdo` 重定向到 `#/collections/linux.do`。
- 平台工作台统一为「内容 / 规则 / 运行」三标签；规则含名称、间隔、上次/下次时间；自动最新话题是一条 full 规则。
- 旧 linux.do YAML 通过启动迁移写入 DB，保留原文件。
