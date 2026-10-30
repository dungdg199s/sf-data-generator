import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSfCli } from '../server/sf/cli.js';
import { createSfClient } from '../server/sf/client.js';
import { insertRecords, toSObject, createInserter, errorPattern, MAX_ERROR_GROUPS } from '../server/sf/insert.js';
import { createRun } from '../server/workflow/executor.js';
import { mapDescribe, mapQueryFields } from '../server/sf/describe-map.js';
import { createQueryCache, prefetchQueries, fingerprint } from '../server/sf/query.js';
import { WorkflowError } from '../server/workflow/schema.js';
import { wf, query, pick, record, loop } from './helpers.js';

test('listOrgs merges groups and de-duplicates by username', async () => {
  const run = async () => ({
    stdout: JSON.stringify({
      status: 0,
      result: {
        nonScratchOrgs: [{ alias: 'dev', username: 'a@x.com', instanceUrl: 'https://a', isDefaultUsername: true }],
        devHubs: [{ alias: 'dev', username: 'a@x.com' }],
        scratchOrgs: [{ alias: 'so', username: 'b@x.com' }],
      },
    }),
  });
  const orgs = await createSfCli({ run }).listOrgs();
  assert.deepEqual(orgs.map((o) => [o.alias, o.isDefault, o.isScratch]), [['dev', true, false], ['so', false, true]]);
});

test('missing sf binary gives an actionable message', async () => {
  const run = async () => ({ stdout: '', stderr: '', code: 'ENOENT' });
  await assert.rejects(createSfCli({ run }).listOrgs(), /Chưa cài Salesforce CLI/);
});

test('toSObject resolves refs, drops nulls, splits geolocation', () => {
  const ids = new Map([['acc#1', '001000000000001AAA']]);
  const out = toSObject({ sobject: 'Contact', fields: { AccountId: { $ref: 'acc#1' }, Email: null, Loc__c: { latitude: 1, longitude: 2 } } }, ids);
  assert.deepEqual(out, { AccountId: '001000000000001AAA', Loc__Latitude__s: 1, Loc__Longitude__s: 2 });
});

test('insertRecords inserts parents before children and cascades failures', async () => {
  const calls = [];
  let n = 0;
  const client = {
    async create(_target, sobject, recs) {
      calls.push(recs.map(() => sobject));
      return recs.map((r) => (r.Name === 'bad' ? { success: false, errors: [{ statusCode: 'X', message: 'nope' }] } : { success: true, id: `id${++n}` }));
    },
  };
  const records = [
    { ref: 'acc#1', sobject: 'Account', fields: { Name: 'ok' } },
    { ref: 'acc#2', sobject: 'Account', fields: { Name: 'bad' } },
    { ref: 'con#1', sobject: 'Contact', fields: { AccountId: { $ref: 'acc#1' } } },
    { ref: 'con#2', sobject: 'Contact', fields: { AccountId: { $ref: 'acc#2' } } },
  ];
  const res = await insertRecords(client, 'dev', records);
  assert.deepEqual(calls, [['Account', 'Account'], ['Contact']]);
  assert.equal(res.inserted, 2);
  assert.deepEqual(res.errors.map((e) => e.ref), ['acc#2', 'con#2']);
});

test('mapDescribe picks sensible defaults and skips non-createable fields', () => {
  const { fields } = mapDescribe({
    name: 'Contact',
    fields: [
      { name: 'Id', type: 'id', createable: false },
      { name: 'LastName', type: 'string', length: 80, createable: true, nillable: false },
      { name: 'Email', type: 'email', createable: true, nillable: true },
      { name: 'AccountId', type: 'reference', referenceTo: ['Account'], createable: true, nillable: true, relationshipOrder: null },
      { name: 'Level__c', type: 'picklist', createable: true, nillable: true, picklistValues: [{ value: 'A', active: true }, { value: 'B', active: false }] },
    ],
  });
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.equal(fields[0].name, 'LastName');
  assert.equal(byName.LastName.options.mode, 'lastName');
  assert.equal(byName.AccountId.type, 'lookup');
  assert.deepEqual(byName.AccountId.referenceTo, ['Account']);
  assert.deepEqual(byName.AccountId.options, { mode: 'current', ref: '', referenceTo: ['Account'] }, 'referenceTo narrows the parent list (0005)');
  assert.deepEqual(byName.Level__c.options.values, ['A']);
  assert.ok(!byName.Id);
});

