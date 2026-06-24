package service

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestCollectBillingRatios(t *testing.T) {
	cases := []struct {
		name string
		in   map[string]float64
		want map[string]float64
	}{
		{"nil 入参", nil, nil},
		{"空 map", map[string]float64{}, nil},
		{"全 1.0 过滤光", map[string]float64{"sku_size": 1.0, "sku_mode": 1.0}, nil},
		{"过滤 1.0 保留其余", map[string]float64{"sku_size": 2.0, "sku_mode": 1.0}, map[string]float64{"sku_size": 2.0}},
		{"过滤 0 和负值", map[string]float64{"a": 0, "b": -1, "c": 3.0}, map[string]float64{"c": 3.0}},
		{"量值键照实保留", map[string]float64{"n": 4.0, "seconds": 8.0}, map[string]float64{"n": 4.0, "seconds": 8.0}},
		{"适配器键保留", map[string]float64{"resolution-1080p": 1.5}, map[string]float64{"resolution-1080p": 1.5}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			assert.Equal(t, c.want, collectBillingRatios(c.in))
		})
	}
}

// TestCollectBillingRatiosCopies 验证 copy-on-write:改返回值不得污染源 map。
// 源 map 与 TaskBillingContext 快照共享底层(controller/relay.go),别名污染会破坏后续计费阶段。
func TestCollectBillingRatiosCopies(t *testing.T) {
	src := map[string]float64{"sku_size": 2.0}
	out := collectBillingRatios(src)
	out["sku_size"] = 999
	assert.Equal(t, 2.0, src["sku_size"], "不得污染源 map")
}
