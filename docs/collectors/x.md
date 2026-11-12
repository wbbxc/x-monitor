# X / Twitter 采集

## 前置条件

X 采集复用现有 `python/accounts.json`，不要求在来源与规则里再次填写 Cookie。

```bash
cd python
cp accounts.example.json accounts.json
chmod 600 accounts.json
```

支持两种登录方式：

1. **浏览器 Cookie（推荐）**：登录 x.com，复制 `auth_token` 与 `ct0`。
2. **账号密码**：风控较严，可能被验证码或二次验证拦截。

代理：

```env
X_PROXY=http://127.0.0.1:10808
# 或在 accounts.json 顶层 / 单个账号中配置 proxy
```

## 规则

| kind | value | 说明 |
|---|---|---|
| `account` | `karpathy` 或 `@karpathy` | 监控账号最新推文 |
| `keyword` | `"AI agent"` | 关键词搜索 |

常用 `options`：

```json
{
  "mode": "auto",
  "perAccount": 20,
  "maxItems": 100,
  "searchType": "latest",
  "minLikes": 10,
  "lang": "en",
  "since": "2026-01-01",
  "until": "2026-12-31"
}
```

- `mode`: `auto`（有账号走真实，否则 mock）/ `real` / `mock`。
- `maxItems`: 单次运行上限；账号规则默认 100。
- `searchType`: `latest` 或 `top`。
- `since`/`until`: `YYYY-MM-DD`。

## 命令验证

```bash
# 不访问 X，验证 worker 和 JSONL 输出
python3 python/worker.py search --query agent --per 5 --mode mock

# 真实账号抓取（需要 accounts.json）
python3 python/worker.py fetch --accounts karpathy --per 5 --mode real
```

## 失败排查

- `accounts.json 为空` / `所有账号密码登录失败`：改用 Cookie，或先在浏览器登录一次。
- 请求挂起：配置 `X_PROXY` 并验证 `curl -x http://127.0.0.1:10808 -I https://x.com`。
- 限流/登录失效：任务会按退避策略重试；检查账号是否被限制。
- 没有可用账号时不会静默返回空结果，会提示配置 Cookie 或改用 `mode=mock`。