test('mapDescribe returns nameField (0012 G)', () => {
  const task = mapDescribe({
    name: 'Task',
    fields: [
      { name: 'Id', type: 'id', createable: false },
      { name: 'Subject', type: 'combobox', length: 255, createable: true, nillable: true, nameField: true },
      { name: 'OwnerId', type: 'reference', referenceTo: ['User'], createable: true, nillable: false, defaultedOnCreate: true },
    ],
  });
  assert.equal(task.nameField, 'Subject');
  assert.deepEqual(task.fields.filter((f) => f.required), [], 'OwnerId is defaulted on create');
  // CaseNumber is the name field but not createable: still reported, not in fields.
  const kase = mapDescribe({ name: 'Case', fields: [{ name: 'CaseNumber', type: 'string', createable: false, autoNumber: true, nameField: true }] });
  assert.equal(kase.nameField, 'CaseNumber');
  assert.deepEqual(kase.fields, []);
  assert.equal(mapDescribe({ name: 'X__c', fields: [] }).nameField, null);
});

function fakeJsforce() {
  const made = [];
  const createConnection = (options) => {
    const conn = {
      options,
      calls: [],
      async describe(name) {
        conn.calls.push(['describe', name]);
        return { name };
      },
      async describeGlobal() {
        const err = Object.assign(new Error('Session expired or invalid'), { errorCode: 'INVALID_SESSION_ID' });
        throw err;
      },
      query(soql, options) {
        conn.calls.push(['query', soql, options]);
        return { then: (ok, ko) => Promise.resolve({ records: [{ attributes: { type: 'Account' }, Id: '001A' }], totalSize: 1, done: true }).then(ok, ko) };
      },
      sobject(type) {
        return {
          create: async (records, opts) => {
            conn.calls.push(['create', type, records.length, opts]);
            return records.map((_, i) => ({ id: `id${i}`, success: true, errors: [] }));
          },
        };
      },
    };
    made.push(conn);
    return conn;
  };
  return { made, createConnection };
}

test('sf client builds one jsforce connection per org from the sf CLI token', async () => {
  const lookups = [];
  const cli = {
    async getConnection(target, { refresh = false } = {}) {
      lookups.push([target, refresh]);
      return { accessToken: refresh ? 'fresh' : 'tok', instanceUrl: 'https://x.my.salesforce.com', apiVersion: '62.0' };
    },
  };
  const { made, createConnection } = fakeJsforce();
  const client = createSfClient({ cli, createConnection });

  await client.describe('dev', 'Account');
  const res = await client.create('dev', 'Contact', [{ LastName: 'A' }, { LastName: 'B' }]);
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].options.version, '62.0');
  assert.equal(made[0].options.accessToken, 'tok');
  assert.deepEqual(made[0].calls[1], ['create', 'Contact', 2, { allOrNone: false }]);
  assert.equal(res.length, 2);

  // refreshFn (called by jsforce on INVALID_SESSION_ID) asks the CLI for a fresh token.
  const token = await new Promise((resolve, reject) => made[0].options.refreshFn(made[0], (err, t) => (err ? reject(err) : resolve(t))));
  assert.equal(token, 'fresh');
  assert.deepEqual(lookups, [['dev', false], ['dev', true]]);
});

test('sf client reports Salesforce errors as 502 with the error code', async () => {
  const cli = { getConnection: async () => ({ accessToken: 't', instanceUrl: 'https://x', apiVersion: '62.0' }) };
  const client = createSfClient({ cli, createConnection: fakeJsforce().createConnection });
  await assert.rejects(client.describeGlobal('dev'), (e) => e.status === 502 && /INVALID_SESSION_ID/.test(e.message));
});

test('sf client retries the CLI lookup after a failure instead of caching it', async () => {
  let n = 0;
  const cli = {
    async getConnection() {
      if (++n === 1) throw new Error('not logged in');
      return { accessToken: 't', instanceUrl: 'https://x', apiVersion: '62.0' };
    },
  };
  const client = createSfClient({ cli, createConnection: fakeJsforce().createConnection });
  await assert.rejects(client.describe('dev', 'Account'), /not logged in/);
  assert.deepEqual(await client.describe('dev', 'Account'), { name: 'Account' });
});

