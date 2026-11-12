# GitHub 采集

监控仓库 Releases/Tags、Issues、Pull Requests、Discussions，以及分支提交和提交里的代码改动。

## Token

公开仓库可以不带 Token，但限额只有约 60 次/小时；分支代码改动会额外请求单提交详情，建议配置 Token。Discussions 必须 Token。

1. 创建 Personal Access Token（classic 或 fine-grained）。
2. 公开仓库只需 `public_repo` / 只读权限；私有仓库需要对应仓库读取权限。
3. 来源与规则页的认证类型选 `Token`，填入 Token（加密保存）。

## 规则

| kind | value | 说明 |
|---|---|---|
| `repo` | `openai/openai-node` 或仓库 URL | 仓库更新 |

### 监控内容

`options.events` 可选：

- `releases`：Releases；没有 Release 时可回退 Tags。
- `issues`：Issues，排除 Pull Request。
- `pulls`：Pull Requests。
- `discussions`：Discussions，需要 Token。
- `branches`：分支提交与代码改动。

### 分支与代码改动示例

```json
{
  "events": ["releases", "pulls", "branches"],
  "branches": ["main", "dev"],
  "includeDefaultBranch": false,
  "includeMergeCommits": false,
  "maxBranches": 10,
  "maxCommitsPerBranch": 50,
  "includeCodeChanges": true,
  "includePatch": true,
  "maxDiffCommitsPerRun": 10,
  "maxFilesPerCommit": 20,
  "maxPatchCharsPerFile": 2000
}
```

- `branches` 为空：只采集仓库默认分支，不论 `includeDefaultBranch` 的值。
- `branches` 非空：只采集列出的分支；`includeDefaultBranch: true` 时再合并默认分支。
- `allBranches: true`：读取仓库分支列表，最多 `maxBranches` 个；默认关闭。
- `includeMergeCommits: false`：过滤有两个及以上父提交的 merge commit。
- `includeCodeChanges`：默认 true；关闭后只保留提交信息，不请求单提交详情。
- `includePatch`：默认 true；关闭后仍保留文件名和增删行数。
- `maxDiffCommitsPerRun`：每轮最多补丁多少个提交，默认 10。
- `maxFilesPerCommit`：每个提交最多保留多少个文件，默认 20。
- `maxPatchCharsPerFile`：每个文件 patch 最大字符数，默认 2000；超出会截断并标记。

前端 GitHub 规则表单可直接勾选“分支提交 / 代码改动”和“采集代码改动”，不需要手写 JSON。分支输入留空表示默认分支。

### 代码改动内容

对本次运行的新提交，适配器会请求：

```text
GET /repos/{owner}/{repo}/commits/{sha}
```

读取 `files[]` 后写入：

- 内容正文：提交说明 + 变更文件列表（状态、文件名、增删行数）。
- `metadata.codeChanges.files`：文件名、重命名前文件名、状态、增删行数、二进制标记、patch 片段。
- `metadata.codeChanges.totalFiles` / `returnedFiles` / `truncated`。
- `metadata.codeChanges.commitUrl` / `compareUrl`。

内容示例：

```text
feat: add collector

变更文件 2 个：
- M src/collector.js +18 -4
- A docs/github.md +42 -0

提交：https://github.com/acme/repo/commit/abc123
对比：https://github.com/acme/repo/compare/parent...abc123
```

## 增量与限流

- 每个仓库/事件保存游标；分支游标结构为 `repos[repo].branches[branch].since/lastSha`。
- `diffedShas` 每分支最多保留 50 个已补丁 SHA，同一提交不重复请求详情。
- 401 立即失败并提示 Token 无效；403/429 区分权限和限流，遵守 `Retry-After` / `X-RateLimit-Reset`。
- 单提交详情 403/429：停止本轮补丁增强，提交仍入库并标记 `codeChangesUnavailable`，运行状态为降级而不是失败。
- 单提交详情 404/410：该提交标记代码改动不可用，继续处理其他提交。

## 通知

- 新 Release/Issue/PR/Discussion/分支提交首次入库生成站内通知。
- 分支提交通知标题形如 `owner/repo main: feat: xxx`，正文包含变更文件摘要。
- 已有条目状态变化默认只更新内容；规则开启 `notifyUpdates` 后，状态/评论变化会生成更新通知。

## 验证

```bash
# 使用 fixture，不访问 GitHub
node --test test/collectors-new.test.js
node --test test/collector-runner-notifications.test.js
```

真实仓库先建一条 `events:["branches"]`、`branches:["main"]`、`includeCodeChanges:false` 的规则，确认提交返回后再打开代码改动。
