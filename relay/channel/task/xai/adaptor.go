package xai

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relay/channel"
	taskcommon "github.com/QuantumNous/new-api/relay/channel/task/taskcommon"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/pkg/errors"
)

type submitResponse struct {
	RequestID string `json:"request_id"`
}

type videoResultResponse struct {
	Status   string `json:"status"`
	Video    video  `json:"video"`
	Model    string `json:"model"`
	Usage    usage  `json:"usage"`
	Progress int    `json:"progress"`
	Error    *struct {
		Message string `json:"message"`
		Code    string `json:"code"`
	} `json:"error,omitempty"`
}

type video struct {
	URL               string  `json:"url"`
	Duration          float64 `json:"duration"`
	RespectModeration bool    `json:"respect_moderation"`
}

type usage struct {
	CostInUSDTicks int64 `json:"cost_in_usd_ticks"`
}

type TaskAdaptor struct {
	taskcommon.BaseBilling
	ChannelType int
	apiKey      string
	baseURL     string
}

func (a *TaskAdaptor) Init(info *relaycommon.RelayInfo) {
	a.ChannelType = info.ChannelType
	a.baseURL = info.ChannelBaseUrl
	a.apiKey = info.ApiKey
}

func (a *TaskAdaptor) ValidateRequestAndSetAction(c *gin.Context, info *relaycommon.RelayInfo) *dto.TaskError {
	var requestMap map[string]any
	if err := common.UnmarshalBodyReusable(c, &requestMap); err != nil {
		return service.TaskErrorWrapperLocal(err, "invalid_request", http.StatusBadRequest)
	}

	modelName, _ := requestMap["model"].(string)
	if strings.TrimSpace(modelName) == "" {
		return service.TaskErrorWrapperLocal(fmt.Errorf("model field is required"), "missing_model", http.StatusBadRequest)
	}

	prompt, _ := requestMap["prompt"].(string)
	if strings.TrimSpace(prompt) == "" {
		return service.TaskErrorWrapperLocal(fmt.Errorf("prompt is required"), "invalid_request", http.StatusBadRequest)
	}

	action := constant.TaskActionGenerate
	path := c.Request.URL.Path
	switch {
	case strings.HasSuffix(path, "/edits"):
		action = TaskActionVideoEdit
		if _, ok := requestMap["video"].(map[string]any); !ok {
			return service.TaskErrorWrapperLocal(fmt.Errorf("video field is required"), "invalid_request", http.StatusBadRequest)
		}
	case strings.HasSuffix(path, "/extensions"):
		action = TaskActionVideoExtend
		if _, ok := requestMap["video"].(map[string]any); !ok {
			return service.TaskErrorWrapperLocal(fmt.Errorf("video field is required"), "invalid_request", http.StatusBadRequest)
		}
	}

	duration := 0
	hasDuration := false
	seconds := 0
	hasSeconds := false
	if action != TaskActionVideoEdit {
		var err error
		duration, hasDuration, err = parseOptionalInt(requestMap["duration"])
		if err != nil {
			return service.TaskErrorWrapperLocal(fmt.Errorf("duration must be an integer"), "invalid_duration", http.StatusBadRequest)
		}
		seconds, hasSeconds, err = parseOptionalInt(requestMap["seconds"])
		if err != nil {
			return service.TaskErrorWrapperLocal(fmt.Errorf("seconds must be an integer"), "invalid_seconds", http.StatusBadRequest)
		}

		if hasDuration {
			if err := validateDuration(action, "duration", duration); err != nil {
				return service.TaskErrorWrapperLocal(err, "invalid_duration", http.StatusBadRequest)
			}
		}
		if hasSeconds {
			if err := validateDuration(action, "seconds", seconds); err != nil {
				return service.TaskErrorWrapperLocal(err, "invalid_seconds", http.StatusBadRequest)
			}
		}
	}

	req := relaycommon.TaskSubmitReq{
		Prompt:      prompt,
		Model:       modelName,
		Mode:        stringField(requestMap, "mode"),
		Image:       imageReferenceField(requestMap, "image"),
		Images:      stringSliceField(requestMap, "images"),
		Size:        stringField(requestMap, "size"),
		Resolution:  stringField(requestMap, "resolution"),
		AspectRatio: stringField(requestMap, "aspect_ratio"),
		Metadata:    mapField(requestMap, "metadata"),
	}
	if hasDuration {
		req.Duration = duration
	} else if hasSeconds {
		req.Duration = seconds
	} else if action == TaskActionVideoExtend {
		req.Duration = DefaultVideoExtensionSeconds
	}
	if hasSeconds {
		req.Seconds = strconv.Itoa(seconds)
	}
	if req.Image != "" && len(req.Images) == 0 {
		req.Images = []string{req.Image}
	}
	info.Action = action
	c.Set("task_request", req)
	return nil
}

