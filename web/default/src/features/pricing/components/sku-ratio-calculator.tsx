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
import { useEffect, useMemo, useState } from 'react'
import { Calculator } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatBillingCurrencyFromUSD } from '@/lib/currency'
import { cn } from '@/lib/utils'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { QUOTA_TYPE_VALUES, TOKEN_UNIT_DIVISORS } from '../constants'
import { getBaseUnitPriceUSD } from '../lib/price'
import { getAvailableGroups } from '../lib/model-helpers'
import {
  applySkuClamp,
  defaultSelection,
  resolveSelectedRatio,
  sourceLabel,
  tierBound,
} from '../lib/sku-format'
import type { PricingModel, SkuRule, TokenUnit } from '../types'

/**
 * Interactive estimator for parameter-based (SKU) pricing. Users pick each
 * parameter tier (size / quality / ...) and see the exact per-request charge
 * with the multiplier chain spelled out, so the abstract `×0.85` becomes a
 * concrete amount. Math is same-source with billing: base price comes from the
 * shared price helpers, the group ratio is applied as an explicit factor (just
 * like the bill), and the cross-dimension cap mirrors the backend clamp.
 */
type SkuRatioCalculatorProps = {
  model: PricingModel
  /** Per-group ratio map; the selected group's ratio multiplies the base, matching the bill. */
  groupRatio: Record<string, number>
  /** Usable groups (with desc/ratio) for resolving which groups this model is sold in. */
  usableGroup: Record<string, { desc: string; ratio: number }>
  priceRate: number
  usdExchangeRate: number
  tokenUnit: TokenUnit
  showRechargePrice: boolean
}

const PRICE_FMT = { digitsLarge: 4, digitsSmall: 6, abbreviate: false } as const

function buildDefaultSelection(rules: SkuRule[]): Record<string, string> {
  const sel: Record<string, string> = {}
  for (const rule of rules) sel[rule.out_key] = defaultSelection(rule)
  return sel
}

/**
 * Pick the default group for the estimate: the one with the smallest ratio
 * (cheapest), which matches the headline price shown on the model card. Returns
 * '' when the model has no usable groups (group factor then defaults to ×1).
 */
function pickDefaultGroup(
  groups: string[],
  groupRatio: Record<string, number>
): string {
  if (groups.length === 0) return ''
  return groups.reduce((best, g) =>
    (groupRatio[g] ?? 1) < (groupRatio[best] ?? 1) ? g : best
  )
}

/** Compact ratio for the formula: integers as-is, else up to 3 decimals trimmed. */
function formatRatio(ratio: number): string {
  return Number.isInteger(ratio)
    ? String(ratio)
    : String(Number(ratio.toFixed(3)))
}

function ratioColorClass(ratio: number): string {
  if (ratio < 1) return 'text-emerald-600 dark:text-emerald-400'
  if (ratio > 1) return 'text-orange-600 dark:text-orange-400'
  return 'text-muted-foreground'
}

