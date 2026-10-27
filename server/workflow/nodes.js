// Step type catalogue, served to the UI via /api/meta (workflow JSON version 2, design 0003).
// `slots` lists the child sequences a container step holds, in reading order (Đúng before Sai);
// it drives the process view (which boxes/columns to draw), the default insert rule and
// validation (which `slots` keys are legal). `category` groups types in the "+" menu and the
// palette. Config options reuse the generator option-definition format (generators/common.js).

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
      { key: 'left', label: 'Giá trị', kind: 'string', default: 'loop.index', help: 'Ví dụ acc.Industry hoặc loop.index.', showIf: { key: 'kind', in: ['compare'] } },
      { key: 'op', label: 'Phép so sánh', kind: 'select', default: 'eq', choices: CONDITION_OPS, showIf: { key: 'kind', in: ['compare'] } },
      { key: 'right', label: 'So với', kind: 'string', default: '', showIf: { key: 'kind', in: ['compare'] } },
    ],
  },
];

export const nodeTypeMap = new Map(NODE_TYPES.map((n) => [n.type, n]));

/** Slot keys of a step type in reading order (for shared/workflow-tree.js). */
export const slotKeys = (type) => nodeTypeMap.get(type)?.slots.map((s) => s.key) ?? [];
