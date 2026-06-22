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
import * as React from 'react'
import { Add01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox'
import { type ComboboxInputOption } from '@/components/ui/combobox-input'

interface ComboboxFreeInputProps {
  options: ComboboxInputOption[]
  value?: string
  onValueChange: (value: string) => void
  placeholder?: string
  emptyText?: string
  className?: string
  id?: string
  /** Allow committing a typed value that is not in `options`. */
  allowCustomValue?: boolean
}

/**
 * ComboboxFreeInput — single-select combobox that also accepts free-typed
 * values. Built on Base UI Combobox so its dropdown renders through a Portal
 * (`ComboboxContent`), which means the popup is never clipped by a scrolling
 * dialog/drawer container — unlike the legacy absolutely-positioned
 * `ComboboxInput` in `combobox-input.tsx`.
 *
 * API mirrors the legacy `ComboboxInput` so it can be used as a drop-in
 * replacement (`options/value/onValueChange/placeholder/emptyText/allowCustomValue`).
 */
export function ComboboxFreeInput({
  options,
  value = '',
  onValueChange,
  placeholder = 'Select or type...',
  emptyText = 'No option found.',
  className,
  id,
  allowCustomValue = false,
}: ComboboxFreeInputProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [inputValue, setInputValue] = React.useState('')

  // Map value -> label so a selected value still shows its friendly label.
  const labelMap = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const option of options) map.set(option.value, option.label)
    return map
  }, [options])

  const trimmedInput = inputValue.trim()
  const inputMatchesExisting =
    trimmedInput.length > 0 &&
    options.some(
      (option) =>
        option.value.toLowerCase() === trimmedInput.toLowerCase() ||
        option.label.toLowerCase() === trimmedInput.toLowerCase()
    )
  const canCreate =
    allowCustomValue && trimmedInput.length > 0 && !inputMatchesExisting

  // Items handed to Base UI for filtering: option values + the in-progress
  // custom value (so a "use <typed>" entry can be highlighted/selected).
  const items = React.useMemo(() => {
    const set = new Set<string>(options.map((option) => option.value))
    if (canCreate) set.add(trimmedInput)
    return Array.from(set)
  }, [options, canCreate, trimmedInput])

  // Keep the input text in sync with the externally controlled value when the
  // popup is closed, so the field shows the current selection/custom value.
  React.useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInputValue(labelMap.get(value) ?? value)
    }
  }, [open, value, labelMap])

  const handleValueChange = (next: string | null) => {
    if (next == null) return
    onValueChange(next)
    setOpen(false)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && canCreate) {
      const popup = document.querySelector<HTMLElement>(
        '[data-slot="combobox-content"][data-open]'
      )
      const hasHighlight = popup?.querySelector('[data-highlighted]') != null
      if (!hasHighlight) {
        event.preventDefault()
        onValueChange(trimmedInput)
        setOpen(false)
      }
    }
  }

  return (
    <Combobox
      items={items}
      value={value}
      onValueChange={handleValueChange}
      inputValue={inputValue}
      onInputValueChange={setInputValue}
      open={open}
      onOpenChange={setOpen}
    >
      <ComboboxInput
        id={id}
        placeholder={placeholder}
        onKeyDown={handleKeyDown}
        className={cn('w-full', className)}
      />
      <ComboboxContent>
        <ComboboxList>
          <ComboboxCollection>
            {(item: string) => {
              const isCreate = canCreate && item === trimmedInput
              const label = labelMap.get(item) ?? item
              return (
                <ComboboxItem key={item} value={item}>
                  {isCreate ? (
                    <>
                      <HugeiconsIcon
                        icon={Add01Icon}
                        strokeWidth={2}
                        className='text-muted-foreground'
                        aria-hidden='true'
                      />
                      <span className='truncate'>
                        {t('Press Enter to use "{{value}}"', { value: item })}
                      </span>
                    </>
                  ) : (
                    <span className='truncate'>{label}</span>
                  )}
                </ComboboxItem>
              )
            }}
          </ComboboxCollection>
        </ComboboxList>
        <ComboboxEmpty>{t(emptyText)}</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  )
}
