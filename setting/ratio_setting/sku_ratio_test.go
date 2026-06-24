package ratio_setting

import (
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// setSkuConfig 用给定配置替换内存 setting 并重建索引(测试夹具)。
func setSkuConfig(t *testing.T, cfg SkuRatioConfig) {
	t.Helper()
	skuRatioSetting = cfg
	RebuildSkuIndex()
}

func TestDeriveLongEdge(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want float64
		ok   bool
	}{
		{"WxH 宽大于高", "1792x1024", 1792, true},
		{"WxH 高大于宽", "1024x1792", 1792, true},
		{"星号分隔", "1024*1024", 1024, true},
		{"单数字", "1024", 1024, true},
		{"2K", "2K", 2048, true},
		{"4K", "4k", 4096, true},
		{"1080p 查表", "1080p", 1920, true},
		{"720p 查表", "720p", 1280, true},
		{"auto 兜底", "auto", 0, false},
		{"空串", "", 0, false},
		{"无法解析", "abc", 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := deriveLongEdge(c.in)
			assert.Equal(t, c.ok, ok)
			if c.ok {
				assert.Equal(t, c.want, got)
			}
		})
	}
}

func TestDeriveMegapixels(t *testing.T) {
	got, ok := deriveMegapixels("1024x1024")
	require.True(t, ok)
	assert.InDelta(t, 1.048576, got, 1e-6)

	got, ok = deriveMegapixels("2048x1024")
	require.True(t, ok)
	assert.InDelta(t, 2.097152, got, 1e-6)

	_, ok = deriveMegapixels("auto")
	assert.False(t, ok)
}

func TestTierRatioBoundaries(t *testing.T) {
	tiers := []SkuTier{
		{UpTo: 1024, Ratio: 1.0},
		{UpTo: 2048, Ratio: 2.0},
		{UpTo: 4096, Ratio: 4.0},
		{UpTo: 0, Ratio: 5.0}, // 无上限兜底
	}
	cases := []struct {
		val  float64
		want float64
	}{
		{512, 1.0},
		{1024, 1.0},  // 边界含
		{1025, 2.0},
		{2048, 2.0},  // 边界含
		{4096, 4.0},  // 边界含
		{8192, 5.0},  // 超过有限档 → 无上限档
	}
	for _, c := range cases {
		assert.Equal(t, c.want, tierRatio(tiers, c.val), "val=%v", c.val)
	}
}

func TestTierRatioNoCatchAll(t *testing.T) {
	// 无无上限档时,超过所有档 → 1.0(不加价)
	tiers := []SkuTier{{UpTo: 1024, Ratio: 1.0}, {UpTo: 2048, Ratio: 2.0}}
	assert.Equal(t, 1.0, tierRatio(tiers, 9999))
}

func TestMatchModel(t *testing.T) {
	cases := []struct {
		patterns []string
		model    string
		want     bool
	}{
		{[]string{"dall-e-3"}, "dall-e-3", true},
		{[]string{"dall-e-3"}, "dall-e-2", false},
		{[]string{"sora*"}, "sora-2", true},
		{[]string{"sora*"}, "veo-3", false},
		{[]string{"*"}, "anything", true},
		{[]string{"*-pro"}, "veo-3-pro", true},
		{[]string{"veo*pro"}, "veo-3-pro", true},
		{[]string{"veo*pro"}, "veo-3-std", false},
		{[]string{"flux*", "dall-e-3"}, "dall-e-3", true},
	}
	for _, c := range cases {
		assert.Equal(t, c.want, matchModel(c.patterns, c.model), "patterns=%v model=%s", c.patterns, c.model)
	}
}

func TestGetSkuRatiosGlobalOff(t *testing.T) {
	setSkuConfig(t, SkuRatioConfig{
		Enabled: false,
		Rules: []SkuRule{
			{Models: []string{"gpt-image-1"}, Source: "quality", Kind: SkuKindEnum, OutKey: "sku_quality", Enabled: true,
				Enum: map[string]float64{"high": 2.5}},
		},
	})
	got := GetSkuRatios("gpt-image-1", map[string]any{"quality": "high"})
	assert.Empty(t, got, "全局 off 时应返回空 map")
}

