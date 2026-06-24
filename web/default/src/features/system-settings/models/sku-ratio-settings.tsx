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
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Code2, Copy, Eye, Plus, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useUpdateOption } from '../hooks/use-update-option'
import { SkuRuleEditor, SkuSourceDatalist } from './sku-rule-editor'
import {
  emptyRule,
  ruleToRow,
  rowToRule,
  validateRuleRows,
  type RuleRow,
  type SkuRule,
} from './sku-rule-types'

const ENABLED_KEY = 'sku_ratio_setting.enabled'
const RULES_KEY = 'sku_ratio_setting.rules'
const MAX_TOTAL_KEY = 'sku_ratio_setting.max_total_ratio'

/** One-click presets: the common shapes admins want, pre-filled. */
type Preset = { titleKey: string; rule: SkuRule }

const PRESETS: Preset[] = [
  {
    titleKey: 'Image size tiers (1K/2K/4K)',
    rule: {
      models: [],
      source: 'size',
      kind: 'tier',
      out_key: 'sku_size',
      enabled: true,
      derive: 'long_edge',
      tiers: [
        { up_to: 1024, ratio: 1, label: '1K' },
        { up_to: 2048, ratio: 2, label: '2K' },
        { up_to: 0, ratio: 4, label: '4K+' },
      ],
    },
  },
  {
    titleKey: 'Image quality (standard/hd)',
    rule: {
      models: [],
      source: 'quality',
      kind: 'enum',
      out_key: 'sku_quality',
      enabled: true,
      enum: { standard: 1, hd: 2 },
    },
  },
  {
    titleKey: 'Video duration tiers',
    rule: {
      models: [],
      source: 'duration',
      kind: 'tier',
      out_key: 'sku_duration',
      enabled: true,
      derive: 'number',
      tiers: [
        { up_to: 5, ratio: 1, label: '≤5s' },
        { up_to: 10, ratio: 1.8, label: '≤10s' },
        { up_to: 0, ratio: 3, label: '10s+' },
      ],
    },
  },
  {
    titleKey: 'Image-to-video surcharge',
    rule: {
      models: [],
      source: 'input_reference',
      kind: 'exists',
      out_key: 'sku_i2v',
      enabled: true,
      exists_ratio: 1.3,
    },
  },
]

function parseRules(raw: string | undefined): SkuRule[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed as SkuRule[]
  } catch {
    /* fall through */
  }
  return []
}

type SkuRatioSettingsProps = {
  enabledDefault: string
  rulesDefault: string
  maxTotalDefault: string
}

