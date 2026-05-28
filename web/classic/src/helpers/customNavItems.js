/*
Copyright (C) 2025 QuantumNous

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
 * Custom top-navigation items — schema, parser and weave-into-builtin helper
 * for the classic UI. Mirrors web/default/src/.../lib/custom-nav-items.ts
 * and merge-nav.ts so the same configuration drives both themes.
 *
 * Each custom item is anchored to a built-in slot (home / console / pricing /
 * docs / about) or one of the __start__ / __end__ sentinels, and `position`
 * controls whether it lands before or after that anchor.
 *
 * @typedef {'__start__'|'__end__'|'home'|'console'|'pricing'|'rankings'|'docs'|'about'} CustomNavAnchor
 * @typedef {'before'|'after'} CustomNavPosition
 * @typedef {Object} CustomNavItem
 * @property {string}            id
 * @property {string}            title
 * @property {string}            url
 * @property {'self'|'blank'}    target
 * @property {string}            icon
 * @property {boolean}           requireAuth
 * @property {boolean}           enabled
 * @property {CustomNavAnchor}   anchor
 * @property {CustomNavPosition} position
 * @property {number}            order
 */

export const BUILTIN_NAV_KEYS = [
  'home',
  'console',
  'pricing',
  'rankings',
  'docs',
  'about',
];

export const CUSTOM_NAV_ANCHORS = ['__start__', ...BUILTIN_NAV_KEYS, '__end__'];

export const CUSTOM_NAV_ITEMS_MAX = 20;

const isAnchor = (v) => typeof v === 'string' && CUSTOM_NAV_ANCHORS.includes(v);
const isPosition = (v) => v === 'before' || v === 'after';
const asString = (v, fb = '') => (typeof v === 'string' ? v : fb);
const asBoolean = (v, fb = false) => (typeof v === 'boolean' ? v : fb);
const asNumber = (v, fb = 0) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return fb;
};

/**
 * Parse the raw value stored in OptionMap["CustomNavItems"].
 * Returns [] for empty / malformed input; skips invalid individual rows.
 * @param {unknown} value
 * @returns {CustomNavItem[]}
 */
export function parseCustomNavItems(value) {
  if (value == null) return [];
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  parsed.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const url = asString(entry.url).trim();
    if (!url) return;
    out.push({
      id: asString(entry.id, `nav-${index}`),
      title: asString(entry.title, url),
      url,
      target: entry.target === 'blank' ? 'blank' : 'self',
      icon: asString(entry.icon, ''),
      requireAuth: asBoolean(entry.requireAuth, false),
      enabled: asBoolean(entry.enabled, true),
      anchor: isAnchor(entry.anchor) ? entry.anchor : '__end__',
      position: isPosition(entry.position) ? entry.position : 'after',
      order: asNumber(entry.order, 0),
    });
  });
  return out;
}

export function serializeCustomNavItems(items) {
  return JSON.stringify(items);
}

/**
 * Convert a custom item into a classic-UI nav link descriptor.
 * Matches the shape Navigation.jsx already consumes for built-in items.
 */
const customToLink = (item) => {
  const isExternalUrl = /^https?:\/\//i.test(item.url);
  const external = item.target === 'blank' || isExternalUrl;
  return {
    itemKey: `custom-${item.id}`,
    text: item.title,
    icon: item.icon,
    isCustom: true,
    ...(external
      ? { isExternal: true, externalLink: item.url }
      : { to: item.url }),
  };
};

/**
 * Weave custom items into the built-in nav sequence.
 *
 * @param {Array<{itemKey: string} & object>} builtin   In canonical render order.
 * @param {CustomNavItem[]}                  custom    Already filtered (enabled + auth).
 * @returns {Array} Final nav links in render order.
 */
export function mergeNavLinks(builtin, custom) {
  const buckets = {
    __start__: { before: [], after: [] },
    __end__: { before: [], after: [] },
  };
  BUILTIN_NAV_KEYS.forEach((k) => {
    buckets[k] = { before: [], after: [] };
  });

  const sorted = [...custom].sort((a, b) => a.order - b.order);
  sorted.forEach((item) => {
    const bucket = buckets[item.anchor] || buckets.__end__;
    bucket[item.position].push(customToLink(item));
  });

  const out = [];
  out.push(...buckets.__start__.before, ...buckets.__start__.after);
  builtin.forEach((link) => {
    const slot = buckets[link.itemKey];
    if (slot) out.push(...slot.before);
    out.push(link);
    if (slot) out.push(...slot.after);
  });
  out.push(...buckets.__end__.before, ...buckets.__end__.after);
  return out;
}
