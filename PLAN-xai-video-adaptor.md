# Plan: 实现 xAI 视频 Task Adaptor

## Context

xAI 的 `grok-imagine-video` 模型已加入 NewAPI 的模型列表，但没有对应的 Task Adaptor。请求视频生成时：
- 渠道类型 48（xAI）→ `GetTaskAdaptor` 返回 nil → 报 `invalid api platform: 48`
- 强改渠道类型为 Sora/OpenAI → Sora adaptor 请求 URL 和响应解析都不匹配 → 报 `task_id is empty`

上游（QuantumNous/new-api）同样没有实现此功能。

## xAI Video API 格式（官方文档）

### 提交
- 文生视频: POST `{baseURL}/v1/videos/generations`
- 视频编辑: POST `{baseURL}/v1/videos/edits`
- 视频延展: POST `{baseURL}/v1/videos/extensions`
- 请求体: `{"model": "grok-imagine-video", "prompt": "...", "duration": 10, "aspect_ratio": "16:9", "resolution": "720p"}`
- 响应体: `{"request_id": "uuid-string"}`

### 轮询
- GET `{baseURL}/v1/videos/{request_id}`
- 响应体: `{"status": "done", "video": {"url": "...", "duration": 1, "respect_moderation": true}, "model": "grok-imagine-video", "usage": {"cost_in_usd_ticks": 500000000}, "progress": 100}`
- status 值: `"done"` / `"expired"` / 其他（处理中）

### 与 Sora 的关键差异
| 对比项 | Sora (OpenAI) | xAI |
|--------|---------------|-----|
| 提交端点 | /v1/videos | /v1/videos/generations |
| 提交响应 ID 字段 | `id` | `request_id` |
| 轮询端点 | /v1/videos/{id} | /v1/videos/{request_id} |
| 完成状态 | `"completed"` | `"done"` |
| 失败状态 | `"failed"` / `"cancelled"` | `"expired"` |
| 视频 URL 位置 | 需通过 proxy content 端点 | `video.url` 直接返回 |
| 进度字段 | `progress` (int 0-100) | `progress` (int 0-100) |

## 实现步骤

### Step 1: 新建 xAI task adaptor 包

创建目录 `relay/channel/task/xai/`，包含两个文件：

**constants.go**
- 定义 `ModelList`（含 `grok-imagine-video`、`grok-imagine-video-1.5-preview`）
- 定义 `ChannelName = "xai"`

**adaptor.go**
- 定义 `TaskAdaptor` struct，内嵌 `taskcommon.BaseBilling`，存储 `channelType`、`baseURL`、`apiKey`
- 实现 `TaskAdaptor` 接口的所有方法：
  - `Init`: 从 RelayInfo 读取 channelType、baseURL、apiKey
  - `ValidateRequestAndSetAction`: 解析 JSON 请求体，设置 action（generate/edit/extend），校验 prompt 非空
  - `EstimateBilling`: 从请求中提取 duration，返回 `{"seconds": duration}` 作为 OtherRatios
  - `BuildRequestURL`: 根据 action 拼接正确端点（/v1/videos/generations、/v1/videos/edits、/v1/videos/extensions）
  - `BuildRequestHeader`: 设置 Bearer token 和 Content-Type: application/json
  - `BuildRequestBody`: 读取缓存的请求体，替换 model 为 `info.UpstreamModelName`，直接传 JSON
  - `DoRequest`: 委托给 `channel.DoTaskApiRequest`
  - `DoResponse`: 读取响应体，解析 `request_id` 字段作为 upstream task ID；向客户端返回统一格式（用 info.PublicTaskID 替换）
  - `FetchTask`: GET `{baseURL}/v1/videos/{request_id}`，带 Bearer auth
  - `ParseTaskResult`: 解析轮询响应，映射 status（done→Success, expired→Failure, 其他→InProgress），提取 `video.url` 和 `progress`
  - `GetModelList` / `GetChannelName`: 返回常量
  - `AdjustBillingOnSubmit`: 内嵌 `BaseBilling` 提供默认空实现即可（提交时无额外计费调整）
  - `AdjustBillingOnComplete`: 若 xAI 响应中包含 `usage.cost_in_usd_ticks`，可在此方法中根据实际用量调整结算金额；初版可先用 `BaseBilling` 默认实现，后续迭代再接入实际 usage
