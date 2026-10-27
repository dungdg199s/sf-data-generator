// Validates workflow JSON before execution. Every issue carries nodeId (the step id) and,
// when relevant, field (an option key, `fields.<Name>` or `slots.<key>`) so the UI can badge
// the step and outline the exact field or slot. The schema is documented in
// docs/workflow-schema.md — keep the two in sync.
//
// Version 2 (tree of steps) is the current format. Version 1 (graph) is still accepted: it is
// migrated with shared/migrate-v1.js first, and the conversion is reported as warnings.

import { NODE_TYPES, nodeTypeMap, CONDITION_OPS, LIMITS } from './nodes.js';
import { getGenerator, describeGenerators } from '../generators/index.js';
import { migrateV1, describeReport, reportNeedsReview } from '../../shared/migrate-v1.js';
import { analyzeScope, referenceOptions, hasUnclosed } from '../../shared/scope.js';

const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ALIASES = new Set(['this']);
const REF_TYPES = new Set(['lookup', 'masterdetail']);

let catalogCache = null;
/** The catalogue analyzeScope reads, same shape as /api/meta. */
export function scopeCatalog() {
  catalogCache ??= { nodeTypes: NODE_TYPES, fieldTypes: describeGenerators() };
  return catalogCache;
}

export const CURRENT_VERSION = 2;

export class WorkflowError extends Error {
  constructor(issues) {
    super(issues.map((i) => i.message).join('\n'));
    this.issues = issues;
  }
}

/** → { errors, warnings } for a v1 or v2 workflow. */
export function validateWorkflow(wf) {
  const { errors, warnings } = prepareWorkflow(wf);
  return { errors, warnings };
}

/**
 * Normalise (v1 → v2) and validate.
 * → { workflow (v2, or null when unusable), errors, warnings, migration (v1 report, or null) }.
 */
