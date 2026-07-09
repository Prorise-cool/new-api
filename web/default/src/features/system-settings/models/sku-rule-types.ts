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

// ---------------------------------------------------------------------------
// Shared SKU rule types + pure helpers (no React).
//
// A "rule" maps one request parameter to a billing multiplier through one of
// three interpreters (tier / enum / exists). Used by the global settings page,
// the per-model drawer, and the visual rule editor.
// ---------------------------------------------------------------------------

export type SkuKind = 'tier' | 'enum' | 'exists'

export type SkuTier = {
  up_to: number
  ratio: number
  label?: string
}

export type SkuRule = {
  models: string[]
  source: string
  kind: SkuKind
  out_key: string
  enabled: boolean
  derive?: string
  tiers?: SkuTier[]
  enum?: Record<string, number>
  exists_ratio?: number
}

/** Quantity keys that must never be used as out_key (would collapse billing). */
export const FORBIDDEN_OUT_KEYS = new Set(['n', 'seconds', 'duration'])

export const KIND_OPTIONS: SkuKind[] = ['tier', 'enum', 'exists']
export const DERIVE_OPTIONS = ['long_edge', 'megapixels', 'number', 'seconds']

/** Common source parameter keys, offered as datalist suggestions. */
export const SOURCE_SUGGESTIONS = [
  'size',
  'resolution',
  'quality',
  'mode',
  'aspect_ratio',
  'duration',
  'background',
  'image',
  'input_reference',
  'metadata.fps',
  'metadata.audio',
]

/** A single enum entry as an editable row (object form is not order-stable). */
export type EnumRow = { uid: number; key: string; ratio: number }

/** A tier as an editable row, carrying a stable uid for React keys. */
export type TierRow = SkuTier & { uid: number }

/** Editable row model: a rule plus UI-only fields. */
export type RuleRow = Omit<SkuRule, 'tiers'> & {
  id: number
  tierRows: TierRow[]
  enumRows: EnumRow[]
}

// Monotonic uid source for editable sub-rows (tiers/enum). UI-only.
let uidSeq = 1
function nextUid(): number {
  uidSeq += 1
  return uidSeq
}

export function enumToRows(e?: Record<string, number>): EnumRow[] {
  if (!e) return []
  return Object.entries(e).map(([key, ratio]) => ({
    uid: nextUid(),
    key,
    ratio,
  }))
}

export function rowsToEnum(rows: EnumRow[]): Record<string, number> {
  const result: Record<string, number> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key) result[key] = Number(row.ratio) || 0
  }
  return result
}

export function tiersToRows(tiers?: SkuTier[]): TierRow[] {
  if (!tiers) return []
  return tiers.map((tier) => ({ ...tier, uid: nextUid() }))
}

export function newTierRow(tier: SkuTier): TierRow {
  return { ...tier, uid: nextUid() }
}

export function newEnumRow(key = '', ratio = 1): EnumRow {
  return { uid: nextUid(), key, ratio }
}

export function emptyRule(id: number): RuleRow {
  return {
    id,
    models: [],
    source: '',
    kind: 'tier',
    out_key: '',
    enabled: true,
    derive: 'long_edge',
    tierRows: [newTierRow({ up_to: 1024, ratio: 1, label: '1K' })],
    enumRows: [],
  }
}

/** Convert a stored SkuRule into an editable RuleRow. */
export function ruleToRow(rule: SkuRule, id: number): RuleRow {
  return {
    ...rule,
    id,
    derive: rule.derive ?? 'long_edge',
    tierRows: tiersToRows(rule.tiers),
    enumRows: enumToRows(rule.enum),
  }
}

/** Convert an editable RuleRow back into a storable SkuRule. */
export function rowToRule(row: RuleRow): SkuRule {
  const rule: SkuRule = {
    models: row.models,
    source: row.source.trim(),
    kind: row.kind,
    out_key: row.out_key.trim(),
    enabled: row.enabled,
  }
  if (row.kind === 'tier') {
    rule.derive = row.derive || 'long_edge'
    rule.tiers = row.tierRows.map((tier) => ({
      up_to: Number(tier.up_to) || 0,
      ratio: Number(tier.ratio) || 0,
      ...(tier.label ? { label: tier.label } : {}),
    }))
  } else if (row.kind === 'enum') {
    rule.enum = rowsToEnum(row.enumRows)
  } else {
    rule.exists_ratio = Number(row.exists_ratio) || 1
  }
  return rule
}

/** Suggest an out_key from a source parameter (e.g. size -> sku_size). */
export function suggestOutKey(source: string): string {
  const base = source.trim().split('.').pop() ?? ''
  if (!base) return ''
  return `sku_${base}`
}

/** Validate rows, return first error message (empty = all valid). */
export function validateRuleRows(
  rows: RuleRow[],
  t: (s: string) => string,
  opts?: { requireModels?: boolean }
): string {
  const requireModels = opts?.requireModels ?? true
  for (const row of rows) {
    if (!row.source.trim() || !row.out_key.trim()) {
      return t('Each rule needs a source and an out_key.')
    }
    if (FORBIDDEN_OUT_KEYS.has(row.out_key.trim().toLowerCase())) {
      return t(
        'out_key cannot be n / seconds / duration (these are quantity keys, not multipliers).'
      )
    }
    if (requireModels && row.models.length === 0) {
      return t('Each rule must target at least one model pattern.')
    }
    if (row.kind === 'tier' && row.tierRows.length === 0) {
      return t('A tier rule needs at least one tier.')
    }
    if (row.kind === 'enum' && row.enumRows.length === 0) {
      return t('An enum rule needs at least one mapping.')
    }
  }
  return ''
}
