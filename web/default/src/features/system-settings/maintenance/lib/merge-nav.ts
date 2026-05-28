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
 * Merge built-in nav items with admin-configured custom items.
 *
 * Algorithm: bucket custom items by (anchor, position). For each built-in
 * item: emit all "before" entries anchored to its key, then the built-in,
 * then all "after" entries. Items anchored to the `__start__` / `__end__`
 * sentinels are emitted at the boundaries of the final list.
 *
 * The function is generic over the link shape so it can be reused by the
 * admin preview panel (which renders a different React element) without
 * coupling to the runtime nav link type.
 */
import {
  type CustomNavAnchor,
  type CustomNavItem,
  type CustomNavPosition,
} from './custom-nav-items'

export type BuiltinSlot<T> = { key: string; link: T }

type Bucket<T> = Record<CustomNavAnchor, Record<CustomNavPosition, T[]>>

const EMPTY_BUCKETS = (): Bucket<unknown> =>
  ({
    __start__: { before: [], after: [] },
    __end__: { before: [], after: [] },
    home: { before: [], after: [] },
    console: { before: [], after: [] },
    pricing: { before: [], after: [] },
    rankings: { before: [], after: [] },
    docs: { before: [], after: [] },
    about: { before: [], after: [] },
  }) as Bucket<unknown>

/**
 * @param builtin   Built-in links in their canonical render order. Each
 *                  entry exposes a `key` matching a {@link BuiltinNavKey}.
 * @param custom    Validated custom items (filtering on `enabled` and
 *                  auth gating is the caller's responsibility).
 * @param toLink    Convert a {@link CustomNavItem} into the same link
 *                  shape the caller uses for built-ins.
 */
export function mergeNavLinks<T>(
  builtin: BuiltinSlot<T>[],
  custom: CustomNavItem[],
  toLink: (item: CustomNavItem) => T
): T[] {
  const buckets = EMPTY_BUCKETS() as Bucket<T>

  const sortedCustom = [...custom].sort((a, b) => a.order - b.order)
  for (const item of sortedCustom) {
    const anchorBucket = buckets[item.anchor] ?? buckets.__end__
    anchorBucket[item.position].push(toLink(item))
  }

  const out: T[] = []
  out.push(...buckets.__start__.before, ...buckets.__start__.after)
  for (const slot of builtin) {
    const slotBucket =
      (buckets as Record<string, Record<CustomNavPosition, T[]>>)[slot.key]
    if (slotBucket) out.push(...slotBucket.before)
    out.push(slot.link)
    if (slotBucket) out.push(...slotBucket.after)
  }
  out.push(...buckets.__end__.before, ...buckets.__end__.after)
  return out
}
