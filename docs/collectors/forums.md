# 论坛与社区采集：Discourse / V2EX / Reddit

## linux.do 与 macos.do

两者共用 Discourse 适配器，默认地址分别是：

- `https://linux.do/latest.json`
- `https://macos.do/latest.json`

规则：

| kind | value | 说明 |
|---|---|---|
| `full` | 空 | 最新话题 |
| `keyword` | `AI` | 站内搜索 `/search.json` |
| `category` | `develop` 或分类 ID | 分类话题 |
| `tag` | `ai` | 标签话题 |

配置：

```json
{
  "maxItems": 500,
  "keywordFallback": true,
  "fetchDetails": false
}
```

- 无 Cookie 时关键词搜索会降级为公开 latest/top 扫描 + 本地匹配。
- 有 Cookie 但搜索失败时也会降级，运行详情记录 `reason`。
- Cloudflare/403：提示检查 Cookie、登录状态或代理；不会伪装成“没有结果”。
- 分类缓存按平台隔离：`data/collector/categories-linux.do.json`、`categories-macos.do.json`。

## V2EX

默认 `https://www.v2ex.com/api/topics/latest.json`。

| kind | value | 说明 |
|---|---|---|
| `full` | 空 | 最新主题 |
| `node` | `programming` | 节点主题 |
| `keyword` | `独立开发` | sov2ex 搜索 |

```json
{
  "maxItems": 100,
  "maxPages": 1,
  "fallbackPublic": true
}
```

- 搜索优先使用 `https://www.sov2ex.com/api/search`；失败时回退公开主题 + 本地匹配，标记 `degraded=true`。
- API 返回 RSS/Atom 时自动按 feed 解析。

## Reddit

公开模式不需要凭据；OAuth app-only 更稳定。

### 公开 JSON

规则：

| kind | value | 说明 |
|---|---|---|
| `subreddit` | `programming` | 最新/热门帖子 |
| `keyword` | `AI agent` | 搜索 |
| `account` | `spez` | 用户投稿 |

```json
{ "sort": "new", "maxPages": 1, "maxItems": 100, "fallbackPublic": true }
```

### OAuth app-only

1. 在 https://www.reddit.com/prefs/apps 创建 app（类型 script）。
2. 来源与规则认证类型选“多字段凭据”，填写：

```json
{ "clientId": "...", "clientSecret": "..." }
```

3. 适配器自动获取并缓存 token，通过 `oauth.reddit.com` 采集。
4. OAuth 失败且 `fallbackPublic !== false` 时回退公开 JSON，运行详情标记降级。

## 本地验证

```bash
# 只验证解析和分页，不访问外网
node --test test/collectors-new.test.js
```
