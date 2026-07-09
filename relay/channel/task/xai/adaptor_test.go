package xai

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestContext(method, path, body string) (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = request
	return context, recorder
}

func TestValidateRequestAndSetActionStoresGenerationRequest(t *testing.T) {
	context, _ := newTestContext(http.MethodPost, "/v1/video/generations", `{"model":"grok-imagine-video","prompt":"ocean","duration":10}`)
	info := &relaycommon.RelayInfo{TaskRelayInfo: &relaycommon.TaskRelayInfo{}}
	adaptor := &TaskAdaptor{}

	taskErr := adaptor.ValidateRequestAndSetAction(context, info)

	require.Nil(t, taskErr)
	assert.Equal(t, constant.TaskActionGenerate, info.Action)
	req, err := relaycommon.GetTaskRequest(context)
	require.NoError(t, err)
	assert.Equal(t, "grok-imagine-video", req.Model)
	assert.Equal(t, "ocean", req.Prompt)
	assert.Equal(t, 10, req.Duration)
}

func TestValidateRequestAndSetActionRejectsInvalidDuration(t *testing.T) {
	tests := []struct {
		name string
		body string
		code string
	}{
		{name: "too long duration", body: `{"model":"grok-imagine-video","prompt":"ocean","duration":16}`, code: "invalid_duration"},
		{name: "zero duration", body: `{"model":"grok-imagine-video","prompt":"ocean","duration":0}`, code: "invalid_duration"},
		{name: "huge seconds", body: `{"model":"grok-imagine-video","prompt":"ocean","seconds":"9999999999"}`, code: "invalid_seconds"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			context, _ := newTestContext(http.MethodPost, "/v1/video/generations", tt.body)
			info := &relaycommon.RelayInfo{TaskRelayInfo: &relaycommon.TaskRelayInfo{}}
			adaptor := &TaskAdaptor{}

			taskErr := adaptor.ValidateRequestAndSetAction(context, info)

			require.NotNil(t, taskErr)
			assert.Equal(t, tt.code, taskErr.Code)
			assert.Equal(t, http.StatusBadRequest, taskErr.StatusCode)
		})
	}
}

func TestValidateRequestAndSetActionUsesExtensionDurationRange(t *testing.T) {
	context, _ := newTestContext(http.MethodPost, "/v1/videos/extensions", `{"model":"grok-imagine-video","prompt":"extend","video":{"url":"https://cdn.example/input.mp4"},"duration":11}`)
	info := &relaycommon.RelayInfo{TaskRelayInfo: &relaycommon.TaskRelayInfo{}}
	adaptor := &TaskAdaptor{}

	taskErr := adaptor.ValidateRequestAndSetAction(context, info)

	require.NotNil(t, taskErr)
	assert.Equal(t, "invalid_duration", taskErr.Code)

	context, _ = newTestContext(http.MethodPost, "/v1/videos/extensions", `{"model":"grok-imagine-video","prompt":"extend","video":{"url":"https://cdn.example/input.mp4"}}`)
	info = &relaycommon.RelayInfo{TaskRelayInfo: &relaycommon.TaskRelayInfo{}}
	taskErr = adaptor.ValidateRequestAndSetAction(context, info)

	require.Nil(t, taskErr)
	assert.Equal(t, TaskActionVideoExtend, info.Action)
	rq, err := relaycommon.GetTaskRequest(context)
	require.NoError(t, err)
	assert.Equal(t, DefaultVideoExtensionSeconds, rq.Duration)
}

func TestBuildRequestBodyDropsEditOnlyUnsupportedDurationFields(t *testing.T) {
	context, _ := newTestContext(http.MethodPost, "/v1/videos/edits", `{"model":"grok-imagine-video","prompt":"edit","video":{"url":"https://cdn.example/input.mp4"},"duration":10,"seconds":"8","resolution":"720p","aspect_ratio":"16:9"}`)
	info := &relaycommon.RelayInfo{
		ChannelMeta:   &relaycommon.ChannelMeta{UpstreamModelName: "mapped-video"},
		TaskRelayInfo: &relaycommon.TaskRelayInfo{Action: TaskActionVideoEdit},
	}
	adaptor := &TaskAdaptor{}

	body, err := adaptor.BuildRequestBody(context, info)
	require.NoError(t, err)
	data, err := io.ReadAll(body)
	require.NoError(t, err)

	var requestMap map[string]any
	require.NoError(t, common.Unmarshal(data, &requestMap))
	assert.Equal(t, "mapped-video", requestMap["model"])
	assert.NotContains(t, requestMap, "duration")
	assert.NotContains(t, requestMap, "seconds")
	assert.NotContains(t, requestMap, "resolution")
	assert.NotContains(t, requestMap, "aspect_ratio")
}

