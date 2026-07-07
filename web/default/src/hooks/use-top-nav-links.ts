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
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useStatus } from '@/hooks/use-status'
import {
  type CustomNavItem,
  parseCustomNavItems,
} from '@/features/system-settings/maintenance/lib/custom-nav-items'
import {
  type BuiltinSlot,
  mergeNavLinks,
} from '@/features/system-settings/maintenance/lib/merge-nav'
import { parseHeaderNavModulesFromStatus } from '@/lib/nav-modules'
import { useAuthStore } from '@/stores/auth-store'

export type TopNavLink = {
  title: string
  href: string
  disabled?: boolean
  requiresAuth?: boolean
  external?: boolean
  /** Stable key for built-in items; used as anchor target by custom items. */
  key?: string
  /** Lucide icon name (PascalCase). Currently only used by custom items. */
  icon?: string
}

const customToLink = (item: CustomNavItem): TopNavLink => {
  const isExternalUrl = /^https?:\/\//i.test(item.url)
  return {
    title: item.title,
    href: item.url,
    icon: item.icon || undefined,
    external: item.target === 'blank' || isExternalUrl,
  }
}

/**
 * Generate top navigation links based on HeaderNavModules configuration from backend /api/status
 * Backend format example (stringified JSON):
 * {
 *   home: true,
 *   console: true,
 *   pricing: { enabled: true, requireAuth: false },
 *   rankings: { enabled: true, requireAuth: false },
 *   docs: true,
 *   about: true
 * }
 *
 * After building the built-in items, this hook merges in admin-defined
 * {@link CustomNavItem}s from `status.CustomNavItems`, honoring the
 * `anchor` / `position` / `order` fields so operators can place custom
 * links between any two built-in items (e.g. between Console and Pricing).
 */
export function useTopNavLinks(): TopNavLink[] {
  const { t } = useTranslation()
  const { status } = useStatus()
  const { auth } = useAuthStore()

  // Parse HeaderNavModules
  const modules = useMemo(() => {
    return parseHeaderNavModulesFromStatus(
      status as Record<string, unknown> | null
    )
  }, [status])

  // Documentation link (may be external)
  const docsLink: string | undefined = status?.docs_link as string | undefined

  const isAuthed = !!auth?.user

  // Build the canonical built-in slots, each carrying its stable key so
  // CustomNavItems can anchor against it.
  const builtin: BuiltinSlot<TopNavLink>[] = []

  if (modules?.home !== false) {
    builtin.push({
      key: 'home',
      link: { title: t('Home'), href: '/', key: 'home' },
    })
  }

  if (modules?.console !== false) {
    builtin.push({
      key: 'console',
      link: { title: t('Console'), href: '/dashboard', key: 'console' },
    })
  }

  const pricing = modules?.pricing
  if (pricing && typeof pricing === 'object' && pricing.enabled) {
    const requiresAuth = pricing.requireAuth && !isAuthed
    builtin.push({
      key: 'pricing',
      link: {
        title: t('Model Square'),
        href: '/pricing',
        requiresAuth,
        key: 'pricing',
      },
    })
  }

  const rankings = modules?.rankings
  if (rankings && typeof rankings === 'object' && rankings.enabled) {
    const requiresAuth = rankings.requireAuth && !isAuthed
    builtin.push({
      key: 'rankings',
      link: {
        title: t('Rankings'),
        href: '/rankings',
        requiresAuth,
        key: 'rankings',
      },
    })
  }

  if (modules?.docs !== false) {
    const docsLinkObj: TopNavLink = docsLink
      ? { title: t('Docs'), href: docsLink, external: true, key: 'docs' }
      : { title: t('Docs'), href: '/docs', key: 'docs' }
    builtin.push({ key: 'docs', link: docsLinkObj })
  }

  if (modules?.about !== false) {
    builtin.push({
      key: 'about',
      link: { title: t('About'), href: '/about', key: 'about' },
    })
  }

  // Parse + filter custom items, then weave them into the built-in sequence.
  const customItems = useMemo(() => {
    const all = parseCustomNavItems(
      (status as Record<string, unknown> | null)?.CustomNavItems
    )
    return all.filter(
      (item) => item.enabled && (!item.requireAuth || isAuthed)
    )
  }, [status, isAuthed])

  if (customItems.length === 0) return builtin.map((slot) => slot.link)
  return mergeNavLinks(builtin, customItems, customToLink)
}
