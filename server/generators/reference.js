import { opt } from './common.js';

// Lookup values are emitted as { $ref: 'alias#n' } placeholders. They are resolved to real
// record Ids at insert time (server/sf/insert.js) once the parent record exists in the org.
// mode 'fixed' picks from existing org Ids the user pastes in, so no placeholder is needed.

const MODES = [
  { value: 'current', label: 'Bản ghi gần nhất của node được chọn' },
  { value: 'random', label: 'Ngẫu nhiên trong các bản ghi đã sinh' },
  { value: 'fixed', label: 'Id có sẵn trong org' },
];

function makeReference(type, label, nullable) {
  return {
    type,
    label,
    category: 'Relationship',
    sfTypes: type === 'lookup' ? ['reference'] : [],
    nullable,
    options: [
      opt('mode', 'Lấy từ', 'select', 'current', { choices: MODES }),
      opt('ref', 'Node cha (alias)', 'ref', '', {
        showIf: { key: 'mode', in: ['current', 'random'] },
        help: 'Alias của một node Record ở phía trước trong workflow.',
      }),
      opt('ids', 'Danh sách Id', 'list', [], { showIf: { key: 'mode', in: ['fixed'] }, help: 'Mỗi dòng một Id 15/18 ký tự.' }),
    ],
    generate(o, { rng, scope, fieldName }) {
      if (o.mode === 'fixed') {
        if (!o.ids.length) throw new Error(`Field ${fieldName}: chưa nhập Id nào.`);
        return rng.pick(o.ids);
      }
      if (!o.ref) throw new Error(`Field ${fieldName}: chưa chọn node cha.`);
      const pool = o.mode === 'random' ? scope.all[o.ref] : scope.current[o.ref] && [scope.current[o.ref]];
      if (!pool || !pool.length) {
        if (!nullable) {
          throw new Error(`Field ${fieldName}: chưa có bản ghi nào của "${o.ref}" khi chạy tới đây. Hãy đặt node "${o.ref}" trước node này.`);
        }
        return null;
      }
      return { $ref: rng.pick(pool).ref };
    },
  };
}

export const lookup = makeReference('lookup', 'Lookup Relationship', true);
export const masterdetail = makeReference('masterdetail', 'Master-Detail Relationship', false);
