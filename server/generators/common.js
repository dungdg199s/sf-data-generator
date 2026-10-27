// Shared option definitions and helpers for field-type generators.
//
// Option definition shape (served to the UI via /api/meta, which renders forms from it):
//   { key, label, kind, default?, min?, max?, step?, choices?, help?, showIf? }
// kind: 'string' | 'text' | 'integer' | 'number' | 'boolean' | 'select' | 'list' | 'numberList' | 'date' | 'datetime' | 'time' | 'ref'
// showIf: { key: otherOptionKey, in: [values] } — UI hides the option unless the condition holds.

import { firstNames, lastNames, companyPrefixes, companySuffixes, words, cities } from '../data/pools.js';

export const nullRatioOption = {
  key: 'nullRatio',
  label: 'Tỉ lệ để trống (0–1)',
  kind: 'number',
  default: 0,
  min: 0,
  max: 1,
  step: 0.05,
  help: '0 = luôn có giá trị, 0.2 = khoảng 20% bản ghi để trống.',
};

export const uniqueOption = {
  key: 'unique',
  label: 'Giá trị duy nhất',
  kind: 'boolean',
  default: false,
  help: 'Không lặp lại trong cùng một lần chạy.',
};

export function opt(key, label, kind, def, extra = {}) {
  return { key, label, kind, default: def, ...extra };
}

/** Merge user options over generator defaults, coercing by kind. */
export function resolveOptions(generator, userOptions = {}) {
  const out = {};
  for (const def of allOptions(generator)) {
    const raw = userOptions[def.key];
    out[def.key] = raw === undefined || raw === '' || raw === null ? def.default : coerce(def, raw);
  }
  return out;
}

export function allOptions(generator) {
  const list = [...generator.options];
  if (generator.nullable !== false) list.push(nullRatioOption);
  if (generator.uniqueable) list.push({ ...uniqueOption, default: generator.uniqueDefault ?? false });
  return list;
}

function coerce(def, raw) {
  switch (def.kind) {
    case 'integer':
      return Math.trunc(Number(raw));
    case 'number':
      return Number(raw);
    case 'boolean':
      return raw === true || raw === 'true';
    case 'list':
      return toList(raw);
    case 'numberList':
      return toList(raw).map(Number);
    default:
      return raw;
  }
}

export function toList(raw) {
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  return String(raw)
    .split(/[\n,;]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export function truncate(value, maxLength) {
  if (typeof value !== 'string' || !maxLength || value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}

export function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function sentence(rng, minWords = 4, maxWords = 12) {
  const n = rng.int(minWords, maxWords);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(rng.pick(words));
  return capitalize(parts.join(' ')) + '.';
}

export function paragraph(rng, minSentences = 2, maxSentences = 5) {
  const n = rng.int(minSentences, maxSentences);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(sentence(rng));
  return parts.join(' ');
}

export function companyName(rng) {
  return `${rng.pick(companyPrefixes)} ${rng.pick(companySuffixes)}`;
}

export function personName(rng) {
  return `${rng.pick(firstNames)} ${rng.pick(lastNames)}`;
}

export function cityName(rng) {
  return rng.pick(cities);
}

/** Pattern tokens: # digit, ? uppercase letter, * alphanumeric, anything else literal. \ escapes. */
export function fromPattern(rng, pattern) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const alnum = letters + '0123456789';
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) out += pattern[++i];
    else if (ch === '#') out += rng.int(0, 9);
    else if (ch === '?') out += letters[rng.int(0, 25)];
    else if (ch === '*') out += alnum[rng.int(0, alnum.length - 1)];
    else out += ch;
  }
  return out;
}

/** Strip diacritics and non-alphanumerics, for building emails/usernames from names. */
export function slug(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toLowerCase();
}

export function roundTo(value, scale) {
  const f = 10 ** scale;
  return Math.round(value * f) / f;
}
