package ratio_setting

import (
	"math"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/config"
)

// ---------------------------------------------------------------------------
// SKU 参数倍率表（站长后台可配置）
//
// 设计文档: docs/sku-ratio-billing-design.md
//
// 一条规则 = 圈定模型 + 取一个参数 + 一种解释方式 + 输出一个倍率键。
// 倍率经 OtherRatios 注入计费管线: finalQuota = baseQuota × ∏(OtherRatios)。
//
// 三种解释器(Kind):
//   - tier   数值分档(尺寸长边、时长秒数、帧率)
//   - enum   离散映射(质量档、模式档)
//   - exists 有无加价(图生视频、带音频)
//
// 取值口径是已解析请求 struct 拍平后的 params map(非 gjson body)。
// 全局默认 off,无命中/取值失败一律 1.0x(不加价),完全向后兼容。
// ---------------------------------------------------------------------------

// SkuKind 解释器类型(封闭集合)。
const (
	SkuKindTier   = "tier"
	SkuKindEnum   = "enum"
	SkuKindExists = "exists"
)

// SkuDerive 数值分档的派生方式。
const (
	SkuDeriveLongEdge   = "long_edge"
	SkuDeriveMegapixels = "megapixels"
	SkuDeriveNumber     = "number"
	SkuDeriveSeconds    = "seconds"
)

// forbiddenOutKeys 是数量型键名,绝不能作为 SKU OutKey。
// n/seconds/duration 进 OtherRatios 的是数量原值(被当倍率连乘),
// SKU 若同名输出会覆盖系统数量键导致计费塌缩(红线 #11)。
var forbiddenOutKeys = map[string]bool{
	"n":        true,
	"seconds":  true,
	"duration": true,
}

// SkuTier 数值分档的单档。
type SkuTier struct {
	UpTo  float64 `json:"up_to"` // 派生值上界(含);最后一档置 0 = 无上限(兜底)
	Ratio float64 `json:"ratio"`
	Label string  `json:"label,omitempty"` // "1K"/"2K"/"4K",仅前端展示用
}

// SkuRule 一条规则。
type SkuRule struct {
	Models  []string `json:"models"`  // 通配: ["gpt-image-1","sora*","veo*"]
	Source  string   `json:"source"`  // params map 的 key: "size"/"quality"/"mode"/"metadata.fps"
	Kind    string   `json:"kind"`    // tier | enum | exists
	OutKey  string   `json:"out_key"` // 写进 OtherRatios 的键名
	Enabled bool     `json:"enabled"`

	// Kind=tier: 数值分档
	Derive string    `json:"derive,omitempty"` // long_edge | megapixels | number | seconds
	Tiers  []SkuTier `json:"tiers,omitempty"`

	// Kind=enum: 离散映射
	Enum map[string]float64 `json:"enum,omitempty"`

	// Kind=exists: 有无/布尔
	ExistsRatio float64 `json:"exists_ratio,omitempty"`
}

// SkuRatioConfig 是后台可配置的 SKU 倍率表(经 GlobalConfig 反射热更新)。
//
// 两种规则来源,求值时合并(精确模型规则在前,全局通配规则在后):
//   - ModelRules: 按模型精确配置(站长在「模型编辑」抽屉里给单个模型挂规则)。
//     map key = 模型名,规则的 Models 字段编译期由 key 注入,无需站长重复填。
//   - Rules: 全局通配规则(用 Models 通配多个模型),做兜底/批量,前端弱化展示。
//
// 注意: 字段 json tag 不可带 `,omitempty`。GlobalConfig 反射热更新
// (setting/config/config.go updateConfigFromMap) 直接用完整 json tag 当键名匹配
// DB 里的 `sku_ratio_setting.<key>`,带 `,omitempty` 会让键名变成
// `model_rules,omitempty` 而永远匹配不上,导致配置加载不进内存。
type SkuRatioConfig struct {
	Enabled       bool                 `json:"enabled"`         // 全局开关,默认 false
	Rules         []SkuRule            `json:"rules"`           // 全局通配规则
	ModelRules    map[string][]SkuRule `json:"model_rules"`     // 按模型精确规则: model -> rules
	MaxTotalRatio float64              `json:"max_total_ratio"` // 跨维度连乘上限(防配置事故),0=不限
}

