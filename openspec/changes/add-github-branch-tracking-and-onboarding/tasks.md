# Tasks

## 1. GitHub 分支与提交采集

- [x] 1.1 扩展 GitHub 规则选项与校验：支持 `branches`、`includeDefaultBranch`、`allBranches`、`includeMergeCommits`、`maxBranches`、`maxCommitsPerBranch`，校验分支名和事件集合；用单测覆盖合法/非法选项。
- [x] 1.2 实现分支解析：读取仓库默认分支、指定分支列表或 `/branches` 列表，去重并应用 `maxBranches`；用 fixture 验证默认分支、指定分支、全部分支三种模式。
- [x] 1.3 实现提交采集：调用 `/commits?sha=&since=&page=`，归一化 SHA、首行标题、完整提交信息、作者、时间、父提交、分支和规范链接；用 fixture 验证分页与字段。
- [x] 1.4 实现分支游标：按 `repos[repo].branches[branch].since/lastSha` 保存并恢复；失败不推进游标；用两次运行验证增量与中断恢复。
- [x] 1.5 实现 merge commit 过滤、每分支/整体数量上限和 SHA 幂等；用单测验证过滤计数与重复提交不重复入库。
- [x] 1.6 接入提交通知：首次入库生成 `commit` 事件通知，标题包含仓库、分支和提交首行；用 Runner 集成测试验证通知去重与 `notifyUpdates` 行为。
- [x] 1.7 更新 `docs/collectors/github.md` 的分支事件、选项、游标和限流说明；按 fixture 跑通一次分支提交采集。

## 2. GitHub 分支代码改动内容

- [x] 2.1 实现单提交详情读取：仅对本次运行的新提交调用 `/repos/{owner}/{repo}/commits/{sha}`，读取 `files[]`；用 fixture 验证只对新增提交请求，不重复请求已 `diffedShas`。
- [x] 2.2 归一化变更文件：文件名、重命名前文件名、状态、增删行数、变更总数、二进制标记、patch 可用性；用 fixture 覆盖 added/modified/removed/renamed/binary。
- [x] 2.3 生成代码改动摘要：`content` / `summary` 包含提交说明与变更文件列表，`metadata.codeChanges` 包含结构化文件和 commit/compare 链接；用单测验证内容格式。
- [x] 2.4 实现 patch 上限：`includePatch`、`maxPatchCharsPerFile`、`maxFilesPerCommit`、`maxDiffCommitsPerRun`，截断时设置 `truncated` 并保留增删行数；用单测验证上限。
- [x] 2.5 实现 `diffedShas` 游标：每分支最多保留 50 个已补丁 SHA，避免重复请求和游标无限增长；用两次运行验证。
- [x] 2.6 实现限流降级：403/429/404/网络错误时保留提交条目、设置 `codeChangesUnavailable`、停止后续补丁请求，运行标记降级而非失败；用 fixture 验证。
- [x] 2.7 更新 `docs/collectors/github.md` 的代码改动示例、上限和降级行为，并用 fixture 跑通一次含 patch 的采集。

## 3. 首次使用快速开始向导

- [x] 3.1 新增“快速开始”入口与三步向导：选择目标、填写最少信息、确认并试跑；用浏览器验证打开/关闭、步骤切换和返回。
- [x] 3.2 定义并接入四个目标预设：GitHub 分支代码、arXiv 论文、Google 关键词、Reddit 社区；用浏览器验证每个目标的预填字段与来源/规则摘要。
- [x] 3.3 实现向导创建流程：创建来源、创建规则、可选试跑；用临时数据库验证 GitHub 目标生成的规则包含 `branches` 和 `includeCodeChanges`。
- [x] 3.4 实现字段校验与错误保留：缺仓库/关键词/subreddit 时停留在当前步骤并显示字段错误，不写库；用浏览器验证。
- [x] 3.5 实现部分失败恢复：来源成功、规则失败时保留来源与表单，显示“来源已创建、规则未创建”，支持只重试规则；用 API mock 验证。
- [x] 3.6 向导关闭不写库，已填内容不持久化；用浏览器验证取消后来源/规则数量不变。

## 4. 新手任务清单与使用指南