// ---------- Query (design 0006) ----------

test('sf client query uses jsforce autoFetch up to maxFetch and never scanAll; slow queries time out', async () => {
  const cli = { getConnection: async () => ({ accessToken: 't', instanceUrl: 'https://x', apiVersion: '62.0' }) };
  const { made, createConnection } = fakeJsforce();
  const client = createSfClient({ cli, createConnection });
  const res = await client.query('dev', 'SELECT Id FROM Account', { maxFetch: 50 });
  assert.equal(res.records[0].Id, '001A');
  assert.deepEqual(made[0].calls[0], ['query', 'SELECT Id FROM Account', { autoFetch: true, maxFetch: 50 }]);
  const slow = createSfClient({ cli, createConnection: () => ({ query: () => new Promise(() => {}) }) });
  await assert.rejects(slow.query('dev', 'SELECT Id FROM Account', { maxFetch: 1, timeoutMs: 20 }), (e) => e.status === 502 && e.cause?.errorCode === 'QUERY_TIMEOUT');
});

const accRows = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ attributes: { type: 'Account' }, Id: `001${i}`, Name: `A${i}`, ...extra }));
function fakeQueryClient(answer) {
  const calls = [];
  return {
    calls,
    async query(org, soql, opts) {
      calls.push([org, soql, opts]);
      return typeof answer === 'function' ? answer(soql, calls.length) : answer;
    },
  };
}

test('prefetch without org returns sample rows with a warning (no Salesforce call)', async () => {
  const client = fakeQueryClient(() => assert.fail('must not query'));
  const w = wf([query('q', 'accs', { fields: ['Id', 'Name', 'Owner.Name'] }), pick('p', 'acc', 'accs')]);
  const pre = await prefetchQueries({ client, org: null, workflow: w, cache: createQueryCache() });
  assert.equal(pre.results.q.records.length, 5);
  assert.equal(pre.results.q.records[0].Id, 'mẫu:accs#1');
  assert.deepEqual(pre.results.q.records[0].Owner, { Name: 'Owner.Name mẫu 1' });
  assert.equal(pre.queries[0].source, 'sample');
  assert.equal(pre.warnings[0].nodeId, 'q');
  assert.equal(pre.warnings[0].message, 'Chưa chọn org nên bước Query "accs" dùng 5 bản ghi mẫu (Id giả). Chọn org ở thanh trên để đọc dữ liệu thật.');
});

test('prefetch reads enabled queries in order, strips attributes and warns on 0 rows / truncation', async () => {
  const client = fakeQueryClient((soql) => (/Contact/.test(soql) ? { records: [], totalSize: 0, done: true } : { records: accRows(2000), totalSize: 15342, done: false }));
  const w = wf([
    query('q', 'accs', { mode: 'soql', soql: 'SELECT Id, Name FROM Account ORDER BY Id' }),
    { ...query('off', 'offs'), disabled: true },
    query('c', 'cons', { sobject: 'Contact' }),
  ]);
  const pre = await prefetchQueries({ client, org: 'dev', workflow: w, cache: createQueryCache() });
  assert.deepEqual(client.calls.map((c) => [c[0], c[1], c[2].maxFetch]), [['dev', 'SELECT Id, Name FROM Account ORDER BY Id', 2000], ['dev', 'SELECT Id, Name FROM Contact ORDER BY Id LIMIT 200', 200]]);
  assert.deepEqual(pre.results.q.records[0], { Id: '0010', Name: 'A0' });
  assert.equal(pre.queries[0].truncated, true);
  assert.deepEqual(pre.warnings.map((x) => x.message), [
    'Query "accs" khớp 15 342 bản ghi nhưng chỉ lấy 2 000 bản ghi đầu theo ORDER BY. Thu hẹp WHERE nếu cần đúng nhóm bản ghi.',
    'Query "cons" không trả về bản ghi nào trong org "dev". Kiểm tra "Điều kiện (WHERE)"; Lookup và bước Chọn bản ghi dùng pool này sẽ không có gì để chọn.',
  ]);
});

