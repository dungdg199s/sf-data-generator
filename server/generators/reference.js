import { opt } from './common.js';

// Lookup values are emitted as { $ref: 'alias#n' } placeholders. They are resolved to real
// record Ids at insert time (server/sf/insert.js) once the parent record exists in the org.
// A record read from the org (Query pool, or picked from one: `existing`, design 0006) gives its
// real Id as a plain string, which insert.js sends as is.
// A Record pool may be count-only ({ kind: 'generated', length, refAt }, server/workflow/executor.js).
// mode 'fixed' picks from existing org Ids the user pastes in, so no placeholder is needed.

const MODES = [
  { value: 'current', label: 'Bản ghi hiện tại của alias' },
  { value: 'random', label: 'Ngẫu nhiên trong pool (đã sinh hoặc đọc từ org)' },
  { value: 'fixed', label: 'Id nhập tay' },
];

function makeReference(type, label, nullable) {
  return {
    type,
    label,
    category: 'Relationship',
    valueType: 'reference',
    sfTypes: type === 'lookup' ? ['reference'] : [],
    nullable,
    options: [
      opt('mode', 'Lấy từ', 'select', 'current', { choices: MODES }),
      opt('ref', 'Bản ghi cha / pool (alias)', 'ref', '', {
        showIf: { key: 'mode', in: ['current', 'random'] },
        help: 'Alias của bước Record, Query hoặc Chọn bản ghi ở phía trên. Bản ghi đọc từ org cho ra Id thật.',
      }),
      opt('ids', 'Danh sách Id', 'list', [], { showIf: { key: 'mode', in: ['fixed'] }, help: 'Mỗi dòng một Id 15/18 ký tự.' }),
      opt('referenceTo', 'Trỏ tới sObject', 'list', [], {
        showIf: { key: 'mode', in: ['current', 'random'] },
        help: 'Điền sẵn khi Import từ org. Danh sách Bản ghi cha chỉ gợi ý bước Record có sObject này; để trống thì không lọc.',
      }),
    ],
    generate(o, { rng, scope, fieldName }) {
      if (o.mode === 'fixed') {
        if (!o.ids.length) throw new Error(`Field ${fieldName}: chưa nhập Id nào.`);
        return rng.pick(o.ids);
      }
      if (!o.ref) throw new Error(`Field ${fieldName}: chưa chọn bản ghi cha.`);
      const pool = o.mode === 'random' ? scope.all[o.ref] : scope.current[o.ref] && [scope.current[o.ref]];
      if (!pool || !pool.length) {
        if (!nullable && pool?.queryAlias) {
          throw new Error(`Field ${fieldName}: Query "${pool.queryAlias}" không trả về bản ghi nào. Kiểm tra "Điều kiện (WHERE)" của bước Query hoặc chọn org khác.`);
        }
        if (!nullable) {
          throw new Error(`Field ${fieldName}: chưa có bản ghi nào của "${o.ref}" khi chạy tới đây. Hãy đặt bước "${o.ref}" phía trên bước này.`);
        }
        return null;
      }
      // A generated pool nobody reads whole records of only counts them (design 0004): draw the
      // index exactly like rng.pick, so the data is the same as with the full list.
      if (pool.kind === 'generated') return { $ref: pool.refAt(Math.floor(rng.next() * pool.length)) };
      const rec = rng.pick(pool);
      if (rec.existing) {
        if (!rec.id) throw new Error(`Field ${fieldName}: pool "${o.ref}" không có cột Id. Thêm Id vào SELECT của bước Query.`);
        return rec.id;
      }
      return { $ref: rec.ref };
    },
  };
}

export const lookup = makeReference('lookup', 'Lookup Relationship', true);
export const masterdetail = makeReference('masterdetail', 'Master-Detail Relationship', false);
