// Step type catalogue, served to the UI via /api/meta (workflow JSON version 2, design 0003).
// `slots` lists the child sequences a container step holds, in reading order (Đúng before Sai);
// it drives the process view (which boxes/columns to draw), the default insert rule and
// validation (which `slots` keys are legal). `category` groups types in the "+" menu and the
// palette. Config options reuse the generator option-definition format (generators/common.js).
//
// Variables (design 0005): `flow` says how the slots run (`sequence`; `loop` with `body`;
// `branch` with `alternatives`) and `exposes` what the step provides to other steps (a record
// alias with its fields, or loop variables; a list of them, entries with `when` applying only
// while the config matches: design 0010). shared/scope.js `analyzeScope` reads both, so a
// new step type only has to declare them. Function-valued keys (`minIterations`) are dropped
// from /api/meta (`serializableNodeTypes`); the browser gets them from shared/scope.js.

// Option `default` is the value a step uses when the key is missing (what the executor, the
// inspector and the card summary assume); `initial`, when present, is what a step added from the
// UI starts with instead (a new Lặp runs 3 times, a hand-written one without `count` runs 0 times).

import { loopMinIterations } from '../../shared/scope.js';
import { QUERY_DEFAULTS } from '../../shared/soql.js';

export const LIMITS = {
  maxRecordsDefault: 50000,
  maxRecordsHard: 200000,
  maxCountPerNode: 100000,
  maxSteps: 2000000,
  maxDepth: 32,
  // Records of each sObject a run sends back for the results table (design 0004); the rest is
  // counted, and downloaded through /api/export.
  previewRows: 200,
  // Query steps (design 0006): rows per Query (LIMIT and jsforce maxFetch), Query steps per
  // workflow, time per query, and how long rows read from an org are reused (same TTL as the
  // sf CLI token cache).
  maxQueryRows: 2000,
  maxQueryNodes: 20,
  queryTimeoutMs: 30000,
  queryTotalMs: 120000, // all Query steps of one run together, well under the HTTP timeouts
  queryCacheTtlMs: 600000,
};

/**
 * Builder defaults per sObject (naming conventions, so they live on the server and are served as
 * meta.queryPresets). `alias` is the suggested pool name; missing keys keep the option defaults.
 */
export const QUERY_PRESETS = {
  User: { alias: 'users', fields: ['Id', 'Name', 'Email'], where: "IsActive = true AND UserType = 'Standard'" },
  Product2: { alias: 'prods', fields: ['Id', 'Name', 'ProductCode'], where: 'IsActive = true' },
  Pricebook2: { alias: 'pb', fields: ['Id', 'Name'], where: 'IsStandard = true', limit: 1 },
  PricebookEntry: { alias: 'pbes', fields: ['Id', 'Product2Id', 'UnitPrice', 'Product2.Name'], where: 'IsActive = true AND Pricebook2.IsStandard = true' },
  RecordType: { alias: 'rts', fields: ['Id', 'Name', 'DeveloperName', 'SobjectType'], where: 'IsActive = true' },
  Case: { fields: ['Id', 'CaseNumber', 'Subject'] },
  Task: { fields: ['Id', 'Subject'] },
  Event: { fields: ['Id', 'Subject'] },
};

