// Validates workflow JSON before execution. Every issue carries nodeId (the step id) and,
// when relevant, field (an option key, `fields.<Name>` or `slots.<key>`) so the UI can badge
// the step and outline the exact field or slot. The schema is documented in
// docs/workflow-schema.md — keep the two in sync.
//
// Version 2 (tree of steps) is the current format. Version 1 (graph) is still accepted: it is
// migrated with shared/migrate-v1.js first, and the conversion is reported as warnings.

import { nodeTypeMap, slotKeys, CONDITION_OPS, LIMITS } from './nodes.js';
import { getGenerator } from '../generators/index.js';
import { migrateV1, describeReport } from '../../shared/migrate-v1.js';
import { analyzeRecordScope, refState } from '../../shared/scope.js';

const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ALIASES = new Set(['this']);
const REF_TYPES = new Set(['lookup', 'masterdetail']);

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
 * Normalise (v1 → v2) and validate. → { workflow (v2, or null when unusable), errors, warnings }.
 */
export function prepareWorkflow(wf) {
  const errors = [];
  const warnings = [];
  const err = (message, nodeId, field) => errors.push({ message, nodeId, field });
  const warn = (message, nodeId, field) => warnings.push({ message, nodeId, field });

  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) {
    err('Workflow phải là một object JSON.');
    return { workflow: null, errors, warnings };
  }
  let workflow = wf;
  if (wf.version === 1) {
    if (!Array.isArray(wf.nodes)) err('Thiếu danh sách "nodes" (workflow version 1).');
    if (!Array.isArray(wf.edges)) err('Thiếu danh sách "edges" (workflow version 1).');
    if (errors.length) return { workflow: null, errors, warnings };
    const migrated = migrateV1(wf);
    workflow = migrated.workflow;
    warn('Workflow version 1 đã được tự chuyển sang version 2 để chạy. Mở file trong trình soạn rồi bấm Lưu để cập nhật.');
    for (const item of describeReport(migrated.report)) warn(item.message, item.nodeId);
  } else if (wf.version !== CURRENT_VERSION) {
    err(`Không hỗ trợ workflow version ${wf.version}. Version hiện tại là ${CURRENT_VERSION}.`);
    return { workflow: null, errors, warnings };
  }
  if (!Array.isArray(workflow.steps)) {
    err('Thiếu danh sách "steps".');
    return { workflow: null, errors, warnings };
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
  if (errors.length) return { workflow, errors, warnings };

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
  const scope = analyzeRecordScope(workflow, slotKeys);
  for (const { step, off } of steps) {
    if (off) continue;
    const c = step.config ?? {};
    if (step.type === 'record') validateRecord(step, c, { err, warn, scope });
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

  return { workflow, errors, warnings };
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
    if (REF_TYPES.has(f.type)) checkRef(step, f, key, { err, warn, scope });
  }
}

function checkRef(step, f, key, { err, warn, scope }) {
  const mode = f.options?.mode ?? 'current';
  const ref = f.options?.ref;
  if (mode === 'fixed') return;
  if (!ref) return err(`Field "${f.name}": chưa chọn bản ghi cha.`, step.id, key);
  const { state } = refState(scope, step.id, ref);
  switch (state) {
    case 'unknown':
      return err(`Field "${f.name}": không có bước Record nào có alias "${ref}".`, step.id, key);
    case 'after':
      return err(`Field "${f.name}": bước "${ref}" nằm sau bước này nên chưa có bản ghi khi chạy tới đây. Kéo bước "${ref}" lên phía trên hoặc chọn bản ghi cha khác.`, step.id, key);
    case 'otherBranch':
      return err(`Field "${f.name}": bước "${ref}" nằm ở nhánh còn lại của bước Rẽ nhánh phía trên nên không chạy cùng lượt với bước này. Đưa "${ref}" ra trước bước Rẽ nhánh hoặc chọn bản ghi cha khác.`, step.id, key);
    case 'disabled':
      return err(`Field "${f.name}": bước "${ref}" đang tắt. Bật lại bước đó (Ctrl+/) hoặc chọn bản ghi cha khác.`, step.id, key);
    case 'maybe':
      return warn(
        f.type === 'masterdetail'
          ? `Field "${f.name}": bước "${ref}" nằm trong một nhánh rẽ hoặc vòng lặp có thể không chạy, nên có lúc chưa có bản ghi cha và lần chạy sẽ báo lỗi. Đưa "${ref}" ra ngoài để nó luôn chạy trước.`
          : `Field "${f.name}": bước "${ref}" nằm trong một nhánh rẽ hoặc vòng lặp có thể không chạy, nên có lúc field này sẽ trống.`,
        step.id,
        key,
      );
    default:
      return undefined; // always / last
  }
}
