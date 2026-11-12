# Spec Delta

## Purpose

定义 Discord 与 Telegram 的频道采集：Discord 通过 Bot 读取服务器频道消息，Telegram 支持公开预览、Bot 更新和可选 MTProto 历史，并提供频道可访问性检测与明确的能力降级。

## ADDED Requirements

### Requirement: Discord bot connection and channel discovery

`discord` 适配器 SHALL 使用 Bot Token 认证，校验 Token 后读取 Bot 可访问的服务器和频道；来源配置 SHALL 支持服务器 ID、频道 ID 列表、是否包含线程和最大条数，并在探活时报告缺失的查看频道或读取历史权限。

#### Scenario: Probe Discord permissions

- **WHEN** 用户用有效 Bot Token 探活一个 Discord 来源
- **THEN** 系统返回 Token 有效、服务器可访问、频道可读，或明确列出缺失的权限

#### Scenario: Invalid bot token

- **WHEN** Discord 返回 401
- **THEN** 任务失败并提示 Bot Token 无效，不重试

### Requirement: Discord message collection

Discord 适配器 SHALL 按频道采集消息历史，使用消息 ID 作为游标向前翻页，保存正文、作者、发布时间、附件、嵌入内容、反应数和跳转链接；支持服务器级搜索规则和本地匹配过滤。

#### Scenario: Collect channel history

- **WHEN** 来源配置频道 ID 和最大 500 条
- **THEN** 适配器从最新消息开始按 `before` 游标翻页，直到达到上限或没有更多消息

#### Scenario: Search server messages

- **WHEN** 规则类型为搜索、关键词为 `release`
- **THEN** 适配器调用服务器消息搜索接口，并按统一匹配条件再次过滤

### Requirement: Discord anonymous fallback

没有 Bot Token 时，Discord 适配器 SHALL 只支持邀请信息探测模式，返回服务器名称、成员数和邀请状态；消息采集 MUST 明确失败并提示需要 Bot Token，不得把“无法读取消息”伪装成空结果。

#### Scenario: Invite metadata without token

- **WHEN** 来源配置为邀请链接且没有 Bot Token
- **THEN** 系统返回邀请对应的服务器公开信息，并在运行详情中标记消息采集不可用

#### Scenario: Message source without token

- **WHEN** 来源要求采集频道消息但没有 Bot Token
- **THEN** 任务失败并提示配置 Bot Token 以及 View Channel / Read Message History 权限

### Requirement: Telegram channel detection

`telegram` 适配器 SHALL 接受 `t.me` 频道、公开预览、私有邀请和帖子链接，先根据链接识别频道类型；在探活可用时返回标题、订阅数、描述和可用采集模式。检测 MUST 在保存来源前给出推荐规则类型和是否需要 Bot/MTProto 凭据。

#### Scenario: Detect public channel

- **WHEN** 用户提交 `https://t.me/durov`
- **THEN** 系统返回公开频道信息和可用的公开预览采集模式

#### Scenario: Detect private invite

- **WHEN** 用户提交 `https://t.me/+AbCdEf` 或 `https://t.me/joinchat/...`
- **THEN** 系统标记为私有邀请，提示需要 Bot 或 MTProto 凭据，并说明公开预览不可用

### Requirement: Telegram public preview collection

Telegram 适配器 SHALL 支持 `t.me/s/<channel>` 公开预览，解析消息文本、发布时间、作者/频道、媒体、链接和浏览数，使用消息 ID 作为 `before` 游标增量采集，并按频道与消息 ID 幂等入库。

#### Scenario: Collect public channel posts

- **WHEN** 规则监控 `https://t.me/s/durov`
- **THEN** 系统解析预览页中的消息，按时间倒序入库，并在下次运行只采集更新的消息

#### Scenario: Preview unavailable

- **WHEN** 频道没有公开预览或页面结构无法识别
- **THEN** 适配器返回明确错误并建议使用 Bot 或 MTProto 模式

### Requirement: Telegram authenticated modes

Telegram 适配器 SHALL 支持 Bot Token 模式和可选 MTProto 模式：Bot 模式通过 `getUpdates` 接收 Bot 可访问频道的新消息并保存 update 游标；MTProto 模式使用 `api_id`/`api_hash` 和会话读取公开频道历史；凭据 MUST 加密保存。

#### Scenario: Bot receives new channel post

- **WHEN** Bot 是频道管理员且收到新消息更新
- **THEN** 适配器采集该消息并推进 update 游标，重启后不重复采集

#### Scenario: MTProto history sync

- **WHEN** 配置了有效的 `api_id`/`api_hash` 和会话，规则要求采集频道历史
- **THEN** 适配器按 `min_id` 增量读取历史消息；未安装 Telethon 时 MUST 降级并说明原因

### Requirement: Telegram feed compatibility and rate limits

Telegram 适配器 MUST 继续支持现有 JSON、RSS 或 Bot API feed 来源；所有模式 SHALL 限制请求频率、遵守 429 退避，并在运行详情中记录实际使用的模式。

#### Scenario: Existing feed source still works

- **WHEN** 用户保留原有的 Telegram JSON/RSS feed 来源
- **THEN** 系统按原格式解析并入库，不需要迁移来源配置

#### Scenario: Telegram rate limit

- **WHEN** Telegram 返回 429 或要求等待
- **THEN** 适配器按等待时间退避，并记录本次运行使用的模式
