# 参数 SKU 倍率表 — 调研与设计报告

> 目标:让站长在后台**可配置**地按「图片 size/quality、视频 resolution/duration」等请求参数设置额外计费倍率,覆盖图片同步接口与视频异步 task 接口。
>
> 状态:调研完成,设计已定稿。已纳入四轮代码逐行核实(§9 五条 + §9.8 七条红线),核心取值模型已修正为 params map(非 gjson)。待实现。

---

## 1. 背景与动机

原版 new-api 对图片/视频模型的「按参数额外计费」支持**很窄且全是硬编码**:

- 加一个模型、调一次分辨率价,都要改 Go 源码重新编译。
- 站长无法在后台自助配置。

社区已有真实诉求与上游讨论,但上游方案仍是硬编码路线(详见第 5 节)。GitHub 上没有任何开源 fork 做了可配置的参数化计费;唯一做对此事的是闭源商业的「智元 FastAPI」。**这是一块差异化空白,值得我们 fork 自建。**

---

## 2. 现状:计费机制全貌(已核实)

### 2.1 计费乘法管线(可直接复用)

- 最终额度公式:`finalQuota = baseQuota × ∏(OtherRatios)`
  - 见 `relay/relay_task.go:260-279` `recalcQuotaFromRatios`。
- `types.PriceData.OtherRatios map[string]float64` + `AddOtherRatio(key, ratio)`(`ratio<=0` 自动忽略)
  - 见 `types/price_data.go:30-38`。
- **关键结论:图片与视频两条路径都已有 OtherRatios 应用机制。SKU 只需往里 `AddOtherRatio`,无需改动下游结算逻辑。**

### 2.2 图片同步接口(`/v1/images/generations`)

| 项 | 事实 | 位置 |
|----|------|------|
| 计费时机 | **后扣**(`PostTextConsumeQuota`) | `relay/image_handler.go:160` |
| size/quality 计费 | **硬编码且只认 dall-e** | `dto/openai_image.go:130-163` `GetTokenCountMeta` |
| n(数量)倍率 | 走 `OtherRatio("n")` | `relay/image_handler.go:121-134` |
| 参数可见点 | `info.Request.(*dto.ImageRequest)` 的 Size/Quality/N | — |

`GetTokenCountMeta` 现状(节选):仅 `strings.HasPrefix(i.Model, "dall-e")` 时计算 `sizeRatio`(256x256→0.4 / 512x512→0.45 / 1024x1024→1 / 长边→2)与 `qualityRatio`(dall-e-3 hd→2,长边 hd→1.5),乘积塞进 `ImagePriceRatio`。

> **非 dall-e 模型(gpt-image-1、即梦、flux、各家 dall-e-3 兼容等)的 size/quality 完全不计费。** 这就是用户说的"原版不支持"的核心场景。

### 2.3 视频异步 task 接口

| 项 | 事实 | 位置 |
|----|------|------|
| 计费时机 | **预扣**(EstimateBilling → 应用 OtherRatios → PreConsumeBilling) | `relay/relay_task.go:187-210` |
| 提交后修正 | `AdjustBillingOnSubmit` 可二次调整倍率 | `relay/relay_task.go:245-249` |
| 统一注入点 | EstimateBilling 调用之后(模型已映射、参数已在 context) | `relay/relay_task.go:190` |

各适配器**硬编码**现状:

| 适配器 | EstimateBilling 行为 | 硬编码价格表 |
|--------|---------------------|-------------|
| Sora | 提取 `seconds`/`size`,返回 `{seconds, size}` | size 长边→1.666667 |
| Ali(通义) | `ProcessAliOtherRatios()` 按 模型×分辨率 查表 | `map[model][resolution]ratio` |
| Gemini/Vertex(Veo) | `VeoResolutionRatio()` 按模型算 | 4K→1.5 / 2.333 |
| Doubao | 仅判断 metadata 是否含视频输入 | video_input 折扣 |
| Kling / Hailuo | 继承 `BaseBilling` 返回 nil | 无参数计费 |

参数提取**不统一**:sora/ali 读 `req.Size`/`req.Duration`;gemini 优先 `req.Metadata`。
`TaskSubmitReq` 字段(Size/Duration/Seconds/Metadata)定义于 `relay/common/relay_info.go:685`。

### 2.4 表达式计费系统(本期不采用,仅记录)

- `pkg/billingexpr` 的 `param("json.path")` 能从请求体提取任意字段(gjson),`relay/helper/billing_expr_request.go` 负责绑定请求体。
- **但仅在 `BillingMode==tiered_expr` 的模型生效**(`relay/helper/price.go:72-74`),且 task 异步路径不走它。
- 用表达式做 SKU 需要每个模型切到 `tiered_expr` 且站长手写表达式 — 门槛高、对 task 不通用。
- **结论:本期采用独立 SKU 倍率表,不走表达式。**

---

## 3. GitHub 上游/Fork 调研结论

### 3.1 上游官方态度(Issue #5266,7 条评论,open)

维护者 **feitianbubu(contributor)** 核心观点:

> "token 计费本身就是根据分辨率、时长统一计算的……token 已经包含了分辨率/时长/帧率。"

即上游设计哲学是 **「能按 token 算就别按参数算」**。只有当厂商对某档分辨率单独加价、token 单价无法表达时,才不得不按参数区分(如 seedance-2.0 的 1080p 独立报价)。

> **踩坑提示 #1:不要做成"凡图片视频都按参数计费"的大一统方案** — 与上游哲学冲突,且 merge 上游易冲突。正确定位:**token 计费为主,参数倍率为补丁/可选覆盖。**

### 3.2 上游正在用的真实方案(PR #5300,open 未合并)

