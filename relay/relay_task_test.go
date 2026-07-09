package relay

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/setting/config"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setTaskSkuTestConfig(t *testing.T, rules []ratio_setting.SkuRule) {
	t.Helper()

	cfg := config.GlobalConfig.Get("sku_ratio_setting")
	require.NotNil(t, cfg)

	rulesJSON, err := common.Marshal(rules)
	require.NoError(t, err)
	require.NoError(t, config.UpdateConfigFromMap(cfg, map[string]string{
		"enabled":         "true",
		"rules":           string(rulesJSON),
		"model_rules":     "{}",
		"max_total_ratio": "0",
	}))
	ratio_setting.RebuildSkuIndex()

	t.Cleanup(func() {
		require.NoError(t, config.UpdateConfigFromMap(cfg, map[string]string{
			"enabled":         "false",
			"rules":           "[]",
			"model_rules":     "{}",
			"max_total_ratio": "0",
		}))
		ratio_setting.RebuildSkuIndex()
	})
}

func TestTaskSkuRatiosUsesVideoResolutionFields(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setTaskSkuTestConfig(t, []ratio_setting.SkuRule{
		{
			Models:  []string{"grok-imagine-video-1.5"},
			Source:  "resolution",
			Kind:    ratio_setting.SkuKindTier,
			OutKey:  "sku_resolution",
			Enabled: true,
			Derive:  ratio_setting.SkuDeriveLongEdge,
			Tiers: []ratio_setting.SkuTier{
				{UpTo: 1280, Ratio: 0.8, Label: "720p"},
				{UpTo: 1920, Ratio: 1.0, Label: "1080p"},
			},
		},
		{
			Models:  []string{"grok-imagine-video-1.5"},
			Source:  "metadata.resolution",
			Kind:    ratio_setting.SkuKindTier,
			OutKey:  "sku_resolution_legacy",
			Enabled: true,
			Derive:  ratio_setting.SkuDeriveLongEdge,
			Tiers: []ratio_setting.SkuTier{
				{UpTo: 1280, Ratio: 0.8, Label: "720p"},
				{UpTo: 1920, Ratio: 1.0, Label: "1080p"},
			},
		},
		{
			Models:  []string{"grok-imagine-video-1.5"},
			Source:  "size",
			Kind:    ratio_setting.SkuKindTier,
			OutKey:  "sku_size_compat",
			Enabled: true,
			Derive:  ratio_setting.SkuDeriveLongEdge,
			Tiers: []ratio_setting.SkuTier{
				{UpTo: 1280, Ratio: 0.8, Label: "720p"},
				{UpTo: 1920, Ratio: 1.0, Label: "1080p"},
			},
		},
		{
			Models:  []string{"grok-imagine-video-1.5"},
			Source:  "aspect_ratio",
			Kind:    ratio_setting.SkuKindEnum,
			OutKey:  "sku_aspect_ratio",
			Enabled: true,
			Enum:    map[string]float64{"16:9": 1.2},
		},
	})

	request := httptest.NewRequest(http.MethodPost, "/v1/videos/generations", nil)
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = request
	metadata := map[string]interface{}{}
	context.Set("task_request", relaycommon.TaskSubmitReq{
		Model:       "grok-imagine-video-1.5",
		Resolution:  "720p",
		AspectRatio: "16:9",
		Metadata:    metadata,
	})

	got := taskSkuRatios(context, &relaycommon.RelayInfo{}, "grok-imagine-video-1.5")

	assert.Equal(t, map[string]float64{
		"sku_resolution":        0.8,
		"sku_resolution_legacy": 0.8,
		"sku_size_compat":       0.8,
		"sku_aspect_ratio":      1.2,
	}, got)
	assert.NotContains(t, metadata, "resolution")
}