// skuRatioSetting 经反射注册接收后台 JSON。热路径不直接读它,改读 skuIndex。
var skuRatioSetting = SkuRatioConfig{
	Enabled:       false,
	Rules:         []SkuRule{},
	ModelRules:    map[string][]SkuRule{},
	MaxTotalRatio: 0,
}

// ---------------------------------------------------------------------------
// 用户侧展示(模型广场): 把命中模型的 SKU 规则带出,与计费同源
// ---------------------------------------------------------------------------

// GetSkuRulesForModel 返回命中 model 的全部启用规则(用于前端展示完整算式)。
// 全局 off 时返回 nil。展示与扣费同源:用的是同一份预编译索引。
func GetSkuRulesForModel(model string) []SkuRule {
	idx := skuIndex.Load()
	if idx == nil || !idx.enabled || len(idx.rules) == 0 {
		return nil
	}
	// 按 OutKey 去重:同 OutKey 后写覆盖,与计费 buildRatioMap 同源(精确 > 通配)。
	// pos 记录每个 OutKey 在 rules 里的下标:首次出现追加(定序),再次命中
	// 原地覆盖(值取最后一条匹配规则)。避免双层配置(全局通配 + 模型侧)对
	// 同一维度在模型广场显示两次、且暗示其叠加 —— 而计费实际只取最后一条。
	pos := make(map[string]int, len(idx.rules))
	var rules []SkuRule
	for _, cr := range idx.rules {
		if !matchModel(cr.rule.Models, model) {
			continue
		}
		if i, ok := pos[cr.rule.OutKey]; ok {
			rules[i] = cr.rule
			continue
		}
		pos[cr.rule.OutKey] = len(rules)
		rules = append(rules, cr.rule)
	}
	return rules
}

// GetSkuMaxTotalRatio 返回当前 SKU 表的跨维度连乘上限(0=不限)。
// 供模型广场试算器复刻后端 clampToMaxTotal,保证展示与扣费同源 ——
// 读的是与 GetSkuRulesForModel 同一份预编译快照,杜绝 clamp 值与规则错位。
// 全局 off 时返回 0(等价不 clamp)。
func GetSkuMaxTotalRatio() float64 {
	idx := skuIndex.Load()
	if idx == nil || !idx.enabled {
		return 0
	}
	return idx.maxTotalRatio
}

func init() {
	config.GlobalConfig.Register("sku_ratio_setting", &skuRatioSetting)
	RebuildSkuIndex()
}

// ---------------------------------------------------------------------------
// 预编译索引(atomic, 热路径无锁读)
//
// 参照 setting/operation_setting/tools.go 的 atomic.Pointer 模式:
// 反射改写 skuRatioSetting 后调用 RebuildSkuIndex 重建快照并 Store。
// 配置写入本就串行化(handleConfigUpdate 在 OptionMapRWMutex.Lock 内),
// 反射改完到重建快照之间无第二 writer,零 data race(红线 #7)。
// ---------------------------------------------------------------------------

// compiledRule 是预编译后的单条规则。
type compiledRule struct {
	rule  SkuRule
	tiers []SkuTier // tier 模式:已按 UpTo 升序(0 上限档置末尾)
}

type compiledSkuRules struct {
	enabled       bool
	rules         []compiledRule
	maxTotalRatio float64
}

var skuIndex atomic.Pointer[compiledSkuRules]

// RebuildSkuIndex 从当前 skuRatioSetting 重建查询索引。
// init 与配置更新后调用,不在计费热路径。
//
// 两个来源合并:Rules(全局通配)在前,ModelRules(按模型精确)在后。
// 顺序决定同 OutKey 后写覆盖语义(见 buildRatioMap)—— 精确模型规则后写,
// 故同 OutKey 时精确规则覆盖全局通配规则(精确 > 通配,符合直觉)。
func RebuildSkuIndex() {
	modelRuleCount := 0
	for _, rs := range skuRatioSetting.ModelRules {
		modelRuleCount += len(rs)
	}
	idx := &compiledSkuRules{
		enabled:       skuRatioSetting.Enabled,
		maxTotalRatio: skuRatioSetting.MaxTotalRatio,
		rules:         make([]compiledRule, 0, len(skuRatioSetting.Rules)+modelRuleCount),
	}

	// 1) 全局通配规则(兜底/批量),先入。
	for _, r := range skuRatioSetting.Rules {
		if cr, ok := compileSkuRule(r); ok {
			idx.rules = append(idx.rules, cr)
		}
	}

	// 2) 按模型精确规则:把 map key(模型名)注入 Models,复用通配/展示链路。
	//    后入,同 OutKey 时覆盖全局通配(精确 > 通配)。
	for model, rules := range skuRatioSetting.ModelRules {
		if model == "" {
			continue
		}
		for _, r := range rules {
			r.Models = []string{model} // 精确锚定到该模型,站长无需在规则里重复填
			if cr, ok := compileSkuRule(r); ok {
				idx.rules = append(idx.rules, cr)
			}
		}
	}

	skuIndex.Store(idx)
}