- [x] 4.1 在仪表盘新增“开始使用”清单，展示配置 LLM、添加来源、创建规则、运行采集、查看通知五步及“快速开始”入口；用浏览器验证无来源与部分完成状态。
- [x] 4.2 从现有 API 计算步骤状态：LLM 配置、来源数量、规则数量、运行记录、通知未读/开启；不新增数据库表，用浏览器验证刷新后状态推进。
- [x] 4.3 完成状态持久化到 `localStorage`，全部完成后允许收起；用浏览器验证刷新后保持收起。
- [x] 4.4 新增“使用指南”导航项和 `view-guide` 视图，包含产品用途、四概念解释、三分钟上手、平台选择表、常见问题；用浏览器验证导航和跳转。
- [x] 4.5 平台选择表覆盖 GitHub、arXiv、Hugging Face、Google、Web、X、Reddit、Discourse、Telegram 的适用场景、必填值、认证提示；用静态检查确保每行可执行。
- [x] 4.6 指南页响应式与深色/浅色适配；用 1440px 和 390px 截图验证无横向滚动。

## 5. 推荐模板、导航与高级选项

- [x] 5.1 在“来源与规则”顶部添加四个模板按钮：GitHub 发布与分支代码、arXiv 关键词、Google 关键词、Reddit 社区；用浏览器验证按钮可见。
- [x] 5.2 实现模板填充：平台、名称、链接、配置、认证提示和推荐规则说明；不直接写库；用浏览器验证 GitHub 与 Reddit 模板字段正确。
- [x] 5.3 模板与快速开始共用预设数据，避免两套配置漂移；用单测或浏览器对比字段。
- [x] 5.4 导航整理为“开始 / 内容 / 采集 / 系统”四组，改名“采集总览→采集”“采集设置→来源与规则”，移除 linux.do 快捷入口；用浏览器验证路由与入口。
- [x] 5.5 新增“显示高级选项”开关，默认关闭；开启后显示 JSON、匹配条件和补丁限制，保留快捷字段值；用浏览器验证持久化。
- [x] 5.6 平台页内统一“采集详情 / 来源与规则 / 匹配条件 / 通知”术语，JSON 默认折叠；用静态检查和浏览器验证。

## 6. GitHub 快捷字段、空状态与术语

- [x] 6.1 规则表单新增 GitHub 快捷区：监控内容复选框、监控分支输入、采集代码改动开关、包含 merge commit 开关；仅 `github` 平台显示；用浏览器验证切换平台时显隐。
- [x] 6.2 保存规则时把快捷字段合并进 `options.events`、`options.branches`、`options.includeCodeChanges`、`options.includeMergeCommits`，高级 JSON 优先；用 API 测试验证保存结果。
- [x] 6.3 分支输入支持逗号分隔、去空、去重和 `main` 示例；留空表示默认分支；用浏览器/API 验证。
- [x] 6.4 规则列表展示 GitHub 事件、分支和代码改动摘要，不再只显示原始 JSON；用浏览器验证规则行可读。
- [x] 6.5 平台内容空状态改为“标题 + 原因 + 快速开始/打开来源与规则/立即采集按钮”；用浏览器验证无来源和无内容两种情况。
- [x] 6.6 规则空状态说明“规则决定采什么”，提供“使用 GitHub 推荐规则”并聚焦新建规则表单；用浏览器验证聚焦行为。
- [x] 6.7 通知抽屉与素材/推文空状态说明原因并提供下一步按钮；用浏览器验证。
- [x] 6.8 采集页、来源与规则页增加“来源=从哪里采，规则=采什么，匹配=留下什么，通知=提醒什么”的首次说明；用浏览器验证。

## 7. 文档、测试与验收

- [x] 7.1 更新 `README.md` 与 `docs/collectors/README.md` 的新手路径、导航改名、快速开始和平台选择说明；逐条执行文档中的分支代码采集命令。
- [x] 7.2 更新 `docs/collectors/github.md` 的代码改动内容、patch 限制、限流降级和示例 JSON；确保示例可直接复制使用。
- [x] 7.3 运行完整测试 `npm test`，确认无回归；GitHub 分支/代码改动 fixture、Runner 通知、API 保存选项、诊断测试全部通过。
- [x] 7.4 用临时数据库做端到端冒烟：快速开始创建 GitHub 规则 → 用 fixture 采集含两份变更文件的提交 → 查看内容中的文件摘要和 patch → 查看通知。
- [x] 7.5 浏览器验收 1440px/390px、深色/浅色：快速开始、任务清单、使用指南、模板、导航、GitHub 快捷字段、空状态均可用且无横向滚动。
- [x] 7.6 兼容性验收：已有 GitHub 规则（无 branches）行为不变；`includeCodeChanges` 关闭时不请求单提交详情；旧路由仍可访问。