export const SkuRatioSettings = memo(function SkuRatioSettings({
  enabledDefault,
  rulesDefault,
  maxTotalDefault,
}: SkuRatioSettingsProps) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()
  const [editMode, setEditMode] = useState<'visual' | 'json'>('visual')
  const [enabled, setEnabled] = useState(false)
  const [maxTotal, setMaxTotal] = useState(0)
  const [rows, setRows] = useState<RuleRow[]>([])
  const [jsonText, setJsonText] = useState('[]')
  const [jsonError, setJsonError] = useState('')
  const [nextRowId, setNextRowId] = useState(1)

  useEffect(() => {
    setEnabled(enabledDefault === 'true')
    setMaxTotal(Number(maxTotalDefault) || 0)
    const rules = parseRules(rulesDefault)
    setRows(rules.map((rule, index) => ruleToRow(rule, index + 1)))
    setJsonText(JSON.stringify(rules, null, 2))
    setJsonError('')
    setNextRowId(rules.length + 1)
  }, [enabledDefault, rulesDefault, maxTotalDefault])

  const currentRules = useMemo(() => rows.map(rowToRule), [rows])

  const syncFromRows = useCallback((nextRows: RuleRow[]) => {
    setRows(nextRows)
    setJsonText(JSON.stringify(nextRows.map(rowToRule), null, 2))
    setJsonError('')
  }, [])

  const updateRow = useCallback(
    (id: number, patch: Partial<RuleRow>) => {
      syncFromRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    },
    [rows, syncFromRows]
  )

  const addRow = useCallback(() => {
    setNextRowId((prev) => prev + 1)
    syncFromRows([...rows, emptyRule(nextRowId)])
  }, [nextRowId, rows, syncFromRows])

  const addPreset = useCallback(
    (preset: Preset) => {
      setNextRowId((prev) => prev + 1)
      syncFromRows([...rows, ruleToRow(preset.rule, nextRowId)])
    },
    [nextRowId, rows, syncFromRows]
  )

  const removeRow = useCallback(
    (id: number) => {
      syncFromRows(rows.filter((r) => r.id !== id))
    },
    [rows, syncFromRows]
  )

  const handleJsonChange = useCallback(
    (text: string) => {
      setJsonText(text)
      try {
        const parsed = JSON.parse(text) as unknown
        if (!Array.isArray(parsed)) {
          setJsonError(t('Rules must be a JSON array'))
          return
        }
        const nextRows = (parsed as SkuRule[]).map((rule, index) =>
          ruleToRow(rule, index + 1)
        )
        setRows(nextRows)
        setNextRowId(nextRows.length + 1)
        setJsonError('')
      } catch (err) {
        setJsonError(err instanceof Error ? err.message : t('Invalid JSON'))
      }
    },
    [t]
  )

  const handleCopyJson = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(jsonText)
      toast.success(t('Copied to clipboard'))
    } catch {
      toast.error(t('Failed to copy'))
    }
  }, [jsonText, t])

  const handleSave = useCallback(async () => {
    if (editMode === 'json' && jsonError) {
      toast.error(t('Please fix JSON errors before saving'))
      return
    }
    const validationError = validateRuleRows(rows, t)
    if (validationError) {
      toast.error(validationError)
      return
    }
    await Promise.all([
      updateOption.mutateAsync({ key: ENABLED_KEY, value: String(enabled) }),
      updateOption.mutateAsync({ key: MAX_TOTAL_KEY, value: String(maxTotal) }),
      updateOption.mutateAsync({
        key: RULES_KEY,
        value: JSON.stringify(currentRules),
      }),
    ])
    toast.success(t('SKU ratio settings saved'))
  }, [
    currentRules,
    editMode,
    enabled,
    jsonError,
    maxTotal,
    rows,
    t,
    updateOption,
  ])

  return (
    <div className='space-y-4'>
      <SkuSourceDatalist />
      <Alert>
        <AlertDescription className='space-y-1 text-sm'>
          <div>
            {t(
              'Configure extra billing multipliers based on request parameters (image size/quality, video resolution/duration). Disabled by default; multipliers stack onto existing pricing.'
            )}
          </div>
          <div>
            {t(
              'These are global wildcard rules (batch / fallback). To configure a single model precisely, edit that model and use its Parameter-based pricing section.'
            )}
          </div>
        </AlertDescription>
      </Alert>

      <div className='flex flex-wrap items-center gap-6'>
        <div className='flex items-center gap-2'>
          <Switch
            id='sku-enabled'
            checked={enabled}
            onCheckedChange={setEnabled}
          />
          <Label htmlFor='sku-enabled'>{t('Enable SKU ratio table')}</Label>
        </div>
        <div className='flex items-center gap-2'>
          <Label htmlFor='sku-max-total'>{t('Max total multiplier')}</Label>
          <Input
            id='sku-max-total'
            type='number'
            min={0}
            step={0.5}
            className='w-28'
            value={maxTotal}
            onChange={(e) => setMaxTotal(Number(e.target.value) || 0)}
          />
          <span className='text-muted-foreground text-xs'>
            {t('0 = unlimited')}
          </span>
        </div>
      </div>

      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex flex-wrap items-center gap-2'>
          {editMode === 'visual' ? (
            <>
              <Button variant='outline' size='sm' onClick={addRow}>
                <Plus className='mr-2 h-4 w-4' />
                {t('Add rule')}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant='outline' size='sm'>
                      <Sparkles className='mr-2 h-4 w-4' />
                      {t('Add from preset')}
                    </Button>
                  }
                />
                <DropdownMenuContent align='start'>
                  {PRESETS.map((preset) => (
                    <DropdownMenuItem
                      key={preset.titleKey}
                      onSelect={() => addPreset(preset)}
                    >
                      {t(preset.titleKey)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : (
            <Button variant='ghost' size='sm' onClick={handleCopyJson}>
              <Copy className='mr-2 h-4 w-4' />
              {t('Copy')}
            </Button>
          )}
        </div>
        <Button
          variant='outline'
          size='sm'
          onClick={() =>
            setEditMode((prev) => (prev === 'visual' ? 'json' : 'visual'))
          }
        >
          {editMode === 'visual' ? (
            <>
              <Code2 className='mr-2 h-4 w-4' />
              {t('Switch to JSON')}
            </>
          ) : (
            <>
              <Eye className='mr-2 h-4 w-4' />
              {t('Switch to Visual')}
            </>
          )}
        </Button>
      </div>

      {editMode === 'visual' ? (
        <div className='space-y-3'>
          {rows.length === 0 && (
            <div className='text-muted-foreground py-8 text-center text-sm'>
              {t('No rules configured')}
            </div>
          )}
          {rows.map((row) => (
            <SkuRuleEditor
              key={row.id}
              row={row}
              onChange={(patch) => updateRow(row.id, patch)}
              onRemove={() => removeRow(row.id)}
            />
          ))}
        </div>
      ) : (
        <div className='space-y-2'>
          <Textarea
            value={jsonText}
            onChange={(e) => handleJsonChange(e.target.value)}
            className='font-mono text-sm'
            rows={16}
            spellCheck={false}
          />
          {jsonError && <p className='text-destructive text-sm'>{jsonError}</p>}
        </div>
      )}

      <div className='flex justify-end'>
        <Button
          onClick={handleSave}
          disabled={
            updateOption.isPending || (editMode === 'json' && !!jsonError)
          }
        >
          {t('Save SKU ratio settings')}
        </Button>
      </div>
    </div>
  )
})