func TestGetSkuRatiosEnum(t *testing.T) {
	setSkuConfig(t, SkuRatioConfig{
		Enabled: true,
		Rules: []SkuRule{
			{Models: []string{"gpt-image-1"}, Source: "quality", Kind: SkuKindEnum, OutKey: "sku_quality", Enabled: true,
				Enum: map[string]float64{"low": 1, "medium": 1.5, "high": 2.5}},
		},
	})
	assert.Equal(t, map[string]float64{"sku_quality": 2.5}, GetSkuRatios("gpt-image-1", map[string]any{"quality": "high"}))
	// 1.0 不写 map
	assert.Empty(t, GetSkuRatios("gpt-image-1", map[string]any{"quality": "low"}))
	// 枚举未命中 → 不加价
	assert.Empty(t, GetSkuRatios("gpt-image-1", map[string]any{"quality": "ultra"}))
	// 模型不匹配
	assert.Empty(t, GetSkuRatios("dall-e-3", map[string]any{"quality": "high"}))
}

func TestGetSkuRatiosTier(t *testing.T) {
	setSkuConfig(t, SkuRatioConfig{
		Enabled: true,
		Rules: []SkuRule{
			{Models: []string{"flux*"}, Source: "size", Kind: SkuKindTier, OutKey: "sku_size", Enabled: true,
				Derive: SkuDeriveLongEdge, Tiers: []SkuTier{
					{UpTo: 1024, Ratio: 1}, {UpTo: 2048, Ratio: 2}, {UpTo: 4096, Ratio: 4}, {UpTo: 0, Ratio: 5},
				}},
		},
	})
	assert.Equal(t, map[string]float64{"sku_size": 2.0}, GetSkuRatios("flux-pro", map[string]any{"size": "2048x2048"}))
	assert.Equal(t, map[string]float64{"sku_size": 5.0}, GetSkuRatios("flux-pro", map[string]any{"size": "8192x8192"}))
	// 取值失败 → 不加价
	assert.Empty(t, GetSkuRatios("flux-pro", map[string]any{"size": "auto"}))
	// 缺失参数 → 不加价
	assert.Empty(t, GetSkuRatios("flux-pro", map[string]any{}))
}

func TestGetSkuRatiosExists(t *testing.T) {
	setSkuConfig(t, SkuRatioConfig{
		Enabled: true,
		Rules: []SkuRule{
			{Models: []string{"veo*"}, Source: "input_reference", Kind: SkuKindExists, OutKey: "sku_i2v", Enabled: true,
				ExistsRatio: 1.3},
		},
	})
	assert.Equal(t, map[string]float64{"sku_i2v": 1.3}, GetSkuRatios("veo-3", map[string]any{"input_reference": "https://x/img.png"}))
	assert.Empty(t, GetSkuRatios("veo-3", map[string]any{"input_reference": ""}))
	assert.Empty(t, GetSkuRatios("veo-3", map[string]any{}))
}

func TestGetSkuRatiosMetadataDotPath(t *testing.T) {
	setSkuConfig(t, SkuRatioConfig{
		Enabled: true,
		Rules: []SkuRule{
			{Models: []string{"veo*"}, Source: "metadata.fps", Kind: SkuKindTier, OutKey: "sku_fps", Enabled: true,
				Derive: SkuDeriveNumber, Tiers: []SkuTier{{UpTo: 24, Ratio: 1}, {UpTo: 60, Ratio: 1.5}}},
		},
	})
	params := map[string]any{"metadata": map[string]any{"fps": float64(60)}}
	assert.Equal(t, map[string]float64{"sku_fps": 1.5}, GetSkuRatios("veo-3", params))
}