## Workflow follow-up

- 实现与验收完成后，运行 `/openspec-archive-change` 归档本变更。
- 归档后检查 `openspec/specs/collectors/github/spec.md` 与 `openspec/specs/product-onboarding/spec.md` 已更新。

## 8. UI-20261111 工作区组合（用户批准的新任务）

- 目标：保留现有配色与业务能力，将主导航收敛为工作台、采集中心、内容库、创作、设置；来源和规则在当前平台内连续管理。
- 允许文件：`web/index.html`、`web/app.js`、`web/style.css`、`test/ui-workspaces.test.js`、本任务清单；仅做必要片段修改。
- 禁止范围：`src/**`、`python/**`、`data/**`、认证/采集/分析逻辑、依赖、其他测试及其他文档；保留所有继承的暂存/未暂存/未跟踪改动。
- 已完成项保护：保留 1–7 节历史；本任务仅按用户新授权调整 5.4 的导航组织及相关页面组合，不重写已完成的向导、GitHub 快捷字段、通知或原有表单业务。
- 基线：仓库外 `ui-implementation/boundary-before.json` 与前端三文件原文副本；当前 index 无暂存改动。
- 计划：回归测试先失败 → 导航与工作台 → 平台内来源/规则 → 内容库 → 桌面/移动、深浅主题与关键交互 → 完整 diff/边界检查。
- 复用：`switchView`、`renderCollectionBoard`、`loadCollectionPlatform`、`loadCollectorSettings`、`renderCollectorSetting`、`openQuickStart` 及现有 Token/按钮/标签页。
- 验收：五个主入口；旧视图/采集路由可达；当前平台不会显示其他平台来源；新增表单默认折叠；输入不被轮询覆盖；无页面级横向溢出；不改变 API 与数据链路。
- 提交策略：仅交付工作区 diff，不 commit、push 或部署。
- [x] 8.1 新增并验证界面回归测试的失败基线；额外覆盖草稿保护、内容库查询、规则仓库预填与快速轮询，最终 12 项通过。
- [x] 8.2 完成五工作区导航、内容库与工作台组合；旧视图/路由保留，原 137 个 DOM ID 无删除、无重复。
- [x] 8.3 完成平台内来源/规则与按需表单；来源保存/新增/删除、规则保存/暂停/删除均在隔离副本上验证，原 API 保留。
- [x] 8.4 完成自动测试、浏览器验收、设计统一和边界复核；`npm test` 108/108，`node --check web/app.js`、`git diff --check` 通过。
- 浏览器证据：仓库外 `ui-implementation/browser-smoke.log`；70 个断言通过，其中 40 组布局检查覆盖 10 个页面 × 深浅主题 × 1440×1024 / 390×844；无页面脚本异常、无页面级横向溢出。
- 边界证据：`ui-implementation/boundary-check.json` 为 `ok: true`；仅上述五文件变化，原 index 与边界外文件未变。对四个已存在脏文件仅允许本任务的增量修改，已与开工原文逐项 review。
- 设计统一：深浅主题 Token 哈希未变，复用既有控件与平台列表；来源表单只有一个共享实例，没有复制认证/配置保存逻辑，没有引入依赖。
- 未验证项：真实平台认证/采集、生产调度、LLM 分析/创作、完整读屏合规不在本次验收范围；浏览器使用 SQLite 副本，未启动调度器/Worker，删除确认在测试浏览器中自动接受。
- 交付状态：本地实现与验证完成，保留工作区 diff；未提交、未推送、未部署。

## 9. SEC-GIT-20261112 配置隔离与 main 合并准备