// compileSkuRule 校验并预编译单条规则。返回 false 表示该规则被丢弃(未启用/非法 OutKey/缺字段)。
func compileSkuRule(r SkuRule) (compiledRule, bool) {
	if !r.Enabled {
		return compiledRule{}, false
	}
	// OutKey 黑名单:数量键被拒绝(红线 #11)
	if forbiddenOutKeys[strings.ToLower(strings.TrimSpace(r.OutKey))] {
		common.SysError("sku_ratio: rejected forbidden out_key '" + r.OutKey + "' for models " + strings.Join(r.Models, ","))
		return compiledRule{}, false
	}
	if r.OutKey == "" || r.Source == "" {
		return compiledRule{}, false
	}

	cr := compiledRule{rule: r}
	if r.Kind == SkuKindTier {
		tiers := make([]SkuTier, len(r.Tiers))
		copy(tiers, r.Tiers)
		// 升序排序;UpTo=0(无上限)统一沉底
		sort.SliceStable(tiers, func(i, j int) bool {
			if tiers[i].UpTo == 0 {
				return false
			}
			if tiers[j].UpTo == 0 {
				return true
			}
			return tiers[i].UpTo < tiers[j].UpTo
		})
		cr.tiers = tiers
	}
	return cr, true
}

// ---------------------------------------------------------------------------
// 查询(计费热路径)
// ---------------------------------------------------------------------------

// GetSkuRatios 返回命中 model 的 SKU 倍率集合(OutKey -> ratio)。
// params 由注入点把已解析请求 struct 字段 + Metadata 拍平传入(非 gjson body)。
// 全局 off / 无命中 / 取值失败 → 返回空 map(零影响,完全向后兼容)。
// MaxTotalRatio 在本函数内对 SKU 各维度乘积做 clamp 后再输出,
// 保证预扣/提交修正/token重算三阶段口径一致(红线 #8)。
func GetSkuRatios(model string, params map[string]any) map[string]float64 {
	hits, maxTotal := evalSkuHits(model, params)
	return buildRatioMap(hits, maxTotal)
}

// GetSkuRatiosForImage 是图片路径专用变体:除返回倍率 map 外,
// 额外返回是否命中 dall-e 内建计费维度(Source 为 size/quality)。
// 用于防双算: dall-e + 按次定价时,SKU 覆盖了内建 size/quality 维度,
// 调用方需把 meta.ImagePriceRatio 归 1,阻止内建倍率重复烘进 modelPrice(红线 #1)。
func GetSkuRatiosForImage(model string, params map[string]any) (map[string]float64, bool) {
	hits, maxTotal := evalSkuHits(model, params)
	overridesBuiltin := false
	for _, h := range hits {
		src := strings.ToLower(h.source)
		if src == "size" || src == "quality" {
			overridesBuiltin = true
			break
		}
	}
	return buildRatioMap(hits, maxTotal), overridesBuiltin
}

// skuHit 是单条命中规则的求值结果。
type skuHit struct {
	outKey string
	ratio  float64
	source string
}

// evalSkuHits 遍历命中 model 的规则求值,返回所有非 1.0x 命中(保留顺序,同 OutKey 后写覆盖)。
func evalSkuHits(model string, params map[string]any) ([]skuHit, float64) {
	idx := skuIndex.Load()
	if idx == nil || !idx.enabled || len(idx.rules) == 0 {
		return nil, 0
	}
	hits := make([]skuHit, 0, len(idx.rules))
	for _, cr := range idx.rules {
		if !matchModel(cr.rule.Models, model) {
			continue
		}
		raw, ok := lookupParam(params, cr.rule.Source)
		if !ok {
			continue // 取值失败 → 该维度 1.0x(不加价)
		}
		ratio := interpretRule(cr, raw)
		if ratio <= 0 || ratio == 1.0 {
			continue // 1.0x 不计入(等价不加价),避免污染日志
		}
		hits = append(hits, skuHit{outKey: cr.rule.OutKey, ratio: ratio, source: cr.rule.Source})
	}
	return hits, idx.maxTotalRatio
}