test('prefetch maps INVALID_FIELD to an issue on fields (other Salesforce errors are 502 with the step)', async () => {
  const sfFail = (errorCode, message) => () => { throw Object.assign(new Error(`Salesforce: ${errorCode}: ${message}`), { status: 502, cause: { errorCode, message } }); };
  const w = wf([query('q', 'accs', { fields: ['Id', 'Nme'] })]);
  await assert.rejects(
    prefetchQueries({ client: fakeQueryClient(sfFail('INVALID_FIELD', "\nSELECT Id, Nme FROM Account\n           ^\nERROR at Row:1:Column:12\nNo such column 'Nme' on entity 'Account'.")), org: 'dev', workflow: w }),
    (e) => e instanceof WorkflowError && e.issues[0].nodeId === 'q' && e.issues[0].field === 'fields'
      && e.issues[0].message === 'Salesforce không có field "Nme" trên Account hoặc bạn không có quyền đọc (INVALID_FIELD). Sửa tên ở "Field cần lấy" hoặc bấm "Chọn field…".',
  );
  const inWhere = wf([query('q', 'accs', { where: 'Indstry = 1' })]);
  await assert.rejects(prefetchQueries({ client: fakeQueryClient(sfFail('INVALID_FIELD', "No such column 'Indstry' on entity 'Account'.")), org: 'dev', workflow: inWhere }), (e) => e.issues[0].field === 'where');
  await assert.rejects(prefetchQueries({ client: fakeQueryClient(sfFail('INVALID_TYPE', "sObject type 'Acount' is not supported.")), org: 'dev', workflow: wf([query('q', 'accs', { sobject: 'Acount' })]) }),
    (e) => e.issues[0].field === 'sobject' && /^Org "dev" không có sObject "Acount"/.test(e.issues[0].message));
  await assert.rejects(prefetchQueries({ client: fakeQueryClient(sfFail('MALFORMED_QUERY', 'line1\nunexpected token: AND')), org: 'dev', workflow: w }),
    (e) => e.issues[0].field === 'where' && e.issues[0].message === 'SOQL sai cú pháp (MALFORMED_QUERY): unexpected token: AND. Kiểm tra ô "Điều kiện (WHERE)".');
  await assert.rejects(prefetchQueries({ client: fakeQueryClient(sfFail('REQUEST_LIMIT_EXCEEDED', 'TotalRequests Limit exceeded.')), org: 'dev', workflow: w }),
    (e) => e.status === 502 && e.issues[0].nodeId === 'q' && e.message === 'Bước Query "accs": Salesforce: REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.');
  // Not logged in (sf CLI): the hint to preview with sample rows.
  await assert.rejects(prefetchQueries({ client: fakeQueryClient(() => { throw new Error('Org "dev" chưa đăng nhập hoặc token hết hạn. Chạy: sf org login web --alias dev'); }), org: 'dev', workflow: w }),
    (e) => /sf org login web --alias dev Hoặc chọn "— không kết nối —" để xem trước bằng bản ghi mẫu\.$/.test(e.message) && e.issues[0].nodeId === 'q');
});

test('cache is reused, bypassed by refresh and cleared after insert', async () => {
  let now = 0;
  const cache = createQueryCache({ ttlMs: 1000, now: () => now });
  const client = fakeQueryClient((_s, n) => ({ records: accRows(n), totalSize: n, done: true }));
  const w = wf([query('q', 'accs')]);
  const a = await prefetchQueries({ client, org: 'dev', workflow: w, cache });
  const b = await prefetchQueries({ client, org: 'dev', workflow: w, cache });
  assert.equal(client.calls.length, 1);
  assert.equal(b.queries[0].source, 'cache');
  assert.equal(b.queries[0].fetchedAt, a.queries[0].fetchedAt, 'the read time of the cached rows');
  const c = await prefetchQueries({ client, org: 'dev', workflow: w, cache, refresh: true });
  assert.equal(client.calls.length, 2);
  assert.equal(c.queries[0].count, 2);
  cache.invalidateOrg('dev');
  await prefetchQueries({ client, org: 'dev', workflow: w, cache });
  assert.equal(client.calls.length, 3);
  now = 5000; // TTL
  await prefetchQueries({ client, org: 'dev', workflow: w, cache });
  assert.equal(client.calls.length, 4);
  const small = createQueryCache({ maxEntries: 2 });
  for (const k of ['a', 'b', 'c']) small.set('dev', k, 1, {});
  assert.equal(small.size, 2);
  assert.equal(small.get('dev', 'a', 1), null);
});

