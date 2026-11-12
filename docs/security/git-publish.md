# Git 推送前安全检查

## 当前发布方式：全新初始版本

按 2026-11-12 新授权，当前代码将作为新仓库的单个初始提交，分支名为 `main`；原 `.git` 整体移动至仓库外的私有备份，不带入新仓库。不要从旧远端 fetch、pull 或 merge，否则可能重新引入敏感历史。

真实配置统一放在 `.env`，完整格式见 [env-configuration.md](env-configuration.md)。只发布 Git 跟踪文件；不要把整个目录（含隐藏文件和运行数据）直接上传 GitHub。

用户删除并重建 GitHub 仓库后，确认远端为空且 `origin` 指向正确地址，再从当前目录执行 `git push -u origin main`。不要使用 `--all`、`--mirror` 或强推。若远端仍有旧分支，先处理旧远端，不拉取旧历史到当前新仓库。

全新本地历史不会使过去泄漏的凭据自动失效。删除 GitHub 仓库也不能保证清除其他克隆、缓存或派生副本；仍需更换已暴露的密码并撤销旧会话。本任务不执行远端删除、推送或账号轮换。

## 配置边界

| 用途 | 本地文件（不提交） | 可提交模板 |
| --- | --- | --- |
| 服务、LLM、代理配置 | `.env`、`.env.*`（非 example） | `.env.example`、`.env.*.example` |
| X 登录账号、密码、Cookie | `.env` 的 `X_ACCOUNTS_JSON`；旧账号文件及备份仅作兼容 | `.env.example`、旧 `python/accounts.example.json` |
| SQLite、采集配置、主密钥 | `data/`、`*.db*` | 源码中的默认值及无凭据文档示例 |
| 认证导出、会话、私钥 | `cookies*.json`、`credentials*.json`、`storage-state.json`、`*.session`、私钥文件 | 不提交真实认证导出 |

保留旧账号与数据兼容，认证设置现在统一写回 `.env`。需要手动导出 YAML 或认证数据时，放在 `data/` 或 `backups/` 内；不要依赖文件名匹配保护任意位置的导出。

`test/fixtures/proxy-test-{cert,key}.pem` 是仅供隔离 HTTPS 代理测试使用的自签 localhost 证书与配套私钥，不用于服务部署。该精确路径保留为测试夹具；其余 PEM/私钥文件默认忽略。不要给所有测试文件设置扫描豁免。

## 2026-11-12 原仓库检查记录（重建前）

- 当前候选源码未检出本机真实配置值；`.env`、账号文件和运行数据不在 Git index。
- 全部分支可达历史中，`e91c7c8` 的 `python/accounts.json.bak` 曾包含真实 X 账号、密码和认证 Cookie；虽然该文件后来删除，旧提交仍能读取。
- 历史备份中的账号密码、`auth_token` 和 `ct0` 与本地账号配置仍一致；未向 X 请求验证其有效性。
- `origin/keep-all` 包含上述历史。仅新增 `.gitignore`、删除当前文件或合并 `main`，均不能消除已发布的历史凭据。
- 上一次任务仅本地合并、不重写历史；本节保留当时发现，不代表新仓库仍包含上述提交。

旧仓库后续处理：

1. 在 X 更改该账号密码、注销现有登录会话，重新获取 Cookie；若密码复用，更新相应账户。不要把新值写入模板或提交。
2. 若保留旧仓库，需要与协作者确认历史清理方案及受影响分支/标签。本次用户选择以当前代码创建全新初始版本，而不是改写并强推旧提交。
3. 检查远端分支、标签、PR、缓存及其他克隆中残留的旧历史；必要时联系托管平台处理，不把本地扫描通过等同于远端彻底清除。
4. 对清理后的全部历史、暂存区、待发布图片与文档重新扫描，再推送。

## 本地验证命令

```bash
node --test test/git-safety.test.js
npm test
git diff --cached --check
gitleaks git . --log-opts='--all --full-history' --ignore-gitleaks-allow --redact
gitleaks git . --pre-commit --staged --ignore-gitleaks-allow --redact
```

Gitleaks 应单独安装，无需加入应用依赖。原始扫描应能检出上述历史问题和测试私钥，不能通过宽泛忽略或零退出码掩盖。人工复核只对精确的测试夹具路径分类。

扫描范围包括 Git 候选文件、全部本地及已获取远端引用的可达提交，并与本地敏感配置值做精确交叉比对；不代表验证所有第三方凭据的有效性，也不保证覆盖图片文字、不可达对象、远端缓存或服务端日志。