func (a *TaskAdaptor) EstimateBilling(c *gin.Context, info *relaycommon.RelayInfo) map[string]float64 {
	req, err := relaycommon.GetTaskRequest(c)
	if err != nil {
		return nil
	}

	if info.Action == TaskActionVideoEdit {
		return nil
	}

	seconds := req.Duration
	if seconds <= 0 && req.Seconds != "" {
		seconds, _ = strconv.Atoi(req.Seconds)
	}
	if seconds <= 0 {
		if info.Action == TaskActionVideoExtend {
			seconds = DefaultVideoExtensionSeconds
		} else {
			return nil
		}
	}
	if info.Action == TaskActionVideoExtend && seconds > MaxVideoExtensionDurationSeconds {
		seconds = MaxVideoExtensionDurationSeconds
	} else if seconds > MaxVideoDurationSeconds {
		seconds = MaxVideoDurationSeconds
	}
	return map[string]float64{"seconds": float64(seconds)}
}

func (a *TaskAdaptor) BuildRequestURL(info *relaycommon.RelayInfo) (string, error) {
	baseURL := strings.TrimRight(a.baseURL, "/")
	switch info.Action {
	case TaskActionVideoEdit:
		return baseURL + VideoEditsEndpoint, nil
	case TaskActionVideoExtend:
		return baseURL + VideoExtensionsEndpoint, nil
	default:
		return baseURL + VideoGenerationsEndpoint, nil
	}
}

func (a *TaskAdaptor) BuildRequestHeader(c *gin.Context, req *http.Request, info *relaycommon.RelayInfo) error {
	req.Header.Set("Authorization", "Bearer "+a.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	return nil
}

func (a *TaskAdaptor) BuildRequestBody(c *gin.Context, info *relaycommon.RelayInfo) (io.Reader, error) {
	storage, err := common.GetBodyStorage(c)
	if err != nil {
		return nil, errors.Wrap(err, "get_request_body_failed")
	}
	cachedBody, err := storage.Bytes()
	if err != nil {
		return nil, errors.Wrap(err, "read_body_bytes_failed")
	}

	var requestMap map[string]any
	if err := common.Unmarshal(cachedBody, &requestMap); err != nil {
		return nil, err
	}
	requestMap["model"] = info.UpstreamModelName
	action := ""
	if info != nil && info.TaskRelayInfo != nil {
		action = info.Action
	}
	if action == TaskActionVideoEdit {
		delete(requestMap, "duration")
		delete(requestMap, "seconds")
		delete(requestMap, "aspect_ratio")
		delete(requestMap, "resolution")
	} else {
		if _, hasDuration := requestMap["duration"]; !hasDuration {
			if seconds, hasSeconds, err := parseOptionalInt(requestMap["seconds"]); err != nil {
				return nil, fmt.Errorf("seconds must be an integer")
			} else if hasSeconds {
				requestMap["duration"] = seconds
			}
		}
		delete(requestMap, "seconds")
	}

	newBody, err := common.Marshal(requestMap)
	if err != nil {
		return nil, err
	}
	return bytes.NewReader(newBody), nil
}

func (a *TaskAdaptor) DoRequest(c *gin.Context, info *relaycommon.RelayInfo, requestBody io.Reader) (*http.Response, error) {
	return channel.DoTaskApiRequest(a, c, info, requestBody)
}

func (a *TaskAdaptor) DoResponse(c *gin.Context, resp *http.Response, info *relaycommon.RelayInfo) (taskID string, taskData []byte, taskErr *dto.TaskError) {
	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		taskErr = service.TaskErrorWrapper(err, "read_response_body_failed", http.StatusInternalServerError)
		return
	}
	_ = resp.Body.Close()

	var xaiResp submitResponse
	if err := common.Unmarshal(responseBody, &xaiResp); err != nil {
		taskErr = service.TaskErrorWrapper(errors.Wrapf(err, "body: %s", responseBody), "unmarshal_response_body_failed", http.StatusInternalServerError)
		return
	}
	if strings.TrimSpace(xaiResp.RequestID) == "" {
		taskErr = service.TaskErrorWrapper(fmt.Errorf("request_id is empty"), "invalid_response", http.StatusInternalServerError)
		return
	}

	openAIVideo := dto.NewOpenAIVideo()
	openAIVideo.ID = info.PublicTaskID
	openAIVideo.TaskID = info.PublicTaskID
	openAIVideo.Model = info.OriginModelName
	openAIVideo.CreatedAt = time.Now().Unix()
	c.JSON(http.StatusOK, openAIVideo)

	return xaiResp.RequestID, responseBody, nil
}

