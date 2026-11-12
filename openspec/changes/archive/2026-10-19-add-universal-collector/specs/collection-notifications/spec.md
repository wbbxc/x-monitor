# Spec Delta

## Purpose

定义站内通知中心：新采集内容命中规则后生成可追踪的通知，提供未读徽标、筛选列表和已读操作，让用户不必反复刷新各平台工作台。

## ADDED Requirements

### Requirement: Notification creation

系统 SHALL 在“新内容首次入库且命中规则”时创建通知，前提是该规则的通知开关开启；重复采集、内容更新和未命中匹配条件的内容 MUST NOT 重复创建通知。

#### Scenario: New matched item creates notification

- **WHEN** 一条首次入库的 GitHub Release 命中规则且该规则开启通知
- **THEN** 系统创建一条包含平台、来源、规则、标题和内容链接的通知，并标记为未读

#### Scenario: Updated item does not duplicate notification

- **WHEN** 同一个 Pull Request 在后续运行中内容或状态发生变化但已存在通知
- **THEN** 内容记录被更新，通知数量不增加，未读状态保持不变

#### Scenario: Disabled notification produces nothing

- **WHEN** 规则的通知开关关闭
- **THEN** 即使内容首次入库并命中规则，也不创建通知

### Requirement: Unread badge

系统 SHALL 提供未读通知计数，并在顶栏展示未读徽标；未读数为零时徽标 MUST 隐藏，未读数变化后前端 MUST 在轮询或下一次页面刷新时更新。

#### Scenario: Badge reflects unread count

- **WHEN** 用户有 3 条未读通知
- **THEN** 顶栏铃铛显示 `3`；全部标记已读后徽标消失

#### Scenario: New notification increments badge

- **WHEN** 后台采集产生一条新通知且页面保持打开
- **THEN** 下一次轮询后未读数增加，无需刷新页面

### Requirement: Notification list and filters

系统 SHALL 按时间倒序返回通知列表，支持按平台、未读状态和分页参数筛选；每条通知 MUST 包含内容标题、平台、规则名称、创建时间、已读状态和可跳转的内容标识。

#### Scenario: Filter unread GitHub notifications

- **WHEN** 客户端请求平台为 `github` 且仅未读的通知
- **THEN** 只返回匹配条件的通知，按最新优先排序并支持分页

#### Scenario: Notification for deleted item

- **WHEN** 通知关联的内容已被删除
- **THEN** 列表仍显示通知摘要，但跳转时提示内容已不可用，而不是报错中断页面

### Requirement: Read state management

系统 SHALL 支持将单条通知标记为已读、将全部通知标记为已读，并对重复标记保持幂等；标记不存在的通知 MUST 返回 404。

#### Scenario: Mark one as read

- **WHEN** 用户点击一条未读通知
- **THEN** 该通知变为已读，未读计数减一，并跳转到内容详情

#### Scenario: Mark all as read

- **WHEN** 用户点击“全部已读”
- **THEN** 所有未读通知变为已读，未读计数归零

#### Scenario: Unknown notification

- **WHEN** 客户端标记一个不存在的通知
- **THEN** 系统返回 404，且不改变其他通知状态

### Requirement: Notification retention

系统 SHALL 在内容被删除时级联删除对应通知，并按保留策略清理超出上限或过期的已读通知；清理 MUST NOT 改变未读通知的状态。

#### Scenario: Delete item removes notification

- **WHEN** 用户删除一条采集内容
- **THEN** 关联通知一并删除，未读计数相应减少

#### Scenario: Retention cleanup

- **WHEN** 已读通知超过保留天数
- **THEN** 系统在维护任务中删除这些通知，未读通知不受影响
