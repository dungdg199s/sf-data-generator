// Guards the design-token system of docs/ui-design-system.md (design doc 0008):
// raw colours live only in the primitive block of client/css/app.css (client/js, shared and index.html set
// none), every step type has its
// tokens, icon and [data-type] rule in both themes, and the semantic colour pairs keep WCAG AA
// contrast when computed from the actual CSS values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NODE_TYPES } from '../server/workflow/nodes.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const CSS = read('client/css/app.css');
const MARKER = '/* ===== end tokens ===== */';
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const [TOKENS_RAW, COMPONENTS_RAW] = CSS.split(MARKER);
const TOKENS = stripComments(TOKENS_RAW);
const COMPONENTS = stripComments(COMPONENTS_RAW ?? '');

// Step types the UI draws: the server's types (Query / Chọn bản ghi of design doc 0006 included)
// and the synthetic Start card.
const TYPES = [...new Set(['start', ...NODE_TYPES.map((t) => t.type), 'query', 'pick'])];

const PRIMITIVE = /^--(?:gray|blue|red|amber|green|teal|cyan|olive|violet|magenta)-\d+$/;
const HEX = /#[0-9a-fA-F]{3,8}(?![\w-])/;
const FUNC = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const NAMED = /(?<![\w-])(?:white|black|red|green|blue|gray|grey|silver|orange|yellow|purple|pink|brown|navy|teal|olive|maroon|lime|aqua|cyan|magenta|fuchsia|gold|indigo|violet|beige|crimson|tomato|coral|salmon)(?![\w-])/i;

/** All `prop: value` declarations of a CSS text (no nesting needed: @media bodies are plain rules). */
function declarations(css) {
  const out = [];
  const re = /([-\w]+)\s*:\s*([^;{}]+)(?=;|})/g;
  for (let m; (m = re.exec(css));) out.push({ prop: m[1], value: m[2].trim() });
  return out;
}

/** Rule bodies whose selector matches `selector` exactly, with @media context. */
function blocks(css, selector) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m; (m = re.exec(css));) if (m[1].trim() === selector) out.push(Object.fromEntries(declarations(m[2]).map((d) => [d.prop, d.value])));
  return out;
}

test('app.css has the end-of-tokens marker exactly once', () => {
  assert.equal(CSS.split(MARKER).length, 2);
});

test('no colour literals after the token block of app.css', () => {
  for (const { prop, value } of declarations(COMPONENTS)) {
    const where = `${prop}: ${value}`;
    assert.ok(!HEX.test(value), `hex colour in components: ${where}`);
    assert.ok(!FUNC.test(value), `colour function in components: ${where}`);
    if (!prop.startsWith('--') && !/^(?:content|font-family|grid-template-areas)$/.test(prop)) {
      assert.ok(!NAMED.test(value), `named colour in components: ${where}`);
    }
  }
});

