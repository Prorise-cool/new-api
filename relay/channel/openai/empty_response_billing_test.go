package openai

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/dto"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newEmptyResponseBillingContext(body string, emptyResponseBillingEnabled *bool) (*gin.Context, *httptest.ResponseRecorder, *http.Response, *relaycommon.RelayInfo) {
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)

	resp := &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
	}
	info := &relaycommon.RelayInfo{
		RelayFormat:     types.RelayFormatOpenAI,
		OriginModelName: "gpt-test",
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelType:       constant.ChannelTypeOpenAI,
			UpstreamModelName: "gpt-test",
			ChannelOtherSettings: dto.ChannelOtherSettings{
				EmptyResponseBillingEnabled: emptyResponseBillingEnabled,
			},
		},
	}
	info.SetEstimatePromptTokens(23)
	return c, recorder, resp, info
}

func TestOpenaiHandlerKeepsEmptyResponseFreeByDefault(t *testing.T) {
	gin.SetMode(gin.TestMode)

	body := `{"id":"chatcmpl-empty","object":"chat.completion","created":1710000000,"model":"gpt-test","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":0,"total_tokens":12}}`
	c, recorder, resp, info := newEmptyResponseBillingContext(body, nil)

	usage, err := OpenaiHandler(c, info, resp)

	require.Nil(t, usage)
	require.NotNil(t, err)
	assert.Equal(t, http.StatusInternalServerError, err.StatusCode)
	assert.Empty(t, recorder.Body.String())
}

func TestOpenaiHandlerBillsEmptyResponseWhenEnabled(t *testing.T) {
	gin.SetMode(gin.TestMode)

	body := `{"id":"chatcmpl-empty","object":"chat.completion","created":1710000000,"model":"gpt-test","choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}`
	enabled := true
	c, recorder, resp, info := newEmptyResponseBillingContext(body, &enabled)

	usage, err := OpenaiHandler(c, info, resp)

	require.Nil(t, err)
	require.NotNil(t, usage)
	assert.Equal(t, 23, usage.PromptTokens)
	assert.Equal(t, 0, usage.CompletionTokens)
	assert.Equal(t, 23, usage.TotalTokens)
	assert.Equal(t, relaycommon.EmptyResponseUsageSource, usage.UsageSource)
	assert.Contains(t, recorder.Body.String(), `"usage"`)
}
