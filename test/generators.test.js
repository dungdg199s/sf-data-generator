import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateValue, listGenerators, describeGenerators, VALUE_TYPES } from '../server/generators/index.js';
import { createRandom } from '../server/random.js';
import { parseBound } from '../server/generators/date.js';
import { NOW } from './helpers.js';

function gen(type, options = {}, extra = {}) {
  return generateValue(
    { name: 'F', type, options },
    { rng: createRandom(1), now: NOW, scope: { current: {}, all: {}, vars: {} }, record: {}, fieldName: 'F', fieldState: {}, ...extra },
  );
}

test('every generator produces a value with default options', () => {
  for (const g of listGenerators()) {
    if (['lookup', 'masterdetail'].includes(g.type)) continue;
    assert.doesNotThrow(() => gen(g.type), g.type);
  }
});

test('describeGenerators adds nullRatio except for non-nullable types', () => {
  const byType = Object.fromEntries(describeGenerators().map((g) => [g.type, g]));
  assert.ok(byType.text.options.some((o) => o.key === 'nullRatio'));
  assert.ok(!byType.checkbox.options.some((o) => o.key === 'nullRatio'));
  assert.ok(byType.email.options.find((o) => o.key === 'unique').default);
});

test('same seed gives same values', () => {
  assert.equal(gen('text', { mode: 'company' }), gen('text', { mode: 'company' }));
});

test('text respects maxLength and pattern', () => {
  assert.equal(gen('text', { mode: 'words', minWords: 20, maxWords: 20, maxLength: 10 }).length, 10);
  assert.match(gen('text', { mode: 'pattern', pattern: 'INV-####-??' }), /^INV-\d{4}-[A-Z]{2}$/);
});

test('number honours min/max/scale', () => {
  const rng = createRandom(7);
  for (let i = 0; i < 200; i++) {
    const v = generateValue({ name: 'N', type: 'currency', options: { min: 10, max: 20, scale: 2 } }, { rng, fieldState: {} });
    assert.ok(v >= 10 && v <= 20);
    assert.equal(Math.round(v * 100) / 100, v);
  }
});

test('nullRatio 1 always yields null, checkbox never null', () => {
  assert.equal(gen('text', { nullRatio: 1 }), null);
  assert.equal(typeof gen('checkbox', { nullRatio: 1 }), 'boolean');
});

test('picklist weights and multipicklist format', () => {
  assert.equal(gen('picklist', { values: ['A', 'B'], weights: [1, 0] }), 'A');
  const mp = gen('multipicklist', { values: 'A\nB\nC', minSelected: 2, maxSelected: 2 });
  assert.equal(mp.split(';').length, 2);
});

test('unique exhausts with a clear error', () => {
  const fieldState = {};
  const rng = createRandom(3);
  const tfield = { name: 'T', type: 'text', options: { mode: 'list', values: ['A', 'B'], unique: true } };
  generateValue(tfield, { rng, fieldState });
  generateValue(tfield, { rng, fieldState });
  assert.throws(() => generateValue(tfield, { rng, fieldState }), /duy nhất/);
});

test('date bounds: relative and absolute', () => {
  assert.equal(new Date(parseBound('-1y', NOW)).toISOString().slice(0, 10), '2024-06-15');
  assert.equal(new Date(parseBound('+30d', NOW)).toISOString().slice(0, 10), '2025-07-15');
  const d = gen('date', { from: '2024-01-01', to: '2024-01-31' });
  assert.match(d, /^2024-01-\d{2}$/);
  assert.match(gen('time', { from: '09:00', to: '09:00' }), /^09:00:00\.000Z$/);
});

test('email from record names strips diacritics', () => {
  const v = gen('email', { mode: 'fromName', domains: ['x.test'] }, { record: { FirstName: 'Dũng', LastName: 'Nguyễn' } });
  assert.match(v, /^dung\.nguyen\d*@x\.test$/);
});

test('autonumber counts per field state', () => {
  const fieldState = {};
  const ctx = { rng: createRandom(1), fieldState };
  const f = { name: 'A', type: 'autonumber', options: { displayFormat: 'INV-{000}', startingNumber: 5 } };
  assert.equal(generateValue(f, ctx), 'INV-005');
  assert.equal(generateValue(f, ctx), 'INV-006');
});

test('every generator declares a known valueType', () => {
  const known = new Set(VALUE_TYPES.map((v) => v.value));
  for (const g of describeGenerators()) assert.ok(known.has(g.valueType), `${g.type}: ${g.valueType}`);
  const byType = Object.fromEntries(describeGenerators().map((g) => [g.type, g.valueType]));
  assert.deepEqual([byType.number, byType.checkbox, byType.date, byType.lookup, byType.geolocation, byType.text], ['number', 'boolean', 'date', 'reference', 'object', 'string']);
});

test('template default {{this.$n}} gives the record number', () => {
  assert.equal(gen('template', {}, { n: 7 }), '7');
  assert.equal(gen('template', { template: 'x{{ this.$n }}y' }, { n: 2 }), 'x2y');
});