// buildRatioMap 把命中列表收敛成 OutKey->ratio(同 OutKey 后写覆盖),并应用 MaxTotalRatio clamp。
func buildRatioMap(hits []skuHit, maxTotal float64) map[string]float64 {
	result := make(map[string]float64, len(hits))
	for _, h := range hits {
		result[h.outKey] = h.ratio // 同 OutKey 后写覆盖(与适配器硬编码同名时覆盖)
	}
	if maxTotal > 0 && len(result) > 0 {
		clampToMaxTotal(result, maxTotal)
	}
	return result
}

// clampToMaxTotal 当 SKU 各维度乘积超 maxTotal 时等比缩小各 ratio,
// 使 clamp 后的值进 map(三阶段一致,红线 #8)。只 scope SKU 键。
func clampToMaxTotal(result map[string]float64, maxTotal float64) {
	product := 1.0
	for _, v := range result {
		product *= v
	}
	if product <= maxTotal {
		return
	}
	// 等比缩小: 每个 ratio 乘以 scale^(1/n),使乘积落到 maxTotal
	scale := maxTotal / product
	n := float64(len(result))
	factor := math.Pow(scale, 1.0/n)
	for k := range result {
		result[k] *= factor
	}
}

// ---------------------------------------------------------------------------
// 解释器: 三种 Kind
// ---------------------------------------------------------------------------

func interpretRule(cr compiledRule, raw any) float64 {
	switch cr.rule.Kind {
	case SkuKindTier:
		val, ok := deriveNumber(cr.rule.Derive, raw)
		if !ok {
			return 1.0 // 派生失败 → 不加价
		}
		return tierRatio(cr.tiers, val)
	case SkuKindEnum:
		key := toStringValue(raw)
		if key == "" {
			return 1.0
		}
		if r, ok := cr.rule.Enum[key]; ok {
			return r
		}
		return 1.0 // 枚举未命中 → 不加价
	case SkuKindExists:
		if valueExists(raw) {
			return cr.rule.ExistsRatio
		}
		return 1.0
	default:
		return 1.0
	}
}

// tierRatio 落进第一个 UpTo >= val 的档;无命中用无上限档(UpTo=0),否则 1.0。
func tierRatio(tiers []SkuTier, val float64) float64 {
	for _, t := range tiers {
		if t.UpTo == 0 {
			continue // 无上限档最后处理
		}
		if val <= t.UpTo {
			return t.Ratio
		}
	}
	// 超过所有有限档 → 找无上限兜底档
	for _, t := range tiers {
		if t.UpTo == 0 {
			return t.Ratio
		}
	}
	return 1.0
}

// ---------------------------------------------------------------------------
// Derive: size/duration/fps 归一化为数字(表驱动,确定性)
// ---------------------------------------------------------------------------

func deriveNumber(derive string, raw any) (float64, bool) {
	switch derive {
	case SkuDeriveNumber, SkuDeriveSeconds:
		return toFloat(raw)
	case SkuDeriveLongEdge:
		return deriveLongEdge(raw)
	case SkuDeriveMegapixels:
		return deriveMegapixels(raw)
	default:
		// 未指定 derive 时按纯数字解析
		return toFloat(raw)
	}
}

// deriveLongEdge 从 size 派生长边像素。
// 支持: "1792x1024" / "1024*1024" / "1024" / "2K"/"4K" / "1080p"/"720p"。
func deriveLongEdge(raw any) (float64, bool) {
	s := strings.TrimSpace(strings.ToLower(toStringValue(raw)))
	if s == "" || s == "auto" {
		return 0, false
	}
	// WxH 或 W*H
	if w, h, ok := parseDimensions(s); ok {
		if w >= h {
			return w, true
		}
		return h, true
	}
	// 2K / 4K
	if strings.HasSuffix(s, "k") {
		if n, err := strconv.ParseFloat(strings.TrimSuffix(s, "k"), 64); err == nil {
			return n * 1024, true
		}
	}
	// 1080p / 720p(按高度命名 → 查表取长边)
	if strings.HasSuffix(s, "p") {
		if edge, ok := resolutionNameToLongEdge[s]; ok {
			return edge, true
		}
	}
	// 单数字
	if n, err := strconv.ParseFloat(s, 64); err == nil {
		return n, true
	}
	return 0, false
}