给 doubao-seedance-2.0 加按 1080p 区分:把 `GetVideoInputRatio(modelName)` 改成 `GetVideoInputRatio(modelName, resolution, hasVideo)`,**仍是硬编码价格表**,返回塞进 OtherRatios。

- 我们本地的 doubao 还是旧单参数签名,**尚未包含 #5300**。

> **踩坑提示 #2:硬编码路线上游自己都嫌烦。** Issue 原始诉求就是吐槽"按 token 要拆成多个模型非常难维护",而上游回应依然是改 Go 代码加表。**这正是我们 fork 把价格表搬到后台可配置的价值点。**

### 3.3 已合并的可复用骨架(PR #2431「分段计费」)

关联 issue #1664,**已合并进上游**(本地有 `service/tiered_settle_test.go`、`modelPriceHelperTiered`)。它已实现"后台可视化规则编辑器 + 配置存储 + 计费应用 + i18n"的完整链路。

> **机会点 #3:SKU 倍率表的前后端骨架可套用 tiered pricing 那套,而非从零搭。**

### 3.4 Fork 调研

GitHub 上能搜到的 new-api fork(zhang709571153、cmy0714 等)都没碰计费。**可配置参数计费是开源空白。**

---

## 4. 设计:SKU 分档倍率表

> **核心理念修订(取代早期 exact-match 草案):** size、duration 这类参数本质是**连续数值量**,不该按字符串逐个枚举(`1024x1024` 一条、`2048x2048` 一条……维护爆炸)。正确的数据结构是:**先从参数派生一个数字,再按阈值落档**。dall-e 现有硬编码(`256→0.4 / 512→0.45 / 1024→1 / 1792→2`)本身就是一张「长边分档表」,我们做的是把它变成站长可配、且适用于所有模型。

### 4.1 一个维度 = 「取值」+「解释」两步解耦

不同参数难在两件事:**值藏在哪**(路径各异)、**值怎么变倍率**(数值/枚举/有无)。把这两步拆开,所有参数(图片的 size/quality/其他,视频的全部计费点)就统一了。

```go
// SkuTier 数值分档的单档。
type SkuTier struct {
    UpTo  float64 `json:"up_to"`           // 派生值上界(含);最后一档置 0 = 无上限(兜底)
    Ratio float64 `json:"ratio"`
    Label string  `json:"label,omitempty"` // "1K"/"2K"/"4K",仅前端展示用
}

// SkuRule 一条规则 = 圈定模型 + 取一个参数 + 一种解释方式 + 输出一个倍率键。
type SkuRule struct {
    Models  []string `json:"models"`   // 通配: ["gpt-image-1","sora*","veo*"]
    Source  string   `json:"source"`   // params map 的 key: "size"/"quality"/"mode"/"metadata.fps"/"input_reference"
    Kind    string   `json:"kind"`     // tier | enum | exists
    OutKey  string   `json:"out_key"`  // 写进 OtherRatios 的键名
    Enabled bool     `json:"enabled"`

    // Kind=tier:数值分档(size 派生长边、duration 派生秒)
    Derive string    `json:"derive,omitempty"` // long_edge | megapixels | number | seconds
    Tiers  []SkuTier `json:"tiers,omitempty"`

    // Kind=enum:离散映射(quality、mode 等真·枚举)
    Enum map[string]float64 `json:"enum,omitempty"`

    // Kind=exists:有无/布尔(图生视频、带音频)
    ExistsRatio float64 `json:"exists_ratio,omitempty"` // 字段存在 / 为 true 时的倍率
}

type SkuRatioConfig struct {
    Enabled      bool      `json:"enabled"`        // 全局开关,默认 false
    Rules        []SkuRule `json:"rules"`
    MaxTotalRatio float64  `json:"max_total_ratio,omitempty"` // 跨维度连乘上限(防配置事故),0=不限
}
```