func TestGetSkuRatiosCrossDimensionMultiply(t *testing.T) {
	setSkuConfig(t, SkuRatioConfig{
		Enabled: true,
		Rules: []SkuRule{
			{Models: []string{"veo*"}, Source: "size", Kind: SkuKindTier, OutKey: "sku_size", Enabled: true,
				Derive: SkuDeriveLongEdge, Tiers: []SkuTier{{UpTo: 1920, Ratio: 1.5}, {UpTo: 0, Ratio: 3}}},
			{Models: []string{"veo*"}, Source: "mode", Kind: SkuKindEnum, OutKey: "sku_mode", Enabled: true,
				Enum: map[string]float64{"pro": 1.5, "master": 2.5}},
		},
	})
	got := GetSkuRatios("veo-3", map[string]any{"size": "1080p", "mode": "pro"})
	assert.Equal(t, map[string]float64{"sku_size": 1.5, "sku_mode": 1.5}, got)
}

func TestMaxTotalRatioClamp(t *testing.T) {
	setSkuConfig(t, SkuRatioConfig{
		Enabled:       true,
		MaxTotalRatio: 4.0,
		Rules: []SkuRule{
			{Models: []string{"veo*"}, Source: "size", Kind: SkuKindEnum, OutKey: "sku_size", Enabled: true,
				Enum: map[string]float64{"big": 3.0}},
			{Models: []string{"veo*"}, Source: "mode", Kind: SkuKindEnum, OutKey: "sku_mode", Enabled: true,
				Enum: map[string]float64{"pro": 3.0}},
		},
	})
	got := GetSkuRatios("veo-3", map[string]any{"size": "big", "mode": "pro"})
	// 原始乘积 9 > 4,等比缩小后乘积应 ≈ 4
	product := 1.0
	for _, v := range got {
		product *= v
	}
	assert.InDelta(t, 4.0, product, 1e-6)
}

func TestMaxTotalRatioNoClampWhenUnderLimit(t *testing.T) {
	setSkuConfig(t, SkuRatioConfig{
		Enabled:       true,
		MaxTotalRatio: 10.0,
		Rules: []SkuRule{
			{Models: []string{"veo*"}, Source: "mode", Kind: SkuKindEnum, OutKey: "sku_mode", Enabled: true,
				Enum: map[string]float64{"pro": 2.0}},
		},
	})
	assert.Equal(t, map[string]float64{"sku_mode": 2.0}, GetSkuRatios("veo-3", map[string]any{"mode": "pro"}))
}

func TestForbiddenOutKeyRejected(t *testing.T) {
	for _, bad := range []string{"n", "seconds", "duration", "SECONDS", " duration "} {
		setSkuConfig(t, SkuRatioConfig{
			Enabled: true,
			Rules: []SkuRule{
				{Models: []string{"sora*"}, Source: "duration", Kind: SkuKindEnum, OutKey: bad, Enabled: true,
					Enum: map[string]float64{"long": 2.0}},
			},
		})
		got := GetSkuRatios("sora-2", map[string]any{"duration": "long"})
		assert.Empty(t, got, "OutKey=%q 应被黑名单拒绝", bad)
	}
}

func TestDisabledRuleSkipped(t *testing.T) {
	setSkuConfig(t, SkuRatioConfig{
		Enabled: true,
		Rules: []SkuRule{
			{Models: []string{"veo*"}, Source: "mode", Kind: SkuKindEnum, OutKey: "sku_mode", Enabled: false,
				Enum: map[string]float64{"pro": 2.0}},
		},
	})
	assert.Empty(t, GetSkuRatios("veo-3", map[string]any{"mode": "pro"}))
}

