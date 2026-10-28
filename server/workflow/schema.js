// Validates workflow JSON before execution. Every issue carries nodeId (the step id) and,
// when relevant, field (an option key, `fields.<Name>` or `slots.<key>`) so the UI can badge
// the step and outline the exact field or slot. The schema is documented in
// docs/workflow-schema.md — keep the two in sync.
//
// Version 2 (tree of steps) is the current format. Version 1 (graph) is still accepted: it is
// migrated with shared/migrate-v1.js first, and the conversion is reported as warnings.

import { NODE_TYPES, nodeTypeMap, CONDITION_OPS, LIMITS } from './nodes.js';
import { checkSoql, checkBuilder, isFieldPath, buildSoql, soqlSobject, selectFields, builderLimit } from '../../shared/soql.js';
import { getGenerator, describeGenerators } from '../generators/index.js';
import { migrateV1, describeReport, reportNeedsReview } from '../../shared/migrate-v1.js';
import { analyzeScope, referenceOptions, hasUnclosed } from '../../shared/scope.js';
import { stepNames } from '../../shared/workflow-tree.js';

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

/**
 * → { errors, warnings } for a v1 or v2 workflow; with `{ derived: true }` (POST /api/validate)
 * also `derived[stepId]`, what the server works out from a Query / Chọn bản ghi config (design
 * 0006): the SOQL it will run, the sObject and the fields of the pool.
 */
export function validateWorkflow(wf, { derived = false } = {}) {
  const { workflow, errors, warnings } = prepareWorkflow(wf);
  if (!derived) return { errors, warnings };
  return { errors, warnings, derived: workflow ? deriveSteps(workflow) : {} };
}

