package service

// collectBillingRatios 复制并过滤生效倍率，用于消费收据透明化。
//
// 计费管线把所有生效倍率（SKU 参数倍率 + 适配器返回倍率，如视频分辨率/时长）
// 收进 info.PriceData.OtherRatios 并连乘进 quota。本函数把这份倍率快照拷出一份
// 供消费日志 other["other_ratios"] 落库，让用户账单能逐项解释"为什么被乘了 N 倍"。
//
// 过滤规则：丢弃 v<=0（非法）与 v==1.0（no-op 噪音，与 task 重算
// task_billing.go:290 的 r!=1.0&&r>0 口径一致），避免污染收据。
//
// 返回新 map（copy-on-write）：controller/relay.go 把 PriceData.OtherRatios 浅拷贝进
// TaskBillingContext 快照、与原 map 共享底层，直接塞进 other 再异步序列化会有别名/竞态风险。
// 空结果返回 nil（而非空 map），让调用方 len()>0 判断干净，避免 other["other_ratios"]={} 落库。
func collectBillingRatios(ratios map[string]float64) map[string]float64 {
	if len(ratios) == 0 {
		return nil
	}
	out := make(map[string]float64, len(ratios))
	for k, v := range ratios {
		if v > 0 && v != 1.0 {
			out[k] = v
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
