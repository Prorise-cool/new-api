/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
// ----------------------------------------------------------------------------
// Shared SKU rule formatting + calculation helpers.
//
// Used by both the read-only breakdown table (sku-ratio-breakdown.tsx) and the
// interactive calculator (sku-ratio-calculator.tsx) so labels and math stay in
// one place and the calculator's numbers match what actually gets billed.
// ----------------------------------------------------------------------------
import type { SkuRule, SkuTier } from '../types'

/** Human-friendly label for the SKU interpreter kind. */
export const KIND_LABEL: Record<string, string> = {
  tier: 'By value tier',
  enum: 'By option',
  exists: 'When present',
}

/** Unit suffix for a tier bound, derived from the rule's numeric derivation. */
export const DERIVE_UNIT: Record<string, string> = {
  long_edge: 'px',
  megapixels: 'MP',
  seconds: 's',
  number: '',
}

/** Human-friendly label for the parameter source key (metadata.fps -> fps). */
export function sourceLabel(source: string): string {
  const idx = source.lastIndexOf('.')
  return idx >= 0 ? source.slice(idx + 1) : source
}

/** Render a single tier bound as "≤2048px" / "≤2.1MP" / "≤8s" / "∞" (up_to=0 = no upper bound). */
export function tierBound(tier: SkuTier, derive?: string): string {
  if (tier.up_to === 0) return '∞'
  if (tier.label?.trim()) return tier.label
  const unit = derive ? (DERIVE_UNIT[derive] ?? '') : ''
  // megapixels up_to is a float (e.g. 2.097152); round for readability.
  const bound = derive === 'megapixels' ? tier.up_to.toFixed(1) : tier.up_to
  return `≤${bound}${unit}`
}

// ----------------------------------------------------------------------------
// Calculator helpers
// ----------------------------------------------------------------------------

/**
 * Replicate the backend clampToMaxTotal (setting/ratio_setting/sku_ratio.go):
 * when the SKU ratios multiply beyond maxTotal, scale every ratio by
 * (maxTotal/product)^(1/n) so the product lands exactly on maxTotal. Order and
 * length are preserved so the formula can show each factor post-clamp.
 * maxTotal <= 0 means unlimited; ratios are returned unchanged.
 */
export function applySkuClamp(ratios: number[], maxTotal: number): number[] {
  if (maxTotal <= 0 || ratios.length === 0) return ratios
  const product = ratios.reduce((acc, r) => acc * r, 1)
  if (product <= maxTotal) return ratios
  const factor = Math.pow(maxTotal / product, 1 / ratios.length)
  return ratios.map((r) => r * factor)
}

/**
 * Default selection key for a rule: the ×1 (no-surcharge) option when one
 * exists, otherwise the cheapest option. Keeps the calculator's initial
 * estimate equal to the pure base price (matching the "Base Price" section).
 *   tier   -> tier index (as string)
 *   enum   -> enum key
 *   exists -> 'off'
 */
export function defaultSelection(rule: SkuRule): string {
  if (rule.kind === 'tier' && rule.tiers && rule.tiers.length > 0) {
    const unitIdx = rule.tiers.findIndex((tier) => tier.ratio === 1)
    if (unitIdx >= 0) return String(unitIdx)
    let minIdx = 0
    for (let i = 1; i < rule.tiers.length; i++) {
      if (rule.tiers[i].ratio < rule.tiers[minIdx].ratio) minIdx = i
    }
    return String(minIdx)
  }
  if (rule.kind === 'enum' && rule.enum) {
    const entries = Object.entries(rule.enum)
    if (entries.length === 0) return ''
    const unit = entries.find(([, ratio]) => ratio === 1)
    if (unit) return unit[0]
    let min = entries[0]
    for (const entry of entries) {
      if (entry[1] < min[1]) min = entry
    }
    return min[0]
  }
  // exists (and any unknown kind): default to no surcharge
  return 'off'
}

/** Resolve the multiplier for the currently selected option of a rule. */
export function resolveSelectedRatio(
  rule: SkuRule,
  selKey: string | undefined
): number {
  if (selKey == null) return 1
  if (rule.kind === 'tier') {
    return rule.tiers?.[Number(selKey)]?.ratio ?? 1
  }
  if (rule.kind === 'enum') {
    return rule.enum?.[selKey] ?? 1
  }
  if (rule.kind === 'exists') {
    return selKey === 'on' ? (rule.exists_ratio ?? 1) : 1
  }
  return 1
}
