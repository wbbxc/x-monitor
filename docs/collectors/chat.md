# Discord 与 Telegram 采集

## Discord

### Bot 准备

1. 在 https://discord.com/developers/applications 创建 Bot。
2. 开启 **Message Content Intent**（否则正文可能为空，只能拿到附件/嵌入）。
3. 邀请 Bot 到服务器，授予：
   - View Channel
   - Read Message History
4. 来源与规则认证类型选 `Token`，填 Bot Token。

### 来源配置

```json
{
  "mode": "bot",
  "guildId": "1234567890",
  "channelIds": ["111", "222"],
  "includeThreads": false,
  "maxItems": 100,
  "maxPages": 1
}
```

| kind | value | 说明 |
|---|---|---|
| `channel` | 频道 ID | 采集频道消息 |
| `guild` | 空或服务器 ID | 采集配置中的频道 |
| `search` | 关键词 | 服务器消息搜索（需要 `guildId`） |

- 首次从最新消息开始；后续用消息 ID 游标只取新消息。
- 线程通过 `/channels/<id>/threads/active` 读取。
- 探活会校验 `/users/@me`、服务器、频道和读取历史权限，返回缺失项。

### 无 Token

只能使用邀请信息模式：

```json
{ "mode": "invite" }
```

返回服务器名称、成员数和邀请状态，并明确标记消息采集不可用；不会把“无法读取消息”伪装成空结果。

## Telegram

### 公开预览

来源 URL 填 `https://t.me/<channel>` 或 `https://t.me/s/<channel>`。无需凭据，抓取 `t.me/s/` 页面。

```json
{ "mode": "auto", "maxPages": 1, "maxItems": 100 }
```

规则 `kind=channel`，value 填 t.me 链接。

### Bot

1. 找 @BotFather 创建 Bot，取得 Token。
2. 把 Bot 加入频道并设为管理员。
3. 来源与规则认证类型选 `Token`。
4. 来源配置 `{"mode":"bot"}`。

限制：Bot 的 `getUpdates` 只能收到加入后的新消息，不能读取历史；运行详情会标注。

### MTProto（可选）

1. 从 https://my.telegram.org 取得 `api_id`/`api_hash`。
2. 生成已授权的 Telethon StringSession。
3. 安装可选依赖：

```bash
python3 -m pip install telethon
```

4. 认证类型选“多字段凭据”：

```json
{ "apiId": 123456, "apiHash": "...", "session": "..." }
```

5. 来源配置 `{"mode":"mtproto"}`。

未安装 Telethon 或 session 无效时返回 `MTPROTO_UNAVAILABLE`，适配器会尝试公开预览/Bot 降级。

### 私有邀请

`https://t.me/+...` 和 `https://t.me/joinchat/...` 无法通过公开预览采集，必须配置 Bot 或 MTProto。

### feed 兼容

原有 JSON/RSS/Bot API feed 来源继续可用，配置 `{"mode":"feed"}` 或 URL 以 `.json/.rss/.xml` 结尾即可。

## 隐私与限流

- 只采集公开频道或 Bot/MTProto 有权限访问的内容。
- 默认 1 请求/秒，429 按等待时间退避。
- 不实现 Discord self-bot、未授权私域抓取或验证码绕过。
