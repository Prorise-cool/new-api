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
import { memo, useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  SkuRuleEditor,
  SkuSourceDatalist,
} from '@/features/system-settings/models/sku-rule-editor'
import {
  emptyRule,
  ruleToRow,
  rowToRule,
  type RuleRow,
  type SkuRule,
} from '@/features/system-settings/models/sku-rule-types'

// ---------------------------------------------------------------------------
// Per-model SKU section, embedded in the model edit drawer.
//
// Edits the rules attached to THIS model (sku_ratio_setting.model_rules[model]).
// The model anchor is implicit, so the model-patterns field is hidden — each
// rule here applies only to the model being edited.
// ---------------------------------------------------------------------------

type ModelSkuRatioSectionProps = {
  /** Rules currently attached to this model. */
  rules: SkuRule[]
  /** Push the edited rules up to the drawer for saving. */
  onChange: (rules: SkuRule[]) => void
}

export const ModelSkuRatioSection = memo(function ModelSkuRatioSection({
  rules,
  onChange,
}: ModelSkuRatioSectionProps) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<RuleRow[]>([])
  const [nextRowId, setNextRowId] = useState(1)

  // Hydrate editor rows from incoming rules (e.g. when the drawer loads a model).
  useEffect(() => {
    setRows(rules.map((rule, index) => ruleToRow(rule, index + 1)))
    setNextRowId(rules.length + 1)
  }, [rules])

  const sync = useCallback(
    (nextRows: RuleRow[]) => {
      setRows(nextRows)
      onChange(nextRows.map(rowToRule))
    },
    [onChange]
  )

  const updateRow = useCallback(
    (id: number, patch: Partial<RuleRow>) => {
      sync(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    },
    [rows, sync]
  )

  const addRow = useCallback(() => {
    setNextRowId((prev) => prev + 1)
    sync([...rows, emptyRule(nextRowId)])
  }, [nextRowId, rows, sync])

  const removeRow = useCallback(
    (id: number) => {
      sync(rows.filter((r) => r.id !== id))
    },
    [rows, sync]
  )

  return (
    <div className='space-y-3'>
      <SkuSourceDatalist />
      <Alert>
        <AlertDescription className='text-sm'>
          {t(
            'Charge extra for this model based on request parameters (e.g. larger size, hd quality, longer duration). Rules here apply only to this model and require the global SKU switch (Billing settings) to be on.'
          )}
        </AlertDescription>
      </Alert>

      {rows.length === 0 ? (
        <div className='text-muted-foreground py-4 text-center text-sm'>
          {t('No parameter-based pricing for this model')}
        </div>
      ) : (
        <div className='space-y-3'>
          {rows.map((row) => (
            <SkuRuleEditor
              key={row.id}
              row={row}
              hideModels
              onChange={(patch) => updateRow(row.id, patch)}
              onRemove={() => removeRow(row.id)}
            />
          ))}
        </div>
      )}

      <Button type='button' variant='outline' size='sm' onClick={addRow}>
        <Plus className='mr-2 h-4 w-4' />
        {t('Add rule')}
      </Button>
    </div>
  )
})
