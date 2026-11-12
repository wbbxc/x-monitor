# arXiv 与 Hugging Face 采集

## arXiv

来源 URL 默认 `https://export.arxiv.org/api/query`，也可以使用镜像地址（`config.baseUrl`）。

规则：

| kind | value 示例 | 说明 |
|---|---|---|
| `keyword` | `large language model` | 自动加 `all:` 前缀 |
| `author` | `Yann LeCun` | 自动加 `au:` 前缀 |
| `category` | `cs.AI` | 自动加 `cat:` 前缀 |
| `full` | 空 | 最新提交全量 |

已经带前缀的查询（`au:`、`cat:`、`ti:`、`id:` 等）会原样传给 arXiv。

```json
{
  "maxResults": 500,
  "pageSize": 100,
  "sortBy": "submittedDate",
  "sortOrder": "descending"
}
```

- `maxResults`: 单次全量同步上限。
- `pageSize`: 每页条数。
- 连续请求间隔 3 秒；429 按退避重试。
- 分页游标在中断后保留，下次从下一页继续。

## Hugging Face / hf-mirror

来源 URL 默认 `https://huggingface.co/api/daily_papers`。镜像：

```json
{
  "baseUrl": "https://hf-mirror.com",
  "pageSize": 100,
  "maxPages": 0,
  "fallbackToOfficial": true
}
```

- `baseUrl`: 官方或 hf-mirror；API 和论文链接都会使用该地址。
- `pageSize`: 每页条数。
- `maxPages`: 0 表示沿 `Link: rel="next"` 同步到末页。
- 镜像失败且 `fallbackToOfficial=true` 时自动切官方，运行详情 `degraded=true`。

规则 `kind=keyword` 是**本地过滤**：先同步 Daily Papers，再按标题/摘要/作者/AI 关键词匹配；不会调用未公开的搜索接口。

## 常见错误

- arXiv 返回 429：等待冷却，降低 `maxResults`/提高间隔。
- HF 返回非 JSON：检查 `baseUrl` 是否指向 API 根路径。
- hf-mirror 超时：确认网络可达，或关闭镜像使用官方。
- 论文链接指向镜像但打不开：检查 `baseUrl` 是否带多余路径。
