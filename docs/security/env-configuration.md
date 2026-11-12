# 统一 .env 配置

## 文件和优先级

首次运行复制 `.env.example` 为 `.env`，只在 `.env` 填入真实值；已有配置不要覆盖。模板列出全部应用配置项，JSON 值必须保持单行，不要在行末追加注释。`.env` 不是 shell 脚本，不要用 `source .env` 加载。

Node 与 Python 均自动读取项目根目录 `.env`，启动进程的环境变量优先。测试或独立实例可在启动前设置 `XMONITOR_ENV_FILE=/absolute/path/to/.env` 切换文件。配置文件应限制为当前用户可读写；界面保存使用原子写入和 `0600` 权限。普通配置修改后重启进程生效，当前进程通过界面保存的 LLM/认证会即时更新。

来源、规则、采集内容、任务和会话缓存仍存于被忽略的 `data/` 或 Python 运行数据中；这些是运行数据，不应放进 `.env` 或 Git。公开监控对象 `MONITOR_ACCOUNTS` 不是登录凭据。

`npm test` 自动使用每个测试进程独立的临时环境文件和数据目录，不加载或改写真实 `.env`；测试仍覆盖旧数据库认证兼容和新的 `.env` 认证模式。

## X 登录账号

`X_ACCOUNTS_JSON` 支持数组；多账号在数组中继续添加对象。以下均为格式占位，不是真实凭据：

```env
X_ACCOUNTS_JSON=[{"username":"your_username","password":"","email":"","email_password":"","cookies":{"auth_token":"replace_locally","ct0":"replace_locally"}}]
```

若使用账号密码，填写 `password/email/email_password` 并移除 `cookies`。也支持顶层对象 `{"proxy":"http://127.0.0.1:7890","accounts":[...]}`；代理优先级为 `X_PROXY`、顶层 proxy、单账号 proxy（Cookie 模式复用全局代理）。

- `X_ACCOUNTS_JSON=[]` 明确禁用登录账号，`auto` 模式使用演示数据。
- 省略或留空时兼容旧 `python/accounts.json`，无旧文件则按未配置处理。
- Node 的旧流水线、统一 X 采集器和直接运行 `python/worker.py` 使用相同配置来源。
- 不合法的 JSON 只报告配置项名称，不回显账号内容。

## 各平台认证

`COLLECTOR_AUTH_JSON` 结构为 `{"sources":{},"platforms":{}}`。`sources` 使用界面来源的完整 URL 为键，跨数据库重建时无需依赖来源 ID；同 URL 的来源共用认证，若需要隔离请勿创建相同 URL 的来源。`platforms` 使用规范平台 ID。具体来源优先于平台默认值，未匹配时兼容旧数据库认证。

```env
COLLECTOR_AUTH_JSON={"sources":{"https://linux.do/latest.json":{"type":"cookie","cookies":{"session":"replace_locally"}}},"platforms":{"github":{"type":"token","token":"replace_locally"},"telegram":{"type":"fields","fields":{"apiId":"123","apiHash":"replace_locally","session":"replace_locally"}}}}
```

认证结构沿用界面已有格式：

| type | 配置字段 |
| --- | --- |
| `none` | 不需要其它字段，显式禁用该来源认证 |
| `cookie` | `cookies` 对象或 Cookie 字符串 |
| `token` / `bearer` | `token`，可选 `header` |
| `api_key` | `token`，可选 `header`（默认 X-API-Key） |
| `basic` | `username`、`password` |
| `headers` | `headers` 请求头对象 |
| `fields` | `fields` 对象，如 Reddit clientId/clientSecret、Telegram apiId/apiHash/session |

GitHub、Hugging Face、Discord、Google 等平台的具体字段规则继续参考 `docs/collectors/`。Google 搜索引擎 ID 使用 `GOOGLE_CSE_CX`。X 的 twscrape 登录使用 `X_ACCOUNTS_JSON`，不使用此认证表。

当 `COLLECTOR_AUTH_JSON` 为非空 JSON 对象时，界面保存认证写入该来源的 URL 条目；清除认证写入 `{"type":"none"}`，不会因平台默认值而意外恢复。认证状态 API 仅返回类型与 configured/storage，不返回真实值。省略或留空此项时保留旧加密数据库保存方式。来源 URL 改动后需要在新 URL 下重新配置或保存认证。

## 主密钥与旧配置

`COLLECTOR_MASTER_KEY` 使用原 `data/.collector-key` 的 64 位十六进制表示可继续解密原数据库。已有数据不要换成随机新值；丢失原密钥会导致旧认证无法解密。新安装留空时仍会生成本机密钥文件。

本次本机迁移将现有账号、已保存的平台认证和原主密钥复制进私有 `.env`，并补齐模板中的其它运行参数；旧账号文件、加密数据库和密钥文件为兼容/恢复保留且仍被忽略。此操作不验证第三方凭据是否有效，也不替换此前泄漏过的密码/Cookie。