const BUILDER = { key: 'mode', in: ['builder'] };
const SOQL = { key: 'mode', in: ['soql'] };
const FILTER = { key: 'filter', in: ['compare'] };
const EACH = { key: 'mode', in: ['each'] };

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
      { key: 'sobject', label: 'sObject', kind: 'string', default: 'Account', suggest: { kind: 'sobject', purpose: 'create' }, help: 'API name, ví dụ Account, Contact, My_Object__c.' },
      { key: 'alias', label: 'Alias', kind: 'string', default: '', help: 'Tên ngắn để bước sau tham chiếu: {{alias.Field}} hoặc Lookup.' },
      { key: 'count', label: 'Số bản ghi mỗi lần chạy', kind: 'integer', default: 1, min: 1, max: LIMITS.maxCountPerNode },
    ],
  },
  {
    type: 'query',
    label: 'Query (đọc org)',
    category: 'data',
    description: 'Đọc bản ghi có sẵn trong org bằng SOQL, chỉ đọc. Kết quả là một pool cho Lookup và bước Chọn bản ghi.',
    slots: [],
    needsOrg: true,
    flow: { kind: 'sequence' },
    exposes: {
      kind: 'record',
      name: { key: 'alias' },
      label: { key: 'sobject' },
      visibleIn: 'downstream',
      members: 'select',
      builtins: [{ key: '$count', valueType: 'number', label: 'Số bản ghi đọc được', level: 'pool' }],
      current: 'none',
      pool: true,
      origin: 'org',
      lookupParent: true,
    },
    options: [
      {
        key: 'mode',
        label: 'Cách nhập',
        kind: 'select',
        default: QUERY_DEFAULTS.mode,
        choices: [
          { value: 'builder', label: 'Chọn sObject và field' },
          { value: 'soql', label: 'Viết SOQL' },
        ],
      },
      { key: 'sobject', label: 'sObject', kind: 'string', default: QUERY_DEFAULTS.sobject, showIf: BUILDER, suggest: { kind: 'sobject', purpose: 'query' }, help: 'API name. Chọn org ở thanh trên để có gợi ý.' },
      { key: 'alias', label: 'Tên pool (alias)', kind: 'string', default: '', help: 'Lookup "Ngẫu nhiên trong pool" và bước Chọn bản ghi dùng tên này. {{accs.$count}} = số bản ghi đọc được.' },
      { key: 'fields', label: 'Field cần lấy', kind: 'list', default: QUERY_DEFAULTS.fields, showIf: BUILDER, suggest: { kind: 'fields', sobjectKey: 'sobject' }, help: 'Mỗi dòng một field. Dùng được field quan hệ như Owner.Name. Id luôn được lấy.' },
      { key: 'where', label: 'Điều kiện (WHERE)', kind: 'string', default: QUERY_DEFAULTS.where, showIf: BUILDER, help: "Cú pháp SOQL, ví dụ Industry = 'Banking' AND CreatedDate = LAST_N_DAYS:30. Để trống = lấy tất cả." },
      { key: 'orderBy', label: 'Sắp xếp (ORDER BY)', kind: 'string', default: QUERY_DEFAULTS.orderBy, showIf: BUILDER, help: 'Giữ thứ tự cố định để cùng seed chọn ra cùng bản ghi.' },
      { key: 'limit', label: 'Số bản ghi tối đa (LIMIT)', kind: 'integer', default: QUERY_DEFAULTS.limit, min: 1, max: LIMITS.maxQueryRows, showIf: BUILDER, help: `Từ 1 đến ${LIMITS.maxQueryRows}.` },
      { key: 'soql', label: 'SOQL', kind: 'text', default: '', rows: 6, monospace: true, showIf: SOQL, help: `Chỉ SELECT. Ví dụ: SELECT Id, Name FROM Account WHERE Industry = 'Banking' ORDER BY Id LIMIT 200. Tối đa ${LIMITS.maxQueryRows} bản ghi.` },
    ],
  },
  {
    type: 'pick',
    label: 'Chọn bản ghi',
    category: 'data',
    description: 'Chọn một bản ghi từ pool (kết quả Query hoặc bản ghi đã sinh) làm bản ghi hiện tại của alias mới. Mỗi lần chạy qua chọn lại.',
    slots: [],
    flow: { kind: 'sequence' },
    exposes: {
      kind: 'record',
      name: { key: 'alias' },
      label: { fromSource: 'from' },
      visibleIn: 'downstream',
      members: { fromSource: 'from' },
      current: 'picked',
      pool: true,
      origin: { fromSource: 'from' },
      lookupParent: true,
    },
    options: [
      { key: 'from', label: 'Chọn từ pool', kind: 'ref', default: '', accepts: { pool: true }, placeholder: '— chọn pool —', empty: '— chưa có pool nào —', help: 'Alias của bước Query, Record hoặc Chọn bản ghi ở phía trên.' },
      { key: 'alias', label: 'Alias', kind: 'string', default: '', help: 'Bước sau dùng {{acc.Name}}, hoặc Lookup "Bản ghi hiện tại" acc.' },
      {
        key: 'mode',
        label: 'Cách chọn',
        kind: 'select',
        default: 'random',
        choices: [
          { value: 'random', label: 'Ngẫu nhiên (có thể lặp lại)' },
          { value: 'unique', label: 'Ngẫu nhiên, không lặp lại' },
          { value: 'sequential', label: 'Lần lượt theo thứ tự (quay vòng)' },
        ],
        help: 'Muốn chạy đúng một lần cho mỗi bản ghi của pool, dùng bước Lặp → "Mỗi bản ghi trong pool".',
      },
      {
        key: 'filter',
        label: 'Lọc',
        kind: 'select',
        default: 'none',
        choices: [
          { value: 'none', label: 'Không lọc' },
          { value: 'compare', label: 'Chỉ bản ghi thỏa điều kiện' },
        ],
      },
      { key: 'filterField', label: 'Field', kind: 'string', default: '', showIf: FILTER, suggest: { kind: 'poolFields', poolKey: 'from' }, help: 'Field của bản ghi trong pool, ví dụ AccountId, Industry hoặc Account.Type.' },
      { key: 'filterOp', label: 'Phép so sánh', kind: 'select', default: 'eq', choices: CONDITION_OPS, showIf: FILTER },
      { key: 'filterValue', label: 'So với', kind: 'string', default: '', vars: 'template', showIf: FILTER, help: 'Giá trị cố định, hoặc {{acc.Id}} để lấy theo bản ghi ở bước trước.' },
      {
        key: 'onEmpty',
        label: 'Khi không còn bản ghi để chọn',
        kind: 'select',
        default: 'skip',
        choices: [
          { value: 'skip', label: 'Bỏ qua các bước phía sau (có cảnh báo)' },
          { value: 'error', label: 'Báo lỗi và dừng' },
        ],
        help: 'Bỏ qua: các bước còn lại của lượt này không chạy (trong Lặp thì sang lần lặp sau).',
      },
    ],
  },
  {
    type: 'loop',
    label: 'Lặp',
    category: 'control',
    description: 'Chạy các bước bên trong nhiều lần: số lần cố định, ngẫu nhiên, hoặc mỗi bản ghi của một pool; rồi đi tiếp xuống bước sau.',
    slots: [{ key: 'body', label: '', empty: 'Thêm bước vào vòng lặp' }],
    flow: { kind: 'loop', body: 'body' },
    minIterations: loopMinIterations,
    // Design 0010: `exposes` is a list; an entry with `when` (same shape as showIf) only applies
    // while the config matches. The first entry is the step's own source (id = step id), the
    // others get the source id `<stepId>#<key>`.
    exposes: [
      {
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
      {
        // The record of the pool the body is running for ("Mỗi bản ghi trong pool").
        key: 'item',
        when: EACH,
        kind: 'record',
        name: { key: 'itemAlias' },
        label: { fromSource: 'from' },
        visibleIn: { inside: 'body' },
        members: { fromSource: 'from' },
        current: 'item',
        pool: false,
        origin: { fromSource: 'from' },
        lookupParent: true,
      },
    ],
    options: [
      {
        key: 'mode',
        label: 'Lặp theo',
        kind: 'select',
        default: 'fixed',
        choices: [
          { value: 'fixed', label: 'Số lần cố định' },
          { value: 'range', label: 'Số lần ngẫu nhiên trong khoảng' },
          { value: 'each', label: 'Mỗi bản ghi trong pool' },
        ],
      },
      { key: 'count', label: 'Số lần lặp', kind: 'integer', default: 0, initial: 3, min: 0, max: LIMITS.maxCountPerNode, showIf: { key: 'mode', in: ['fixed'] } },
      { key: 'min', label: 'Ít nhất', kind: 'integer', default: 1, min: 0, max: LIMITS.maxCountPerNode, showIf: { key: 'mode', in: ['range'] } },
      { key: 'max', label: 'Nhiều nhất', kind: 'integer', default: 1, initial: 5, min: 0, max: LIMITS.maxCountPerNode, showIf: { key: 'mode', in: ['range'] } },
      { key: 'from', label: 'Lặp qua pool', kind: 'ref', default: '', showIf: EACH, accepts: { pool: true }, placeholder: '— chọn pool —', empty: '— chưa có pool nào phía trên —', help: 'Alias của bước Query, Record hoặc Chọn bản ghi ở phía trên. Thân vòng lặp chạy một lần cho mỗi bản ghi, theo thứ tự của pool.' },
      { key: 'itemAlias', label: 'Tên bản ghi đang lặp', kind: 'string', default: '', showIf: EACH, help: 'Bên trong vòng lặp dùng {{acc.Name}}, hoặc Lookup "Bản ghi hiện tại" acc.' },
      { key: 'alias', label: 'Tên biến lặp', kind: 'string', default: 'loop', help: 'Dùng {{loop.index}} (từ 1), {{loop.index0}} (từ 0), {{loop.count}}. Khi lặp theo pool, count = số bản ghi của pool.' },
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