test('inside the token block only primitives, shadows, backdrop and icons hold raw colours', () => {
  const RAW_OK = /^--(?:shadow-\d|color-backdrop|ico-[\w-]+)$/;
  for (const { prop, value } of declarations(TOKENS)) {
    if (!(HEX.test(value) || FUNC.test(value))) continue;
    if (prop.startsWith('--ico-')) continue; // data: URIs of the mask icons
    assert.ok(PRIMITIVE.test(prop) || RAW_OK.test(prop), `raw colour outside the primitive block: ${prop}: ${value}`);
    if (PRIMITIVE.test(prop)) assert.match(value, /^#[0-9a-f]{6}$/, `${prop} should be a 6-digit lower-case hex`);
  }
});

const NAMED_WORDS = NAMED.source.match(/\(\?:([^)]+)\)\(\?!/)[1];
// A colour property in a JS style object / assignment / setProperty with a named colour value.
const STYLE_NAMED = new RegExp(
  String.raw`(?:\b(?:color|background(?:Color)?|border(?:Top|Right|Bottom|Left)?(?:Color)?|outline(?:Color)?|fill|stroke|accentColor|caretColor)\s*[:=]|setProperty\(\s*['"][\w-]+['"]\s*,)\s*['"\x60][^'"\x60]*(?<![\w-])(?:${NAMED_WORDS})(?![\w-])`,
  'i',
);

/** Colour problems in a client/shared JS source: [what, ...]. */
function jsColourIssues(src) {
  return [
    [/['"`]#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3}(?:[0-9a-fA-F]{2})?)?['"`]/, 'hex colour'],
    [FUNC, 'colour function'],
    [/var\(--(?:step|node|color|gray|blue|red|amber|green|teal|cyan|olive|violet|magenta)-/, 'colour token'],
    [/NODE_COLORS/, 'NODE_COLORS'],
    [/['"]--c['"]/, 'inline --c'],
    [STYLE_NAMED, 'named colour in a style'],
  ].filter(([re]) => re.test(src)).map(([, what]) => what);
}

test('the JS colour scanner catches each kind of colour literal', () => {
  for (const src of [
    "h('div', { style: { color: 'red' } })", "el.style.backgroundColor = 'white';", "el.style.setProperty('border-color', 'black')",
    "h('p', { style: { border: '1px solid tomato' } })", "const c = '#0b6bcb';", "x = 'rgb(1 2 3)'", "'var(--step-record)'",
  ]) assert.notDeepEqual(jsColourIssues(src), [], `not caught: ${src}`);
  for (const src of ["h('td', { style: { whiteSpace: 'normal' } })", "h('div', { class: 'red' })", "style: { width: '100%' }"]) {
    assert.deepEqual(jsColourIssues(src), [], `false positive: ${src}`);
  }
});

test('client and shared JS set no colours (step colours come from [data-type] in CSS)', () => {
  for (const sub of ['client/js/', 'shared/']) {
    const dir = new URL(`../${sub}`, import.meta.url);
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      assert.deepEqual(jsColourIssues(fs.readFileSync(new URL(f, dir), 'utf8')), [], `${sub}${f}`);
    }
  }
});

test('client/index.html has no inline styles or colour literals', () => {
  const html = read('client/index.html');
  assert.ok(!/<style[\s>]/i.test(html), '<style> block in index.html');
  assert.ok(!/\sstyle\s*=/i.test(html), 'style="" attribute in index.html');
  assert.ok(!/(?<![\w&-])#[0-9a-fA-F]{3,8}(?![\w-])/.test(html), 'hex colour in index.html');
  assert.ok(!FUNC.test(html), 'colour function in index.html');
  assert.ok(!/name=["']theme-color["']/i.test(html), 'meta theme-color with a hard-coded colour');
});

const LIGHT = blocks(TOKENS, ':root').find((b) => b['--color-bg']);
const DARK_MEDIA = blocks(TOKENS, ':root:not([data-theme="light"])').find((b) => b['--color-bg']);
const DARK_ATTR = blocks(TOKENS, ':root[data-theme="dark"]').find((b) => b['--color-bg']);

test('every prefers-color-scheme dark block is :root:not([data-theme="light"]) inside the media query', () => {
  // "Sáng" must win over a dark OS: the media block may only apply when data-theme is not "light".
  const sel = ':root:not([data-theme="light"])';
  const at = [];
  for (let i = TOKENS.indexOf(sel); i !== -1; i = TOKENS.indexOf(sel, i + 1)) at.push(i);
  assert.ok(at.length >= 2, 'expected the colour and the shadow dark blocks');
  const OPEN = /@media \(prefers-color-scheme: dark\) \{\s*$/;
  for (const i of at) assert.match(TOKENS.slice(0, i), OPEN, `${sel} at offset ${i} is not directly inside @media (prefers-color-scheme: dark)`);
  const first = TOKENS.slice(at[0]);
  assert.match(first, /^:root:not\(\[data-theme="light"\]\) \{[^}]*--color-bg:/, 'the first dark block must hold the colour tokens');
  const medias = TOKENS.match(/@media \(prefers-color-scheme: dark\) \{/g) ?? [];
  assert.equal(medias.length, at.length, 'a prefers-color-scheme: dark block without the :not([data-theme="light"]) guard');
});

test('light and dark themes define the same semantic tokens; both dark blocks are identical', () => {
  assert.ok(LIGHT && DARK_MEDIA && DARK_ATTR, 'missing a theme block');
  assert.deepEqual(Object.keys(DARK_MEDIA).sort(), Object.keys(LIGHT).sort());
  assert.deepEqual(DARK_ATTR, DARK_MEDIA, ':root[data-theme="dark"] must repeat the prefers-color-scheme block');
  const shadowMedia = blocks(TOKENS, ':root:not([data-theme="light"])').find((b) => b['--shadow-1']);
  const shadowAttr = blocks(TOKENS, ':root[data-theme="dark"]').find((b) => b['--shadow-1']);
  assert.deepEqual(shadowAttr, shadowMedia, 'dark shadows differ between the two dark blocks');
});

test('every step type has tokens in both themes, an icon and a [data-type] rule', () => {
  const allTokens = Object.fromEntries(declarations(TOKENS).map((d) => [d.prop, d.value]));
  for (const t of TYPES) {
    for (const suffix of ['', '-subtle', '-strong', '-text']) {
      const name = `--step-${t}${suffix}`;
      assert.ok(LIGHT[name], `${name} missing in the light theme`);
      assert.ok(DARK_MEDIA[name], `${name} missing in the dark theme`);
    }
    assert.match(allTokens[`--ico-${t}`] ?? '', /^url\("data:image\/svg\+xml,/, `--ico-${t} missing`);
    const rule = blocks(COMPONENTS, `[data-type="${t}"]`)[0];
    assert.ok(rule, `[data-type="${t}"] rule missing`);
    assert.equal(rule['--c'], `var(--step-${t})`);
    assert.equal(rule['--c-subtle'], `var(--step-${t}-subtle)`);
    assert.equal(rule['--c-strong'], `var(--step-${t}-strong)`);
    assert.equal(rule['--c-text'], `var(--step-${t}-text)`);
    assert.equal(rule['--ico'], `var(--ico-${t})`);
  }
  assert.ok(blocks(COMPONENTS, '[data-type]')[0]?.['--ico'], 'fallback [data-type] rule for unknown types missing');
});

test('the [data-type] fallback rule comes before every typed rule (equal specificity: source order decides)', () => {
  const fallback = COMPONENTS.search(/(?:^|\})\s*\[data-type\]\s*\{/);
  assert.ok(fallback !== -1, 'fallback [data-type] rule missing');
  for (const t of TYPES) {
    const typed = COMPONENTS.indexOf(`[data-type="${t}"]`);
    assert.ok(typed > fallback, `[data-type="${t}"] is before the fallback rule, so unknown-type colours would win`);
  }
});

test('coloured buttons keep their own fill when pressed (button:active would turn them grey)', () => {
  // `button:active:not(:disabled)` (0,2,1) beats `.step-card .badge` / `.toast-action`, so their hover rule must list :active too.
  const rules = [...COMPONENTS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sels: m[1].split(',').map((x) => x.trim()), body: m[2] }));
  for (const sel of ['.step-card .badge', '.start-card .badge', '.step-card .badge.warn', '.start-card .badge.warn', '.toast-action']) {
    const active = rules.find((r) => r.sels.includes(`${sel}:active:not(:disabled)`));
    assert.ok(active && /(?:^|;|\s)background\s*:/.test(active.body), `${sel}:active:not(:disabled) needs its own background`);
    const hover = rules.find((r) => r.sels.includes(`${sel}:hover:not(:disabled)`));
    assert.equal(active, hover, `${sel}: :hover and :active should share one rule`);
  }
});

test('spacing (padding, margin, gap, outline-offset) uses the 4 px scale tokens', () => {
  // Exempt, on purpose: the .sr-only idiom `margin: -1px`; the device's safe area (`env(safe-area-inset-*)`,
  // the select bar of 0012 B above a phone's home indicator) is not a spacing choice.
  const EXEMPT = new Set(['margin: -1px']);
  const PART = /^(?:0|auto|var\(--(?:space-[\d-]+|focus-offset(?:-card)?|canvas-tail)\)|calc\(-1 \* var\(--space-[\d-]+\)\)|env\(safe-area-inset-(?:top|right|bottom|left)\))$/;
  for (const { prop, value } of declarations(COMPONENTS)) {
    if (!/^(?:(?:padding|margin)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?|gap|row-gap|column-gap|outline-offset)$/.test(prop)) continue;
    const where = `${prop}: ${value}`;
    if (EXEMPT.has(where)) continue;
    const parts = value.match(/calc\([^)]*\)\)|var\([^)]*\)|\S+/g);
    for (const part of parts) assert.match(part, PART, `off-scale spacing: ${where}`);
  }
  const scale = Object.fromEntries(declarations(TOKENS).filter((d) => /^--space-/.test(d.prop)).map((d) => [d.prop, d.value]));
  for (const [name, v] of Object.entries(scale)) {
    const px = Number(/^(\d+)px$/.exec(v)?.[1]);
    assert.ok(px === 2 || px % 4 === 0, `${name}: ${v} is not on the 4 px scale (2 px is the only half step)`);
  }
});

test('components use the type, radius, z-index and font tokens', () => {
  for (const { prop, value } of declarations(COMPONENTS)) {
    const where = `${prop}: ${value}`;
    if (prop === 'font-size') assert.match(value, /^var\(--text-(?:xs|sm|md|lg|xl)\)$/, where);
    if (prop === 'font-family') assert.match(value, /^var\(--font-(?:sans|mono)\)$/, where);
    if (prop === 'font-weight') assert.match(value, /^var\(--weight-(?:regular|medium|semibold)\)$/, where);
    if (prop === 'z-index') assert.ok(/^var\(--z-\w+\)$/.test(value) || Number(value) <= 1, where);
    if (/^border(?:-\w+)*-radius$/.test(prop)) {
      for (const part of value.split(/\s+/)) assert.match(part, /^(?:var\(--radius-(?:sm|md|lg|xl|pill)\)|0|50%)$/, where);
    }
    if (prop === 'box-shadow' && value !== 'none') assert.match(value, /var\(--/, where);
  }
});

test('docs/ui-design-system.md primitive table matches the CSS primitives 1:1', () => {
  const doc = read('docs/ui-design-system.md');
  const section = doc.slice(doc.indexOf('## 2. Token primitive'), doc.indexOf('## 3.'));
  const fromDoc = {};
  for (const line of section.split('\n')) {
    const m = /^\| (\w+)(?: \([^)]*\))? \| (.+) \|$/.exec(line);
    if (!m || m[1] === 'Họ') continue;
    for (const [, step, hex] of m[2].matchAll(/(\d+) `(#[0-9a-f]{6})`/g)) fromDoc[`--${m[1]}-${step}`] = hex;
  }
  const fromCss = Object.fromEntries(declarations(TOKENS).filter((d) => PRIMITIVE.test(d.prop)).map((d) => [d.prop, d.value]));
  assert.deepEqual(fromCss, fromDoc);
});

// ---------- contrast, computed from the CSS values ----------

const PRIMS = Object.fromEntries(declarations(TOKENS).filter((d) => PRIMITIVE.test(d.prop)).map((d) => [d.prop, d.value]));
const parseHex = (hx) => [1, 3, 5].map((i) => parseInt(hx.slice(i, i + 2), 16) / 255);
const toHex = (rgb) => `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;

/** Resolves a token to a hex colour: var() chains and `color-mix(in srgb, A p%, B)`. */
function resolve(value, theme, depth = 0) {
  assert.ok(depth < 20, `var() cycle at ${value}`);
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  let m = /^var\((--[\w-]+)\)$/.exec(v);
  if (m) {
    const next = theme[m[1]] ?? PRIMS[m[1]];
    assert.ok(next, `unknown token ${m[1]}`);
    return resolve(next, theme, depth + 1);
  }
  m = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/.exec(v);
  if (m) {
    const a = parseHex(resolve(m[1], theme, depth + 1));
    const b = parseHex(resolve(m[3], theme, depth + 1));
    const p = Number(m[2]) / 100;
    return toHex(a.map((x, i) => x * p + b[i] * (1 - p)));
  }
  throw new Error(`cannot resolve ${v}`);
}
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hx) => { const [r, g, b] = parseHex(hx).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// docs/ui-design-system.md §8.1: [foreground, background, minimum].
const PAIRS = [
  ['text', 'bg', 4.5], ['text-muted', 'bg', 4.5], ['text', 'surface', 4.5], ['text-muted', 'surface', 4.5],
  ['text', 'surface-raised', 4.5], ['text-muted', 'surface-raised', 4.5], ['text-muted', 'surface-sunken', 4.5],
  ['text-muted', 'surface-hover', 4.5], ['text', 'accent-subtle', 4.5], ['text-muted', 'accent-subtle', 4.5],
  ['accent-contrast', 'accent', 4.5], ['accent-contrast', 'accent-hover', 4.5], ['accent-text', 'surface', 4.5],
  ['accent-text', 'accent-subtle', 4.5], ['accent', 'surface', 3], ['accent', 'bg', 3], ['accent', 'accent-subtle', 3],
  ['focus-ring', 'surface', 3], ['focus-ring', 'bg', 3], ['focus-ring', 'accent-subtle', 3],
  ['focus-ring-inverse', 'inverse-bg', 3],
  ['danger-contrast', 'danger', 4.5], ['danger-text', 'surface', 4.5], ['danger-text', 'danger-subtle', 4.5],
  ['text', 'danger-subtle', 4.5], ['danger', 'surface', 3], ['danger', 'bg', 3],
  ['warning-contrast', 'warning-fill', 4.5], ['warning-text', 'surface', 4.5], ['warning-text', 'warning-subtle', 4.5],
  ['text', 'warning-subtle', 4.5], ['warning', 'surface', 3],
  ['success-text', 'surface', 4.5], ['success-contrast', 'success', 4.5],
  ['border-control', 'surface', 3], ['border-control', 'surface-raised', 3], ['border-control', 'surface-sunken', 3],
  ['text-muted', 'bg-disabled', 4.5], ['inverse-text', 'inverse-bg', 4.5],
].map(([f, b, min]) => [`--color-${f}`, `--color-${b}`, min]);
for (const t of TYPES) {
  PAIRS.push(
    [`--step-${t}`, '--color-surface-raised', 3], [`--step-${t}`, `--step-${t}-subtle`, 3],
    [`--step-${t}-text`, '--color-surface', 4.5], [`--step-${t}-text`, `--step-${t}-subtle`, 4.5],
    ['--color-text', `--step-${t}-subtle`, 4.5], ['--color-text-muted', `--step-${t}-subtle`, 4.5],
  );
}

/** Contrast of every documented pair in both themes: [{ theme, fg, bg, min, ratio }]. */
export function contrastReport() {
  const themes = { light: LIGHT, dark: { ...LIGHT, ...DARK_MEDIA } };
  return Object.entries(themes).flatMap(([name, theme]) =>
    PAIRS.map(([fg, bg, min]) => ({ theme: name, fg, bg, min, ratio: contrast(resolve(theme[fg], theme), resolve(theme[bg], theme)) })));
}

test('documented colour pairs meet WCAG 2.2 AA in both themes (computed from app.css)', () => {
  const failing = contrastReport().filter((r) => r.ratio < r.min).map((r) => `${r.theme}: ${r.fg} on ${r.bg} = ${r.ratio.toFixed(2)} (< ${r.min})`);
  assert.deepEqual(failing, []);
});

test('layout tokens of design 0009 are defined and documented in docs/ui-design-system.md', () => {
  const all = Object.fromEntries(declarations(TOKENS).map((d) => [d.prop, d.value]));
  assert.equal(all['--canvas-tail'], '64px');
  assert.equal(all['--issues-max-h'], 'min(124px, 25vh)');
  assert.equal(all['--sheet-h'], 'min(60dvh, calc(100dvh - 200px))');
  assert.match(all['--ico-theme'] ?? '', /^url\("data:image\/svg\+xml,/);
  const doc = read('docs/ui-design-system.md');
  for (const t of ['--canvas-tail', '--issues-max-h', '--sheet-h']) assert.ok(doc.includes(`\`${t}\``), `${t} missing from the scale table`);
  assert.match(doc, /\| `theme` \|/, 'the theme icon is missing from the icon table');
});