test('expectQueries mismatch is a 409 before any write, naming the Query', async () => {
  const w = wf([query('q', 'accs')]);
  const before = accRows(200).map(({ attributes, ...r }) => r);
  const client = fakeQueryClient(() => ({ records: accRows(201), totalSize: 201, done: true }));
  await assert.rejects(
    prefetchQueries({ client, org: 'dev', workflow: w, expect: { q: { fingerprint: fingerprint(before), count: 200, fetchedAt: '2026-10-27T10:32:05.120Z' } }, preview: false }),
    (e) => e.status === 409 && /^Dữ liệu trong org đã thay đổi từ lần xem trước/.test(e.message)
      && e.issues[0].nodeId === 'q'
      && /^Query "accs" lúc xem trước có 200 bản ghi \(đọc \d\d:\d\d\), bây giờ đọc lại thì khác \(201 bản ghi\)\. Chưa ghi gì vào org\. Bấm Xem trước để xem dữ liệu mới rồi Insert lại\.$/.test(e.issues[0].message),
  );
  const same = await prefetchQueries({ client, org: 'dev', workflow: w, expect: { q: fingerprint(accRows(201).map(({ attributes, ...r }) => r)) } });
  assert.equal(same.queries[0].count, 201);
});

test('insertRecords sends existing Ids as-is in the first wave', async () => {
  const calls = [];
  const client = { async create(_t, sobject, recs) { calls.push([sobject, recs]); return recs.map((_, i) => ({ success: true, id: `003${i}` })); } };
  const res = await insertRecords(client, 'dev', [{ ref: 'con#1', sobject: 'Contact', fields: { LastName: 'A', AccountId: '001000000000001AAA' } }]);
  assert.equal(res.inserted, 1);
  assert.deepEqual(calls, [['Contact', [{ LastName: 'A', AccountId: '001000000000001AAA' }]]]);
});

test('mapQueryFields lists every field: Id, the name field, then by label', () => {
  const r = mapQueryFields({ name: 'Account', label: 'Account', fields: [
    { name: 'OwnerId', label: 'Owner ID', type: 'reference', referenceTo: ['User'], relationshipName: 'Owner', filterable: true, sortable: true, createable: true },
    { name: 'Name', label: 'Account Name', type: 'string', nameField: true },
    { name: 'CreatedDate', label: 'Created Date', type: 'datetime', createable: false },
    { name: 'Id', label: 'Account ID', type: 'id' },
  ] });
  assert.equal(r.nameField, 'Name');
  assert.deepEqual(r.fields.map((f) => f.name), ['Id', 'Name', 'CreatedDate', 'OwnerId']);
  assert.deepEqual(r.fields[3], { name: 'OwnerId', label: 'Owner ID', type: 'reference', referenceTo: ['User'], relationshipName: 'Owner', filterable: true, sortable: true });
});

// ---------- review fixes (0006 "Sửa sau review") ----------

test('prefetch re-keys rows to the SELECT spelling and never asks jsforce for LIMIT 0', async () => {
  const client = fakeQueryClient(() => ({ records: [{ attributes: {}, Id: '001', Name: 'Acme', Owner: { attributes: {}, Name: 'Lan' } }], totalSize: 1, done: true }));
  const pre = await prefetchQueries({ client, org: 'dev', workflow: wf([query('q', 'accs', { mode: 'soql', soql: 'SELECT id, name, owner.name FROM Account ORDER BY Id' })]) });
  assert.deepEqual(pre.results.q.records[0], { id: '001', name: 'Acme', owner: { name: 'Lan' } });
  const zero = await prefetchQueries({ client, org: 'dev', workflow: wf([query('z', 'none', { mode: 'soql', soql: 'SELECT Id FROM Account ORDER BY Id LIMIT 0' })]) });
  assert.equal(client.calls.length, 1, 'no call for LIMIT 0');
  assert.deepEqual(zero.results.z.records, []);
});

