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
/**
 * Custom top navigation items — schema and helpers.
 *
 * Custom items are anchored to built-in nav items (home, console, pricing,
 * rankings, docs, about) plus two sentinels (__start__, __end__). The
 * `position` field controls whether the item renders before or after its
 * anchor; ties are broken by `order`.
 *
 * This avoids the brittleness of absolute index numbers when the upstream
 * project later adds/removes built-in items.
 */

/** Stable identifiers for the built-in top navigation slots. */
export const BUILTIN_NAV_KEYS = [
  'home',
  'console',
  'pricing',
  'rankings',
  'docs',
  'about',
] as const

export type BuiltinNavKey = (typeof BUILTIN_NAV_KEYS)[number]

/** Anchor: built-in item key or a sentinel (__start__ / __end__). */
export type CustomNavAnchor = BuiltinNavKey | '__start__' | '__end__'

export const CUSTOM_NAV_ANCHORS: CustomNavAnchor[] = [
  '__start__',
  ...BUILTIN_NAV_KEYS,
  '__end__',
]

export type CustomNavPosition = 'before' | 'after'

export type CustomNavItem = {
  /** nanoid-style stable identifier, set by the admin form on create. */
  id: string
  /** Display text — passed through i18n's t() so it may be a translation key. */
  title: string
  /** Target href: "/internal/path" or "https://external". */
  url: string
  /** Whether to open in a new tab. External URLs are always treated as blank. */
  target: 'self' | 'blank'
  /** Lucide icon name (PascalCase). Falls back to ExternalLink when unknown. */
  icon: string
  /** Hide from logged-out visitors when true. */
  requireAuth: boolean
  /** Soft toggle without deleting the entry. */
  enabled: boolean
  /** Insert this item before or after the anchor. */
  position: CustomNavPosition
  /** Anchor key — built-in item or sentinel. */
  anchor: CustomNavAnchor
  /** Ordering within the same (anchor, position) bucket. Lower goes first. */
  order: number
}

/** Server-side cap — keep in sync with backend validation. */
export const CUSTOM_NAV_ITEMS_MAX = 20

const isCustomNavAnchor = (raw: unknown): raw is CustomNavAnchor =>
  typeof raw === 'string' &&
  (CUSTOM_NAV_ANCHORS as readonly string[]).includes(raw)

const isCustomNavPosition = (raw: unknown): raw is CustomNavPosition =>
  raw === 'before' || raw === 'after'

const toString = (raw: unknown, fallback = ''): string =>
  typeof raw === 'string' ? raw : fallback

const toBoolean = (raw: unknown, fallback = false): boolean =>
  typeof raw === 'boolean' ? raw : fallback

const toNumber = (raw: unknown, fallback = 0): number => {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = Number.parseFloat(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

/**
 * Parse the raw JSON string stored in OptionMap["CustomNavItems"].
 *
 * Returns `[]` for empty / null / malformed input — never throws. Invalid
 * individual entries are skipped so a single bad row does not blank out
 * the whole nav.
 */
export function parseCustomNavItems(value: unknown): CustomNavItem[] {
  if (value == null) return []
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === 'object')
    )
    .map((entry, index): CustomNavItem | null => {
      const url = toString(entry.url).trim()
      if (!url) return null
      const anchor: CustomNavAnchor = isCustomNavAnchor(entry.anchor)
        ? entry.anchor
        : '__end__'
      const position: CustomNavPosition = isCustomNavPosition(entry.position)
        ? entry.position
        : 'after'
      return {
        id: toString(entry.id, `nav-${index}`),
        title: toString(entry.title, url),
        url,
        target: entry.target === 'blank' ? 'blank' : 'self',
        icon: toString(entry.icon, ''),
        requireAuth: toBoolean(entry.requireAuth, false),
        enabled: toBoolean(entry.enabled, true),
        position,
        anchor,
        order: toNumber(entry.order, 0),
      }
    })
    .filter((item): item is CustomNavItem => item !== null)
}

/** Serialize for persistence. */
export function serializeCustomNavItems(items: CustomNavItem[]): string {
  return JSON.stringify(items)
}
