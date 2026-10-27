import { opt } from './common.js';

const DAY = 86400000;

/**
 * Accepts absolute ('2024-01-31', '2024-01-31T10:00:00Z') or relative bounds:
 * 'today' / 'now', or an offset like '-1y', '+30d', '-6m', '+2w', '-12h'.
 * `now` is passed in so a whole run uses one clock (and tests can pin it).
 */
export function parseBound(value, now) {
  if (value instanceof Date) return value.getTime();
  const s = String(value ?? '').trim();
  if (!s || s === 'today' || s === 'now') return now;
  const rel = /^([+-]?\d+)\s*([hdwmy])$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    if (unit === 'h') return now + n * 3600000;
    if (unit === 'd') return now + n * DAY;
    if (unit === 'w') return now + n * 7 * DAY;
    const d = new Date(now);
    if (unit === 'm') d.setUTCMonth(d.getUTCMonth() + n);
    else d.setUTCFullYear(d.getUTCFullYear() + n);
    return d.getTime();
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`Không hiểu mốc thời gian "${s}". Dùng YYYY-MM-DD hoặc dạng -1y, +30d.`);
  return t;
}

function between(o, { rng, now }) {
  const a = parseBound(o.from, now);
  const b = parseBound(o.to, now);
  return rng.int(Math.min(a, b), Math.max(a, b));
}

const RANGE_HELP = 'YYYY-MM-DD hoặc tương đối: today, -1y, +30d, -6m, +2w.';

export const date = {
  type: 'date',
  label: 'Date',
  category: 'Date/Time',
  sfTypes: ['date'],
  options: [
    opt('from', 'Từ', 'string', '-1y', { help: RANGE_HELP }),
    opt('to', 'Đến', 'string', 'today', { help: RANGE_HELP }),
  ],
  generate(o, ctx) {
    return new Date(between(o, ctx)).toISOString().slice(0, 10);
  },
};

export const datetime = {
  type: 'datetime',
  label: 'Date/Time',
  category: 'Date/Time',
  sfTypes: ['datetime'],
  options: [
    opt('from', 'Từ', 'string', '-1y', { help: RANGE_HELP }),
    opt('to', 'Đến', 'string', 'now', { help: RANGE_HELP }),
  ],
  generate(o, ctx) {
    const t = between(o, ctx);
    return new Date(t - (t % 1000)).toISOString();
  },
};

export const time = {
  type: 'time',
  label: 'Time',
  category: 'Date/Time',
  sfTypes: ['time'],
  options: [
    opt('from', 'Từ (HH:MM)', 'time', '08:00'),
    opt('to', 'Đến (HH:MM)', 'time', '18:00'),
    opt('stepMinutes', 'Bước (phút)', 'integer', 15, { min: 1, max: 720 }),
  ],
  generate(o, { rng }) {
    const toMin = (s) => {
      const [h, m] = String(s).split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const a = toMin(o.from);
    const b = toMin(o.to);
    const step = Math.max(1, o.stepMinutes);
    const steps = Math.floor(Math.abs(b - a) / step);
    const minutes = Math.min(a, b) + rng.int(0, steps) * step;
    const hh = String(Math.floor(minutes / 60) % 24).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
    // Salesforce REST format for Time fields.
    return `${hh}:${mm}:00.000Z`;
  },
};
