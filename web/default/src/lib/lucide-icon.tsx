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
 * Lookup Lucide icons by string name.
 *
 * Used by admin-configurable surfaces (custom navigation items, etc.)
 * where the icon identifier is stored as a string in the database.
 *
 * Uses a namespace import so that any icon exported by lucide-react can be
 * referenced at runtime. Modern bundlers tree-shake unreferenced exports
 * from this entry, so the cost is bounded by which icons are actually used
 * in the configured CustomNavItems and elsewhere in the bundle.
 */
import * as LucideIcons from 'lucide-react'
import { ExternalLink, type LucideIcon } from 'lucide-react'

const iconCache = new Map<string, LucideIcon>()

/**
 * Resolve a lucide-react icon component by its PascalCase name.
 *
 * Returns the {@link ExternalLink} icon as a fallback when the name is
 * empty or does not match a known export.
 */
export function getLucideIconByName(name: string | undefined | null): LucideIcon {
  if (!name) return ExternalLink
  const trimmed = name.trim()
  if (!trimmed) return ExternalLink
  const cached = iconCache.get(trimmed)
  if (cached) return cached
  const candidate = (LucideIcons as unknown as Record<string, unknown>)[trimmed]
  const resolved =
    typeof candidate === 'object' || typeof candidate === 'function'
      ? (candidate as LucideIcon)
      : ExternalLink
  iconCache.set(trimmed, resolved)
  return resolved
}

type LucideIconByNameProps = React.ComponentProps<LucideIcon> & {
  name?: string | null
}

/** Render helper. Wraps {@link getLucideIconByName} in JSX. */
export function LucideIconByName({ name, ...rest }: LucideIconByNameProps) {
  const Icon = getLucideIconByName(name)
  return <Icon {...rest} />
}