- 实现 `OpenAIVideoConverter` 接口的 `ConvertToOpenAIVideo` 方法，将存储的 task data 转换为 OpenAI Video API 格式输出

### Step 2: 注册 adaptor

修改 `relay/relay_adaptor.go` 中的 `GetTaskAdaptor` 函数：
- 在 switch 中添加 `case constant.ChannelTypeXai:` 返回 `&taskxai.TaskAdaptor{}`
- 添加对应的 import

### Step 3: 确认 action 路由

检查 `relay/common/` 中的 `ValidateMultipartDirect` 以及视频路由中间件，确保：
- POST `/v1/video/generations` 能正确路由到 xAI adaptor（当渠道类型为 48 时）
- **注意**: xAI 上游端点是 `/v1/videos/generations`（带 s），而 NewAPI 前端路由是 `/v1/video/generations`（不带 s）。`BuildRequestURL` 必须拼接上游的 `/v1/videos/generations`，不要照搬前端路由路径
- xAI 不需要 multipart，只需 JSON，所以 ValidateRequestAndSetAction 要自行处理 JSON 解析而非依赖 ValidateMultipartDirect

### Step 4: action 映射（可选）

如果需要支持 edit 和 extension 端点：
- 定义新的 action 常量（如 `TaskActionVideoEdit`、`TaskActionVideoExtend`）或复用现有的
- 在 `ValidateRequestAndSetAction` 中根据请求路径判断 action
- `BuildRequestURL` 根据不同 action 拼不同路径

### Step 5: Billing 安全校验

遵循 `AGENTS.md` 中的 billing safety invariants：
- **duration 上限校验**: 在 `ValidateRequestAndSetAction` 中对请求的 `duration` 字段强制上限（复用 `relaycommon.MaxTaskDurationSeconds`），超出返回 400
- **quota 溢出防护**: `EstimateBilling` 返回的 `{"seconds": duration}` 会乘以 model ratio 进入预扣费，确保乘积通过 `common.QuotaFromFloat` / `QuotaFromFloatChecked` 转换，不使用裸 `int()` 强转
- **结算阶段**: `AdjustBillingOnComplete` 如果后续接入 `usage.cost_in_usd_ticks`，需对该值做合理性校验（非负、非 NaN、上限 clamp），用 `*Checked` 变体并将 `QuotaClamp` 挂到 `relayInfo.QuotaClamp` 上
- **预扣费 vs 结算一致性**: 预扣费（基于请求 duration 预估）和结算（基于实际 usage）的差额退款路径需走标准 settle 流程

## 关键参考文件

- 接口定义: `relay/channel/adapter.go` (TaskAdaptor interface — 共 14 个方法，含 Init/Validate/Billing×3/Request×3/HTTP×2/Meta×2/Polling×2)
- OpenAIVideoConverter 接口: `relay/channel/adapter.go` (可选，单方法 `ConvertToOpenAIVideo`，Sora 已实现)
- Sora 参考实现: `relay/channel/task/sora/adaptor.go` (~330 行，最佳参考模板)
- 通用帮助: `relay/channel/task/taskcommon/helpers.go` (BaseBilling, BuildProxyURL, UnmarshalMetadata, DefaultString/DefaultInt)
- 请求分发: `relay/channel/api_request.go` (DoTaskApiRequest)
- adaptor 注册: `relay/relay_adaptor.go` (GetTaskAdaptor, line ~138, switch on channelType)
- 渠道常量: `constant/channel.go` (ChannelTypeXai = 48, BaseURL = "https://api.x.ai")
- 现有 xAI 模型列表: `relay/channel/xai/constants.go` (grok-imagine-video 已在列表中)
- TaskInfo 结构: `relay/common/relay_info.go`
- Quota 安全转换: `common/quota_math.go` (QuotaFromFloat, QuotaRound, QuotaFromDecimal 及 *Checked 变体)
- Duration 上限常量: `relay/common/` (MaxTaskDurationSeconds)

## 验证方式