// TestModelRulesExactMatch 验证按模型精确规则:map key 注入 Models,只命中该模型。
func TestModelRulesExactMatch(t *testing.T) {
	setSkuConfig(t, SkuRatioConfig{
		Enabled: true,
		ModelRules: map[string][]SkuRule{
			"gpt-image-1": {
				// 注意:规则内不填 Models,由 map key 注入
				{Source: "quality", Kind: SkuKindEnum, OutKey: "sku_quality", Enabled: true,
					Enum: map[string]float64{"high": 2.5}},
			},
		},
	})
	assert.Equal(t, map[string]float64{"sku_quality": 2.5}, GetSkuRatios("gpt-image-1", map[string]any{"quality": "high"}))
	// 精确锚定:不泄漏到其它模型
	assert.Empty(t, GetSkuRatios("gpt-image-2", map[string]any{"quality": "high"}))
}

// TestModelRulesAndGlobalMerge 验证精确规则与全局通配规则合并、跨维度连乘。
func TestModelRulesAndGlobalMerge(t *testing.T) {
	setSkuConfig(t, SkuRatioConfig{
		Enabled: true,
		Rules: []SkuRule{
			{Models: []string{"veo*"}, Source: "size", Kind: SkuKindTier, OutKey: "sku_size", Enabled: true,
				Derive: SkuDeriveLongEdge, Tiers: []SkuTier{{UpTo: 1920, Ratio: 1.5}, {UpTo: 0, Ratio: 3}}},
		},
		ModelRules: map[string][]SkuRule{
			"veo-3": {
				{Source: "mode", Kind: SkuKindEnum, OutKey: "sku_mode", Enabled: true,
					Enum: map[string]float64{"pro": 2.0}},
			},
		},
	})
	got := GetSkuRatios("veo-3", map[string]any{"size": "4096x4096", "mode": "pro"})
	assert.Equal(t, map[string]float64{"sku_size": 3.0, "sku_mode": 2.0}, got)
}

// TestModelRulesOverrideGlobal 验证同 OutKey 时精确规则覆盖全局通配(精确 > 通配)。
func TestModelRulesOverrideGlobal(t *testing.T) {
	setSkuConfig(t, SkuRatioConfig{
		Enabled: true,
		Rules: []SkuRule{
			{Models: []string{"sora*"}, Source: "size", Kind: SkuKindEnum, OutKey: "sku_size", Enabled: true,
				Enum: map[string]float64{"big": 2.0}},
		},
		ModelRules: map[string][]SkuRule{
			"sora-2": {
				{Source: "size", Kind: SkuKindEnum, OutKey: "sku_size", Enabled: true,
					Enum: map[string]float64{"big": 5.0}},
			},
		},
	})
	// 精确规则后写覆盖全局通配:5.0 而非 2.0
	assert.Equal(t, map[string]float64{"sku_size": 5.0}, GetSkuRatios("sora-2", map[string]any{"size": "big"}))
	// 未被精确规则覆盖的其它 sora 模型仍走全局通配
	assert.Equal(t, map[string]float64{"sku_size": 2.0}, GetSkuRatios("sora-1", map[string]any{"size": "big"}))
}

// TestGetSkuRulesForModelIncludesModelRules 验证展示链路能带出精确规则(注入了 Models)。
func TestGetSkuRulesForModelIncludesModelRules(t *testing.T) {
	setSkuConfig(t, SkuRatioConfig{
		Enabled: true,
		ModelRules: map[string][]SkuRule{
			"gpt-image-1": {
				{Source: "quality", Kind: SkuKindEnum, OutKey: "sku_quality", Enabled: true,
					Enum: map[string]float64{"high": 2.5}},
			},
		},
	})
	rules := GetSkuRulesForModel("gpt-image-1")
	require.Len(t, rules, 1)
	assert.Equal(t, []string{"gpt-image-1"}, rules[0].Models, "Models 应由 map key 注入")
	assert.Equal(t, "sku_quality", rules[0].OutKey)
}

