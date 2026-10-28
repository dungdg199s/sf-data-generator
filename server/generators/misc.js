import { opt, roundTo } from './common.js';
import { resolvePath, renderTemplate } from '../workflow/paths.js';

export const geolocation = {
  type: 'geolocation',
  label: 'Geolocation',
  category: 'Other',
  valueType: 'object',
  members: [
    { key: 'latitude', valueType: 'number', label: 'Vĩ độ' },
    { key: 'longitude', valueType: 'number', label: 'Kinh độ' },
  ],
  sfTypes: ['location'],
  options: [
    opt('latMin', 'Vĩ độ nhỏ nhất', 'number', -90, { min: -90, max: 90 }),
    opt('latMax', 'Vĩ độ lớn nhất', 'number', 90, { min: -90, max: 90 }),
    opt('lngMin', 'Kinh độ nhỏ nhất', 'number', -180, { min: -180, max: 180 }),
    opt('lngMax', 'Kinh độ lớn nhất', 'number', 180, { min: -180, max: 180 }),
    opt('scale', 'Số chữ số thập phân', 'integer', 6, { min: 0, max: 15 }),
  ],
  // Compound value; server/sf/insert.js splits it into <Name>__Latitude__s / __Longitude__s.
  generate(o, { rng }) {
    return {
      latitude: roundTo(rng.float(o.latMin, o.latMax), o.scale),
      longitude: roundTo(rng.float(o.lngMin, o.lngMax), o.scale),
    };
  },
};

export const template = {
  type: 'template',
  label: 'Template (ghép giá trị)',
  category: 'Other',
  sfTypes: [],
  uniqueable: true,
  options: [
    opt('template', 'Mẫu', 'string', '{{this.$n}}', {
      vars: 'template',
      help: 'Bấm {x} hoặc gõ {{ để chèn biến. Ví dụ {{this.FirstName}}, {{acc.Name}}, {{loop.index}}, {{this.$n}}.',
    }),
  ],
  generate(o, { scope, record, n }) {
    return renderTemplate(o.template, scope, record, { n });
  },
};

// Copies a variable with its type kept (design 0006/0007: `{{pbe.UnitPrice}}` through a
// Template is a string; OpportunityLineItem.UnitPrice needs the number).
export const copy = {
  type: 'copy',
  label: 'Lấy từ biến (giữ kiểu)',
  category: 'Other',
  valueType: 'any',
  sfTypes: [],
  options: [
    opt('path', 'Biến', 'string', 'this.$n', {
      vars: 'path',
      help: 'Bấm {x} để chọn, ví dụ pbe.UnitPrice. Giữ nguyên kiểu số / đúng-sai (Template luôn ra chuỗi).',
    }),
  ],
  generate(o, { scope, record, n, fieldName }) {
    const v = resolvePath(o.path, scope, record, { n });
    // A Lookup value ({ $ref }) is copied as a Lookup; any other object (a relationship of a Query
    // row, a geolocation) is not one value Salesforce accepts.
    if (v && typeof v === 'object' && typeof v.$ref !== 'string') {
      throw new Error(`Field ${fieldName}: biến "${o.path}" là cả một đối tượng, không phải một giá trị. Chọn một field con, ví dụ ${o.path}.Name.`);
    }
    return v === undefined ? null : v;
  },
};

export const constant = {
  type: 'constant',
  label: 'Giá trị cố định',
  category: 'Other',
  sfTypes: [],
  options: [opt('value', 'Giá trị', 'string', '', { help: 'Luôn đúng giá trị này. Muốn ghép biến? Đổi kiểu sang Template.' })],
  generate(o) {
    return o.value;
  },
};
