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
import { memo, useCallback } from 'react'
import { HelpCircle, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DERIVE_OPTIONS,
  FORBIDDEN_OUT_KEYS,
  KIND_OPTIONS,
  newEnumRow,
  newTierRow,
  SOURCE_SUGGESTIONS,
  suggestOutKey,
  type EnumRow,
  type RuleRow,
  type SkuKind,
  type TierRow,
} from './sku-rule-types'

// ---------------------------------------------------------------------------
// SkuRuleEditor — visual editor for a single SKU rule. No raw JSON: tiers and
// enum are edited as rows, source/kind/derive as dropdowns, out_key with a
// one-click suggestion. Every field carries an inline tooltip.
//
// Reused by the global settings page and the per-model drawer.
// ---------------------------------------------------------------------------

/** Label with an info tooltip explaining the field. */
function FieldLabel({ label, hint }: { label: string; hint: string }) {
  return (
    <div className='flex items-center gap-1'>
      <Label className='text-xs'>{label}</Label>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            type='button'
            className='text-muted-foreground hover:text-foreground'
            aria-label={label}
          >
            <HelpCircle className='h-3.5 w-3.5' />
          </TooltipTrigger>
          <TooltipContent side='top' className='max-w-xs'>
            {hint}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}

type SkuRuleEditorProps = {
  row: RuleRow
  /** Hide the model-patterns field (per-model drawer anchors the model itself). */
  hideModels?: boolean
  onChange: (patch: Partial<RuleRow>) => void
  onRemove: () => void
}

export const SkuRuleEditor = memo(function SkuRuleEditor({
  row,
  hideModels,
  onChange,
  onRemove,
}: SkuRuleEditorProps) {
  const { t } = useTranslation()

  const addTier = useCallback(() => {
    onChange({ tierRows: [...row.tierRows, newTierRow({ up_to: 0, ratio: 1 })] })
  }, [onChange, row.tierRows])

  const updateTier = useCallback(
    (index: number, patch: Partial<TierRow>) => {
      const next = [...row.tierRows]
      next[index] = { ...next[index], ...patch }
      onChange({ tierRows: next })
    },
    [onChange, row.tierRows]
  )

  const removeTier = useCallback(
    (index: number) => {
      onChange({ tierRows: row.tierRows.filter((_, i) => i !== index) })
    },
    [onChange, row.tierRows]
  )

  const addEnumRow = useCallback(() => {
    onChange({ enumRows: [...row.enumRows, newEnumRow()] })
  }, [onChange, row.enumRows])

  const updateEnumRow = useCallback(
    (index: number, patch: Partial<EnumRow>) => {
      const next = [...row.enumRows]
      next[index] = { ...next[index], ...patch }
      onChange({ enumRows: next })
    },
    [onChange, row.enumRows]
  )

  const removeEnumRow = useCallback(
    (index: number) => {
      onChange({ enumRows: row.enumRows.filter((_, i) => i !== index) })
    },
    [onChange, row.enumRows]
  )

  const outKeyForbidden = FORBIDDEN_OUT_KEYS.has(
    row.out_key.trim().toLowerCase()
  )

  return (
    <div className='space-y-3 rounded-lg border p-3'>
      <div className='flex items-center justify-between gap-2'>
        <div className='flex items-center gap-2'>
          <Switch
            checked={row.enabled}
            onCheckedChange={(v) => onChange({ enabled: v })}
          />
          <span className='text-muted-foreground text-xs'>{t('Enabled')}</span>
        </div>
        <Button
          variant='ghost'
          size='icon'
          onClick={onRemove}
          aria-label={t('Delete')}
        >
          <Trash2 className='text-destructive h-4 w-4' />
        </Button>
      </div>

      <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
        {!hideModels && (
          <div className='space-y-1'>
            <FieldLabel
              label={t('Model patterns (comma-separated)')}
              hint={t(
                'Which models this rule applies to. Exact names or wildcards, e.g. gpt-image-1, sora*, veo*.'
              )}
            />
            <Input
              value={row.models.join(', ')}
              placeholder='gpt-image-1, sora*, veo*'
              onChange={(e) =>
                onChange({
                  models: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </div>
        )}
        <div className='space-y-1'>
          <FieldLabel
            label={t('Source parameter key')}
            hint={t(
              'The request field to read. Image: size / quality / background. Video: size / duration / mode / input_reference, or metadata.* for custom fields.'
            )}
          />
          <Input
            list='sku-source-suggestions'
            value={row.source}
            placeholder='size / quality / mode / metadata.fps'
            onChange={(e) => {
              const source = e.target.value
              const patch: Partial<RuleRow> = { source }
              // Auto-fill out_key once, when it is still empty.
              if (!row.out_key.trim()) patch.out_key = suggestOutKey(source)
              onChange(patch)
            }}
          />
        </div>
        <div className='space-y-1'>
          <FieldLabel
            label={t('Kind')}
            hint={t(
              'How the value becomes a multiplier. Tier: numeric brackets (size/duration). Enum: discrete mapping (quality/mode). Exists: surcharge when the field is present.'
            )}
          />
          <NativeSelect
            className='w-full'
            value={row.kind}
            onChange={(e) => onChange({ kind: e.target.value as SkuKind })}
          >
            {KIND_OPTIONS.map((k) => (
              <NativeSelectOption key={k} value={k}>
                {t(`sku_kind_${k}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className='space-y-1'>
          <FieldLabel
            label={t('Out key')}
            hint={t(
              'Name shown on the bill and used to stack multipliers. Use a sku_ prefix. Cannot be n / seconds / duration.'
            )}
          />
          <Input
            value={row.out_key}
            placeholder='sku_size / sku_quality / sku_duration'
            aria-invalid={outKeyForbidden}
            onChange={(e) => onChange({ out_key: e.target.value })}
          />
          {outKeyForbidden && (
            <p className='text-destructive text-xs'>
              {t(
                'out_key cannot be n / seconds / duration (these are quantity keys, not multipliers).'
              )}
            </p>
          )}
        </div>
        {row.kind === 'tier' && (
          <div className='space-y-1'>
            <FieldLabel
              label={t('Derive')}
              hint={t(
                'How to turn the value into a number. long_edge: longest side of size. megapixels: width*height. number/seconds: parse directly.'
              )}
            />
            <NativeSelect
              className='w-full'
              value={row.derive || 'long_edge'}
              onChange={(e) => onChange({ derive: e.target.value })}
            >
              {DERIVE_OPTIONS.map((d) => (
                <NativeSelectOption key={d} value={d}>
                  {d}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
      </div>

      {/* Kind-specific editor */}
      {row.kind === 'tier' && (
        <div className='space-y-2'>
          <FieldLabel
            label={t('Tiers')}
            hint={t(
              'Each bracket: the derived value <= up_to gets that multiplier. Set up_to = 0 for the no-upper-bound catch-all (put it last).'
            )}
          />
          <div className='space-y-2'>
            {row.tierRows.map((tier, index) => (
              <div key={tier.uid} className='flex items-center gap-2'>
                <div className='flex flex-1 items-center gap-1'>
                  <span className='text-muted-foreground w-12 text-xs'>
                    {t('up to')}
                  </span>
                  <Input
                    type='number'
                    value={tier.up_to}
                    placeholder='0 = ∞'
                    onChange={(e) =>
                      updateTier(index, { up_to: Number(e.target.value) || 0 })
                    }
                  />
                </div>
                <div className='flex flex-1 items-center gap-1'>
                  <span className='text-muted-foreground text-xs'>×</span>
                  <Input
                    type='number'
                    step={0.1}
                    value={tier.ratio}
                    onChange={(e) =>
                      updateTier(index, { ratio: Number(e.target.value) || 0 })
                    }
                  />
                </div>
                <Input
                  className='flex-1'
                  value={tier.label ?? ''}
                  placeholder={t('label (optional)')}
                  onChange={(e) => updateTier(index, { label: e.target.value })}
                />
                <Button
                  variant='ghost'
                  size='icon'
                  onClick={() => removeTier(index)}
                  aria-label={t('Delete')}
                >
                  <Trash2 className='text-destructive h-4 w-4' />
                </Button>
              </div>
            ))}
          </div>
          <Button variant='outline' size='sm' onClick={addTier}>
            <Plus className='mr-2 h-4 w-4' />
            {t('Add tier')}
          </Button>
        </div>
      )}

      {row.kind === 'enum' && (
        <div className='space-y-2'>
          <FieldLabel
            label={t('Enum mapping')}
            hint={t(
              'Map each parameter value to a multiplier, e.g. standard -> 1, hd -> 2. Values not listed are not surcharged (x1).'
            )}
          />
          <div className='space-y-2'>
            {row.enumRows.map((entry, index) => (
              <div key={entry.uid} className='flex items-center gap-2'>
                <Input
                  className='flex-1'
                  value={entry.key}
                  placeholder={t('value (e.g. hd)')}
                  onChange={(e) => updateEnumRow(index, { key: e.target.value })}
                />
                <span className='text-muted-foreground text-xs'>×</span>
                <Input
                  className='flex-1'
                  type='number'
                  step={0.1}
                  value={entry.ratio}
                  onChange={(e) =>
                    updateEnumRow(index, { ratio: Number(e.target.value) || 0 })
                  }
                />
                <Button
                  variant='ghost'
                  size='icon'
                  onClick={() => removeEnumRow(index)}
                  aria-label={t('Delete')}
                >
                  <Trash2 className='text-destructive h-4 w-4' />
                </Button>
              </div>
            ))}
          </div>
          <Button variant='outline' size='sm' onClick={addEnumRow}>
            <Plus className='mr-2 h-4 w-4' />
            {t('Add mapping')}
          </Button>
        </div>
      )}

      {row.kind === 'exists' && (
        <div className='space-y-1'>
          <FieldLabel
            label={t('Existence ratio')}
            hint={t(
              'Multiplier applied when the field is present / true (e.g. image-to-video, with-audio). Otherwise x1.'
            )}
          />
          <Input
            type='number'
            step={0.1}
            className='w-32'
            value={row.exists_ratio ?? 1.3}
            onChange={(e) =>
              onChange({ exists_ratio: Number(e.target.value) || 1 })
            }
          />
        </div>
      )}
    </div>
  )
})

/** Shared datalist of source suggestions. Render once per page. */
export function SkuSourceDatalist() {
  return (
    <datalist id='sku-source-suggestions'>
      {SOURCE_SUGGESTIONS.map((s) => (
        <option key={s} value={s} />
      ))}
    </datalist>
  )
}