func TestBuildRequestURLByAction(t *testing.T) {
	adaptor := &TaskAdaptor{baseURL: "https://api.x.ai/"}

	generateURL, err := adaptor.BuildRequestURL(&relaycommon.RelayInfo{TaskRelayInfo: &relaycommon.TaskRelayInfo{Action: constant.TaskActionGenerate}})
	require.NoError(t, err)
	assert.Equal(t, "https://api.x.ai/v1/videos/generations", generateURL)

	editURL, err := adaptor.BuildRequestURL(&relaycommon.RelayInfo{TaskRelayInfo: &relaycommon.TaskRelayInfo{Action: TaskActionVideoEdit}})
	require.NoError(t, err)
	assert.Equal(t, "https://api.x.ai/v1/videos/edits", editURL)

	extendURL, err := adaptor.BuildRequestURL(&relaycommon.RelayInfo{TaskRelayInfo: &relaycommon.TaskRelayInfo{Action: TaskActionVideoExtend}})
	require.NoError(t, err)
	assert.Equal(t, "https://api.x.ai/v1/videos/extensions", extendURL)
}

func TestBuildRequestBodyReplacesModelAndConvertsSeconds(t *testing.T) {
	context, _ := newTestContext(http.MethodPost, "/v1/video/generations", `{"model":"grok-imagine-video","prompt":"ocean","seconds":"8"}`)
	info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{UpstreamModelName: "mapped-video"}}
	adaptor := &TaskAdaptor{}

	body, err := adaptor.BuildRequestBody(context, info)
	require.NoError(t, err)
	data, err := io.ReadAll(body)
	require.NoError(t, err)

	var requestMap map[string]any
	require.NoError(t, common.Unmarshal(data, &requestMap))
	assert.Equal(t, "mapped-video", requestMap["model"])
	assert.Equal(t, "ocean", requestMap["prompt"])
	assert.Equal(t, float64(8), requestMap["duration"])
	assert.NotContains(t, requestMap, "seconds")
}

func TestDoResponseUsesRequestIDAndPublicTaskID(t *testing.T) {
	context, recorder := newTestContext(http.MethodPost, "/v1/video/generations", `{}`)
	info := &relaycommon.RelayInfo{
		OriginModelName: "grok-imagine-video",
		TaskRelayInfo:   &relaycommon.TaskRelayInfo{PublicTaskID: "task_public"},
	}
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(`{"request_id":"upstream-request"}`)),
	}
	adaptor := &TaskAdaptor{}

	upstreamID, taskData, taskErr := adaptor.DoResponse(context, resp, info)

	require.Nil(t, taskErr)
	assert.Equal(t, "upstream-request", upstreamID)
	assert.Contains(t, string(taskData), "upstream-request")
	assert.Equal(t, http.StatusOK, recorder.Code)

	var openAIVideo dto.OpenAIVideo
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &openAIVideo))
	assert.Equal(t, "task_public", openAIVideo.ID)
	assert.Equal(t, "task_public", openAIVideo.TaskID)
	assert.Equal(t, "grok-imagine-video", openAIVideo.Model)
}

func TestParseTaskResultMapsStatusesAndVideoURL(t *testing.T) {
	adaptor := &TaskAdaptor{}

	success, err := adaptor.ParseTaskResult([]byte(`{"status":"done","video":{"url":"https://cdn.example/video.mp4","duration":10},"progress":100}`))
	require.NoError(t, err)
	assert.Equal(t, string(model.TaskStatusSuccess), success.Status)
	assert.Equal(t, "https://cdn.example/video.mp4", success.Url)
	assert.Equal(t, "100%", success.Progress)

	expired, err := adaptor.ParseTaskResult([]byte(`{"status":"expired"}`))
	require.NoError(t, err)
	assert.Equal(t, string(model.TaskStatusFailure), expired.Status)
	assert.Equal(t, "task expired", expired.Reason)
	assert.Equal(t, "100%", expired.Progress)

	processing, err := adaptor.ParseTaskResult([]byte(`{"status":"generating","progress":40}`))
	require.NoError(t, err)
	assert.Equal(t, string(model.TaskStatusInProgress), processing.Status)
	assert.Equal(t, "40%", processing.Progress)
}

func TestConvertToOpenAIVideoIncludesXAIResultMetadata(t *testing.T) {
	adaptor := &TaskAdaptor{}
	task := &model.Task{
		TaskID:    "task_public",
		Status:    model.TaskStatusSuccess,
		Progress:  "100%",
		CreatedAt: 100,
		UpdatedAt: 200,
		Properties: model.Properties{
			OriginModelName: "grok-imagine-video",
		},
		PrivateData: model.TaskPrivateData{
			ResultURL: "https://cdn.example/video.mp4",
		},
		Data: []byte(`{"status":"done","model":"grok-imagine-video","video":{"url":"https://cdn.example/video.mp4","duration":10},"usage":{"cost_in_usd_ticks":500000000},"progress":100}`),
	}

	data, err := adaptor.ConvertToOpenAIVideo(task)
	require.NoError(t, err)

	var openAIVideo dto.OpenAIVideo
	require.NoError(t, common.Unmarshal(data, &openAIVideo))
	assert.Equal(t, "task_public", openAIVideo.ID)
	assert.Equal(t, dto.VideoStatusCompleted, openAIVideo.Status)
	assert.Equal(t, 100, openAIVideo.Progress)
	assert.Equal(t, "https://cdn.example/video.mp4", openAIVideo.Metadata["url"])
	assert.Equal(t, float64(10), openAIVideo.Metadata["duration"])
	assert.Equal(t, float64(500000000), openAIVideo.Metadata["cost_in_usd_ticks"])
}
