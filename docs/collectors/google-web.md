# Google 与通用 Web 采集

## Google

### 默认：Google News RSS

不需要任何凭据。规则 `kind=keyword`，`value` 为关键词。运行详情中的 `provider` 为 `google_news`。

### 网页搜索：Google Custom Search

1. 在 Google Cloud 启用 Custom Search API，创建 API Key。
2. 在 [Programmable Search Engine](https://programmablesearchengine.google.com/) 创建搜索引擎，取得 `cx`。
3. 来源与规则中认证类型选 `API Key`，填 API Key；来源配置填 `{"cx":"你的搜索引擎ID"}`。
4. 规则可以设置 `site`：

```json
{
  "site": "example.com",
  "maxPages": 3,
  "dateRestrict": "m1",
  "safe": "active",
  "fetchDetails": true
}
```

CSE 免费额度有限；失败会回退 Google News/Bing News 的 `site:` 搜索，并在运行详情记录 `degraded=true`。

## 通用 Web

来源 URL 可以留空，所有行为由规则 `options` 控制。

### 站点搜索

```json
{
  "mode": "search",
  "searchUrlTemplate": "https://example.com/search?q={query}&page={page}",
  "resultLinkPattern": "href=\"(/article/[^\"]+)\"",
  "resultLinkIncludes": ["/article/"],
  "maxPages": 5,
  "maxItems": 100,
  "fetchDetails": true
}
```

- `{query}` 会做 URL 编码，`{page}` 从 `pageStart`（默认 1）开始。
- 不配置 `searchUrlTemplate` 时，会用 Google/Bing News 的 `site:` 搜索兜底（标记降级）。
- `resultLinkPattern` 是正则，可使用捕获组；也支持默认的 `<a href>` 提取。

### 全量列表

```json
{
  "mode": "full",
  "listUrlTemplate": "https://example.com/news?page={page}",
  "pageStart": 1,
  "maxPages": 50,
  "stopAfterSeenPages": 2,
  "itemLinkIncludes": ["/news/"],
  "itemLinkExcludes": ["/tag/", "/author/"],
  "fetchDetails": true
}
```

也支持用 `nextLinkPattern` 跟随“下一页”，不依赖 `{page}`。

### Sitemap

```json
{
  "mode": "sitemap",
  "sitemapUrl": "https://example.com/sitemap.xml",
  "maxSitemaps": 5,
  "maxItems": 500,
  "fetchDetails": true
}
```

自动解析 sitemap index 并抓取子 sitemap。

### 详情提取

优先 JSON-LD、OpenGraph、`article`/`main`，最后回退到列表页标题/摘要。解析失败时保留原始 HTML 并标记字段不完整，不丢内容。

### robots 与限速

- 默认遵守 robots.txt；被禁止的路径会跳过并记录原因。
- 每个主机默认 1 请求/秒，可用 `config.rateLimit` 覆盖。
- 不提供验证码/Cloudflare 绕过。请只采集公开页面或你有权访问的站点。

## 本地验证

没有外网时可用 HTML fixture 或 `fetchImpl` 单测；真实站点先用一条 `maxPages:1` 的手动规则验证选择器，再扩大页数。