- 用户授权：检查敏感信息、补充 Git 忽略并将当前完整项目本地合并到 `main`；不推送、不清理或重写历史。
- 复用：现有 `.env` 加载/保存、账号模板与 `data/` 隔离；不迁移真实配置，不新增配置系统。
- 允许修改：`.gitignore`、`.env.example` 的 Key 模板行、`README.md` 配置说明、`docs/security/git-publish.md`、`test/git-safety.test.js`、本任务清单。
- 保护：其余源码、前序 UI 与采集能力、已有工作区改动、真实账号/配置/数据库均保持原样；既有 1–8 节不改写。提交范围包括经扫描的全部现有项目改动与本次安全补充。
- 基线：仓库外 `security-release/boundary-before.json`；index 初始为空；原分支 `keep-all`、HEAD `22cfb11`，`main` 为其祖先。
- [x] 9.1 扫描候选文件及全部历史；发现历史 X 账号备份，另有已分类的 localhost 测试私钥。
- [x] 9.2 新增安全回归失败基线，补齐环境变体/账号备份/认证导出/会话/私钥忽略规则；Key 模板清空，不改变真实配置。
- [x] 9.3 聚焦测试 3/3、全量测试 111/111；候选 182 文件与 160 历史 blob 交叉比对无当前真实值命中，Gitleaks 当前候选仅命中已分类测试私钥；边界检查通过。提交前暂存扫描零命中，完整 diff/新增文件及测试夹具已复核，证据保留仓库外。
- [x] 9.4 完整项目提交 `67f687d`，已从 `keep-all` 快进合并至 `main`，合并结果重跑测试 111/111、无跳过；保留 `keep-all` 分支。原 `.env`、`python/accounts.json`、`data/.collector-key` 哈希不变且仍被忽略。
- 验收证据：仓库外 `security-release/` 下 `boundary-check.json`、`staged-scan.json`、`known-values-audit.json`、`test-focused.log`、`test-full.log`、`test-main.log`；原始历史扫描保留真实命中，不用忽略项掩盖。
- 交付状态：本地合并完成；未推送、未部署、未重写历史，远端敏感历史仍待单独处理。后续验收记录提交仅修改本节，不改业务代码。
- 推送阻断：真实账号密码与 Cookie 已进入 `origin/keep-all` 可达历史，需要更换凭据并另行授权历史清理；未声称可以安全推送。

## 10. ENV-ROOT-20261112 统一配置与干净初始版本

- 用户授权：以当前代码作为全新初始版本，将需要手工配置的项目集中到 `.env`；用户自行处理 GitHub，本任务不删远端、不推送、不强推。
- 允许文件：`src/config.js`、`src/scraper.js`、`src/collectors/x.js`、`src/collectors/auth.js`、`src/db.js`、`src/server.js`、`python/local_settings.py`、`python/worker.py`、`python/diagnose_login.py`、`.env.example`、`test/env-config.test.js`、`test/git-safety.test.js`、`README.md`、`docs/security/env-configuration.md`、`docs/security/git-publish.md`、本任务清单；另允许备份并更新本地被忽略的 `.env`，在仓库外保留旧 Git 元数据后重建当前仓库。
- 禁止：前端、采集规则/内容数据、其它业务模块与测试、真实对外采集、停止或重启已有服务；旧账号与数据保留兼容，不丢失已完成改动。
- 复用：已有 dotenv 解析、账号 Cookie 规范化、认证校验/脱敏/加密、UI 保存入口；不新建第二套采集接口。
- 基线：仓库外 `env-initial-release/boundary-before.json`；分支 `main`、HEAD `47bc09b`、工作区干净。
- 测试隔离补充范围（实施前明确）：允许修改 `package.json` 的 test 命令并新增 `test/isolate-env.js`。原因是认证现改为 `.env` 写入，旧测试虽隔离 DATA_DIR，却可能误写真实 `.env`；必须让默认 `npm test` 自动隔离环境文件与认证，不能只依赖人工加环境变量。
- [x] 10.1 新增失败测试，覆盖全部模板项、Node/Python 账号读取、环境覆盖、原子安全保存、界面认证读写与脱敏。
- [x] 10.2 完成统一环境配置并迁移 1 个 X 登录账号、3 个来源认证与原主密钥；`.env` 权限 0600，旧账号与密钥文件哈希不变；迁移仅输出计数，不输出真实值。
- [x] 10.3 聚焦 10/10、全量 118/118 无跳过；JS/Python 语法、边界与 diff 检查通过。186 个候选文件与 21 项本机敏感值交叉扫描零命中；Gitleaks 仅命中已分类的 localhost 测试私钥。默认 npm test 自动隔离配置，真实 `.env` 哈希不变。
- [x] 10.4 旧 `.git` 已移至仓库外 `env-initial-release/private-backup/original.git`，当前目录重建 `main` 且未获取任何旧远端引用；经扫描的当前源码作为唯一初始版本。最终提交 hash、提交数、提交后复测与全历史扫描写入仓库外 `env-initial-release/final-report.json`，不为回填 hash 增加后续提交。
- 旧凭据曾进入远端的事实不因新初始版本消失；用户仍需更换密码/撤销旧会话。当前新 Git 历史和远端旧历史分别验收，不混为一谈。