- **Source = params map 的 key**:由注入点把已解析的请求 struct(图片 `dto.ImageRequest`、视频 `TaskSubmitReq`)字段 + `Metadata` map 拍平成 `map[string]any` 传入。**注意:image/video 两条路径在注入点拿到的都是已解析 struct,不是原始 body**,所以**不走 gjson**(gjson + 原始 body 仅 text relay 的 `pkg/billingexpr` 成立,本期不走那条路,见 §9.8 红线 #6)。`metadata.*` 形态的 key 由拍平逻辑展开后按点路径取值。**新增「非 metadata」参数仍需先加进 `TaskSubmitReq`(封闭 struct),走 `metadata.*` 才能零改 Go 代码,见 §9.8 红线 #7。**
- **Kind = 三种解释器**,封闭集合,覆盖全部真实计费形态,可穷举测试:
  - `tier` — 数值分档(尺寸、时长、帧率)
  - `enum` — 离散映射(质量档、模式档)
  - `exists` — 有无加价(图生视频、带音频)
- option key:分层配置 `sku_ratio_setting.*`(经 `model/option.go:577 handleConfigUpdate` 反射热更新,**无需加后处理分支**,见 §9.5)。
- 模型匹配:**需自实现**通配函数(精确优先,再 `*` 通配),项目无现成 glob(见 §9.4)。

### 4.2 三种 Kind 的配置示例

**图片 — quality 因模型而异**(用 `enum` + 模型通配,各模型互不干扰):

```
规则A  models:[dall-e-3]     source:quality  kind:enum  {standard:1, hd:2}
规则B  models:[gpt-image-1]  source:quality  kind:enum  {low:1, medium:1.5, high:2.5}
规则C  models:[flux*]        source:size     kind:tier  derive:long_edge
                                          ≤1024×1  ≤2048×2  ≤4096×4  无上限×5
规则D  models:[gpt-image-1]  source:background  kind:enum  {transparent:1.2, opaque:1}
```

**视频 — 多个计费点**(一个模型挂多条规则,跨维度相乘):

```
source:size            kind:tier   derive:long_edge  ≤720×1 ≤1080×1.5 ≤4096×3
source:duration        kind:tier   derive:seconds    ≤5×1 ≤10×1.8 ≤30×5
source:metadata.fps    kind:tier   derive:number     ≤24×1 ≤60×1.5
source:mode            kind:enum   {std:1, pro:1.5, master:2.5}
source:input_reference kind:exists exists_ratio:1.3   (图生视频加价)
source:metadata.audio  kind:exists exists_ratio:1.2   (带音频加价)
```

### 4.3 查询函数(热路径)

```go
func GetSkuRatios(model string, params map[string]any) map[string]float64
// 注入点把已解析 struct 字段 + Metadata 拍平成 params 传入(非 gjson body,见 §9.8 红线 #6)
// 遍历命中 model 的规则 → 按 Source 从 params 取值 → 按 Kind 解释出倍率 → {OutKey: ratio}
// 全局 off / 无命中 / 取值失败 → 返回空 map(零影响,完全向后兼容)
// MaxTotalRatio 在本函数内对 SKU 各维度乘积做 clamp 后再输出,保证三阶段口径一致(见 §9.8 红线 #8)
```

### 4.4 匹配与叠加规则(已定)

1. **数值分档无歧义**:派生值落进**第一个 `UpTo ≥ 值`** 的档;最后一档 `UpTo=0` 为无上限兜底。分档天然不会并列,消除了早期草案「最具体优先」的边界问题。
2. **跨维度相乘**:每条规则各出一个 `{OutKey: ratio}`,不同 OutKey 的倍率**连乘**,对接后端 `∏(OtherRatios)` 管线。
3. **同 OutKey 覆盖适配器硬编码**:SKU 用与适配器相同的键名时,后写覆盖(见 §9.6 注入顺序)。
4. **取值失败一律 1.0x**:Source 解析不到、派生失败、枚举未命中 → 该维度倍率 1.0(即不加价)+ 记日志。**计费安全红线:解析不出的参数绝不能意外加价。**
5. **总倍率上限保护**:多维度连乘可能爆炸(2×2×1.5×1.3≈7.8),`MaxTotalRatio` 兜底,防止站长配置事故。

### 4.5 归一化规范(数值型 tier 的工程难点,也是计费风险点)

`size` 入参形态各异,`Derive` 必须是确定性、表驱动、单测全覆盖的:

| 输入 | `long_edge` 派生 | `megapixels` 派生 |
|------|-----------------|-------------------|
| `1792x1024` / `1024*1024` | max → 1792 / 1024 | 宽×高/1e6 |
| `1024`(单数字) | 1024 | — |
| `2K` / `4K` | 2048 / 4096 | — |
| `1080p` / `720p`(按高命名) | 查表 → 1920 / 1280 | — |
| `auto` / 空 / 无法解析 | **→ 兜底 ratio 1.0** | **→ 1.0** |

> **long_edge vs megapixels:** 默认 `long_edge`(贴合「1K/2K/4K」心智,与现有 dall-e 一致)。但面积按平方增长(1K→2K 像素翻 4 倍),按面积成本计价的厂商应让站长在档位 ratio 上自行填 `1/2/4/8`,或选 `megapixels` 模式。结构两者都支持,曲线交给站长。

### 4.6 注入点(两处)

**图片** — `relay/image_handler.go` `PostTextConsumeQuota`(:160)之前:
- `skuRatios = GetSkuRatios(model, body)` → 逐项 `info.PriceData.AddOtherRatio(outKey, ratio)`。
- **仅当 `info.PriceData.UsePrice && strings.HasPrefix(model,"dall-e")` 且 SKU 命中 size/quality 维度**:需避免与 `ImagePriceRatio` 双算(该路径下 dalleRatio 已乘进 modelPrice)。**建议把 SKU 判定前移到 `ModelPriceHelper`,与 `ImagePriceRatio` 二选一,从源头杜绝双算**(实现要点见 §9.1 / §9.6)。
- 按 token 倍率模式(gpt-image-1 等)无此问题,SKU 经 OtherRatios 即唯一来源。

**视频** — `relay/relay_task.go:190` EstimateBilling 注入之后、:197 应用到 Quota 之前:
- 从请求体取 size/duration/fps/mode 等 → `GetSkuRatios` → 逐项 `AddOtherRatio`。
- **同 OutKey 覆盖适配器**(Sora→`size`,Veo→`resolution`);**时长维度的 OutKey 禁止用 `seconds`**,改独立键 `sku_duration`(见 §9.3 红线 #4)。
- SKU 进 `info.PriceData.OtherRatios` 后,自动随 `controller/relay.go:590` 快照持久化,保证 **预扣 / 提交修正 / 任务完成 token 重算** 三阶段口径一致(见 §9.2 红线 #2)。

### 4.7 日志与展示

- OtherRatios 已进扣费日志(`service/task_billing.go:128`、`service/text_quota.go:281`),SKU 项自动出现在明细,无需额外改动。建议 OutKey 加 `sku_` 前缀便于辨识与翻译。

### 4.8 前端(后台配置页 + 用户侧模型广场)

**后台配置页**:复用 `web/default/src/features/system-settings/billing` 表格骨架。
- 全局开关 + `MaxTotalRatio` + 规则列表(模型通配 / Source 路径 / Kind / 分档或枚举编辑器 / OutKey / 启用)+ Raw JSON 兜底。
- UI 按所选模型/Kind 给 OutKey 安全默认(时长默认 `sku_duration`,Veo 分辨率默认 `resolution`),挡住红线 #3/#4。

**用户侧模型广场**(关键,防举报):见 §10。后端 `model/pricing.go` 把命中模型的 SKU 规则随 `Pricing` 结构带出 → 卡片打「参数计费」标 → 详情抽屉复用现成 `DynamicPricingBreakdown`(`pricing/components/`)按 Kind 分区渲染**完整算式**(基础价 × 各档倍率连乘),与实际计费同源。

- i18n:en 为基准 + zh 等,key 用英文源串(项目约定)。

---

## 5. 实施步骤(每步可独立编译/测试)

1. **后端配置层**:新建 `setting/ratio_setting/sku_ratio.go`(`SkuRule`/`SkuTier`/`SkuRatioConfig` struct + `GlobalConfig.Register("sku_ratio_setting", ...)` + Get/Update + 自实现模型通配匹配 + 三种 Kind 解释器 + `Derive` 归一化 + `GetSkuRatios(model, params map[string]any)`)。配置存储用 **`atomic.Pointer[SkuRatioConfig]`**,并在 `handleConfigUpdate` 加 `sku_ratio_setting` 分支重建指针(见 §9.8 红线 #7,**非反射热更新直接安全**);`MaxTotalRatio` 在 `GetSkuRatios` 内 clamp(红线 #8);`n`/`seconds`/`duration` 拒绝作 OutKey(红线 #11);前端默认 key 注册 `{}`。
2. **归一化与解释器单测**:`sku_ratio_test.go` 表驱动覆盖 —— `long_edge`/`megapixels` 各种 size 形态、tier 落档边界、enum 命中/未命中、exists、通配匹配、取值失败→1.0、`MaxTotalRatio` 截断、OutKey 黑名单、全局 off。**另加 `go test -race` 并发读 + reload 用例(红线 #7)**。testify require/assert。
3. **图片注入**:改 `relay/image_handler.go`(从 `dto.ImageRequest` struct 拍平 params → `GetSkuRatios` → `AddOtherRatio`,**非 gjson body**,红线 #9);**dall-e + 按次定价**场景把 SKU 判定前移到 `relay/helper/price.go ModelPriceHelper`,与 `ImagePriceRatio` 二选一防双算(§9.1)。
4. **视频注入**:改 `relay/relay_task.go` EstimateBilling 后(从 `TaskSubmitReq` struct + Metadata 拍平 params → `GetSkuRatios` → `AddOtherRatio`),同 OutKey 覆盖适配器、时长用 `sku_duration` 独立键(§9.3),确认随 `controller/relay.go:590` 快照持久化(§9.2)。**SKU 注入须在 `AdjustBillingOnSubmit` 之后,或 recalc 后补回(红线 #6);非 metadata 新参数需先扩 `TaskSubmitReq`(红线 #10)**。
5. **后端构建校验**:`go build ./... && go vet ./... && go test -race ./setting/ratio_setting/...`。
6. **用户侧模型广场**:`model/pricing.go` `Pricing` 结构加 `SkuRatios` 字段并在 `updatePricing()` 组装;前端模型卡片打标 + 详情抽屉复用 `DynamicPricingBreakdown` 渲染算式(见 §10)。
7. **后台配置页**:SKU 规则编辑器(分档/枚举/exists 三态 UI + OutKey 安全默认)+ i18n。`bun run build`。
8. **联调**:按 §9.7 验收矩阵逐场景跑(图片三模式 + 视频时长/分辨率覆盖 + 任务完成 token 重算口径一致 + off 零影响)。

---

## 6. 风险与约束

- **向后兼容**:全局默认 off;不删任何现有硬编码计费;SKU 仅叠加/覆盖。merge 上游冲突面小(以新增文件 + 两个注入点为主)。
- **跨库**:option 表 JSON 字符串,SQLite/MySQL/PG 通用;无新表、无 schema 变更。
- **JSON**:全程用 `common.Marshal/Unmarshal`(项目强制约定)。
- **双重计费**:SKU 与适配器硬编码可能对同维度都设倍率 → 已用「SKU 覆盖硬编码」消解;UI 需提示。
- **品牌保护**:不动任何 new-api / QuantumNous 标识(项目治理红线)。

---

## 7. 关键文件索引

| 用途 | 文件:行号 |
|------|-----------|
| 计费乘法公式 | `relay/relay_task.go:260-279` |
| OtherRatios 结构 | `types/price_data.go:30-38` |
| 图片计费(后扣) | `relay/image_handler.go:121-160` |
| 图片 size/quality 硬编码 | `dto/openai_image.go:130-163` |
| 视频预扣 + 注入点 | `relay/relay_task.go:187-210` |
| 视频提交后修正 | `relay/relay_task.go:245-249` |
| 配置存储模式参照 | `setting/billing_setting/tiered_billing.go` |
| 分层配置热更新 | `model/option.go:576-611` |
| GlobalConfig 加载/序列化 | `setting/config/config.go:42,281` |
| 倍率 RWMap 模式参照 | `setting/ratio_setting/model_ratio.go:647-671` |
| 前端 billing 配置页 | `web/default/src/features/system-settings/billing/` |
| 前端倍率编辑器参照 | `web/default/src/features/system-settings/models/model-ratio-visual-editor.tsx` |

---

## 8. 参考(GitHub)

- Issue #5266 — 按视频分辨率区分定价需求 + 维护者态度(open)
- PR #5300 — doubao-seedance-2.0 按 1080p 区分(硬编码,open 未合并)
- PR #3046 — 完善阿里/豆包/Gemini 视频计费(closed 未合并)
- PR #2431 / Issue #1664 — 分段计费 Token Tier Pricing(已合并,骨架可复用)

---

## 9. 实施前核实补遗(第二轮逐行核实结论 — 计费安全红线)

> 本节是对照真实代码逐行复核后,对前文「行号级假设」的修正与补强。**每一条都直接关系到会不会算错钱,实现时必须逐条满足。**

### 9.1 图片:`ImagePriceRatio` 与 `OtherRatios` 是两套独立乘法(原文档最大盲区)

核实结论(`relay/helper/price.go:88-121`、`service/text_quota.go:281-300`):

- 图片走 `ModelPriceHelper`(非 PerCall),内部按 `usePrice` 二分两条路径:
  - **按次定价**(`usePrice==true`):`modelPrice *= meta.ImagePriceRatio`(`price.go:117-118`),`ImagePriceRatio = sizeRatio*qualityRatio` 仅在此模式生效;最终再 `× ∏(OtherRatios)`(`text_quota.go:295-299`)。
  - **按 token 倍率**(`usePrice==false`):`ImagePriceRatio` **完全不参与计算**;计费 = token 量 × modelRatio × groupRatio × `∏(OtherRatios)`(`text_quota.go:232-285`)。
- **结论:`OtherRatios` 在两种模式都乘;`ImagePriceRatio` 只在按次模式经 `modelPrice` 乘。**

> **红线 #1:** 原文档 4.4 节「SKU 命中维度时短路 dall-e 那段、用 AddOtherRatio 覆盖」的说法在**按 token 倍率模式下不成立** —— 那里 `ImagePriceRatio` 本就不生效,根本没有「覆盖」关系,SKU 经 OtherRatios 注入即是唯一来源,正确。**但在按次定价 + dall-e 模型时**,若不把 `GetTokenCountMeta` 对命中维度归 1,就会变成 `modelPrice × dalleRatio`(进 modelPrice)再 `× skuRatio`(进 OtherRatios)= **双重计费**。短路只对「dall-e 系 + 按次定价」这一交叉场景必要,实现时必须精确判断,不能无条件短路。

### 9.2 视频:存在「第三次计费」token 重算,SKU 必须持久化进 BillingContext(原文档完全未提)

核实结论(`service/task_billing.go:250-301`、`controller/relay.go:586-593`):

- 视频任务计费有**三个阶段**,原文档只覆盖了前两个:
  1. 预扣:`EstimateBilling → AddOtherRatio → Quota × ∏(ratio)`(`relay_task.go:190-203`)。
  2. 提交后修正:`AdjustBillingOnSubmit → recalcQuotaFromRatios`(`relay_task.go:245-249`)。
  3. **任务完成后 token 重算**:`RecalculateTaskQuotaByTokens`,从 `task.PrivateData.BillingContext.OtherRatios` 连乘所有倍率重算实际额度(`task_billing.go:287-297`)。
- BillingContext 快照在 `controller/relay.go:590` 写入:`OtherRatios: relayInfo.PriceData.OtherRatios`(直接引用整个 map)。

> **红线 #2:** SKU 倍率**必须在 `controller/relay.go:586` 写快照之前**进入 `info.PriceData.OtherRatios` 这个 map(不能另开字段)。`RelayTaskSubmit` 内 EstimateBilling 之后注入 → 自动随快照持久化 → token 重算阶段(`task_billing.go:289`)也能拿到。**若漏掉持久化,预扣含 SKU、token 重算不含 SKU,差额结算会把 SKU 多扣的退回去 —— 用户实际付不到 SKU 价。**

### 9.3 视频维度 key 命名不统一,「同名覆盖」不可一刀切(原文档 4.1 低估)

核实结论(逐个适配器):

| 适配器 | 分辨率维度 key | 时长维度 key | 备注 |
|--------|---------------|-------------|------|
| Sora (`sora/adaptor.go:122-128`) | `size`(倍率 1 / 1.666667) | `seconds`(**数量原值**,如 8) | — |
| Ali (`ali/adaptor.go:359-369`) | `ProcessAliOtherRatios` 返回(查表) | `seconds`(**数量原值**) | key 名取决于该函数 |
| Gemini/Veo (`gemini/adaptor.go:175-178`) | `resolution`(倍率) | `seconds`(**数量原值**) | 用 `resolution` 不是 `size` |

> **红线 #3:** 「SKU 同名 key 覆盖适配器」依赖**键名完全一致**。站长对 Gemini 视频想覆盖分辨率倍率必须配 `resolution`,配 `size` 会变成**叠加**(两个 key 都进 map 各自连乘)。前端 UI 必须按渠道/适配器提示正确的维度键名,或文档明确列出「图片用 `size`/`quality`,Sora/Ali 视频用 `size`,Gemini 视频用 `resolution`」。

> **红线 #4(数量型 ratio 陷阱):** `seconds` 进 OtherRatios 的是**数量原值**(8 秒就是 8),被当倍率连乘。SKU 白名单**绝不能**允许站长配 `seconds`/`duration` 同名 key,否则会覆盖掉真实秒数导致计费塌缩。SKU 对「时长」计费应使用**独立维度键**(如 `sku_duration`)或只读取参数值做区间匹配后输出**独立倍率键**,不与 `seconds` 同名。原文档 4.1 把 `duration`/`seconds` 列进视频白名单是危险的,需改为「读取 duration 参数做匹配条件,但输出独立倍率 key」。

### 9.4 模型匹配:无现成通配符 glob,需自带(原文档 4.1「复用现成通配符 glob」不准确)

核实结论(`setting/ratio_setting/model_ratio.go:392-406,714-731`):

- `GetModelRatio` 是 map 精确查找 + `FormatMatchingModelName` 归一化(只处理 gizmo、gemini-thinking 等固定前缀改写),**不是通用通配符匹配**。
- 项目内**没有**现成的 `MatchModelName(pattern, name)` glob 工具可直接复用。

> **红线 #5:** SKU 的模型通配符(`sora*`、`dall-e-3`)需要**自己实现匹配函数**(标准库 `path.Match` 或简单前后缀匹配即可),不能假设有现成 glob。建议:精确匹配优先,再尝试 `*` 通配,匹配逻辑写进 `GetSkuRatios` 并单独测试。

### 9.5 配置热更新:Register 后自动生效,无需额外后处理(原文档第 1 步可简化)

核实结论(`model/option.go:576-611`、`setting/billing_setting/tiered_billing.go:30-32`):

- `config.GlobalConfig.Register("sku_ratio_setting", &cfg)` 后,`handleConfigUpdate` 通过反射(`UpdateConfigFromMap`)自动热更新内存 struct,**无需在 `handleConfigUpdate` 加分支**(除非要主动失效某缓存)。
> **注:** 本结论仅对**标量/字符串**配置成立。SKU 的 `Rules` 是 **slice**,热路径并发遍历 + reload 原地改写会触发 data race,**必须改用 `atomic.Pointer[SkuRatioConfig]` 并在 `handleConfigUpdate` 加重建分支**(见 §9.8 红线 #7,该红线部分推翻本节)。

### 9.6 修正后的注入点与顺序(实现清单)

**图片** — 注入点定稿为 `controller/relay.go` 的 **:131(算 meta)↔ :153(调 ModelPriceHelper)之间**,而非 handler 末端、也非 ModelPriceHelper 内部(已读透链路,推翻早期两种待定方案):

核实链路(`controller/relay.go`):
- `:131 / :286` `meta = request.GetTokenCountMeta()` —— `ImagePriceRatio`(=sizeRatio×qualityRatio,仅 dall-e)在此算出。
- `:153` `ModelPriceHelper(c, relayInfo, tokens, meta)` → `price.go:117-118` `modelPrice *= meta.ImagePriceRatio`(**仅 usePrice 模式**)。

```
在 controller/relay.go :131 之后、:153 之前:
1. 从 request(*dto.ImageRequest)拍平 params(Size/Quality/N/Background…),非 gjson(红线 #9)
2. skuRatios = GetSkuRatios(model, params)
3. 防双算:仅当 (usePrice && strings.HasPrefix(model,"dall-e")) 且 SKU 命中 size/quality 维度
   → 把 meta.ImagePriceRatio = 1.0 归一,阻止它烘进 modelPrice(从源头断,无需末端"除回")
4. SKU 倍率经 OtherRatios 注入(沿用 image_handler.go:130-134 追加 "n" 的同款模式)
```

> **关键修正(定稿):** 早期文档给了两个待定方案 —— ①前移到 `ModelPriceHelper` 内、②handler 末端把 dalleRatio 除回。读透后**两个都不采用**:`ModelPriceHelper` 被 text/responses/image 多路共用,塞 SKU 判断会污染且拿不到干净配置入口;末端除回是补救而非根治。**正确点是 `controller/relay.go` :131↔:153 之间** —— 此处 meta(含 ImagePriceRatio)与 request(SKU 取值源)同时在手,把 `ImagePriceRatio` 归 1 即从源头杜绝双算,且**无需改 `ModelPriceHelper` 签名**。非 dall-e / 按 token 倍率模式 `ImagePriceRatio` 本就不生效,SKU 经 OtherRatios 是唯一来源(红线 #1),无需特殊处理。

**视频** — `relay/relay_task.go`,EstimateBilling 注入(:190-194)之后、应用到 Quota(:197-203)之前:
```
1. 从 req 的 resolution/size/duration 参数构造 params(只读不覆盖 seconds)
2. skuRatios = GetSkuRatios(model, params),输出独立倍率 key(见红线 #4)
3. 逐项 AddOtherRatio —— 同名维度(如 resolution)覆盖适配器值,数量键(seconds)不碰
4. AdjustBillingOnSubmit 路径(recalcQuotaFromRatios)同样需要 SKU 仍在 OtherRatios 中,
   保证 预扣 / 提交修正 / token重算 三阶段口径一致(见红线 #2)
```

### 9.7 联调验收(扩展原文档第 6 步,必须覆盖三模式)

| 场景 | 验证点 |
|------|--------|
| 图片 dall-e-3 + 按次定价 + hd | SKU 命中 quality 时**不双算**(modelPrice 路径与 SKU 只生效一处) |
| 图片 gpt-image-1 + 按 token 倍率 | SKU size 倍率正确进 OtherRatios,日志可见 |
| 视频 Sora 不同 size | SKU `size` 覆盖适配器 1.666667,`seconds` 数量不受影响 |
| 视频 Gemini 不同 resolution | SKU 必须配 `resolution` 才覆盖;配 `size` 验证为叠加(反例) |
| 视频任务完成 token 重算 | 预扣 quota == token重算 actualQuota(SKU 已持久化进 BillingContext) |
| 全局 off | OtherRatios 不含任何 SKU 项,与改动前完全一致 |
| **视频 AdjustBillingOnSubmit 覆盖场景** | **构造一个返回非空 map 的适配器,验证 SKU 仍在 quota 与 BillingContext 快照中(红线 #6 之外的 #A)** |
| **配置 reload 并发** | **`go test -race`:一边 `GetSkuRatios` 高频读,一边热更新 Rules,无 data race** |
| **MaxTotalRatio 截断** | **多维度连乘超限时,预扣 / 提交修正 / token 重算三处用的都是 clamp 后的值** |
| **OutKey 黑名单** | **配置 `n`/`seconds`/`duration` 作 OutKey 被拒绝(保存即报错或后端忽略)** |

---

## 9.8 第三/四轮核实补遗(逐行复核新发现的计费安全红线)

> 本节是在 §9 五条红线之外,第三、四轮对照真实代码新发现的风险。**P0 级会算错钱或 panic,实现前必须定稿对应方案。**

### 红线 #6(P0):`AdjustBillingOnSubmit` 是整体替换 OtherRatios,会静默清除 SKU

核实结论(`relay/relay_task.go:245-250`):

```go
if adjustedRatios := adaptor.AdjustBillingOnSubmit(info, taskData); len(adjustedRatios) > 0 {
    finalQuota = recalcQuotaFromRatios(info, adjustedRatios)
    info.PriceData.OtherRatios = adjustedRatios   // ← 整体替换,非合并
    info.PriceData.Quota = finalQuota
}
```

- `recalcQuotaFromRatios`(:262-279)先用**当前** OtherRatios(含 SKU)把 base 除回,再乘 `adjustedRatios`(可能不含 SKU)→ SKU 在 quota 与 `controller/relay.go:590` 写的 BillingContext 快照里**同时蒸发**。
- **当前安全**:全部适配器仅 `BaseBilling` 返回 nil(`taskcommon/helpers.go:90`),`len>0` 永不成立。**但这是潜伏地雷**——上游 PR #5300(doubao 按 1080p)方向正是往这类钩子塞东西,一旦任何适配器实现它并返回新 map,SKU 无声消失,差额结算把 SKU 多扣部分退回,用户实付不到 SKU 价。
- **修法(三选一,实现前定稿)**:① SKU 注入点移到 `AdjustBillingOnSubmit` 之后;② 钩子语义改成 merge 而非替换;③ recalc 后重新 `AddOtherRatio` 回 SKU 项。推荐 ③ —— 改动最小且不动适配器契约。

### 红线 #7(P0):配置热更新对 `Rules` slice 是 data race,需 atomic.Pointer

核实结论(`setting/config/config.go updateConfigFromMap`):Slice 分支��地 `json.Unmarshal(field.Addr())`、Map 分支 `field.Set(fresh)`。热路径 `GetSkuRatios` 并发遍历 `Rules` slice 时,站长保存配置触发 reload = 典型 data race(`go test -race` 必报,撕裂的 slice header 极端下可 panic)。

- §9.5「裸 struct 直读、连缓存都不需要」对**标量/字符串**配置成立,但对 **slice/map 字段**不成立。文档关键文件索引(:272)自己引了 `model_ratio.go` 的 RWMap 模式,这里应当复用思路。
- **修法(已找到 1:1 现成模板,定稿)**:抄 `setting/operation_setting/tools.go` —— 该文件 `toolPriceSetting` 走 reflection 注册接收后台 JSON,但热路径读的是 `var currentIndex atomic.Pointer[toolPriceIndex]`,`RebuildToolPriceIndex()` 构造新 idx 后 `Store`,在 `handleConfigUpdate` 的 `tool_price_setting` 分支调用,读路径 `GetToolPriceForModel` 用 `Load()` 无锁遍历。SKU 照此:`skuRatioSetting` struct 走 reflection 注册;另设 `var skuIndex atomic.Pointer[compiledSkuRules]`;`RebuildSkuIndex()` 预编译 Rules(通配/Kind/Tiers 排序)后 `Store`,在 `handleConfigUpdate` 加 `sku_ratio_setting` 分支调用;`GetSkuRatios` 用 `skuIndex.Load()`。**配置写入本就串行化**(`handleConfigUpdate` 在 `common.OptionMapRWMutex.Lock()` 内,`model/option.go:257-263`),reflection 改完 struct 到重建快照之间无第二 writer,零 data race。

### 红线 #8(P0):MaxTotalRatio 必须烘焙进 ratio 值,且只 scope SKU 维度

核实结论(`service/task_billing.go:287-294` token 重算阶段只无脑连乘 `bc.OtherRatios`):

- 若 `MaxTotalRatio` 做成"算完额度再 clamp",它不进 OtherRatios → token 重算拿不到 → 三阶段口径不一致(违背红线 #2)。
- `OtherRatios` 里混有 `seconds`(数量原值 8)、`n` 等**非倍率量**,对整个 map 连乘封顶会被 seconds 顶爆。**上限只能 scope 到 SKU 贡献的键**。
- **修法**:`GetSkuRatios` 内先算 SKU 各维度乘积,超 `MaxTotalRatio` 时等比缩小各 ratio,再 `AddOtherRatio` 输出。clamp 后的值进 map → 三阶段一致。

### 红线 #9(P1):`GetSkuRatios` 取值口径是 params map,不是 gjson body(推翻 §4.1 卖点)

核实结论:
- 图片注入点(`image_handler.go`)全程用已解析 struct `info.Request.(*dto.ImageRequest)`(:26);视频适配器(sora/gemini/ali EstimateBilling)全部从 `c.Get("task_request")` 的 `TaskSubmitReq` struct 取值(`relay_utils.go:62`)。**两条路径在注入点都没有原始 body 在手**(图片虽可经 `common.GetRequestBody` 重读 body,但已有强类型 struct,gjson 是多余)。
- gjson + 原始 body 仅 text relay 的 `pkg/billingexpr` 天然成立,本期不走。
- **修法**:签名定为 `GetSkuRatios(model string, params map[string]any)`,注入点把 struct 字段 + Metadata 拍平传入(已改 §4.1/§4.3)。`Source` 是 params key,`metadata.fps` 由拍平逻辑按点路径展开。

### 红线 #10(P1):`TaskSubmitReq` 是封闭 struct,非 metadata 新参数会被丢弃

核实结论(`relay/common/relay_info.go TaskSubmitReq`):字段仅 Prompt/Model/Mode/Image(s)/Size/Duration/Seconds/InputReference/Metadata(map)。**客户端传的任何不在显式字段且不在 metadata 内的参数,JSON 解析阶段即被丢弃**,SKU 永远取不到 → 按红线 #4 静默落 1.0x。

- §4.1「新增参数不用改 Go 代码」对视频路径**仅在参数走 `metadata.*` 时成立**。
- **修法**:文档与前端 UI 明确——视频自定义计费参数一律约定走 `metadata.*`;非 metadata 字段必须先扩 `TaskSubmitReq`。

### 红线 #11(P1):`n`/`seconds`/`duration` 必须进 OutKey 黑名单

核实结论:图片路径 `image_handler.go:130-134` 把数量 `n` 当 OtherRatio(数量原值,非倍率);视频 `seconds` 同理(§9.3)。站长若把 SKU 规则 OutKey 配成这三者之一,会覆盖系统的数量键,导致张数/秒数计费塌缩。

- **修法**:`n`/`seconds`/`duration` 列入禁用 OutKey 白名单,保存配置时校验拒绝。

### 红线 #12(P1):recalcQuotaFromRatios 整数截断被 SKU 放大

`baseQuota = int(float64(baseQuota) / ra)`(:268)整数来回除乘恢复 base,SKU 每多一个倍率键多一次 `int()` 截断,误差累积。属既有实现缺陷,SKU 增加乘法因子数量会放大它。建议(可选):recalc 保留不含 OtherRatios 的真实 baseQuota 字段,避免整数反除。

---

## 10. 前端展示:用户必须看到计费公式(防举报核心)

后端算得对只是一半;用户在**事前(模型广场)看到的价**和**事后(账单)查到的明细**都必须和实际扣费对得上,否则照样产生纠纷。

### 10.1 样式范本可抄,但需新建组件(已核实,修正早期「直接复用」假设)

模型广场在 `web/default/src/features/pricing/`,数据来自后端 `model/pricing.go` 的 `Pricing` 结构。

- **后端挂载点是现成模板**:`updatePricing()`(`pricing.go:334-339`)挂 `billing_expr` 的写法可 1:1 仿照,SKU 加 `pricing.SkuRatios = ...` 即可。
- **前端不能直接复用 `DynamicPricingBreakdown`**:核实发现该组件(407 行)入参是 **`billingExpr: string`**,整体围绕**解析 billing 表达式字符串**构建(`splitBillingExprAndRequestRules`/`parseTiersFromExpr`/`tryParseRequestRuleExpr`)。SKU 是**结构化 Rules**,数据形态不同 —— 硬塞进去得把 Rules 反拼成表达式字符串,荒谬。
- **正确做法**:新建轻量 `SkuRatioBreakdown` 组件,**抄** `dynamic-pricing-breakdown.tsx` 末段 `Conditional multipliers` 区块(:380-404)的 JSX/样式(`ruleGroups.map → 描述 + {multiplier}x Badge`),但数据直接吃后端带出的结构化 `SkuRatios`。
- **可借的工具**:`../lib/billing-expr` 的 `MATCH_TIER/EQ/EXISTS/RANGE` 常量与 `normalizeTierLabel`,SKU 三种 Kind 的标签归一化可直接用,不必重写。
- `pricing/components/model-details.tsx:1195` 是 `DynamicPricingBreakdown` 挂进详情抽屉的位置,`SkuRatioBreakdown` 挂在紧邻处即可。

### 10.2 三层改动

**第一层 — 后端 pricing 接口带出 SKU 规则**(`model/pricing.go:290-340` 逐模型组装处,紧邻现有 `billing_expr` 挂载 :334):

```go
// Pricing 结构新增
SkuRatios []SkuRuleDisplay `json:"sku_ratios,omitempty"`

// updatePricing() 内,对每个 model:
if rules := ratio_setting.GetSkuRulesForModel(model); len(rules) > 0 {
    pricing.SkuRatios = rules  // 与计费同源:同一份配置
}
```

`Pricing` 结构同时也是 `/pricing` 用户接口的返回体,SKU 表天然随之带出,**展示与扣费同源**,杜绝「展示一套、扣费另一套」。前端 `pricing/types.ts PricingModel` 加对应字段。

**第二层 — 模型卡片打标**(`pricing/components/model-card.tsx`):仿现有 `Dynamic Pricing` 标,加「参数计费」角标,用户一眼可辨。

**第三层 — 详情抽屉展示完整算式**(`pricing/components/model-details.tsx`):复用 `DynamicPricingBreakdown` 的分区渲染,按 Kind 展示:

```
参数计费 (gpt-image-1)        基础价 $0.04 / 张
尺寸 (size,按长边)   ≤1K ×1.0   ≤2K ×2.0   ≤4K ×4.0
品质 (quality)        low ×1.0   medium ×1.5   high ×2.5
背景 (background)     transparent ×1.2
示例:2048尺寸 + high + transparent = $0.04 × 2.0 × 2.5 × 1.2 = $0.24 / 张
```

### 10.3 展示规范(必须给出最终算式,不能只列倍率)

| 要展示 | 原因 |
|--------|------|
| **基础价 × 各维度倍率连乘的最终算式** | 用户不会自己乘,要把结果算给他看 |
| **维度键名按模型/厂商区分** | 红线 #3:Veo 视频是 `resolution`,Sora 是 `size` |
| **时长展示为「按秒计费 + 档位加价」** | 红线 #4:`seconds` 是数量不是倍率,不可写成「时长 ×N」误导 |
| **off 时整块不渲染** | 全局关闭时模型详情与现状完全一致 |

### 10.4 事后账单(比事前展示更重要)

真正决定纠纷的是扣完钱用户能否看懂为什么扣这么多。已核实:SKU 倍率进 `OtherRatios`,而 `OtherRatios` 已自动入扣费日志 `other` 字段(`service/task_billing.go:128-132`、`service/text_quota.go`),**账单侧基本零后端改动**。前端只需在日志详情把 `sku_size: 2.00` 翻译成「尺寸(长边2K)倍率 2.0」即可(OutKey 带 `sku_` 前缀便于识别)。

**结论:事前看得到公式、事后查得到明细,两头都堵住,才不会挨举报。**
