# 采集页面验收记录（2026-10-17）

验证对象：`#/collections` 采集总览、`#/collections/arxiv` 平台页、`#/collections/arxiv/items/1` 内容详情、`#/settings/collectors` 采集设置。

## 环境

- 服务：`node src/index.js` 的 HTTP 层（临时端口 3999），代理使用 `.env` 中的 `X_PROXY`。
- 数据：当日真实采集结果，`collection_items` 共 262 条（arXiv 50、Hugging Face 200、Web 12）。
- 浏览器：Playwright 驱动本机 Chrome，桌面 1440x900、移动 390x844。

## 结果

| 页面 | 桌面横向溢出 | 移动横向溢出 | 控制台错误 |
| --- | ---: | ---: | ---: |
| 采集总览 | 0 | 0 | 0 |
| 平台工作页 | 0 | 0 | 0 |
| 内容详情 | 0 | 0 | 0 |
| 采集设置 | 0 | 0 | 0 |
| linux.do 采集列表 | 0 | 0 | 0 |
| linux.do 设置弹窗 | 0 | 0 | 0 |
| linux.do 采集次数弹窗 | 0 | 0 | 0 |

移动端平台 chips 和运行记录表格在各自容器内横向滚动，不撑破文档宽度。

配置流程（Playwright 实际点击）：

1. 采集设置页平台下拉从 `/api/collections/adapters` 填充。
2. 新增临时采集源并写入 `headers` 认证 → 卡片显示"已配置 headers"，API 响应不含密钥。
3. 为临时源新增关键词规则 → 设置页立即出现该规则。
4. 打开对应平台页 → 显示新增采集源。
5. 平台页点击"暂停" → 状态刷新为"已暂停"。
6. 清理临时采集源。

## 产物

- `overview-desktop.png` / `overview-mobile.png`
- `platform-desktop.png` / `platform-mobile.png`
- `detail-desktop.png` / `detail-mobile.png`
- `settings-desktop.png` / `settings-mobile.png`
- `linuxdo-desktop.png` / `linuxdo-mobile.png`
- `ui-verification.json`：逐页溢出、可见视图、控制台错误和配置流程步骤的机器可读结果。
- `linuxdo-verification.json`：linux.do 关键词列表、分页、设置/采集次数弹窗和 YAML 落盘结果。
- `linuxdo-page2-desktop.png` / `linuxdo-page2-mobile.png`：第二页截图。
- `linuxdo-filter-desktop.png` / `linuxdo-filter-mobile.png`：分类 + 标签筛选截图。
- `linuxdo-taxonomy-verification.json`：分类名称、标签展示和筛选结果。
- `linuxdo-schedule-verification.json`：全局/规则级自动采集字段与 YAML 落盘结果。
- `linuxdo-layout-verification.json`：新框架布局、摘要、设置标签和保存/规则操作结果。
- `linuxdo-settings-desktop.png` / `linuxdo-settings-mobile.png`
- `linuxdo-counts-desktop.png` / `linuxdo-counts-mobile.png`

复跑方式：启动服务后执行 `test` 目录之外的验收脚本（需 Playwright）；本文档只记录本次结果，临时采集源已删除。

## linux.do 独立页与弹窗（2026-10-18）

- 页面框架：桌面为「列表 + 330px 右栏」，移动端单列；四格摘要（已入库/字段不完整/今日运行/自动采集状态）正常渲染，均无横向溢出。
- 设置弹窗三个标签（基础/自动/规则）切换正常；底部保存按钮可通过 `form` 属性提交；规则新建/删除和设置保存均验证通过。
- 分页：每页 50 条，实测第 1 页 50 条、第 2 页 38 条（共 88 条），上一页/下一页切换正常。
- 分类/标签：分类下拉 13 项（全部 + 12 个分类）；按「搞七捻三」筛选 38 条，再叠加标签「人工智能」17 条；搜索「人工智能」命中 49 条；详情页显示「搞七捻三 · #订阅节点」。
- 自动采集：设置弹窗开启全局自动（30 分钟）后 `settings.yaml` 写入 `autoLatestEnabled/autoLatestNextRunAt`；规则间隔 15 分钟创建后写入 `intervalMin/nextRunAt`，改回 0 后 `nextRunAt` 清空；关闭全局后状态复原。调度执行逻辑由 `test/linuxdo-scheduler.test.js` 覆盖（不发真实网络）。
- 采集次数弹窗包含 6 张统计卡（总运行/成功/警告/失败/运行中/今日）和最近 5 次运行记录。
- 新建规则 `UI 测试规则` → 生成 `data/linuxdo/rules/ui.yaml`；保存最大条数 31 → `settings.yaml` 落盘；删除规则后文件移除。测试后把最大条数恢复为 30。

## linux.do 独立页（2026-10-17）

- 真实采集：经本机代理（`X_PROXY`）使用 HTTP/2 拉取 `latest.json`，30 条话题入库；作者、标签、回复数正常解析。
- 关键词采集（无 Cookie）：自动扫描 `latest.json` + `top.json?period=weekly` 并按关键词本地过滤；实测 `AI` 扫描 80 条命中 20 条，API 运行新增 11 条入库。第二路公开源遇到 429 时保留第一路结果，运行状态为 warn。
- 桌面/移动横向溢出均为 0，控制台错误 0。
- 保存最大条数为 30 → `/api/linuxdo/overview` 读回 30。
- 采集总览的平台链接与来源列表不再包含 linux.do。
- 访问旧地址 `#/collections/linux.do` 自动进入 `#/linuxdo`。
