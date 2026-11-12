# 采集器文档索引

统一采集内核支持“来源 + 规则 + 匹配条件 + 通知”的模型。所有平台共用任务队列、限流、游标、去重、加密认证和站内通知中心。

| 平台 | 能力 | 认证 | 公开降级 | 文档 |
|---|---|---|---|---|
| X / Twitter | 账号时间线、关键词搜索 | 复用 `python/accounts.json` | 无（可用 mock） | [x.md](x.md) |
| Google | News RSS、Custom Search | `api_key` + `config.cx` | Google/Bing News RSS | [google-web.md](google-web.md) |
| 通用 Web | RSS/JSON、站点搜索、全量列表、sitemap | 可选 Cookie/Headers | 公开页面 | [google-web.md](google-web.md) |
| arXiv | 关键词/作者/分类、分页 | 无 | 公开 API | [academic.md](academic.md) |
| Hugging Face | Daily Papers 全量同步 | 可选 Token | 官方 / hf-mirror | [academic.md](academic.md) |
| linux.do / macos.do | Discourse 最新/搜索/分类/标签 | 可选 Cookie | 公开 latest/top 扫描 | [forums.md](forums.md) |
| V2EX | 最新/节点/搜索 | 无 | API/RSS + sov2ex | [forums.md](forums.md) |
| Reddit | subreddit/账号/搜索 | `fields` OAuth | 公开 JSON | [forums.md](forums.md) |
| GitHub | Releases/Tags、Issues、PRs、Discussions、分支提交与代码改动 | 可选 Token | 公开 REST（Discussions 和代码改动建议 Token） | [github.md](github.md) |
| Discord | 频道消息、线程、服务器搜索 | Bot Token | 仅邀请信息 | [chat.md](chat.md) |
| Telegram | 公开预览、Bot、MTProto、feed | Bot Token / `fields` | `t.me/s/` 预览 | [chat.md](chat.md) |

## 通用配置

- 来源=从哪里采，规则=采什么，`options` 是平台查询参数，`match` 决定“留什么”，`notify`/`notifyUpdates` 控制站内通知。
- 认证通过来源与规则录入，使用 AES-256-GCM 加密；X 例外，复用 `python/accounts.json`（请确保文件权限为 600）。
- 未配置凭据时优先使用公开降级；无法降级的平台会返回明确错误，不会静默返回空结果。
- 站点全量采集默认遵守 robots.txt 和限速，不实现验证码/Cloudflare 绕过。
- 通知默认仅站内展示，不发送外部 Webhook/邮件。

## 链接识别

来源与规则页可粘贴链接调用 `POST /api/collections/detect`，自动推荐平台、规则类型和配置。已知域名离线识别，`probe=true` 时附带轻量探活。