/** { [stepId]: { soql, sobject, fields } } for Query steps, { sobject, fields, from } for Chọn bản ghi. */
export function deriveSteps(workflow) {
  const out = {};
  let scope = null;
  const visit = (list) => {
    for (const st of Array.isArray(list) ? list : []) {
      if (!st || typeof st !== 'object') continue;
      if (st.type === 'query') out[st.id] = { soql: buildSoql(st.config ?? {}), sobject: soqlSobject(st.config ?? {}), fields: selectFields(st.config ?? {}).fields };
      if (st.type === 'pick') {
        scope ??= analyzeScope(workflow, scopeCatalog());
        const src = scope.sources[st.id];
        out[st.id] = { sobject: src?.sobject ?? '', fields: (src?.members ?? []).filter((m) => !m.builtin).map((m) => m.key), from: st.config?.from ?? '' };
      }
      for (const children of Object.values(st.slots ?? {})) visit(children);
    }
  };
  visit(workflow.steps);
  return out;
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

  // Aliases: one namespace for Record, Query and Chọn bản ghi (every type exposing a record
  // named by its `alias`) and the record a Lặp `each` loops over (`itemAlias`, design 0010),
  // unique across the whole tree, disabled steps included (so turning one back on cannot create
  // a clash). Loop variables must not reuse them.
  const catalog = scopeCatalog();
  const aliasOwner = new Map(); // name → { step, key }
  const loopVars = new Set(steps.filter(({ step }) => step.type === 'loop').map(({ step }) => step.config?.alias || 'loop'));
  for (const { step, off } of steps) {
    const isLoop = step.type === 'loop';
    const ex = nodeTypeMap.get(step.type)?.exposes;
    const named = !Array.isArray(ex) && ex?.kind === 'record' && ex.name?.key === 'alias';
    const each = isLoop && step.config?.mode === 'each';
    if (isLoop) {
      const alias = step.config?.alias || 'loop';
      if (!ALIAS.test(alias) || RESERVED_ALIASES.has(alias)) err(`Alias "${alias}" không hợp lệ (chỉ chữ, số, gạch dưới; không bắt đầu bằng số; không dùng "this").`, step.id, 'alias');
    } else if (named && !step.config?.alias) {
      // A Record falls back to its id; a pool (Query) or a picked record needs a name.
      if (step.type !== 'record' && !off) err(`Đặt alias để bước khác dùng được ${step.type === 'query' ? 'pool này (ví dụ accs)' : 'bản ghi này (ví dụ acc)'}.`, step.id, 'alias');
    }
    // Without a pool yet, the first thing to fix is `from` (its error); the name comes with it.
    if (each && !step.config?.itemAlias && step.config?.from && !off) err('Đặt tên cho bản ghi đang lặp (ví dụ acc) để các bước bên trong dùng {{acc.Name}}.', step.id, 'itemAlias');
    for (const { key, value } of stepNames(step, catalog)) {
      if (!ALIAS.test(value) || RESERVED_ALIASES.has(value)) {
        err(`Alias "${value}" không hợp lệ (chỉ chữ, số, gạch dưới; không bắt đầu bằng số; không dùng "this").`, step.id, key);
        continue;
      }
      if (aliasOwner.has(value)) err(`Alias "${value}" đã được dùng ở bước khác. Đổi alias của một trong hai bước.`, step.id, key);
      else aliasOwner.set(value, { step, key });
      if (key === 'itemAlias' && loopVars.has(value)) err(`Tên bản ghi đang lặp "${value}" trùng tên biến lặp. Đổi một trong hai tên.`, step.id, key);
    }
  }
  for (const { step } of steps) {
    const owner = step.type === 'loop' ? aliasOwner.get(step.config?.alias || 'loop') : null;
    // A clash with a record looped over is reported on that `itemAlias` (above).
    if (owner && owner.key === 'alias') {
      err(`Tên biến lặp "${step.config?.alias || 'loop'}" trùng alias của một bước ${nodeTypeMap.get(owner.step.type)?.label ?? owner.step.type}. Đổi một trong hai tên.`, step.id, 'alias');
    }
  }
  // A Record without alias is named by its id (executor, Lookups): that name must not clash with
  // another name either, or a reference silently reads the wrong records (0010 review).
  for (const { step } of steps) {
    if (step.type !== 'record' || step.config?.alias) continue;
    const id = String(step.id);
    const owner = aliasOwner.get(id);
    if (owner || loopVars.has(id)) {
      const what = !owner ? 'tên một biến lặp'
        : owner.key === 'itemAlias' ? 'tên bản ghi đang lặp của một bước Lặp' : `alias của một bước ${nodeTypeMap.get(owner.step.type)?.label ?? owner.step.type}`;
      err(`Bước này chưa có alias nên được gọi bằng id "${id}", trùng ${what}. Đặt alias cho bước này (ví dụ ${id}_rec) hoặc đổi tên kia.`, step.id, 'alias');
    }
  }

  // Per-step config (turned-off steps are not checked: they do not run).
  const scope = analyzeScope(workflow, catalog);
  const insideLoop = new Set();
  {
    const mark = (list, inLoop) => {
      for (const st of list ?? []) {
        if (!st || typeof st !== 'object') continue;
        if (inLoop) insideLoop.add(st.id);
        for (const [key, children] of Object.entries(st.slots ?? {})) {
          if (Array.isArray(children)) mark(children, inLoop || (st.type === 'loop' && key === 'body'));
        }
      }
    };
    mark(workflow.steps, false);
  }
  let queries = 0;
  for (const { step, off } of steps) {
    if (off) continue;
    const c = step.config ?? {};
    if (step.type === 'record') validateRecord(step, c, { err, warn, scope });
    if (step.type === 'query') {
      if (++queries === LIMITS.maxQueryNodes + 1) {
        err(`Workflow có quá ${LIMITS.maxQueryNodes} bước Query. Gộp các query cùng sObject lại (lọc bằng bước Chọn bản ghi).`, step.id);
      }
      validateQuery(step, c, { err, warn, scope, inLoop: insideLoop.has(step.id) });
    }
    if (step.type === 'pick') validatePick(step, c, { err });
    if (step.type === 'loop') {
      const mode = c.mode ?? 'fixed';
      // Whether the pool `from` is usable here is checked by analyzeScope (refs), like Chọn bản ghi.
      if (mode === 'each' && !c.from) err('Chưa chọn pool để lặp. Chọn alias của một bước Query, Record hoặc Chọn bản ghi ở phía trên.', step.id, 'from');
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
      } else if (mode !== 'each') err(`Chế độ lặp "${mode}" không hợp lệ.`, step.id, 'mode');
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
      if (ref.disabled || ref.hidden || !ref.code) continue;
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
    // A Query pool nobody reads (no Lookup, Chọn bản ghi or template refers to it).
    for (const { step, off } of steps) {
      if (off || step.type !== 'query' || !step.config?.alias) continue;
      if (scope.refs.some((r) => r.source === step.id && !r.disabled && !r.hidden)) continue;
      const a = step.config.alias;
      warn(`Chưa có bước nào dùng pool "${a}". Thêm bước Chọn bản ghi, Lặp qua từng bản ghi (menu ⋯), hoặc chọn "${a}" ở một field Lookup.`, step.id, undefined, { code: 'poolUnused' });
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

function validateRecord(step, c, { err, warn, scope }) {
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
    if (REF_TYPES.has(f.type) && (f.options?.mode ?? 'current') !== 'fixed') {
      if (!f.options?.ref) err(`Field "${f.name}": chưa chọn bản ghi cha. Chọn một bước Record phía trên trong ô "Bản ghi cha".`, step.id, key);
      else {
        const pool = (f.options?.mode ?? 'current') === 'current' && Object.values(scope.sources).find((s) => s.lookupParent && s.name === f.options.ref && s.current === 'none');
        // (Outside its loop the reference is already an error: outsideLoop.)
        const item = f.options?.mode === 'random' && !scope.refs.some((r) => r.nodeId === step.id && r.field === key && r.option === 'ref' && r.code)
          && Object.values(scope.sources).find((s) => s.name === f.options.ref && s.current === 'item');
        if (item) {
          err(`Field "${f.name}": "${item.name}" là bản ghi đang lặp, không phải pool. Chọn "Bản ghi hiện tại của alias", hoặc chọn pool "${item.from || '…'}" nếu muốn ngẫu nhiên.`, step.id, key, { code: 'randomOfItem', path: item.name, option: 'mode' });
        }
        if (pool) {
          err(`Field "${f.name}": Query "${pool.name}" là một pool nhiều bản ghi, không có "bản ghi hiện tại". Chọn "Ngẫu nhiên trong pool", hoặc thêm bước Chọn bản ghi rồi trỏ Lookup vào alias của nó.`, step.id, key, { code: 'currentOfPool', path: pool.name, option: 'mode' });
        }
        checkReferenceTo(step, f, key, { warn, scope });
      }
    }
  }
}

/** Query step (design 0006): builder or hand-written SOQL, read-only, within LIMITS. */
function validateQuery(step, c, { err, warn, inLoop }) {
  const mode = c.mode ?? 'builder';
  if (mode === 'builder') {
    if (!API_NAME.test(String(c.sobject ?? 'Account'))) err('Chưa nhập sObject hợp lệ (API name).', step.id, 'sobject');
    const raw = c.fields;
    if (raw !== undefined && !Array.isArray(raw) && typeof raw !== 'string') err('"fields" phải là một danh sách tên field.', step.id, 'fields');
    else {
      const list = Array.isArray(raw) ? raw : raw === undefined ? [] : String(raw).split(/[\n,;]/);
      const bad = list.map((x) => String(x ?? '').trim()).filter(Boolean).find((x) => !isFieldPath(x));
      if (bad !== undefined) err(`Field "${bad}" không hợp lệ. Dùng API name; field quan hệ viết Owner.Name.`, step.id, 'fields');
    }
    const limit = builderLimit(c);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxQueryRows) err(`Số bản ghi tối đa phải là số nguyên từ 1 đến ${LIMITS.maxQueryRows}.`, step.id, 'limit');
    for (const i of checkBuilder(c)) err(i.message, step.id, i.field, { code: i.code });
  } else if (mode === 'soql') {
    for (const i of checkSoql(c.soql)) (i.level === 'error' ? err : warn)(i.message, step.id, 'soql', { code: i.code });
  } else err(`Cách nhập "${mode}" không hợp lệ.`, step.id, 'mode');
  if (inLoop) warn('Query nằm trong vòng lặp vẫn chỉ đọc org một lần, trước khi sinh dữ liệu. Nên đặt Query ngay sau Bắt đầu.', step.id, undefined, { code: 'queryInLoop' });
}

const PICK_MODES = new Set(['random', 'unique', 'sequential']);

/** Chọn bản ghi (design 0006). Whether `from` is usable here is checked by analyzeScope (refs). */
function validatePick(step, c, { err }) {
  if (!c.from) err('Chưa chọn pool. Chọn alias của bước Query hoặc Record ở phía trên.', step.id, 'from');
  if (!PICK_MODES.has(c.mode ?? 'random')) err(`Cách chọn "${c.mode}" không hợp lệ.`, step.id, 'mode');
  const filter = c.filter ?? 'none';
  if (filter === 'compare') {
    if (!String(c.filterField ?? '').trim()) err('Chưa nhập field để lọc, ví dụ AccountId hoặc Account.Type.', step.id, 'filterField');
    else if (!isFieldPath(c.filterField)) err(`Field "${c.filterField}" không hợp lệ. Dùng API name; field quan hệ viết Account.Type.`, step.id, 'filterField');
    if (!CONDITION_OPS.some((o) => o.value === (c.filterOp ?? 'eq'))) err('Phép so sánh không hợp lệ.', step.id, 'filterOp');
  } else if (filter !== 'none') err(`Cách lọc "${filter}" không hợp lệ.`, step.id, 'filter');
  if (!['skip', 'error'].includes(c.onEmpty ?? 'skip')) err(`Lựa chọn "${c.onEmpty}" không hợp lệ.`, step.id, 'onEmpty');
}

/** A Lookup imported from the org (referenceTo) whose parent step creates another sObject. */
function checkReferenceTo(step, f, key, { warn, scope }) {
  const targets = Array.isArray(f.options?.referenceTo) ? f.options.referenceTo.filter(Boolean) : [];
  if (!targets.length) return;
  const parent = Object.values(scope.sources).find((s) => s.lookupParent && s.name === f.options.ref);
  if (!parent?.sobject || targets.some((t) => String(t).toLowerCase() === parent.sobject.toLowerCase())) return;
  warn(`Field "${f.name}": bước "${parent.name}" là ${parent.sobject}, nhưng field này trỏ tới ${targets.join(', ')}. Chọn bản ghi cha là ${targets.join(' hoặc ')}.`, step.id, key, { code: 'wrongSobject', path: f.options.ref, option: 'ref' });
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

  const isLoop = step?.type === 'loop';
  if (ref.mode === 'ref' && ref.option === 'from') {
    // A pool option (Chọn bản ghi `from`, design 0006; Lặp `each`, 0010).
    switch (ref.code) {
      case 'unknownName':
        message = `Không có bước nào có alias "${ref.path}".${suggest ? ` Ý bạn là "${suggest}"?` : ''} Chọn pool khác trong danh sách hoặc thêm bước Query/Record có alias này ở phía trên.`;
        break;
      case 'after':
        message = isLoop
          ? `Pool "${s}" nằm sau bước Lặp này nên chưa có bản ghi khi chạy tới đây. Kéo bước "${s}" lên phía trên hoặc chọn pool khác.`
          : `Pool "${s}" phải nằm phía trước bước này trong workflow. Kéo bước "${s}" lên phía trên hoặc chọn pool khác.`;
        break;
      case 'itemNotPool':
        message = `"${s}" là bản ghi đang lặp${isLoop ? ' của bước Lặp phía trên' : ''}, không phải pool. Chọn pool gốc "${ref.pool || '…'}".`;
        break;
      case 'otherBranch':
        message = `Pool "${s}" nằm ở nhánh còn lại của bước Rẽ nhánh phía trên nên không chạy cùng lượt với bước này. Đưa "${s}" ra trước bước Rẽ nhánh hoặc chọn pool khác.`;
        break;
      case 'disabled':
        message = `Bước "${s}" đang tắt. Bật lại bước đó (Ctrl+/) hoặc chọn pool khác.`;
        break;
      case 'maybe':
        message = isLoop
          ? `Pool "${s}" nằm trong một nhánh rẽ hoặc vòng lặp có thể không chạy, nên có lúc vòng lặp này không chạy lần nào.`
          : maybeMessage(ref, s, true, false);
        break;
      default:
        return null;
    }
  } else if (ref.mode === 'ref') {
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
      case 'outsideLoop':
        // The record a Lặp `each` loops over (0010), used outside the loop body.
        message = `"${s}" là bản ghi đang lặp của bước Lặp phía trên, chỉ dùng được bên trong vòng lặp đó. Kéo bước này vào trong vòng lặp hoặc chọn bản ghi cha khác.`;
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
          // For a Chọn bản ghi, name the Query its rows come from.
          const q = src.root !== undefined ? scope.sources[src.root]?.name ?? s : s;
          message = ref.mode === 'template'
            ? `Template dùng ${show(ref.path)} nhưng Query "${q}" không lấy field ${ref.missing}. Thêm ${ref.missing} vào "Field cần lấy" của bước Query.`
            : `Biến ${ref.path} cần field ${ref.missing} nhưng Query "${q}" không lấy field này. Thêm ${ref.missing} vào "Field cần lấy" của bước Query.`;
        } else if (ref.memberOf) {
          const hint = suggest ? suggest.split('.').pop() : null;
          message = `field "${ref.memberOf}" của bước "${s}" chỉ có ${ref.validMembers.join(', ')}; không có "${ref.missing}".${hint ? ` Ý bạn là "${hint}"?` : ''}`;
        } else if (ref.viaThis) {
          message = `bước này không có field "${ref.missing}". Chọn field khác bằng {x}.`;
        } else {
          const hint = suggest ? suggest.split('.').slice(1).join('.') : null;
          // A Chọn bản ghi from a Record pool: the field is added on that Record step.
          const owner = src?.root !== undefined ? scope.sources[src.root]?.name ?? s : s;
          message = `bước "${s}"${what} không có field "${ref.missing}".${hint ? ` Ý bạn là "${hint}"?` : ''} Thêm field đó vào bước "${owner}" hoặc chọn field khác bằng {x}.`;
        }
        break;
      case 'wholeRecord':
        if (ref.objectMember) {
          message = `${show(ref.path)} là cả một đối tượng (${ref.validMembers.join(', ')}), không phải một giá trị; hãy chọn một field con, ví dụ ${show(`${ref.path}.${ref.validMembers[0]}`)}.`;
          break;
        }
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
        if (src?.current === 'item') {
          message = `${show(ref.path)}: "${s}" là bản ghi đang lặp của bước Lặp phía trên, chỉ dùng được bên trong vòng lặp đó. Kéo bước này vào trong vòng lặp.`;
          break;
        }
        message = ref.noLoop
          ? `${show(ref.path)} chỉ dùng được bên trong một vòng lặp, nhưng bước này không nằm trong vòng lặp nào. Bọc bước này trong Lặp (menu ⋯ → "Bọc trong Lặp"), hoặc chọn biến khác bằng {x}.`
          : `${show(ref.path)} chỉ dùng được bên trong vòng lặp "${s}". Kéo bước này vào trong vòng lặp "${s}", hoặc bỏ biến này.`;
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
      case 'noCurrent': {
        const one = s.length > 1 && s.endsWith('s') ? s.slice(0, -1) : `${s}1`;
        message = `${show(ref.path)}: "${s}" là pool nhiều bản ghi nên không biết lấy bản ghi nào. Thêm bước Chọn bản ghi từ "${s}" rồi dùng ${show(`${one}.${ref.member || 'Name'}`)}; ${show(`${s}.$count`)} thì dùng được.`;
        break;
      }
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
    if (ref.why.each !== undefined) {
      return `vòng lặp "${ref.why.loop}" chạy 0 lần khi pool "${ref.why.each || '?'}" rỗng nên "${s}" có thể chưa có bản ghi.${isMD ? ' Master-Detail sẽ báo lỗi khi chạy nếu pool đó rỗng.' : ''}`;
    }
    return `vòng lặp "${ref.why.loop}" có thể chạy 0 lần nên "${s}" có thể chưa có bản ghi.${isMD ? ` Master-Detail sẽ báo lỗi khi chạy; đặt ${ref.why.range ? '"Ít nhất"' : '"Số lần lặp"'} ≥ 1.` : ''}`;
  }
  return `"${s}" chỉ được tạo trên một số nhánh trước khi tới đây, nên có thể chưa có (${isLookup ? 'field này trống' : 'giá trị trống'}, hoặc là bản ghi của lần lặp trước). Đặt bước này ngay sau "${s}" nếu cần luôn có giá trị.${isMD ? ' Master-Detail sẽ báo lỗi khi chạy nếu chưa có bản ghi cha.' : ''}`;
}