export function prepareWorkflow(wf) {
  const errors = [];
  const warnings = [];
  let migration = null;
  const err = (message, nodeId, field, extra) => errors.push({ message, nodeId, field, ...extra });
  const warn = (message, nodeId, field, extra) => warnings.push({ message, nodeId, field, ...extra });

  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) {
    err('Workflow phải là một object JSON.');
    return { workflow: null, errors, warnings, migration };
  }
  let workflow = wf;
  if (wf.version === 1) {
    if (!Array.isArray(wf.nodes)) err('Thiếu danh sách "nodes" (workflow version 1).');
    if (!Array.isArray(wf.edges)) err('Thiếu danh sách "edges" (workflow version 1).');
    if (errors.length) return { workflow: null, errors, warnings, migration };
    const migrated = migrateV1(wf, { maxDepth: LIMITS.maxDepth, fieldTypes: describeGenerators() });
    workflow = migrated.workflow;
    migration = migrated.report;
    warn('Workflow version 1 đã được tự chuyển sang version 2 để chạy. Mở file trong trình soạn rồi bấm Lưu để cập nhật.');
    for (const item of describeReport(migrated.report)) warn(item.message, item.nodeId);
  } else if (wf.version !== CURRENT_VERSION) {
    err(`Không hỗ trợ workflow version ${wf.version}. Version hiện tại là ${CURRENT_VERSION}.`);
    return { workflow: null, errors, warnings, migration };
  }
  if (!Array.isArray(workflow.steps)) {
    err('Thiếu danh sách "steps".');
    return { workflow: null, errors, warnings, migration };
  }

  // Structure: ids, types, slots, depth. Collects steps (with their disabled state) in reading order.
  const ids = new Set();
  const steps = []; // { step, off }
  let tooDeep = false;
  const visit = (list, depth, off) => {
    for (const step of list) {
      if (!step || typeof step !== 'object' || step.id === undefined || step.id === null || step.id === '') {
        err('Có bước không có id.');
        continue;
      }
      if (ids.has(step.id)) err(`Trùng id bước "${step.id}".`, step.id);
      ids.add(step.id);
      const type = nodeTypeMap.get(step.type);
      if (!type) {
        err(`Loại bước "${step.type}" không tồn tại.`, step.id);
        continue;
      }
      const stepOff = off || step.disabled === true;
      steps.push({ step, off: stepOff });
      if (step.slots === undefined) continue;
      if (!step.slots || typeof step.slots !== 'object' || Array.isArray(step.slots)) {
        err('"slots" phải là một object { <nhánh>: [bước…] }.', step.id, 'slots');
        continue;
      }
      if (!type.slots.length) {
        if (Object.keys(step.slots).length) err(`Bước ${type.label} không chứa bước con. Xóa "slots" khỏi bước này.`, step.id, 'slots');
        continue;
      }
      const legal = new Set(type.slots.map((s) => s.key));
      for (const [key, children] of Object.entries(step.slots)) {
        if (!legal.has(key)) {
          err(`Bước ${type.label} không có nhánh "${key}".`, step.id, `slots.${key}`);
          continue;
        }
        if (!Array.isArray(children)) {
          err(`"slots.${key}" phải là một danh sách bước.`, step.id, `slots.${key}`);
          continue;
        }
        if (depth + 1 > LIMITS.maxDepth) {
          if (children.length && !tooDeep) {
            tooDeep = true;
            err(`Workflow lồng nhau quá ${LIMITS.maxDepth} cấp. Bỏ bớt Lặp/Rẽ nhánh lồng nhau.`, step.id);
          }
          continue;
        }
        visit(children, depth + 1, stepOff);
      }
    }
  };
  visit(workflow.steps, 0, false);
  if (errors.length) return { workflow, errors, warnings, migration };

  // Aliases: unique across the whole tree, disabled steps included (so turning one back on
  // cannot create a clash).
  const aliasOwner = new Map();
  for (const { step } of steps) {
    const alias = step.type === 'record' ? step.config?.alias : step.type === 'loop' ? (step.config?.alias || 'loop') : null;
    if (!alias) continue;
    if (!ALIAS.test(alias) || RESERVED_ALIASES.has(alias)) {
      err(`Alias "${alias}" không hợp lệ (chỉ chữ, số, gạch dưới; không bắt đầu bằng số; không dùng "this").`, step.id, 'alias');
      continue;
    }
    if (step.type === 'record' && aliasOwner.has(alias)) err(`Alias "${alias}" đã được dùng ở bước khác. Đổi alias của một trong hai bước.`, step.id, 'alias');
    if (step.type === 'record' && !aliasOwner.has(alias)) aliasOwner.set(alias, step.id);
  }
  for (const { step } of steps) {
    if (step.type === 'loop' && aliasOwner.has(step.config?.alias || 'loop')) {
      err(`Tên biến lặp "${step.config?.alias || 'loop'}" trùng alias của một bước Record. Đổi một trong hai tên.`, step.id, 'alias');
    }
  }

  // Per-step config (turned-off steps are not checked: they do not run).
  const catalog = scopeCatalog();
  const scope = analyzeScope(workflow, catalog);
  for (const { step, off } of steps) {
    if (off) continue;
    const c = step.config ?? {};
    if (step.type === 'record') validateRecord(step, c, { err, warn });
    if (step.type === 'loop') {
      const mode = c.mode ?? 'fixed';
      const check = (key) => {
        const v = c[key];
        if (v !== undefined && (!Number.isInteger(Number(v)) || v < 0 || v > LIMITS.maxCountPerNode)) {
          err(`Số lần lặp phải là số nguyên từ 0 đến ${LIMITS.maxCountPerNode}.`, step.id, key);
        }
      };
      if (mode === 'fixed') check('count');
      else if (mode === 'range') {
        check('min');
        check('max');
        if (Number(c.min) > Number(c.max)) err('"Ít nhất" lớn hơn "Nhiều nhất".', step.id, 'min');
      } else err(`Chế độ lặp "${mode}" không hợp lệ.`, step.id, 'mode');
      if (!step.slots?.body?.length) warn('Vòng lặp chưa có bước nào. Bấm "+ Thêm bước vào vòng lặp".', step.id, 'slots.body');
    }
    if (step.type === 'branch') {
      const kind = c.kind ?? 'chance';
      if (kind === 'chance') {
        const p = Number(c.probability ?? 0.5);
        if (!(p >= 0 && p <= 1)) err('Xác suất phải nằm trong khoảng 0–1.', step.id, 'probability');
      } else if (kind === 'compare') {
        if (!c.left) err('Chưa nhập giá trị cần so sánh.', step.id, 'left');
        if (!CONDITION_OPS.some((o) => o.value === c.op)) err('Phép so sánh không hợp lệ.', step.id, 'op');
      } else err(`Loại điều kiện "${kind}" không hợp lệ.`, step.id, 'kind');
      if (!step.slots?.true?.length && !step.slots?.false?.length) {
        warn('Cả hai nhánh đều trống nên bước này không làm gì. Thêm bước vào nhánh Đúng hoặc xóa bước này.', step.id, 'slots.true');
      }
    }
  }

  // Variable references (templates, branch `left`, Lookup `ref`): every option declaring `vars`
  // or `kind: 'ref'` is checked against the scope analysis (design 0005).
  {
    const stepById = new Map(steps.map(({ step }) => [step.id, step]));
    const seen = new Set();
    for (const ref of scope.refs) {
      if (ref.disabled || !ref.code) continue;
      const key = `${ref.nodeId}|${ref.field}|${ref.path}|${ref.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const issue = referenceIssue(ref, scope, stepById.get(ref.nodeId));
      if (!issue) continue;
      (ref.level === 'warning' ? warn : err)(issue.message, ref.nodeId, ref.field, issue.extra);
    }
    for (const { step, off } of steps) {
      if (off) continue;
      for (const o of referenceOptions(step, catalog)) {
        if (o.mode === 'template' && typeof o.value === 'string' && hasUnclosed(o.value)) {
          warn(`${o.fieldName !== undefined ? `Field "${o.fieldName}": ` : ''}có "{{" chưa đóng bằng "}}" nên sẽ được giữ nguyên là chữ.`, step.id, o.field, { code: 'unclosed', option: o.option });
        }
      }
    }
  }

  return { workflow, errors, warnings, migration };
}

/**
 * Message when a version-1 workflow may not be inserted into an org as is: its conversion
 * copied or cut steps, so the user must review it in the editor first. Null when fine.
 */
export function insertBlockedReason(wf) {
  if (wf?.version !== 1) return null;
  const { migration } = prepareWorkflow(wf);
  if (!reportNeedsReview(migration)) return null;
  return 'Workflow version 1 này phải đổi cấu trúc khi chuyển sang version 2 (có bước được nhân bản hoặc bị cắt). Mở file trong trình soạn, kiểm tra hộp thoại chuyển đổi rồi bấm Lưu trước khi insert. Xem trước vẫn chạy được.';
}

function validateRecord(step, c, { err, warn }) {
  if (!c.sobject || !API_NAME.test(c.sobject)) err('Chưa nhập sObject hợp lệ (API name).', step.id, 'sobject');
  const count = c.count ?? 1;
  if (!Number.isInteger(Number(count)) || count < 1 || count > LIMITS.maxCountPerNode) {
    err(`Số bản ghi phải là số nguyên từ 1 đến ${LIMITS.maxCountPerNode}.`, step.id, 'count');
  }
  const fields = c.fields ?? [];
  if (!Array.isArray(fields)) {
    err('"fields" phải là một danh sách.', step.id);
    return;
  }
  if (!fields.length) warn('Bước chưa có field nào; bản ghi sẽ rỗng. Thêm field hoặc "Import từ org…".', step.id);
  const names = new Set();
  for (const f of fields) {
    const key = `fields.${f?.name}`;
    if (!f?.name || !API_NAME.test(f.name)) {
      err(`Tên field "${f?.name ?? ''}" không hợp lệ.`, step.id, key);
      continue;
    }
    if (names.has(f.name.toLowerCase())) err(`Field "${f.name}" bị khai báo hai lần.`, step.id, key);
    names.add(f.name.toLowerCase());
    if (!getGenerator(f.type)) {
      err(`Field "${f.name}": kiểu "${f.type}" không được hỗ trợ.`, step.id, key);
      continue;
    }
    if (REF_TYPES.has(f.type) && (f.options?.mode ?? 'current') !== 'fixed' && !f.options?.ref) {
      err(`Field "${f.name}": chưa chọn bản ghi cha. Chọn một bước Record phía trên trong ô "Bản ghi cha".`, step.id, key);
    }
  }
}

// ---------- variable references (design 0005, "Thông báo lỗi và cảnh báo") ----------

/**
 * Issue for one problem reference found by analyzeScope: { message, extra: { code, path, option, suggestion? } }.
 * Field options get the `Field "<Name>": ` prefix; step options (branch `left`) do not.
 */
export function referenceIssue(ref, scope, step) {
  const src = ref.source !== undefined ? scope.sources[ref.source] : null;
  const fieldName = ref.field.startsWith('fields.') ? ref.field.slice('fields.'.length) : null;
  const prefix = fieldName !== null ? `Field "${fieldName}": ` : '';
  const show = (p) => (ref.mode === 'template' ? `{{${p}}}` : p);
  const s = src?.name ?? ref.name;
  const what = src ? `${src.sobject ? ` (${src.sobject})` : ''}` : '';
  const suggest = ref.suggestion ? ref.suggestion.to : null;
  const firstField = (source) => source?.members.find((m) => !m.builtin)?.key ?? 'Name';
  const isMD = fieldName !== null && (step?.config?.fields ?? []).find((f) => f?.name === fieldName)?.type === 'masterdetail';
  let message;

  if (ref.mode === 'ref') {
    switch (ref.code) {
      case 'unknownName':
        message = `không có bước Record nào có alias "${ref.path}".${suggest ? ` Ý bạn là "${suggest}"?` : ''} Chọn bản ghi cha trong danh sách "Bản ghi cha".`;
        break;
      case 'after':
        message = `bước "${s}" nằm sau bước này nên chưa có bản ghi khi chạy tới đây. Kéo bước "${s}" lên phía trên hoặc chọn bản ghi cha khác.`;
        break;
      case 'otherBranch':
        message = `bước "${s}" nằm ở nhánh còn lại của bước Rẽ nhánh phía trên nên không chạy cùng lượt với bước này. Đưa "${s}" ra trước bước Rẽ nhánh hoặc chọn bản ghi cha khác.`;
        break;
      case 'disabled':
        message = `bước "${s}" đang tắt. Bật lại bước đó (Ctrl+/) hoặc chọn bản ghi cha khác.`;
        break;
      case 'maybe':
        message = maybeMessage(ref, s, true, isMD);
        break;
      default:
        return null;
    }
  } else {
    switch (ref.code) {
      case 'unknownName':
        message = `không có biến "${ref.name}" (không phải alias của bước Record nào, cũng không phải tên biến lặp).${suggest ? ` Ý bạn là "${suggest.split('.')[0]}"?` : ''} Bấm {x} để chọn biến có sẵn.`;
        break;
      case 'unknownMember':
        if (src?.kind === 'vars') {
          message = `biến lặp "${s}" chỉ có ${src.members.map((m) => m.key).join(', ')}; không có "${ref.missing ?? ref.member}".`;
        } else if (src?.origin === 'org' || src?.nodeType === 'query') {
          message = `Query "${s}" không lấy field "${ref.missing}". Thêm ${ref.missing} vào "Field cần lấy" của bước Query.`;
        } else if (ref.viaThis) {
          message = `bước này không có field "${ref.missing}". Chọn field khác bằng {x}.`;
        } else {
          const hint = suggest ? suggest.split('.').slice(1).join('.') : null;
          message = `bước "${s}"${what} không có field "${ref.missing}".${hint ? ` Ý bạn là "${hint}"?` : ''} Thêm field đó vào bước "${s}" hoặc chọn field khác bằng {x}.`;
        }
        break;
      case 'wholeRecord':
        message = src?.kind === 'vars'
          ? `${show(s)} là cả vòng lặp; hãy chọn một biến, ví dụ ${show(`${s}.index`)}.`
          : `${show(ref.name)} là cả bản ghi; hãy chọn một field, ví dụ ${show(`${ref.name}.${ref.viaThis ? firstField(src) : firstField(src)}`)}.`;
        break;
      case 'noTraversal': {
        const parent = ref.traversalRef ? scope.sources[Object.keys(scope.sources).find((id) => scope.sources[id].name === ref.traversalRef)] : null;
        const p = parent?.name ?? ref.traversalRef ?? 'acc';
        message = `không đi tiếp qua field Lookup "${ref.traversal}" được. Dùng thẳng alias của bước cha, ví dụ ${show(`${p}.${firstField(parent)}`)}.`;
        break;
      }
      case 'after':
        message = `bước "${s}" chạy sau bước này nên chưa có giá trị khi chạy tới đây. Kéo bước "${s}" lên phía trên, hoặc chọn biến khác.`;
        break;
      case 'otherBranch':
        message = `bước "${s}" nằm ở nhánh còn lại của Rẽ nhánh phía trên nên không chạy cùng lượt với bước này. Đưa "${s}" ra trước Rẽ nhánh, hoặc chọn biến khác.`;
        break;
      case 'disabled':
        message = src?.kind === 'vars'
          ? `vòng lặp "${s}" đang tắt. Bật lại bước đó (Ctrl+/) hoặc chọn biến khác.`
          : `bước "${s}" đang tắt. Bật lại bước đó (Ctrl+/) hoặc chọn biến khác.`;
        break;
      case 'outsideLoop':
        message = `${show(ref.path)} chỉ dùng được bên trong vòng lặp "${s}". Kéo bước này vào trong vòng lặp "${s}", hoặc bỏ biến này.`;
        break;
      case 'thisBelow':
        message = `${show(ref.path)} chỉ thấy field phía trên. Kéo field "${ref.member.split('.')[0]}" lên trên "${fieldName}" (nút ↑).`;
        break;
      case 'thisUnknown': {
        const hint = suggest ? suggest.split('.')[1] : null;
        message = `bước này không có field "${ref.member.split('.')[0]}".${hint ? ` Ý bạn là "${hint}"?` : ` Thêm field đó phía trên "${fieldName}" hoặc chọn biến khác bằng {x}.`}`;
        break;
      }
      case 'thisSelf':
        message = `template không thể dùng chính field "${fieldName}".`;
        break;
      case 'thisOutsideRecord':
        message = `"this" chỉ dùng trong template của bước Record. Ở đây hãy chọn alias của bước, ví dụ acc.Industry.`;
        break;
      case 'selfAlias':
        message = `đang ở trong bước "${s}", hãy dùng ${show(`this.${ref.member || firstField(src)}`)} thay cho ${show(ref.path)} (${s}.* ở đây là bản ghi trước đó của chính bước này).`;
        break;
      case 'noIdYet':
        message = `"${s}" là bản ghi được sinh ra nên chưa có Id trước khi insert. Muốn nối bản ghi con với "${s}" thì dùng field Lookup; {{${s}.Id}} chỉ có với bản ghi đọc từ org (Query, Chọn bản ghi).`;
        break;
      case 'noCurrent':
        message = `"${s}" là danh sách bản ghi đọc từ org, không có bản ghi hiện tại. Thêm bước Chọn bản ghi lấy từ "${s}" rồi dùng alias của bước đó.`;
        break;
      case 'openMember':
        message = `chưa chắc "${s}" có field "${ref.missing}" (danh sách field chưa đầy đủ); kiểm tra lại câu truy vấn.`;
        break;
      case 'maybe':
        message = maybeMessage(ref, s, false, false);
        break;
      default:
        return null;
    }
  }
  const extra = { code: ref.code, path: ref.path, option: ref.option };
  if (ref.suggestion) extra.suggestion = ref.suggestion;
  return { message: prefix + message, extra };
}

function maybeMessage(ref, s, isLookup, isMD) {
  if (ref.why?.loop) {
    return `vòng lặp "${ref.why.loop}" có thể chạy 0 lần nên "${s}" có thể chưa có bản ghi.${isMD ? ' Master-Detail sẽ báo lỗi khi chạy; đặt "Ít nhất" ≥ 1.' : ''}`;
  }
  return `"${s}" chỉ được tạo trên một số nhánh trước khi tới đây, nên có thể chưa có (${isLookup ? 'field này trống' : 'giá trị trống'}, hoặc là bản ghi của lần lặp trước). Đặt bước này ngay sau "${s}" nếu cần luôn có giá trị.${isMD ? ' Master-Detail sẽ báo lỗi khi chạy nếu chưa có bản ghi cha.' : ''}`;
}
