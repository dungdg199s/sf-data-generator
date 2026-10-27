import { opt, roundTo } from './common.js';

function numeric(o, rng) {
  const lo = Math.min(o.min, o.max);
  const hi = Math.max(o.min, o.max);
  if (o.scale <= 0) return rng.int(lo, hi);
  return roundTo(rng.float(lo, hi), o.scale);
}

function makeNumeric({ type, label, sfTypes, min, max, scale, extra = [] }) {
  return {
    type,
    label,
    category: 'Number',
    sfTypes,
    uniqueable: true,
    options: [
      opt('min', 'Nhỏ nhất', 'number', min),
      opt('max', 'Lớn nhất', 'number', max),
      opt('scale', 'Số chữ số thập phân', 'integer', scale, { min: 0, max: 17 }),
      ...extra,
    ],
    generate(o, { rng }) {
      return numeric(o, rng);
    },
  };
}

export const number = makeNumeric({ type: 'number', label: 'Number', sfTypes: ['int', 'double', 'long'], min: 0, max: 1000, scale: 0 });
export const currency = makeNumeric({ type: 'currency', label: 'Currency', sfTypes: ['currency'], min: 0, max: 100000, scale: 2 });
export const percent = makeNumeric({ type: 'percent', label: 'Percent', sfTypes: ['percent'], min: 0, max: 100, scale: 2 });
