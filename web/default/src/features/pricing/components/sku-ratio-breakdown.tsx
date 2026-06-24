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
import { useTranslation } from 'react-i18next'
import { SlidersHorizontal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { SkuRule, SkuTier } from '../types'

type SkuRatioBreakdownProps = {
  /** Structured SKU rules carried by the backend pricing payload. */
  rules: SkuRule[] | null | undefined
}

const KIND_LABEL: Record<string, string> = {
  tier: 'By value tier',
  enum: 'By option',
  exists: 'When present',
}

/** Human-friendly label for the parameter source key. */
function sourceLabel(source: string): string {
  // metadata.fps -> fps; keep other keys as-is
  const idx = source.lastIndexOf('.')
  return idx >= 0 ? source.slice(idx + 1) : source
}

// Unit suffix for a tier bound, derived from the rule's numeric derivation.
const DERIVE_UNIT: Record<string, string> = {
  long_edge: 'px',
  megapixels: 'MP',
  seconds: 's',
  number: '',
}

/** Render a single tier bound as "≤2048px" / "≤2.1MP" / "≤8s" / "∞" (up_to=0 = no upper bound). */
function tierBound(tier: SkuTier, derive?: string): string {
  if (tier.up_to === 0) return '∞'
  if (tier.label?.trim()) return tier.label
  const unit = derive ? (DERIVE_UNIT[derive] ?? '') : ''
  // megapixels up_to is a float (e.g. 2.097152); round for readability.
  const bound = derive === 'megapixels' ? tier.up_to.toFixed(1) : tier.up_to
  return `≤${bound}${unit}`
}

/** Render the tier ladder as badges, e.g. "≤2048px ×2.0" / "∞ ×5.0". */
function TierBadges({ tiers, derive }: { tiers: SkuTier[]; derive?: string }) {
  return (
    <div className='flex flex-wrap gap-1.5'>
      {tiers.map((tier) => (
        <Badge
          key={`tier-${tier.up_to}-${tier.ratio}`}
          variant='secondary'
          className='shrink-0 bg-orange-100 font-mono text-orange-700 dark:bg-orange-500/20 dark:text-orange-300'
        >
          {tierBound(tier, derive)} ×{tier.ratio}
        </Badge>
      ))}
    </div>
  )
}

function EnumBadges({ map }: { map: Record<string, number> }) {
  return (
    <div className='flex flex-wrap gap-1.5'>
      {Object.entries(map).map(([key, ratio]) => (
        <Badge
          key={`enum-${key}`}
          variant='secondary'
          className='shrink-0 bg-orange-100 font-mono text-orange-700 dark:bg-orange-500/20 dark:text-orange-300'
        >
          {key} ×{ratio}
        </Badge>
      ))}
    </div>
  )
}

/**
 * Renders the parameter-based SKU ratio table for a model in the detail
 * drawer. Mirrors the visual language of the "Conditional multipliers"
 * block in dynamic-pricing-breakdown.tsx but consumes structured SkuRule
 * data straight from the backend (same source as actual billing), so the
 * displayed multipliers always match what gets charged.
 */
export function SkuRatioBreakdown({ rules }: SkuRatioBreakdownProps) {
  const { t } = useTranslation()
  const visible = (rules ?? []).filter((r) => r.enabled)
  if (visible.length === 0) {
    return null
  }

  return (
    <section className='space-y-3'>
      <div className='text-foreground flex items-center gap-1.5 text-sm font-semibold'>
        <SlidersHorizontal className='size-3.5' />
        {t('Parameter-based pricing')}
      </div>
      <ul className='space-y-2'>
        {visible.map((rule) => (
          <li
            key={`sku-${rule.out_key}-${rule.source}-${rule.kind}`}
            className='bg-muted/50 space-y-1.5 rounded-md px-3 py-2'
          >
            <div className='flex items-center gap-2 text-sm'>
              <span className='text-foreground font-medium'>
                {t(sourceLabel(rule.source))}
              </span>
              <span className='text-muted-foreground text-xs'>
                {t(KIND_LABEL[rule.kind] ?? rule.kind)}
              </span>
            </div>
            {rule.kind === 'tier' && rule.tiers && (
              <TierBadges tiers={rule.tiers} derive={rule.derive} />
            )}
            {rule.kind === 'enum' && rule.enum && (
              <EnumBadges map={rule.enum} />
            )}
            {rule.kind === 'exists' && (
              <Badge
                variant='secondary'
                className='shrink-0 bg-orange-100 font-mono text-orange-700 dark:bg-orange-500/20 dark:text-orange-300'
              >
                ×{rule.exists_ratio ?? 1}
              </Badge>
            )}
          </li>
        ))}
      </ul>
      <div className='text-muted-foreground text-xs'>
        {t(
          'Final price = base price × each matched multiplier (multiplied together).'
        )}
      </div>
    </section>
  )
}