1. 编译通过: `go build ./...`
2. 用测试 key 调用 `POST /v1/video/generations` with model `grok-imagine-video`，确认返回 task_id
3. 用返回的 task_id 调用 `GET /v1/video/generations/{task_id}`，确认能轮询到状态和最终 video URL
4. 确认原有 Sora/OpenAI 渠道的视频功能不受影响

## 本地评估与完善记录（2026-07-09）

### 官方更新同步
- 已执行 `git fetch --all --prune` 并将 `upstream/main` 合并到本地 `main`。
- 合并时处理了 `relay/relay_task.go` 与 `service/task_billing.go` 冲突，保留本地 SKU/other_ratios 收据逻辑，并吸收上游 `PriceData.ReplaceOtherRatios` / `OtherRatios()` 安全过滤改动。
- 已生成本地 merge commit：`36f8d877 Merge remote-tracking branch 'upstream/main'`。
- 未执行 push，等待后续统一推送计划。

### xAI Video Adaptor 实现结果
- 新增 `relay/channel/task/xai/`：
  - `constants.go`：定义 xAI task channel、视频端点、状态、模型列表，以及 generate 1–15 秒、extension 2–10 秒 duration 约束。
  - `adaptor.go`：实现 `channel.TaskAdaptor` 与 `channel.OpenAIVideoConverter`。
  - `adaptor_test.go`：覆盖请求校验、URL 构建、模型映射、`request_id` 响应解析、轮询状态映射、OpenAI Video 输出转换。
- 已在 `relay/relay_adaptor.go` 注册 `constant.ChannelTypeXai` → `taskxai.TaskAdaptor`，修复渠道类型 48 视频提交时 `invalid api platform: 48`。
- 已在 `router/video-router.go` 增加 xAI 官方风格提交路由：
  - `POST /v1/videos/generations`
  - `POST /v1/videos/edits`
  - `POST /v1/videos/extensions`
  原有 `POST /v1/video/generations` 与 OpenAI compatible `POST /v1/videos` 继续可用。
- 已在 `relay/channel/xai/constants.go` 增补视频模型：
  - `grok-imagine-video-1.5`
  - `grok-imagine-video-1.5-preview`

### 关键行为确认
- 提交端点按 action 映射到上游：
  - generate → `/v1/videos/generations`
  - edit → `/v1/videos/edits`
  - extend → `/v1/videos/extensions`
- 提交响应解析上游 `request_id`，内部存储真实 upstream task id，对客户端返回本地公开 `task_*` ID。
- 轮询端点使用 `GET /v1/videos/{request_id}`。
- 轮询状态映射：
  - `done` → `SUCCESS`，提取 `video.url` 为任务结果 URL。
  - `expired` / `failed` → `FAILURE`。
  - `pending` / `queued` / `processing` / `in_progress` / `generating` / 空状态 → `IN_PROGRESS`。
- duration/seconds 在请求校验阶段按 action 限制为 xAI 官方范围：generate 1–15 秒、extension 2–10 秒，且仍低于项目级 `relaycommon.MaxTaskDurationSeconds` 安全上限。edit 不支持 duration，构建上游请求时会移除 `duration` / `seconds` / `resolution` / `aspect_ratio`。
- `seconds` 兼容字段会在构建上游 JSON 时转换为 `duration`，并从上游请求中移除，避免把非 xAI 字段透传给上游。
- `EstimateBilling` 对 generate 仅在用户显式提供 duration/seconds 时写入 `OtherRatios["seconds"]`；对 extension 未显式提供时按官方默认 6 秒预估；对 edit 不写入 duration 计费倍率。

### 本地验证
- `go test ./relay/channel/task/xai ./relay ./relay/channel/task/... ./service ./relay/helper ./types`：通过。
- `go test ./...`：通过。
- `go build ./...`：通过。

### 后续可选项
- 接入 `usage.cost_in_usd_ticks` 做完成态实际成本差额结算前，需要先明确站内 USD ticks → quota 的兑换策略，并用 `common.QuotaFromFloatChecked` / clamp 审计链路实现。
- 若后续官方只保留 `grok-imagine-video-1.5` 而非 `grok-imagine-video-1.5-preview`，可再清理 preview 别名。
