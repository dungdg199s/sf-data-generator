import { opt, roundTo } from './common.js';
import { resolvePath } from '../workflow/paths.js';

export const geolocation = {
  type: 'geolocation',
  label: 'Geolocation',
  category: 'Other',
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
    opt('template', 'Mẫu', 'string', '{{this.LastName}} - {{loop.index}}', {
      help: '{{this.Field}} = field đã sinh trong node này, {{alias.Field}} = node trước, {{loop.index}} = vòng lặp hiện tại (bắt đầu từ 1).',
    }),
  ],
  generate(o, { scope, record }) {
    return o.template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
      const v = resolvePath(path, scope, record);
      if (v === undefined || v === null) return '';
      if (typeof v === 'object' && v.$ref) return v.$ref;
      return String(v);
    });
  },
};

export const constant = {
  type: 'constant',
  label: 'Giá trị cố định',
  category: 'Other',
  sfTypes: [],
  options: [opt('value', 'Giá trị', 'string', '')],
  generate(o) {
    return o.value;
  },
};