test('prefetch refuses unsafe SOQL even when validation was skipped', async () => {
  const client = fakeQueryClient(() => assert.fail('must not query'));
  for (const config of [{ mode: 'soql', soql: 'SELECT Id FROM Account UPDATE VIEWSTAT' }, { where: "Name = 'x' UPDATE TRACKING" }]) {
    await assert.rejects(prefetchQueries({ client, org: 'dev', workflow: wf([query('q', 'accs', config)]) }), (e) => e instanceof WorkflowError && e.issues[0].code === 'update');
  }
});

test('prefetch stops with an issue once the total time budget is used up', async () => {
  let t = 0;
  const clock = () => new Date(t);
  const client = fakeQueryClient(() => { t += 70000; return { records: accRows(1), totalSize: 1, done: true }; });
  const w = wf([query('a', 'as'), query('b', 'bs', { sobject: 'Contact' }), query('c', 'cs', { sobject: 'Lead' })]);
  await assert.rejects(prefetchQueries({ client, org: 'dev', workflow: w, clock, budgetMs: 120000 }), (e) => e instanceof WorkflowError
    && e.issues[0].nodeId === 'c'
    && e.issues[0].message === 'Các bước Query đọc org quá 120 giây nên đã dừng ở bước Query "cs" (chưa ghi gì vào org). Bớt bước Query, thu hẹp "Điều kiện (WHERE)" hoặc giảm LIMIT rồi chạy lại.');
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1][2].timeoutMs, 30000);
  // The last query only gets what is left of the budget.
  t = 0;
  const calls = [];
  const slow = { async query(_o, _s, opts) { calls.push(opts.timeoutMs); t += 100000; return { records: [], totalSize: 0, done: true }; } };
  await prefetchQueries({ client: slow, org: 'dev', workflow: wf([query('a', 'as'), query('b', 'bs', { sobject: 'Contact' })]), clock, budgetMs: 120000 }).catch(() => {});
  assert.deepEqual(calls, [30000, 20000]);
});

test('the query cache is keyed by org identity (instance URL + username), not the alias', async () => {
  const cache = createQueryCache();
  const who = { dev: 'https://a|u@x', dev2: 'https://a|u@x', other: 'https://b|v@y' };
  const client = fakeQueryClient(() => ({ records: accRows(1), totalSize: 1, done: true }));
  client.identity = async (org) => who[org];
  const w = wf([query('q', 'accs')]);
  await prefetchQueries({ client, org: 'dev', workflow: w, cache });
  const again = await prefetchQueries({ client, org: 'dev2', workflow: w, cache });
  assert.equal(client.calls.length, 1, 'two aliases of one org share the rows');
  assert.equal(again.queries[0].org, 'dev2');
  who.dev = 'https://b|v@y'; // alias re-pointed to another org
  await prefetchQueries({ client, org: 'dev', workflow: w, cache });
  assert.equal(client.calls.length, 2);
  cache.invalidateOrg('https://a|u@x');
  await prefetchQueries({ client, org: 'dev2', workflow: w, cache });
  assert.equal(client.calls.length, 3);
  // The real client's identity comes from the sf CLI.
  const real = createSfClient({ cli: { getConnection: async () => ({ instanceUrl: 'https://x', username: 'me@x', accessToken: 't' }) }, createConnection: fakeJsforce().createConnection });
  assert.equal(await real.identity('dev'), 'https://x|me@x');
});

// ---------- windowed inserter (design 0004) ----------

/** Fake client: Ids by sObject, `fail(record)` → SaveResult errors, optional `gate` to hold a call. */
function fakeClient({ fail = () => null, gate } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    async create(_target, sobject, recs) {
      calls.push({ sobject, recs });
      if (gate) await gate(calls.length);
      return recs.map((r) => {
        const errors = fail(r, sobject);
        return errors ? { success: false, errors } : { success: true, id: `${sobject.slice(0, 3)}${String(++n).padStart(4, '0')}` };
      });
    },
  };
}
const acc = (i) => ({ ref: `acc#${i}`, sobject: 'Account', nodeId: 'a', fields: { Name: `A${i}` } });
const con = (i, parent) => ({ ref: `con#${i}`, sobject: 'Contact', nodeId: 'c', fields: { LastName: `C${i}`, AccountId: { $ref: `acc#${parent}` } } });