// resolutionNameToLongEdge 按高度命名的分辨率 → 长边像素。
var resolutionNameToLongEdge = map[string]float64{
	"480p":  854,
	"720p":  1280,
	"1080p": 1920,
	"1440p": 2560,
	"2160p": 3840,
}

// deriveMegapixels 从 size 派生百万像素(宽×高/1e6)。
func deriveMegapixels(raw any) (float64, bool) {
	s := strings.TrimSpace(strings.ToLower(toStringValue(raw)))
	if s == "" || s == "auto" {
		return 0, false
	}
	if w, h, ok := parseDimensions(s); ok {
		return w * h / 1e6, true
	}
	return 0, false
}

// parseDimensions 解析 "WxH" / "W*H" 形态,返回宽高。
func parseDimensions(s string) (float64, float64, bool) {
	var sep string
	if strings.Contains(s, "x") {
		sep = "x"
	} else if strings.Contains(s, "*") {
		sep = "*"
	} else {
		return 0, 0, false
	}
	parts := strings.SplitN(s, sep, 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	w, err1 := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
	h, err2 := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return w, h, true
}

// ---------------------------------------------------------------------------
// 模型通配匹配(精确优先,再 * 通配) — 项目无现成 glob(红线 #5)
// ---------------------------------------------------------------------------

func matchModel(patterns []string, model string) bool {
	// 精确优先
	for _, p := range patterns {
		if p == model {
			return true
		}
	}
	// 再 * 通配
	for _, p := range patterns {
		if !strings.Contains(p, "*") {
			continue
		}
		if matchWildcard(p, model) {
			return true
		}
	}
	return false
}

// matchWildcard 支持单个/多个 * 通配。
func matchWildcard(pattern, s string) bool {
	if pattern == "*" {
		return true
	}
	parts := strings.Split(pattern, "*")
	// 头部锚定
	if parts[0] != "" {
		if !strings.HasPrefix(s, parts[0]) {
			return false
		}
		s = s[len(parts[0]):]
	}
	// 尾部锚定
	last := parts[len(parts)-1]
	if last != "" {
		if !strings.HasSuffix(s, last) {
			return false
		}
		s = s[:len(s)-len(last)]
	}
	// 中间段按顺序匹配
	for _, mid := range parts[1 : len(parts)-1] {
		if mid == "" {
			continue
		}
		i := strings.Index(s, mid)
		if i < 0 {
			return false
		}
		s = s[i+len(mid):]
	}
	return true
}

// ---------------------------------------------------------------------------
// params 取值 + 类型工具
// ---------------------------------------------------------------------------

// lookupParam 按 key 从 params 取值,支持 "metadata.fps" 点路径。
func lookupParam(params map[string]any, key string) (any, bool) {
	if params == nil {
		return nil, false
	}
	if v, ok := params[key]; ok {
		return v, valueNonNil(v)
	}
	// 点路径
	if strings.Contains(key, ".") {
		parts := strings.Split(key, ".")
		var cur any = params
		for _, p := range parts {
			m, ok := cur.(map[string]any)
			if !ok {
				return nil, false
			}
			cur, ok = m[p]
			if !ok {
				return nil, false
			}
		}
		return cur, valueNonNil(cur)
	}
	return nil, false
}

func valueNonNil(v any) bool {
	return v != nil
}

func toStringValue(raw any) string {
	switch v := raw.(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case bool:
		if v {
			return "true"
		}
		return "false"
	default:
		return ""
	}
}

func toFloat(raw any) (float64, bool) {
	switch v := raw.(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case uint:
		return float64(v), true
	case string:
		n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return 0, false
		}
		return n, true
	default:
		return 0, false
	}
}

// valueExists 判断 exists 语义: 字段存在且非空/非 false/非零。
func valueExists(raw any) bool {
	switch v := raw.(type) {
	case nil:
		return false
	case bool:
		return v
	case string:
		return v != ""
	case float64:
		return v != 0
	case int:
		return v != 0
	case []any:
		return len(v) > 0
	case map[string]any:
		return len(v) > 0
	default:
		return true
	}
}
