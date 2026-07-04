package common

import "github.com/QuantumNous/new-api/dto"

const EmptyResponseUsageSource = "empty_response_billing"

func ShouldBillEmptyResponse(info *RelayInfo) bool {
	return info != nil &&
		info.ChannelMeta != nil &&
		info.ChannelOtherSettings.EmptyResponseBillingEnabled
}

func EnsureEmptyResponseBillableUsage(info *RelayInfo, usage *dto.Usage) *dto.Usage {
	if usage == nil {
		usage = &dto.Usage{}
	}
	if usage.PromptTokens == 0 && usage.InputTokens > 0 {
		usage.PromptTokens = usage.InputTokens
	}
	if usage.CompletionTokens == 0 && usage.OutputTokens > 0 {
		usage.CompletionTokens = usage.OutputTokens
	}
	if usage.PromptTokens == 0 && usage.CompletionTokens == 0 {
		promptTokens := 0
		if info != nil {
			promptTokens = info.GetEstimatePromptTokens()
		}
		if promptTokens <= 0 {
			promptTokens = 1
		}
		usage.PromptTokens = promptTokens
	}
	if usage.TotalTokens == 0 {
		usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
	}
	if usage.UsageSource == "" {
		usage.UsageSource = EmptyResponseUsageSource
	}
	return usage
}
