// Step type catalogue, served to the UI via /api/meta (workflow JSON version 2, design 0003).
// `slots` lists the child sequences a container step holds, in reading order (Đúng before Sai);
// it drives the process view (which boxes/columns to draw), the default insert rule and
// validation (which `slots` keys are legal). `category` groups types in the "+" menu and the
// palette. Config options reuse the generator option-definition format (generators/common.js).
//
// Variables (design 0005): `flow` says how the slots run (`sequence`; `loop` with `body`;
// `branch` with `alternatives`) and `exposes` what the step provides to other steps (a record
// alias with its fields, or loop variables). shared/scope.js `analyzeScope` reads both, so a
// new step type only has to declare them. Function-valued keys (`minIterations`) are dropped
// from /api/meta (`serializableNodeTypes`); the browser gets them from shared/scope.js.

import { loopMinIterations } from '../../shared/scope.js';

export const LIMITS = {
  maxRecordsDefault: 50000,
  maxRecordsHard: 200000,
  maxCountPerNode: 100000,
  maxSteps: 2000000,
  maxDepth: 32,
};

export const STEP_CATEGORIES = [
  { key: 'data', label: 'Dữ liệu' },
  { key: 'control', label: 'Điều khiển' },
];

export const CONDITION_OPS = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'contains', label: 'chứa' },
  { value: 'empty', label: 'trống' },
  { value: 'notEmpty', label: 'không trống' },
  { value: 'divisibleBy', label: 'chia hết cho' },
];

export const NODE_TYPES = [
  {
    type: 'record',
    label: 'Record',
    category: 'data',
    description: 'Sinh bản ghi cho một sObject. Mỗi lần chạy qua bước này sinh "Số bản ghi" bản ghi.',
    slots: [],
    flow: { kind: 'sequence' },
    exposes: {
      kind: 'record',
      name: { key: 'alias', fallback: 'id' },
      label: { key: 'sobject' },
      visibleIn: 'downstream',
      members: 'fields',
      builtins: [{ key: '$n', valueType: 'number', label: 'Số thứ tự bản ghi (n trong acc#n)' }],
      current: 'last',
      pool: true,
      origin: 'generated',
      lookupParent: true,
    },
    options: [
      { key: 'sobject', label: 'sObject', kind: 'string', default: 'Account', help: 'API name, ví dụ Account, Contact, My_Object__c.' },
      { key: 'alias', label: 'Alias', kind: 'string', default: '', help: 'Tên ngắn để bước sau tham chiếu: {{alias.Field}} hoặc Lookup.' },
      { key: 'count', label: 'Số bản ghi mỗi lần chạy', kind: 'integer', default: 1, min: 1, max: LIMITS.maxCountPerNode },
    ],
  },
  {
    type: 'loop',
    label: 'Lặp',
    category: 'control',
    description: 'Chạy các bước bên trong N lần, rồi đi tiếp xuống bước sau.',
    slots: [{ key: 'body', label: '', empty: 'Thêm bước vào vòng lặp' }],
    flow: { kind: 'loop', body: 'body' },
    minIterations: loopMinIterations,
    exposes: {
      kind: 'vars',
      name: { key: 'alias', default: 'loop' },
      label: 'Vòng lặp',
      visibleIn: { inside: 'body' },
      members: [
        { key: 'index', valueType: 'number', label: 'Lần lặp hiện tại (từ 1)' },
        { key: 'index0', valueType: 'number', label: 'Lần lặp hiện tại (từ 0)' },
        { key: 'count', valueType: 'number', label: 'Tổng số lần lặp' },
      ],
    },
    options: [
      {
        key: 'mode',
        label: 'Số lần',
        kind: 'select',
        default: 'fixed',
        choices: [
          { value: 'fixed', label: 'Cố định' },
          { value: 'range', label: 'Ngẫu nhiên trong khoảng' },
        ],
      },
      { key: 'count', label: 'Số lần lặp', kind: 'integer', default: 3, min: 0, max: LIMITS.maxCountPerNode, showIf: { key: 'mode', in: ['fixed'] } },
      { key: 'min', label: 'Ít nhất', kind: 'integer', default: 1, min: 0, max: LIMITS.maxCountPerNode, showIf: { key: 'mode', in: ['range'] } },
      { key: 'max', label: 'Nhiều nhất', kind: 'integer', default: 5, min: 0, max: LIMITS.maxCountPerNode, showIf: { key: 'mode', in: ['range'] } },
      { key: 'alias', label: 'Tên biến lặp', kind: 'string', default: 'loop', help: 'Dùng {{loop.index}} (từ 1), {{loop.index0}} (từ 0), {{loop.count}}.' },
    ],
  },
  {
    type: 'branch',
    label: 'Rẽ nhánh',
    category: 'control',
    description: 'Chạy nhánh Đúng hoặc Sai tùy điều kiện, rồi đi tiếp xuống bước sau.',
    slots: [
      { key: 'true', label: 'Đúng' },
      { key: 'false', label: 'Sai', hint: 'Để trống: không làm gì' },
    ],
    flow: { kind: 'branch', alternatives: ['true', 'false'] },
    options: [
      {
        key: 'kind',
        label: 'Loại điều kiện',
        kind: 'select',
        default: 'chance',
        choices: [
          { value: 'chance', label: 'Xác suất' },
          { value: 'compare', label: 'So sánh giá trị' },
        ],
      },
      { key: 'probability', label: 'Xác suất đi nhánh đúng (0–1)', kind: 'number', default: 0.5, min: 0, max: 1, step: 0.05, showIf: { key: 'kind', in: ['chance'] } },
      { key: 'left', label: 'Giá trị', kind: 'string', vars: 'path', default: 'loop.index', help: 'Bấm {x} để chọn biến, ví dụ acc.Industry hoặc loop.index.', showIf: { key: 'kind', in: ['compare'] } },
      { key: 'op', label: 'Phép so sánh', kind: 'select', default: 'eq', choices: CONDITION_OPS, showIf: { key: 'kind', in: ['compare'] } },
      { key: 'right', label: 'So với', kind: 'string', default: '', showIf: { key: 'kind', in: ['compare'] } },
    ],
  },
];

export const nodeTypeMap = new Map(NODE_TYPES.map((n) => [n.type, n]));

/** Slot keys of a step type in reading order (for shared/workflow-tree.js). */
export const slotKeys = (type) => nodeTypeMap.get(type)?.slots.map((s) => s.key) ?? [];

/** NODE_TYPES without function-valued keys (minIterations), as served by /api/meta. */
export function serializableNodeTypes() {
  return NODE_TYPES.map((t) => Object.fromEntries(Object.entries(t).filter(([, v]) => typeof v !== 'function')));
}
