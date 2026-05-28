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
import { useEffect, useState } from 'react'
import { nanoid } from 'nanoid'
import { ArrowDown, ArrowUp, Edit, Plus, Save, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { LucideIconByName } from '@/lib/lucide-icon'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { SettingsSection } from '../components/settings-section'
import { useUpdateOption } from '../hooks/use-update-option'
import {
  CUSTOM_NAV_ITEMS_MAX,
  type CustomNavAnchor,
  type CustomNavItem,
  type CustomNavPosition,
  parseCustomNavItems,
  serializeCustomNavItems,
} from './lib/custom-nav-items'

type SectionProps = {
  data: string
}

type LocationKey = `${CustomNavAnchor}:${CustomNavPosition}`

const ANCHOR_LABELS: Record<CustomNavAnchor, string> = {
  __start__: 'At start',
  home: 'Home',
  console: 'Console',
  pricing: 'Model Square',
  rankings: 'Rankings',
  docs: 'Docs',
  about: 'About',
  __end__: 'At end',
}

const LOCATION_OPTIONS: Array<{
  value: LocationKey
  anchor: CustomNavAnchor
  position: CustomNavPosition
  /** i18n key */
  labelKey: string
}> = [
  // Standalone anchors at the very edges
  {
    value: '__start__:after',
    anchor: '__start__',
    position: 'after',
    labelKey: 'At start',
  },
  // Built-in items: render "before X" and "after X" pairs.
  ...(['home', 'console', 'pricing', 'rankings', 'docs', 'about'] as const)
    .flatMap((anchor) => [
      {
        value: `${anchor}:before` as LocationKey,
        anchor,
        position: 'before' as const,
        labelKey: `Before ${ANCHOR_LABELS[anchor]}`,
      },
      {
        value: `${anchor}:after` as LocationKey,
        anchor,
        position: 'after' as const,
        labelKey: `After ${ANCHOR_LABELS[anchor]}`,
      },
    ]),
  {
    value: '__end__:before',
    anchor: '__end__',
    position: 'before',
    labelKey: 'At end',
  },
]

type FormState = {
  title: string
  url: string
  icon: string
  target: 'self' | 'blank'
  requireAuth: boolean
  enabled: boolean
  location: LocationKey
  order: number
}

const EMPTY_FORM: FormState = {
  title: '',
  url: '',
  icon: '',
  target: 'self',
  requireAuth: false,
  enabled: true,
  location: '__end__:before',
  order: 0,
}

const toLocationKey = (item: CustomNavItem): LocationKey =>
  `${item.anchor}:${item.position}` as LocationKey

const splitLocation = (
  loc: LocationKey
): { anchor: CustomNavAnchor; position: CustomNavPosition } => {
  const [anchor, position] = loc.split(':') as [
    CustomNavAnchor,
    CustomNavPosition,
  ]
  return { anchor, position }
}

const itemToForm = (item: CustomNavItem): FormState => ({
  title: item.title,
  url: item.url,
  icon: item.icon,
  target: item.target,
  requireAuth: item.requireAuth,
  enabled: item.enabled,
  location: toLocationKey(item),
  order: item.order,
})

export function CustomNavItemsSection({ data }: SectionProps) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()

  const [items, setItems] = useState<CustomNavItem[]>([])
  const [dirty, setDirty] = useState(false)
  const [showDialog, setShowDialog] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [deleteTarget, setDeleteTarget] = useState<CustomNavItem | null>(null)

  // Hydrate from upstream value whenever it changes (e.g. after a save).
  useEffect(() => {
    setItems(parseCustomNavItems(data))
    setDirty(false)
  }, [data])

  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const openAdd = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setShowDialog(true)
  }

  const openEdit = (item: CustomNavItem) => {
    setEditingId(item.id)
    setForm(itemToForm(item))
    setShowDialog(true)
  }

  const submitForm = () => {
    const trimmedUrl = form.url.trim()
    const trimmedTitle = form.title.trim()
    if (!trimmedTitle) {
      toast.error(t('Title is required'))
      return
    }
    if (!trimmedUrl) {
      toast.error(t('URL is required'))
      return
    }
    const isInternal = trimmedUrl.startsWith('/')
    const isExternal = /^https?:\/\//i.test(trimmedUrl)
    if (!isInternal && !isExternal) {
      toast.error(t('URL must start with / or http(s)://'))
      return
    }

    const { anchor, position } = splitLocation(form.location)
    const next: CustomNavItem = {
      id: editingId ?? nanoid(),
      title: trimmedTitle,
      url: trimmedUrl,
      icon: form.icon.trim(),
      target: form.target,
      requireAuth: form.requireAuth,
      enabled: form.enabled,
      anchor,
      position,
      order: Number.isFinite(form.order) ? form.order : 0,
    }

    setItems((prev) => {
      if (editingId) {
        return prev.map((it) => (it.id === editingId ? next : it))
      }
      if (prev.length >= CUSTOM_NAV_ITEMS_MAX) {
        toast.error(
          t('Custom nav items limit reached ({{n}} max)', {
            n: CUSTOM_NAV_ITEMS_MAX,
          })
        )
        return prev
      }
      return [...prev, next]
    })
    setDirty(true)
    setShowDialog(false)
  }

  const confirmDelete = () => {
    if (!deleteTarget) return
    setItems((prev) => prev.filter((it) => it.id !== deleteTarget.id))
    setDirty(true)
    setDeleteTarget(null)
  }

  // Move an item up/down within its (anchor, position) bucket. Operates on the
  // stable `order` field rather than the underlying array index, so it works
  // even when items are interleaved across anchors.
  const moveWithinBucket = (item: CustomNavItem, delta: number) => {
    const siblings = items
      .filter(
        (it) => it.anchor === item.anchor && it.position === item.position
      )
      .sort((a, b) => a.order - b.order)
    const idx = siblings.findIndex((it) => it.id === item.id)
    const target = siblings[idx + delta]
    if (!target) return
    setItems((prev) =>
      prev.map((it) => {
        if (it.id === item.id) return { ...it, order: target.order }
        if (it.id === target.id) return { ...it, order: item.order }
        return it
      })
    )
    setDirty(true)
  }

  const handleSaveAll = async () => {
    await updateOption.mutateAsync({
      key: 'CustomNavItems',
      value: serializeCustomNavItems(items),
    })
    setDirty(false)
  }

  const renderLocation = (item: CustomNavItem) => {
    const match = LOCATION_OPTIONS.find(
      (opt) => opt.anchor === item.anchor && opt.position === item.position
    )
    return match ? t(match.labelKey) : `${item.anchor}:${item.position}`
  }

  return (
    <SettingsSection title={t('Custom navigation items')}>
      <div className='space-y-4'>
        <div className='flex flex-wrap items-center gap-2'>
          <Button onClick={openAdd} size='sm'>
            <Plus className='mr-2 h-4 w-4' />
            {t('Add item')}
          </Button>
          <Button
            onClick={handleSaveAll}
            size='sm'
            variant='secondary'
            disabled={!dirty || updateOption.isPending}
          >
            <Save className='mr-2 h-4 w-4' />
            {updateOption.isPending ? t('Saving...') : t('Save Settings')}
          </Button>
          <span className='text-muted-foreground ml-auto text-sm'>
            {t('{{count}} / {{max}}', {
              count: items.length,
              max: CUSTOM_NAV_ITEMS_MAX,
            })}
          </span>
        </div>

        <div className='rounded-md border'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className='w-16'>{t('Enabled')}</TableHead>
                <TableHead className='w-12'>{t('Icon')}</TableHead>
                <TableHead>{t('Title')}</TableHead>
                <TableHead>{t('URL')}</TableHead>
                <TableHead>{t('Location')}</TableHead>
                <TableHead className='w-44 text-right'>
                  {t('Actions')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className='h-24 text-center'>
                    {t('No custom nav items yet. Click "Add item" to create one.')}
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <Switch
                        checked={item.enabled}
                        onCheckedChange={(checked) => {
                          setItems((prev) =>
                            prev.map((it) =>
                              it.id === item.id
                                ? { ...it, enabled: checked }
                                : it
                            )
                          )
                          setDirty(true)
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <LucideIconByName name={item.icon} className='h-4 w-4' />
                    </TableCell>
                    <TableCell>{item.title}</TableCell>
                    <TableCell
                      className='max-w-xs truncate font-mono text-sm'
                      title={item.url}
                    >
                      {item.url}
                      {item.target === 'blank' ? ' ↗' : ''}
                    </TableCell>
                    <TableCell>{renderLocation(item)}</TableCell>
                    <TableCell className='text-right'>
                      <div className='flex justify-end gap-1'>
                        <Button
                          size='sm'
                          variant='ghost'
                          onClick={() => moveWithinBucket(item, -1)}
                          title={t('Move up')}
                        >
                          <ArrowUp className='h-4 w-4' />
                        </Button>
                        <Button
                          size='sm'
                          variant='ghost'
                          onClick={() => moveWithinBucket(item, 1)}
                          title={t('Move down')}
                        >
                          <ArrowDown className='h-4 w-4' />
                        </Button>
                        <Button
                          size='sm'
                          variant='ghost'
                          onClick={() => openEdit(item)}
                        >
                          <Edit className='h-4 w-4' />
                        </Button>
                        <Button
                          size='sm'
                          variant='ghost'
                          onClick={() => setDeleteTarget(item)}
                        >
                          <Trash2 className='text-destructive h-4 w-4' />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className='sm:max-w-lg'>
          <DialogHeader>
            <DialogTitle>
              {editingId ? t('Edit nav item') : t('Add nav item')}
            </DialogTitle>
            <DialogDescription>
              {t('Append a custom link to the top navigation bar. Internal paths start with /, external URLs start with http(s)://')}
            </DialogDescription>
          </DialogHeader>

          <div className='space-y-4'>
            <div className='space-y-2'>
              <Label>{t('Title')}</Label>
              <Input
                value={form.title}
                onChange={(e) => updateForm('title', e.target.value)}
                placeholder={t('My Studio')}
              />
            </div>

            <div className='space-y-2'>
              <Label>{t('URL')}</Label>
              <Input
                value={form.url}
                onChange={(e) => updateForm('url', e.target.value)}
                placeholder='https://example.com or /internal'
              />
            </div>

            <div className='grid gap-4 sm:grid-cols-2'>
              <div className='space-y-2'>
                <Label>{t('Icon name (lucide)')}</Label>
                <div className='flex items-center gap-2'>
                  <Input
                    value={form.icon}
                    onChange={(e) => updateForm('icon', e.target.value)}
                    placeholder='Sparkles, ExternalLink, Wand2, ...'
                  />
                  <div className='border-input flex h-9 w-9 shrink-0 items-center justify-center rounded-md border'>
                    <LucideIconByName name={form.icon} className='h-4 w-4' />
                  </div>
                </div>
              </div>

              <div className='space-y-2'>
                <Label>{t('Open in')}</Label>
                <Select
                  value={form.target}
                  onValueChange={(v) =>
                    updateForm('target', v as 'self' | 'blank')
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='self'>{t('Same tab')}</SelectItem>
                    <SelectItem value='blank'>{t('New tab')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className='grid gap-4 sm:grid-cols-2'>
              <div className='space-y-2'>
                <Label>{t('Location')}</Label>
                <Select
                  value={form.location}
                  onValueChange={(v) =>
                    updateForm('location', v as LocationKey)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOCATION_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {t(opt.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className='space-y-2'>
                <Label>{t('Sort order')}</Label>
                <Input
                  type='number'
                  value={form.order}
                  onChange={(e) =>
                    updateForm('order', Number.parseFloat(e.target.value) || 0)
                  }
                />
              </div>
            </div>

            <div className='flex items-center gap-6'>
              <div className='flex items-center gap-2'>
                <Switch
                  checked={form.enabled}
                  onCheckedChange={(c) => updateForm('enabled', c)}
                />
                <Label>{t('Enabled')}</Label>
              </div>
              <div className='flex items-center gap-2'>
                <Switch
                  checked={form.requireAuth}
                  onCheckedChange={(c) => updateForm('requireAuth', c)}
                />
                <Label>{t('Require login')}</Label>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant='outline' onClick={() => setShowDialog(false)}>
              {t('Cancel')}
            </Button>
            <Button onClick={submitForm}>{t('Save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Delete nav item?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('"{{title}}" will be removed once you save settings.', {
                title: deleteTarget?.title ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>
              {t('Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  )
}