export function SkuRatioCalculator(props: SkuRatioCalculatorProps) {
  const { t } = useTranslation()
  const {
    model,
    groupRatio,
    usableGroup,
    priceRate,
    usdExchangeRate,
    tokenUnit,
    showRechargePrice,
  } = props

  const visibleRules = useMemo(
    () => (model.sku_ratios ?? []).filter((rule) => rule.enabled),
    [model.sku_ratios]
  )

  // Groups this model is actually sold in. The estimate multiplies the selected
  // group's ratio onto the base, mirroring how the bill is computed.
  const availableGroups = useMemo(
    () => getAvailableGroups(model, usableGroup || {}),
    [model, usableGroup]
  )

  const [selection, setSelection] = useState<Record<string, string>>(() =>
    buildDefaultSelection(visibleRules)
  )
  // Default to the cheapest group (smallest ratio), matching the card's headline price.
  const [selectedGroup, setSelectedGroup] = useState<string>(() =>
    pickDefaultGroup(availableGroups, groupRatio)
  )

  // Reset selection when the model (and thus its rule set) changes.
  useEffect(() => {
    setSelection(buildDefaultSelection(visibleRules))
  }, [visibleRules])

  // Re-pick a valid default group when the model's group set changes.
  useEffect(() => {
    setSelectedGroup(pickDefaultGroup(availableGroups, groupRatio))
  }, [availableGroups, groupRatio])

  if (visibleRules.length === 0) return null

  const isRequest = model.quota_type === QUOTA_TYPE_VALUES.REQUEST
  const tokenUnitLabel = tokenUnit === 'K' ? '1K' : '1M'
  const unitSuffix = isRequest ? `/ ${t('request')}` : `/ ${tokenUnitLabel}`

  // Group ratio applied to this estimate (1 when the model has no usable groups).
  const activeGroupRatio = selectedGroup ? (groupRatio[selectedGroup] ?? 1) : 1

  // Base unit price (USD), same source as formatPrice / formatFixedPrice, with
  // the selected group's ratio applied so the estimate matches the actual bill.
  // For token models this is USD per 1M tokens; divide to the display unit. SKU
  // ratios are unit-independent multipliers, so order does not matter.
  const baseRawUSD = getBaseUnitPriceUSD(model, {
    type: 'input',
    groupRatio: activeGroupRatio,
    showWithRecharge: showRechargePrice,
    priceRate,
    usdExchangeRate,
  })
  const unitDivisor = isRequest ? 1 : TOKEN_UNIT_DIVISORS[tokenUnit]
  const baseUnitUSD = baseRawUSD / unitDivisor

  // The un-grouped base (groupRatio=1), shown in the header so users can see the
  // list price before the group multiplier is applied as an explicit factor.
  const listRawUSD = getBaseUnitPriceUSD(model, {
    type: 'input',
    groupRatio: 1,
    showWithRecharge: showRechargePrice,
    priceRate,
    usdExchangeRate,
  })
  const listUnitUSD = listRawUSD / unitDivisor

  // Selected factor per rule (incl. ×1 for display completeness).
  const rawFactors = visibleRules.map((rule) => ({
    rule,
    sel: selection[rule.out_key],
    ratio: resolveSelectedRatio(rule, selection[rule.out_key]),
  }))
  // Backend clamps only the non-unit dimensions (evalSkuHits drops ×1).
  const maxTotal = model.sku_max_total_ratio ?? 0
  const nonUnit = rawFactors.filter((f) => f.ratio > 0 && f.ratio !== 1)
  const rawProduct = nonUnit.reduce((acc, f) => acc * f.ratio, 1)
  const clampedNonUnit = applySkuClamp(
    nonUnit.map((f) => f.ratio),
    maxTotal
  )
  const clampByKey = new Map<string, number>()
  nonUnit.forEach((f, i) => clampByKey.set(f.rule.out_key, clampedNonUnit[i]))

  const factors = rawFactors.map((f) => ({
    rule: f.rule,
    sel: f.sel,
    ratio: clampByKey.get(f.rule.out_key) ?? f.ratio,
  }))
  const skuProduct = factors.reduce((acc, f) => acc * f.ratio, 1)
  const finalUSD = baseUnitUSD * skuProduct
  const isClamped = maxTotal > 0 && rawProduct > maxTotal

  const fmt = (usd: number) =>
    Number.isFinite(usd) ? formatBillingCurrencyFromUSD(usd, PRICE_FMT) : '—'

  const factorLabel = (rule: SkuRule, selKey: string | undefined): string => {
    if (rule.kind === 'tier') {
      const tier = rule.tiers?.[Number(selKey)]
      return tier ? tierBound(tier, rule.derive) : (selKey ?? '')
    }
    if (rule.kind === 'enum') return selKey ?? ''
    if (rule.kind === 'exists') return t(selKey === 'on' ? 'On' : 'Off')
    return selKey ?? ''
  }

  return (
    <section className='space-y-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='text-foreground flex items-center gap-1.5 text-sm font-semibold'>
          <Calculator className='size-3.5' />
          {t('Estimate this request')}
        </div>
        <div className='text-muted-foreground text-xs'>
          {t('Base Price')}{' '}
          <span className='text-foreground font-mono font-medium'>
            {fmt(listUnitUSD)}
          </span>
          <span className='text-muted-foreground/60'> {unitSuffix}</span>
        </div>
      </div>

      <div className='bg-muted/50 space-y-3 rounded-md px-3 py-2.5'>
        {/* Group picker — the selected group's ratio multiplies the base, matching the bill. */}
        {availableGroups.length > 0 && (
          <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
            <span className='text-foreground min-w-14 text-xs font-medium'>
              {t('Group')}
            </span>
            <ToggleGroup
              variant='outline'
              size='sm'
              spacing={1}
              value={[selectedGroup]}
              onValueChange={(value) => {
                const arr = value as string[]
                if (arr.length) setSelectedGroup(arr[arr.length - 1])
              }}
              className='max-w-full flex-wrap'
            >
              {availableGroups.map((g) => (
                <ToggleGroupItem
                  key={g}
                  value={g}
                  className='font-mono text-xs'
                >
                  {usableGroup[g]?.desc || g} ×{groupRatio[g] ?? 1}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        )}

        {/* Parameter pickers */}
        <div className='space-y-2'>
          {visibleRules.map((rule) => {
            const options =
              rule.kind === 'tier'
                ? (rule.tiers ?? []).map((tier, idx) => ({
                    key: String(idx),
                    label: `${tierBound(tier, rule.derive)} ×${tier.ratio}`,
                  }))
                : rule.kind === 'enum'
                  ? Object.entries(rule.enum ?? {}).map(([key, ratio]) => ({
                      key,
                      label: `${key} ×${ratio}`,
                    }))
                  : [
                      { key: 'off', label: `${t('Off')} ×1` },
                      {
                        key: 'on',
                        label: `${t('On')} ×${rule.exists_ratio ?? 1}`,
                      },
                    ]
            return (
              <div
                key={rule.out_key}
                className='flex flex-wrap items-center gap-x-2 gap-y-1'
              >
                <span className='text-foreground min-w-14 text-xs font-medium'>
                  {t(sourceLabel(rule.source))}
                </span>
                <ToggleGroup
                  variant='outline'
                  size='sm'
                  spacing={1}
                  value={[selection[rule.out_key] ?? '']}
                  onValueChange={(value) =>
                    setSelection((prev) => {
                      const arr = value as string[]
                      return {
                        ...prev,
                        [rule.out_key]: arr.length
                          ? arr[arr.length - 1]
                          : prev[rule.out_key],
                      }
                    })
                  }
                  className='max-w-full flex-wrap'
                >
                  {options.map((opt) => (
                    <ToggleGroupItem
                      key={opt.key}
                      value={opt.key}
                      className='font-mono text-xs'
                    >
                      {opt.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            )
          })}
        </div>

        {/* Formula: list price × group ratio × each selected SKU factor = final charge */}
        <div className='border-border/60 border-t pt-2.5'>
          <div className='flex flex-wrap items-baseline gap-x-1.5 gap-y-1 font-mono text-sm'>
            <span className='text-foreground'>{fmt(listUnitUSD)}</span>
            {activeGroupRatio !== 1 && (
              <span className='inline-flex items-baseline gap-1'>
                <span className='text-muted-foreground'>×</span>
                <span className={ratioColorClass(activeGroupRatio)}>
                  {formatRatio(activeGroupRatio)}
                </span>
                <span className='text-muted-foreground/70 text-xs'>
                  ({t('Group')}
                  {selectedGroup
                    ? `: ${usableGroup[selectedGroup]?.desc || selectedGroup}`
                    : ''}
                  )
                </span>
              </span>
            )}
            {factors.map((f) => (
              <span
                key={f.rule.out_key}
                className='inline-flex items-baseline gap-1'
              >
                <span className='text-muted-foreground'>×</span>
                <span className={ratioColorClass(f.ratio)}>
                  {formatRatio(f.ratio)}
                </span>
                <span className='text-muted-foreground/70 text-xs'>
                  ({factorLabel(f.rule, f.sel)})
                </span>
              </span>
            ))}
            <span className='text-muted-foreground'>=</span>
            <span className='text-foreground font-semibold'>
              {fmt(finalUSD)}
              <span className='text-muted-foreground/60 font-normal'>
                {' '}
                {unitSuffix}
              </span>
            </span>
            {skuProduct !== 1 && (
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-xs font-medium',
                  skuProduct < 1
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
                    : 'bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300'
                )}
              >
                {skuProduct < 1
                  ? t('Save {{pct}}%', {
                      pct: Math.round((1 - skuProduct) * 100),
                    })
                  : `+${Math.round((skuProduct - 1) * 100)}%`}
              </span>
            )}
          </div>
          {isClamped && (
            <p className='mt-1.5 text-xs text-amber-600 dark:text-amber-400'>
              {t('Capped at {{cap}}× total', { cap: maxTotal })}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
