import { opt } from './common.js';

export const checkbox = {
  type: 'checkbox',
  label: 'Checkbox',
  category: 'Choice',
  valueType: 'boolean',
  sfTypes: ['boolean'],
  nullable: false, // Salesforce checkboxes are never null.
  options: [opt('trueProbability', 'Xác suất true (0–1)', 'number', 0.5, { min: 0, max: 1, step: 0.05 })],
  generate(o, { rng }) {
    return rng.bool(o.trueProbability);
  },
};

export const picklist = {
  type: 'picklist',
  label: 'Picklist',
  category: 'Choice',
  sfTypes: ['picklist'],
  options: [
    opt('values', 'Giá trị', 'list', ['Option A', 'Option B', 'Option C'], { help: 'Mỗi dòng một giá trị (API name).' }),
    opt('weights', 'Trọng số', 'numberList', [], {
      help: 'Không bắt buộc. Cùng thứ tự với giá trị, ví dụ 70, 20, 10.',
    }),
  ],
  generate(o, { rng }) {
    return o.values.length ? rng.weighted(o.values, o.weights) : null;
  },
};

export const multipicklist = {
  type: 'multipicklist',
  label: 'Picklist (Multi-Select)',
  category: 'Choice',
  sfTypes: ['multipicklist'],
  options: [
    opt('values', 'Giá trị', 'list', ['Option A', 'Option B', 'Option C'], { help: 'Mỗi dòng một giá trị (API name).' }),
    opt('minSelected', 'Chọn tối thiểu', 'integer', 1, { min: 0 }),
    opt('maxSelected', 'Chọn tối đa', 'integer', 2, { min: 1 }),
  ],
  generate(o, { rng }) {
    if (!o.values.length) return null;
    const k = rng.int(Math.min(o.minSelected, o.values.length), Math.min(o.maxSelected, o.values.length));
    const picked = rng.sample(o.values, k);
    return picked.length ? picked.join(';') : null;
  },
};
