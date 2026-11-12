# 采集系统重构验收（2026-10-18）

## 范围

- 统一采集核心：DB 唯一规则/调度，YAML 仅导入导出。
- 统一平台工作台：内容 / 规则 / 运行三标签；linux.do 作为平台入口。
- 采集设置单页：来源、认证、配置 YAML 导出/导入。

## 结果

| 项目 | 结果 |
|---|---|
| 自动化测试 | 36/36 通过（迁移、调度、配置导入导出、适配器、API） |
| 总览 | 7 个平台卡片；最近运行显示平台 |
| linux.do 别名 | `#/linuxdo` → `#/collections/linux.do` |
| 平台工作台 | 摘要 4 格；内容 50 条/页；规则/运行标签正常 |
| 分页 | 131 条：第 2 页 50 条，第 3 页 31 条 |
| 分类筛选 | 分类 11 共 60 条，分页总数随筛选变化 |
| 规则 | 新建 15 分钟规则写入 `next_run_at`；自动最新开关读取 full 规则 |
| 配置导出 | 4 个来源、4 条规则写入 `data/collector/` |
| 移动端 | 390x844 无横向溢出，控制台错误 0 |

截图：`overview-desktop.png`、`linuxdo-desktop.png`、`rules-desktop.png`、`filter-desktop.png`、`settings-desktop.png`、`linuxdo-mobile.png`、`overview-mobile.png`。

机器可读结果：`refactor-verification.json`。

## 迁移

- 启动时 `collector-migrate.js` 把 `data/linuxdo/settings.yaml` 与规则一次性写入 SQLite，marker `collector_yaml_migrated_v1` 防重复。
- 旧 YAML 保留作备份；之后运行时不再读取。