test('windowed insert resolves parents from earlier windows (and the same window in waves)', async () => {
  const client = fakeClient();
  const ins = createInserter(client, 'dev', { window: 3, keepId: (ref) => ref.startsWith('acc#') });
  for (const r of [acc(1), con(1, 1), acc(2), con(2, 1), con(3, 2), con(4, 2), con(5, 1)]) await ins.push(r);
  const res = await ins.end();
  assert.equal(res.inserted, 7);
  // window 1: acc#1 then (wave 2) con#1 + acc#2… acc#2 has no deps, so wave 1 = [acc#1, acc#2]
  assert.deepEqual(client.calls.map((c) => [c.sobject, c.recs.length]), [['Account', 2], ['Contact', 1], ['Contact', 3], ['Contact', 1]]);
  const accIds = Object.fromEntries(Object.entries(res.ids).filter(([k]) => k.startsWith('acc#')));
  assert.deepEqual(client.calls[2].recs.map((r) => r.AccountId), [accIds['acc#1'], accIds['acc#2'], accIds['acc#2']]);
  assert.deepEqual(Object.keys(res.ids).sort(), ['acc#1', 'acc#2'], 'keepId limits retained Ids');
});

test('failure cascades across windows, grouped, with the parent ref and the field Salesforce names', async () => {
  const client = fakeClient({ fail: (r) => (r.Name === 'A2' ? [{ statusCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [Phone]', fields: ['Phone'] }] : null) });
  const ins = createInserter(client, 'dev', { window: 2, keepId: (ref) => ref.startsWith('acc#') });
  for (const r of [acc(1), acc(2), con(1, 2), con(2, 1), con(3, 2)]) await ins.push(r);
  const res = await ins.end();
  assert.equal(res.inserted, 2);
  assert.deepEqual(res.errors.map((e) => [e.ref, e.message, e.parentRef ?? null]), [
    ['acc#2', 'REQUIRED_FIELD_MISSING: Required fields are missing: [Phone] [Phone]', null],
    ['con#1', 'Bỏ qua vì bản ghi cha lỗi.', 'acc#2'],
    ['con#3', 'Bỏ qua vì bản ghi cha lỗi.', 'acc#2'],
  ]);
  assert.equal(res.errors[0].field, undefined, 'Phone is not a field of the record');
  assert.deepEqual(res.errorGroups.map((g) => [g.sobject, g.nodeId, g.count, g.refs]), [['Contact', 'c', 2, ['con#1', 'con#3']], ['Account', 'a', 1, ['acc#2']]]);
  assert.deepEqual(res.bySobject, { Account: { inserted: 1, failed: 1 }, Contact: { inserted: 1, failed: 2 } });

  const named = fakeClient({ fail: (r) => (r.LastName === 'C1' ? [{ statusCode: 'X', message: 'bad', fields: ['lastname'] }] : null) });
  const one = await insertRecords(named, 'dev', [acc(1), con(1, 1)]);
  assert.equal(one.errors[0].field, 'fields.LastName');
  assert.equal(one.errorGroups[0].field, 'fields.LastName');
});

test('window 2000 keeps batches full for nested Account→Contact (4 000 records ⇒ 20 calls)', async () => {
  const w = wf([loop('l', { count: 800 }, [record('a', 'Account', 'acc', [{ name: 'Name', type: 'text', options: {} }]), loop('m', { count: 4 }, [record('c', 'Contact', 'con', [{ name: 'AccountId', type: 'lookup', options: { ref: 'acc' } }])])])]);
  const run = createRun(w, { seed: 1 });
  const client = fakeClient();
  const ins = createInserter(client, 'dev', { keepId: (ref) => ref.startsWith('acc#') });
  for (const r of run.records()) await ins.push(r);
  const res = await ins.end();
  assert.equal(res.inserted, 4000);
  assert.equal(client.calls.length, 20);
  assert.ok(client.calls.every((c) => c.recs.length === 200));
  assert.ok(client.calls.every((c) => c.recs.every((r) => c.sobject === 'Account' || /^Acc\d+$/.test(r.AccountId))), 'every Contact got its Account Id');
});

test('stops after 3 all-failing batches of one sObject and reports stopped', async () => {
  const client = fakeClient({ fail: (_r, s) => (s === 'Contact' ? [{ statusCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [LastName]', fields: ['LastName'] }] : null) });
  const ins = createInserter(client, 'dev', { window: 2000 });
  const records = [acc(1), ...Array.from({ length: 1000 }, (_, i) => con(i + 1, 1))];
  for (const r of records) await ins.push(r);
  const res = await ins.end();
  assert.equal(client.calls.length, 4, '1 Account call + 3 Contact calls');
  assert.equal(res.inserted, 1);
  assert.deepEqual([res.stopped.reason, res.stopped.sobject, res.stopped.nodeId, res.stopped.batches], ['allFailing', 'Contact', 'c', 3]);
  assert.match(res.stopped.message, /REQUIRED_FIELD_MISSING/);
  assert.equal(res.failed, 600);
  assert.equal(res.notSent, 400);
  assert.deepEqual(res.errorGroups.map((g) => [g.field, g.count]), [['fields.LastName', 600]]);

  // A failing batch after a success of the same sObject does not stop (data-dependent errors).
  let k = 0;
  const flaky = fakeClient({ fail: (_r, s) => (s === 'Contact' && k++ >= 200 ? [{ message: 'dup' }] : null) });
  const res2 = await insertRecords(flaky, 'dev', records);
  assert.equal(res2.stopped, null);
  assert.equal(flaky.calls.length, 6);
});

test('cancel waits for the in-flight batch and reports exact counts', async () => {
  const controller = new AbortController();
  const client = fakeClient({ gate: async (n) => { if (n === 2) controller.abort(); } });
  const ins = createInserter(client, 'dev', { window: 2000, signal: controller.signal });
  for (let i = 1; i <= 1000; i++) await ins.push(acc(i));
  const res = await ins.end();
  assert.equal(client.calls.length, 2, 'the call in flight when Dừng came is finished, no more after it');
  assert.equal(res.inserted, 400);
  assert.equal(res.notSent, 600);
  assert.equal(res.cancelled, true);
  assert.equal(Object.keys(res.ids).length, 400);
});

test('errors are capped at 1000 but groups count everything', async () => {
  let k = 0;
  const client = fakeClient({ fail: () => (k++ % 2 ? [{ statusCode: 'DUPLICATE_VALUE', message: 'dup' }] : null) });
  const records = Array.from({ length: 2600 }, (_, i) => acc(i + 1));
  const res = await insertRecords(client, 'dev', records);
  assert.equal(res.errorsTotal, 1300);
  assert.equal(res.errors.length, 1000);
  assert.deepEqual(res.errorGroups.map((g) => [g.count, g.refs.length]), [[1300, 3]]);
  assert.equal(res.inserted, 1300);
});

test('fail fast: stopped.records counts what Salesforce refused, not the children skipped because of it', async () => {
  const client = fakeClient({ fail: (_r, s) => (s === 'Account' ? [{ statusCode: 'X', message: 'nope' }] : null) });
  const records = [];
  for (let i = 1; i <= 600; i++) records.push(acc(i), con(i, i));
  const res = await insertRecords(client, 'dev', records, { window: 2000 });
  assert.equal(res.stopped.reason, 'allFailing');
  assert.equal(res.stopped.records, 600, 'three calls of 200 Accounts');
  assert.ok(res.failed > 600, 'skipped Contacts are failures too, just not "refused"');
});

test('error groups: Ids and quoted values are masked in the key, at most 100 groups plus a counted remainder', async () => {
  assert.equal(errorPattern('duplicate value found: Email duplicates value on record with id: 003000000000123'), 'duplicate value found: Email duplicates value on record with id: <Id>');
  assert.equal(errorPattern("bad value for restricted picklist field: 'Foo'"), 'bad value for restricted picklist field: "…"');
  assert.equal(errorPattern('REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]'), 'REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]');
  // Every record a different, unmaskable message: 300 patterns.
  const client = fakeClient({ fail: (r) => [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: `rule ${r.Name} broke` }] });
  const res = await insertRecords(client, 'dev', Array.from({ length: 300 }, (_, i) => acc(i + 1)), { failFast: 99 });
  assert.equal(res.errorGroups.length, MAX_ERROR_GROUPS);
  assert.deepEqual(res.errorGroupsOther, { groups: 200, count: 200 });
  assert.equal(res.errorGroups.reduce((n, g) => n + g.count, 0) + res.errorGroupsOther.count, res.errorsTotal);
});