// TestGetSkuRulesForModelDedupesByOutKey 复现生产场景:模型同时被全局通配规则
// 与精确模型规则命中(同 OutKey)。展示需按 OutKey 去重且精确覆盖通配,与计费
// buildRatioMap 同源 —— 否则模型广场会把同一维度显示两次、且暗示其叠加,而计费
// 实际只取最后一条。
func TestGetSkuRulesForModelDedupesByOutKey(t *testing.T) {
	setSkuConfig(t, SkuRatioConfig{
		Enabled: true,
		// 全局通配:gpt-image* 的 size + quality(站长「统一发放」)
		Rules: []SkuRule{
			{Models: []string{"gpt-image*"}, Source: "size", Kind: SkuKindEnum, OutKey: "sku_size", Enabled: true,
				Enum: map[string]float64{"big": 0.9}},
			{Models: []string{"gpt-image*"}, Source: "quality", Kind: SkuKindEnum, OutKey: "sku_quality", Enabled: true,
				Enum: map[string]float64{"high": 0.9}},
		},
		// 模型侧:gpt-image-2 同名 OutKey,值取 0.5 以验证覆盖方向(精确 > 通配)
		ModelRules: map[string][]SkuRule{
			"gpt-image-2": {
				{Source: "size", Kind: SkuKindEnum, OutKey: "sku_size", Enabled: true,
					Enum: map[string]float64{"big": 0.5}},
				{Source: "quality", Kind: SkuKindEnum, OutKey: "sku_quality", Enabled: true,
					Enum: map[string]float64{"high": 0.5}},
			},
		},
	})

	rules := GetSkuRulesForModel("gpt-image-2")
	// 去重前会是 4 条(全局 2 + 模型侧 2);去重后每个 OutKey 仅一条
	require.Len(t, rules, 2, "同 OutKey 应去重,size/quality 各一条")

	byKey := make(map[string]SkuRule, len(rules))
	for _, r := range rules {
		byKey[r.OutKey] = r
	}
	require.Contains(t, byKey, "sku_size")
	require.Contains(t, byKey, "sku_quality")
	// 精确模型规则覆盖全局通配:Models 为模型名,值取模型侧的 0.5
	assert.Equal(t, []string{"gpt-image-2"}, byKey["sku_size"].Models, "精确规则应覆盖通配")
	assert.Equal(t, 0.5, byKey["sku_size"].Enum["big"])
	assert.Equal(t, 0.5, byKey["sku_quality"].Enum["high"])
	// 展示顺序稳定:先 size 后 quality(首次出现顺序,与全局规则定义序一致)
	assert.Equal(t, "sku_size", rules[0].OutKey)
	assert.Equal(t, "sku_quality", rules[1].OutKey)

	// 关键不变量:展示去重必须与计费同源。GetSkuRatios 经 buildRatioMap 已按
	// OutKey 折叠,展示侧去重后两者口径完全一致(同 0.5,精确覆盖通配)。
	ratios := GetSkuRatios("gpt-image-2", map[string]any{"size": "big", "quality": "high"})
	assert.Equal(t, map[string]float64{"sku_size": 0.5, "sku_quality": 0.5}, ratios,
		"展示去重应与计费 buildRatioMap 折叠口径一致")
}

// TestConcurrentReadDuringReload 验证热路径并发读 + 配置 reload 无 data race(红线 #7)。
// 必须配合 go test -race 运行。
func TestConcurrentReadDuringReload(t *testing.T) {
	setSkuConfig(t, SkuRatioConfig{
		Enabled: true,
		Rules: []SkuRule{
			{Models: []string{"veo*"}, Source: "size", Kind: SkuKindTier, OutKey: "sku_size", Enabled: true,
				Derive: SkuDeriveLongEdge, Tiers: []SkuTier{{UpTo: 1080, Ratio: 1.5}, {UpTo: 0, Ratio: 3}}},
		},
	})

	var wg sync.WaitGroup
	stop := make(chan struct{})

	// 多个高频读
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					GetSkuRatios("veo-3", map[string]any{"size": "1080p"})
				}
			}
		}()
	}

	// 一个 writer 反复 reload
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			RebuildSkuIndex()
		}
	}()

	// 让读写跑一会
	for i := 0; i < 200; i++ {
		GetSkuRatios("veo-3", map[string]any{"size": "720p"})
	}
	close(stop)
	wg.Wait()
}
