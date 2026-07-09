package xai

const ChannelName = "xai"

const (
	StatusPending = "pending"
	StatusDone    = "done"
	StatusExpired = "expired"
	StatusFailed  = "failed"
)

const (
	VideoGenerationsEndpoint = "/v1/videos/generations"
	VideoEditsEndpoint       = "/v1/videos/edits"
	VideoExtensionsEndpoint  = "/v1/videos/extensions"
)

const (
	TaskActionVideoEdit   = "edit"
	TaskActionVideoExtend = "extend"
)

const (
	// xAI documents generation duration as 1–15 seconds and extension duration as 2–10 seconds.
	// Duration is also a billing multiplier.
	MinVideoDurationSeconds          = 1
	MaxVideoDurationSeconds          = 15
	MinVideoExtensionDurationSeconds = 2
	MaxVideoExtensionDurationSeconds = 10
	DefaultVideoExtensionSeconds     = 6
)

var ModelList = []string{
	"grok-imagine-video",
	"grok-imagine-video-1.5",
}
