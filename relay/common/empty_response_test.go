package common

import (
	"testing"

	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/setting/model_setting"
	"github.com/stretchr/testify/assert"
)

func emptyResponseRelayInfo(channelType int, channelSetting *bool) *RelayInfo {
	return &RelayInfo{
		ChannelMeta: &ChannelMeta{
			ChannelType: channelType,
			ChannelOtherSettings: dto.ChannelOtherSettings{
				EmptyResponseBillingEnabled: channelSetting,
			},
		},
	}
}

func TestShouldBillEmptyResponsePriority(t *testing.T) {
	settings := model_setting.GetGlobalSettings()
	originalPolicy := settings.EmptyResponseBillingPolicy
	defer func() {
		settings.EmptyResponseBillingPolicy = originalPolicy
	}()

	settings.EmptyResponseBillingPolicy = model_setting.EmptyResponseBillingPolicy{
		ChannelTypes: map[int]bool{
			constant.ChannelTypeOpenAI: true,
			constant.ChannelTypeGemini: false,
		},
	}

	assert.True(
		t,
		ShouldBillEmptyResponse(emptyResponseRelayInfo(constant.ChannelTypeOpenAI, nil)),
	)
	assert.False(
		t,
		ShouldBillEmptyResponse(emptyResponseRelayInfo(constant.ChannelTypeGemini, nil)),
	)

	channelDisabled := false
	assert.False(
		t,
		ShouldBillEmptyResponse(emptyResponseRelayInfo(constant.ChannelTypeOpenAI, &channelDisabled)),
	)

	channelEnabled := true
	assert.True(
		t,
		ShouldBillEmptyResponse(emptyResponseRelayInfo(constant.ChannelTypeGemini, &channelEnabled)),
	)
	assert.False(t, ShouldBillEmptyResponse(nil))
}
