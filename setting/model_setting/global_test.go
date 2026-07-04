package model_setting

import (
	"testing"

	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/setting/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGlobalSettingsEmptyResponseBillingPolicyLoadsFromConfig(t *testing.T) {
	settings := GlobalSettings{}

	err := config.UpdateConfigFromMap(&settings, map[string]string{
		"empty_response_billing_policy": `{"channel_types":{"1":true,"24":false}}`,
	})

	require.NoError(t, err)
	assert.True(
		t,
		settings.EmptyResponseBillingPolicy.IsChannelTypeEnabled(constant.ChannelTypeOpenAI),
	)
	assert.False(
		t,
		settings.EmptyResponseBillingPolicy.IsChannelTypeEnabled(constant.ChannelTypeGemini),
	)
	assert.False(
		t,
		settings.EmptyResponseBillingPolicy.IsChannelTypeEnabled(constant.ChannelTypeAnthropic),
	)
}