func (a *TaskAdaptor) FetchTask(baseUrl, key string, body map[string]any, proxy string) (*http.Response, error) {
	taskID, ok := body["task_id"].(string)
	if !ok || strings.TrimSpace(taskID) == "" {
		return nil, fmt.Errorf("invalid task_id")
	}

	uri := fmt.Sprintf("%s/v1/videos/%s", strings.TrimRight(baseUrl, "/"), taskID)
	req, err := http.NewRequest(http.MethodGet, uri, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Accept", "application/json")

	client, err := service.GetHttpClientWithProxy(proxy)
	if err != nil {
		return nil, fmt.Errorf("new proxy http client failed: %w", err)
	}
	return client.Do(req)
}

func (a *TaskAdaptor) ParseTaskResult(respBody []byte) (*relaycommon.TaskInfo, error) {
	var xaiResp videoResultResponse
	if err := common.Unmarshal(respBody, &xaiResp); err != nil {
		return nil, errors.Wrap(err, "unmarshal task result failed")
	}

	taskResult := &relaycommon.TaskInfo{Code: 0}
	if xaiResp.Progress > 0 {
		taskResult.Progress = fmt.Sprintf("%d%%", xaiResp.Progress)
	}

	switch xaiResp.Status {
	case StatusDone:
		taskResult.Status = model.TaskStatusSuccess
		taskResult.Url = xaiResp.Video.URL
		if taskResult.Progress == "" {
			taskResult.Progress = taskcommon.ProgressComplete
		}
	case StatusExpired:
		taskResult.Status = model.TaskStatusFailure
		taskResult.Reason = "task expired"
		if taskResult.Progress == "" {
			taskResult.Progress = taskcommon.ProgressComplete
		}
	case StatusFailed:
		taskResult.Status = model.TaskStatusFailure
		if xaiResp.Error != nil && xaiResp.Error.Message != "" {
			taskResult.Reason = xaiResp.Error.Message
		} else {
			taskResult.Reason = "task failed"
		}
		if taskResult.Progress == "" {
			taskResult.Progress = taskcommon.ProgressComplete
		}
	case StatusPending, "queued", "processing", "in_progress", "generating", "":
		taskResult.Status = model.TaskStatusInProgress
		if taskResult.Progress == "" {
			taskResult.Progress = taskcommon.ProgressInProgress
		}
	default:
		taskResult.Status = model.TaskStatusInProgress
		if taskResult.Progress == "" {
			taskResult.Progress = taskcommon.ProgressInProgress
		}
	}

	return taskResult, nil
}

func (a *TaskAdaptor) GetModelList() []string {
	return ModelList
}

func (a *TaskAdaptor) GetChannelName() string {
	return ChannelName
}

func (a *TaskAdaptor) ConvertToOpenAIVideo(task *model.Task) ([]byte, error) {
	openAIVideo := task.ToOpenAIVideo()

	var xaiResp videoResultResponse
	if err := common.Unmarshal(task.Data, &xaiResp); err == nil {
		openAIVideo.Status = convertStatus(xaiResp.Status)
		if xaiResp.Model != "" {
			openAIVideo.Model = xaiResp.Model
		}
		if xaiResp.Progress > 0 {
			openAIVideo.Progress = xaiResp.Progress
		}
		if xaiResp.Video.URL != "" {
			openAIVideo.SetMetadata("url", xaiResp.Video.URL)
		}
		if xaiResp.Video.Duration > 0 {
			openAIVideo.SetMetadata("duration", xaiResp.Video.Duration)
		}
		if xaiResp.Usage.CostInUSDTicks > 0 {
			openAIVideo.SetMetadata("cost_in_usd_ticks", xaiResp.Usage.CostInUSDTicks)
		}
		if xaiResp.Error != nil {
			openAIVideo.Error = &dto.OpenAIVideoError{
				Message: xaiResp.Error.Message,
				Code:    xaiResp.Error.Code,
			}
		}
	}

	data, err := common.Marshal(openAIVideo)
	if err != nil {
		return nil, errors.Wrap(err, "marshal openai video failed")
	}
	return data, nil
}

func parseOptionalInt(value any) (int, bool, error) {
	if value == nil {
		return 0, false, nil
	}
	switch v := value.(type) {
	case float64:
		maxInt := int(^uint(0) >> 1)
		minInt := -maxInt - 1
		if v < float64(minInt) || v > float64(maxInt) {
			return 0, true, fmt.Errorf("out of range")
		}
		parsed := int(v)
		if v != float64(parsed) {
			return 0, true, fmt.Errorf("not integer")
		}
		return parsed, true, nil
	case string:
		if strings.TrimSpace(v) == "" {
			return 0, false, nil
		}
		parsed, err := strconv.Atoi(v)
		return parsed, true, err
	case int:
		return v, true, nil
	default:
		return 0, true, fmt.Errorf("not integer")
	}
}

func validateDuration(action string, field string, duration int) error {
	minDuration := MinVideoDurationSeconds
	maxDuration := MaxVideoDurationSeconds
	if action == TaskActionVideoExtend {
		minDuration = MinVideoExtensionDurationSeconds
		maxDuration = MaxVideoExtensionDurationSeconds
	}
	if duration < minDuration || duration > maxDuration {
		return fmt.Errorf("%s must be between %d and %d", field, minDuration, maxDuration)
	}
	if duration > relaycommon.MaxTaskDurationSeconds {
		return fmt.Errorf("%s must be between 1 and %d", field, relaycommon.MaxTaskDurationSeconds)
	}
	return nil
}

func stringField(requestMap map[string]any, key string) string {
	value, _ := requestMap[key].(string)
	return value
}

func imageReferenceField(requestMap map[string]any, key string) string {
	switch value := requestMap[key].(type) {
	case string:
		return strings.TrimSpace(value)
	case map[string]any:
		if url, ok := value["url"].(string); ok {
			return strings.TrimSpace(url)
		}
	}
	return ""
}

func stringSliceField(requestMap map[string]any, key string) []string {
	values, ok := requestMap[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if s, ok := value.(string); ok && strings.TrimSpace(s) != "" {
			out = append(out, s)
		}
	}
	return out
}

func mapField(requestMap map[string]any, key string) map[string]interface{} {
	value, ok := requestMap[key].(map[string]any)
	if !ok {
		return nil
	}
	return value
}

func convertStatus(status string) string {
	switch status {
	case StatusDone:
		return dto.VideoStatusCompleted
	case StatusFailed, StatusExpired:
		return dto.VideoStatusFailed
	case StatusPending, "queued", "processing", "in_progress", "generating", "":
		return dto.VideoStatusInProgress
	default:
		return dto.VideoStatusInProgress
	}
}
