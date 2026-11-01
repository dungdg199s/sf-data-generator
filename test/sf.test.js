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
import { planInsert } from '../shared/insert-plan.js';
import { parseCsv, bulkCell } from '../server/sf/bulk-csv.js';
import { deleteRun } from '../server/sf/delete.js';

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

test('getConnection returns the org Id (`id` of sf org display) and never more than the connection keys (0011)', async () => {
  const run = async (_cmd, args) => ({
    stdout: JSON.stringify({ status: 0, result: { id: '00D000000000001AAA', accessToken: 'tok', instanceUrl: 'https://acme.my.salesforce.com/', apiVersion: '62.0', username: 'me@x.com', alias: 'dev', clientId: 'PlatformCLI' } }),
    args,
  });
  const conn = await createSfCli({ run }).getConnection('dev');
  assert.deepEqual(conn, { accessToken: 'tok', instanceUrl: 'https://acme.my.salesforce.com', apiVersion: '62.0', username: 'me@x.com', orgId: '00D000000000001AAA' });
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

test('the inserter counts byStep; children skipped because their parent failed count for their own step (0012 D)', async () => {
  const client = {
    async create(_target, _sobject, recs) {
      return recs.map((r, i) => (r.Name === 'bad' ? { success: false, errors: [{ statusCode: 'X', message: 'nope' }] } : { success: true, id: `id${i}${r.Name ?? r.LastName}` }));
    },
  };
  const records = [
    { ref: 'acc#1', sobject: 'Account', nodeId: 'a', fields: { Name: 'ok' } },
    { ref: 'acc#2', sobject: 'Account', nodeId: 'a', fields: { Name: 'bad' } },
    { ref: 'con#1', sobject: 'Contact', nodeId: 'c', fields: { LastName: 'x', AccountId: { $ref: 'acc#1' } } },
    { ref: 'con#2', sobject: 'Contact', nodeId: 'c', fields: { LastName: 'y', AccountId: { $ref: 'acc#2' } } },
    { ref: 'con#3', sobject: 'Contact', nodeId: 'c2', fields: { LastName: 'z', AccountId: { $ref: 'acc#2' } } },
    { ref: 'x#1', sobject: 'Lead', fields: { LastName: 'no step' } },
  ];
  const seen = [];
  const res = await insertRecords(client, 'dev', records, { onProgress: () => {} });
  const inserter = createInserter(client, 'dev', { onBatch: (s) => seen.push(JSON.parse(JSON.stringify(s.byStep))) });
  for (const r of records) await inserter.push(r);
  const sum = await inserter.end();
  for (const s of [res, sum]) {
    assert.deepEqual(s.byStep, { a: { inserted: 1, failed: 1 }, c: { inserted: 1, failed: 1 }, c2: { inserted: 0, failed: 1 } });
  }
  assert.deepEqual(seen.at(-1), sum.byStep);
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
  // Review of 0011 (S1): every call asks the CLI (cached there) who the target is, so a re-pointed
  // alias gets its own connection; the connection itself is still made once.
  assert.deepEqual(lookups, [['dev', false], ['dev', false], ['dev', true]]);
});

test('sf client: a re-pointed alias gets a new connection; refreshFn refuses a token of another org or user (S1)', async () => {
  let who = { orgId: '00DA', username: 'me@x.com' };
  const cli = { getConnection: async (_t, { refresh = false } = {}) => ({ accessToken: refresh ? 'fresh' : 'tok', instanceUrl: 'https://x.my.salesforce.com', apiVersion: '62.0', ...who }) };
  const { made, createConnection } = fakeJsforce();
  const client = createSfClient({ cli, createConnection });
  await client.create('dev', 'Contact', [{ LastName: 'A' }]);
  who = { orgId: '00DB', username: 'me@x.com' };
  const refused = await new Promise((resolve) => made[0].options.refreshFn(made[0], (err) => resolve(err)));
  assert.match(refused.message, /^Org "dev" bây giờ là org khác \(00DB, me@x.com\)/);
  await client.create('dev', 'Contact', [{ LastName: 'B' }]);
  assert.equal(made.length, 2, 'the new org gets its own connection');
  assert.equal(made[0].calls.length, 1);
  assert.equal(made[1].calls.length, 1);
  who = { orgId: '00DB', username: 'other@x.com' };
  assert.match((await new Promise((resolve) => made[1].options.refreshFn(made[1], (err) => resolve(err)))).message, /bây giờ là org khác/);
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

// ---------- design 0011: the inserter with Bulk API 2.0 (in-memory client) ----------

const tick = () => new Promise((r) => setImmediate(r));

/** In-memory client with create + bulkJob; jobs complete after `checks` InProgress answers. */
function bulkClient(opts = {}) {
  let n = 0;
  const calls = [];
  const jobs = [];
  const rows = (text) => parseCsv(text);
  const id = (sobject) => `${sobject === 'Account' ? '001' : '003'}${String(++n).padStart(15, '0')}`;
  return {
    calls,
    jobs,
    async create(_t, sobject, recs) {
      calls.push({ op: 'create', sobject, recs });
      await opts.gateCreate?.(calls.length);
      return recs.map((r) => (opts.createFail?.(r, sobject)
        ? { success: false, errors: [{ statusCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [LastName]', fields: ['LastName'] }] }
        : { success: true, id: id(sobject) }));
    },
    async describe(_t, sobject) {
      return { name: sobject, keyPrefix: { Account: '001', Contact: '003' }[sobject] };
    },
    bulkJob(_t, { object, operation }) {
      if (!['insert', 'delete'].includes(operation)) throw new Error('not allowed');
      const job = { id: `750${String(jobs.length + 1).padStart(15, '0')}`, object, operation, state: 'Open', csv: '', checks: 0, log: [], results: null };
      jobs.push(job);
      calls.push({ op: 'bulkJob', object, operation });
      const info = () => {
        const done = job.results ? job.results.slice(0, job.state === 'Aborted' ? (opts.abortKeep ?? 0) : undefined) : [];
        return { state: job.state, numberRecordsProcessed: done.length, numberRecordsFailed: done.filter((r) => !r.ok).length, errorMessage: job.errorMessage ?? null };
      };
      return {
        get id() { return job.id; },
        async open() {
          job.log.push('open');
          if (opts.openError) throw opts.openError;
        },
        async upload(csv) {
          job.log.push('upload');
          job.csv = csv;
          await opts.onUpload?.(job);
        },
        async close() {
          job.log.push('close');
          const [header, ...data] = rows(job.csv);
          job.header = header;
          job.results = data.map((cells) => {
            const fields = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
            const err = opts.rowFail?.(fields, job);
            return err ? { ok: false, cells, err } : { ok: true, cells, id: operation === 'delete' ? fields.Id : id(object) };
          });
          job.state = 'UploadComplete';
        },
        async abort() {
          job.log.push('abort');
          job.state = 'Aborted';
        },
        async check() {
          job.log.push('check');
          await opts.onCheck?.(job);
          if (job.state === 'UploadComplete' || job.state === 'InProgress') {
            if (opts.never || job.checks++ < (opts.checks ?? 1)) job.state = 'InProgress';
            else {
              job.state = opts.jobFinal?.(job) ?? 'JobComplete';
              if (job.state === 'Failed') {
                job.errorMessage = 'InvalidBatch : Field name not found : Foo__c';
                job.results = [];
              }
            }
          }
          return info();
        },
        async successfulResults() {
          job.log.push('successfulResults');
          if (job.state === 'Aborted' && !opts.abortedResults) throw Object.assign(new Error('Salesforce: NOT_FOUND'), { status: 502 });
          const done = job.results.slice(0, job.state === 'Aborted' ? (opts.abortKeep ?? 0) : undefined).filter((r) => r.ok).reverse();
          return [['sf__Id', 'sf__Created', ...job.header], ...done.map((r) => [r.id, 'true', ...r.cells])].map((l) => l.map(bulkCell).join(',')).join('\n') + '\n';
        },
        async failedResults() {
          job.log.push('failedResults');
          const done = job.results.slice(0, job.state === 'Aborted' ? (opts.abortKeep ?? 0) : undefined).filter((r) => !r.ok);
          return [['sf__Id', 'sf__Error', ...job.header], ...done.map((r) => ['', r.err, ...r.cells])].map((l) => l.map(bulkCell).join(',')).join('\n') + '\n';
        },
      };
    },
  };
}

/** Account (n) each followed by its `per` Contacts, as the executor yields them. */
function accConRecords(accounts, per) {
  const out = [];
  let c = 0;
  for (let a = 1; a <= accounts; a++) {
    out.push({ ref: `acc#${a}`, sobject: 'Account', alias: 'acc', nodeId: 'a', fields: { Name: `A${a}` } });
    for (let k = 0; k < per; k++) {
      c++;
      out.push({ ref: `con#${c}`, sobject: 'Contact', alias: 'con', nodeId: 'c', fields: { LastName: `L${c}`, AccountId: { $ref: `acc#${a}` } } });
    }
  }
  return out;
}

const conPlan = (records, contacts) => planInsert({
  steps: [{ nodeId: 'a', alias: 'acc', sobject: 'Account', records: records - contacts }, { nodeId: 'c', alias: 'con', sobject: 'Contact', records: contacts }],
  referenced: new Set(['acc']),
});

async function insertAll(client, records, opts = {}) {
  const ins = createInserter(client, 'dev', { keepId: (ref) => ref.startsWith('acc#'), bulkOptions: { sleep: tick }, ...opts });
  for (const r of records) await ins.push(r);
  return ins.end();
}

test('Bulk: Account 300 + Contact 12 000 ⇒ Account only by create, Contact 200 by create then 2 jobs with real Account Ids; unordered results all reach onInserted', async () => {
  const client = bulkClient();
  const recs = accConRecords(300, 40);
  const saved = [];
  const jobsSeen = [];
  const res = await insertAll(client, recs, {
    plan: conPlan(recs.length, 12000),
    onInserted: async (rows) => { saved.push(...rows); },
    onJob: async (j) => { jobsSeen.push([j.jobId, j.state]); },
  });
  const creates = client.calls.filter((c) => c.op === 'create');
  assert.equal(creates.filter((c) => c.sobject === 'Account').reduce((s, c) => s + c.recs.length, 0), 300);
  const conCreates = creates.filter((c) => c.sobject === 'Contact');
  assert.deepEqual(conCreates.map((c) => c.recs.length), [200], 'the probe: the first Contact call of the step');
  assert.equal(client.jobs.length, 2);
  assert.deepEqual(client.jobs.map((j) => j.results.length), [10000, 1800]);
  assert.ok(client.jobs.every((j) => j.operation === 'insert' && j.log.join() === 'open,upload,close,check,check,successfulResults,failedResults'));
  // Every Contact row points at a real Account Id from the create results.
  const accountIds = new Set(saved.filter((r) => r.sobject === 'Account').map((r) => r.id));
  const [header, ...rows1] = parseCsv(client.jobs[0].csv);
  assert.deepEqual(header, ['LastName', 'AccountId']);
  assert.ok(rows1.every(([, accId]) => accountIds.has(accId)));
  assert.equal(res.inserted, 12300);
  assert.equal(res.failed, 0);
  assert.deepEqual(res.bySobject, { Account: { inserted: 300, failed: 0 }, Contact: { inserted: 12000, failed: 0 } });
  assert.deepEqual(res.byStep, { a: { inserted: 300, failed: 0 }, c: { inserted: 12000, failed: 0 } });
  assert.equal(saved.length, 12300);
  assert.equal(new Set(saved.map((r) => r.id)).size, 12300);
  assert.deepEqual(saved.filter((r) => r.sobject === 'Contact' && r.ref).length, 200, 'Bulk Ids have no ref');
  assert.deepEqual(res.bulk, [{ nodeId: 'c', sobject: 'Contact', jobs: 2, records: 11800, inserted: 12000, failed: 0 }]);
  assert.deepEqual(res.bulkJobs.map((j) => [j.state, j.idsCollected, j.inserted]), [['JobComplete', true, 10000], ['JobComplete', true, 1800]]);
  assert.deepEqual(jobsSeen.map((j) => j[1]), ['Open', 'JobComplete', 'Open', 'JobComplete'], 'job Id recorded before its upload');
  assert.equal(res.notSent, 0);
});

test('Bulk: the probe failing 3 times ⇒ allFailing, no job is ever opened', async () => {
  const client = bulkClient({ createFail: (_r, so) => so === 'Contact' });
  const recs = accConRecords(300, 40);
  const res = await insertAll(client, recs, { plan: conPlan(recs.length, 12000) });
  assert.equal(res.stopped.reason, 'allFailing');
  assert.equal(res.stopped.sobject, 'Contact');
  assert.equal(client.jobs.length, 0);
  assert.equal(client.calls.filter((c) => c.op === 'bulkJob').length, 0);
});

test('Bulk: failed rows are matched back to their ref with the same message and field as Collections; byStep counts them', async () => {
  const client = bulkClient({ rowFail: (f) => (f.LastName === 'L500' ? 'REQUIRED_FIELD_MISSING:Required fields are missing: [LastName]:LastName --' : null) });
  const recs = accConRecords(300, 40);
  const res = await insertAll(client, recs, { plan: conPlan(recs.length, 12000) });
  assert.equal(res.failed, 1);
  assert.deepEqual(res.errors.map((e) => [e.ref, e.nodeId, e.field, e.message]), [['con#500', 'c', 'fields.LastName', 'REQUIRED_FIELD_MISSING: Required fields are missing: [LastName] [LastName]']]);
  assert.deepEqual(res.byStep.c, { inserted: 11999, failed: 1 });
});

test('Bulk: a job Failed fails its rows with the job sentence; two such jobs in a row stop with bulkFailing', async () => {
  const client = bulkClient({ jobFinal: () => 'Failed' });
  const recs = accConRecords(300, 80); // 24 000 Contacts ⇒ 3 jobs planned
  const res = await insertAll(client, recs, { plan: conPlan(recs.length, 24000) });
  assert.equal(res.stopped.reason, 'bulkFailing');
  assert.equal(res.stopped.jobs, 2);
  assert.equal(res.stopped.records, 20000);
  assert.match(res.stopped.message, /^Job Bulk 750\d+ \(Contact\) thất bại: InvalidBatch : Field name not found : Foo__c\. Bản ghi của job này chưa được insert\./);
  assert.equal(client.jobs.length, 2);
  assert.equal(res.bySobject.Contact.inserted, 200, 'the probe');
  assert.equal(res.failed, 20000);
  assert.equal(res.inserted + res.failed + res.notSent, recs.length);
  assert.equal(res.errorGroups.length, 1, 'the job Id is masked in the group key');
  assert.equal(res.errorGroups[0].count, 20000);
});

test('Bulk: a job Salesforce will not open (INVALIDENTITY) ⇒ the step falls back to Collections with a warning', async () => {
  const openError = Object.assign(new Error('Salesforce: INVALIDENTITY: Entity is not supported by the Bulk API'), { status: 502, cause: { errorCode: 'INVALIDENTITY', message: 'Entity is not supported by the Bulk API' } });
  const client = bulkClient({ openError });
  const recs = accConRecords(300, 40);
  const res = await insertAll(client, recs, { plan: conPlan(recs.length, 12000) });
  assert.equal(res.inserted, 12300);
  assert.deepEqual(res.warnings, ['Bước "con": Bulk API 2.0 không nhận Contact (Entity is not supported by the Bulk API), nên đã gửi bằng sObject Collections.']);
  assert.equal(client.jobs.length, 1, 'tried once');
  assert.equal(client.calls.filter((c) => c.op === 'create' && c.sobject === 'Contact').reduce((s, c) => s + c.recs.length, 0), 12000);
  // A limit error does not fall back: the job's rows fail.
  const limited = bulkClient({ openError: Object.assign(new Error('Salesforce: REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.'), { cause: { errorCode: 'REQUEST_LIMIT_EXCEEDED' } }) });
  const res2 = await insertAll(limited, recs, { plan: conPlan(recs.length, 12000) });
  assert.equal(res2.warnings.length, 0);
  assert.equal(res2.failed, 11800);
  assert.equal(res2.stopped.reason, 'bulkFailing');
});

test('Bulk: Dừng while a job is InProgress waits for JobComplete (no abort) and counts it; the rest is notSent', async () => {
  const ctl = new AbortController();
  const client = bulkClient({ checks: 3, onCheck: (job) => { if (job.checks === 1) ctl.abort(); } });
  const recs = accConRecords(300, 80);
  const progress = [];
  const res = await insertAll(client, recs, { plan: conPlan(recs.length, 24000), signal: ctl.signal, onBatch: (s) => progress.push(s) });
  assert.equal(client.jobs.length, 1);
  assert.ok(!client.jobs[0].log.includes('abort'));
  assert.equal(client.jobs[0].state, 'JobComplete');
  assert.equal(res.cancelled, true);
  assert.equal(res.inserted + res.failed + res.notSent, recs.length);
  assert.equal(res.bySobject.Contact.inserted, 200 + 10000);
  const withBulk = progress.filter((p) => p.bulk);
  assert.ok(withBulk.length >= 2);
  assert.deepEqual(Object.keys(withBulk.at(-1).bulk).sort(), ['failed', 'job', 'jobId', 'jobs', 'nodeId', 'processed', 'records', 'sobject', 'state']);
  assert.equal(withBulk[0].bulk.jobs, 3);
});

test('Bulk: Dừng while the job is still Open (uploading) aborts it; its rows are notSent', async () => {
  const ctl = new AbortController();
  const client = bulkClient({ onUpload: () => ctl.abort() });
  const recs = accConRecords(300, 40);
  const res = await insertAll(client, recs, { plan: conPlan(recs.length, 12000), signal: ctl.signal });
  assert.deepEqual(client.jobs[0].log, ['open', 'upload', 'abort']);
  assert.equal(res.bySobject.Contact.inserted, 200);
  assert.equal(res.bulkJobs[0].state, 'Aborted');
  assert.equal(res.inserted + res.failed + res.notSent, recs.length);
  assert.equal(res.cancelled, true);
});

test('Bulk: Dừng ngay aborts the job being processed, then reads its results when Salesforce keeps them', async () => {
  const force = new AbortController();
  const ctl = new AbortController();
  const client = bulkClient({ checks: 5, abortKeep: 6200, abortedResults: true, onCheck: (job) => { if (job.checks === 1) { ctl.abort(); force.abort(); } } });
  const recs = accConRecords(300, 40);
  const saved = [];
  const res = await insertAll(client, recs, { plan: conPlan(recs.length, 12000), signal: ctl.signal, forceSignal: force.signal, onInserted: async (r) => { saved.push(...r); } });
  assert.ok(client.jobs[0].log.includes('abort'));
  assert.deepEqual(res.bulkAborted, { jobId: client.jobs[0].id, sobject: 'Contact', nodeId: 'c', processed: 6200, records: 10000, idsKnown: true });
  assert.equal(res.bySobject.Contact.inserted, 200 + 6200);
  assert.equal(saved.filter((r) => r.sobject === 'Contact').length, 6400);
  // Without results for the aborted job: Ids unknown, counted apart.
  const force2 = new AbortController();
  const ctl2 = new AbortController();
  const client2 = bulkClient({ checks: 5, abortKeep: 6200, onCheck: (job) => { if (job.checks === 1) { ctl2.abort(); force2.abort(); } } });
  const res2 = await insertAll(client2, recs, { plan: conPlan(recs.length, 12000), signal: ctl2.signal, forceSignal: force2.signal });
  assert.deepEqual(res2.bulkAborted, { jobId: client2.jobs[0].id, sobject: 'Contact', nodeId: 'c', processed: 6200, records: 10000, idsKnown: false });
  assert.equal(res2.bulkUnknown, 6200);
  assert.equal(res2.bulkJobs[0].idsUnknown, true);
});

test('Bulk: a job not done after the timeout stops the run with bulkTimeout (job Id kept)', async () => {
  let t = 0;
  const client = bulkClient({ never: true });
  const recs = accConRecords(300, 40);
  const res = await insertAll(client, recs, { plan: conPlan(recs.length, 12000), bulkOptions: { sleep: async (ms) => { t += ms; await tick(); }, clock: () => t, timeoutMs: 60000 } });
  assert.equal(res.stopped.reason, 'bulkTimeout');
  assert.equal(res.stopped.jobId, client.jobs[0].id);
  assert.equal(res.bulkUnknown, 10000);
  // back-off: 2 s × 1.5 … up to 15 s
  assert.ok(client.jobs[0].log.filter((l) => l === 'check').length < 10);
});

test('Bulk: onInserted failing stops the insert after the call in flight (history)', async () => {
  const client = bulkClient();
  const recs = accConRecords(300, 40);
  let calls = 0;
  const res = await insertAll(client, recs, { plan: conPlan(recs.length, 12000), onInserted: async () => { if (++calls === 2) throw new Error('ENOSPC: no space left on device'); } });
  assert.deepEqual(res.stopped, { reason: 'history', message: 'ENOSPC: no space left on device' });
  assert.equal(client.calls.filter((c) => c.op === 'create').length, 2, 'nothing sent after the failed write');
  assert.equal(client.jobs.length, 0);
});

test('without a plan the inserter never opens a Bulk job (records and calls unchanged)', async () => {
  const client = bulkClient();
  const recs = accConRecords(30, 400);
  const res = await insertAll(client, recs);
  assert.equal(client.jobs.length, 0);
  assert.equal(res.inserted, recs.length);
  assert.deepEqual(res.bulk, []);
});

// ---------- design 0011 §7: deleteRun (in-memory client, history in a temporary directory) ----------

async function historyWith(rows, steps) {
  const { mkdtemp } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createHistory } = await import('../server/history.js');
  const h = createHistory({ dir: await mkdtemp(path.join(os.tmpdir(), 'sfdg-del-')) });
  const hid = await h.create({ org: { alias: 'dev', username: 'me@x.com' }, workflow: null, seed: 1, now: 1, steps, total: rows.length });
  await h.appendIds(hid, rows);
  await h.finish(hid, { status: 'done', inserted: rows.length });
  return { h, hid };
}

function deleteClient({ errorFor = () => null } = {}) {
  const calls = [];
  return {
    calls,
    async destroy(_t, sobject, ids) {
      calls.push({ sobject, ids: [...ids] });
      return ids.map((id) => {
        const code = errorFor(id, sobject, calls.length);
        return code ? { id, success: false, errors: [{ statusCode: code, message: `${code} msg`, fields: [] }] } : { id, success: true, errors: [] };
      });
    },
    bulkJob() {
      throw new Error('no Bulk in this test');
    },
    async describe(_t, sobject) {
      return { name: sobject, keyPrefix: { Account: '001', Contact: '003' }[sobject] };
    },
  };
}

const id18 = (p, i) => `${p}${String(i).padStart(15, '0')}`;

test('deleteRun: children before parents, Ids of a step in reverse insert order, every outcome in the history file', async () => {
  const rows = [];
  for (let a = 1; a <= 3; a++) {
    rows.push({ sobject: 'Account', nodeId: 'a', ref: `acc#${a}`, id: id18('001', a) });
    for (let k = 1; k <= 2; k++) rows.push({ sobject: 'Contact', nodeId: 'c', ref: `con#${a}${k}`, id: id18('003', a * 10 + k) });
  }
  const { h, hid } = await historyWith(rows, [{ nodeId: 'a', sobject: 'Account' }, { nodeId: 'c', sobject: 'Contact' }]);
  const client = deleteClient({ errorFor: (id) => (id === id18('003', 12) ? 'ENTITY_IS_DELETED' : null) });
  const res = await deleteRun({ client, history: h, hid, target: 'dev', batchSize: 4 });
  assert.deepEqual(client.calls.map((c) => [c.sobject, c.ids]), [
    ['Contact', [id18('003', 32), id18('003', 31), id18('003', 22), id18('003', 21)]],
    ['Contact', [id18('003', 12), id18('003', 11)]],
    ['Account', [id18('001', 3), id18('001', 2), id18('001', 1)]],
  ]);
  assert.deepEqual([res.deleted, res.gone, res.failed, res.remaining], [8, 1, 0, 0]);
  assert.deepEqual(res.bySobject, { Account: { deleted: 3, gone: 0, failed: 0, total: 3 }, Contact: { deleted: 5, gone: 1, failed: 0, total: 6 } });
  const map = await h.deletedMap(hid);
  assert.equal(map.size, 9);
  assert.equal(map.get(id18('003', 12)), 'gone');
  const data = await h.read(hid);
  assert.deepEqual([data.deletion.status, data.deletion.deleted, data.deletion.gone], ['done', 8, 1]);
  assert.equal((await h.remaining(hid)).total, 0);
});

test('deleteRun: 3 calls of an sObject failing completely (no Delete permission) stop it; nothing of the parents is sent', async () => {
  const rows = [];
  for (let i = 1; i <= 2; i++) rows.push({ sobject: 'Account', nodeId: 'a', ref: `acc#${i}`, id: id18('001', i) });
  for (let i = 1; i <= 1000; i++) rows.push({ sobject: 'Contact', nodeId: 'c', ref: `con#${i}`, id: id18('003', i) });
  const { h, hid } = await historyWith(rows, [{ nodeId: 'a', sobject: 'Account' }, { nodeId: 'c', sobject: 'Contact' }]);
  const client = deleteClient({ errorFor: (_id, so) => (so === 'Contact' ? 'INSUFFICIENT_ACCESS_OR_READONLY' : null) });
  const res = await deleteRun({ client, history: h, hid, target: 'dev' });
  assert.equal(client.calls.length, 3);
  assert.ok(client.calls.every((c) => c.sobject === 'Contact'));
  assert.equal(res.stopped.reason, 'allFailing');
  assert.equal(res.stopped.text, 'Đã dừng xóa: 3 lời gọi xóa Contact đầu tiên đều lỗi "INSUFFICIENT_ACCESS_OR_READONLY: INSUFFICIENT_ACCESS_OR_READONLY msg". Kiểm tra quyền Delete của user trên Contact. Chưa xóa bản ghi Contact nào.');
  assert.deepEqual([res.deleted, res.failed, res.remaining], [0, 600, 1002]);
  assert.equal(res.errorGroups.length, 1);
  assert.equal((await h.read(hid)).deletion.status, 'partial');
});

test('deleteRun: DELETE_FAILED Ids get exactly one more try at the end; Dừng stops before the next call', async () => {
  const rows = [1, 2, 3].map((i) => ({ sobject: 'Account', nodeId: 'a', ref: `acc#${i}`, id: id18('001', i) }));
  const { h, hid } = await historyWith(rows, [{ nodeId: 'a', sobject: 'Account' }]);
  let first = true;
  const client = deleteClient({ errorFor: (id) => (id === id18('001', 2) && first ? (first = false, 'DELETE_FAILED') : null) });
  const res = await deleteRun({ client, history: h, hid, target: 'dev' });
  assert.deepEqual(client.calls.map((c) => c.ids.length), [3, 1]);
  assert.deepEqual([res.deleted, res.failed], [3, 0]);

  const many = Array.from({ length: 1000 }, (_, i) => ({ sobject: 'Account', nodeId: 'a', ref: `acc#${i}`, id: id18('001', i + 1) }));
  const x = await historyWith(many, [{ nodeId: 'a', sobject: 'Account' }]);
  const ctl = new AbortController();
  const c2 = deleteClient({ errorFor: (_id, _so, n) => { if (n === 2) ctl.abort(); return null; } });
  const res2 = await deleteRun({ client: c2, history: x.h, hid: x.hid, target: 'dev', signal: ctl.signal });
  assert.equal(c2.calls.length, 2);
  assert.deepEqual([res2.deleted, res2.remaining, res2.cancelled], [400, 600, true]);
  assert.equal((await x.h.remaining(x.hid)).total, 600, '"Xóa phần còn lại…" picks up the rest');
});

test('deleteRun: a step with bulkMinRecords Ids goes probe by destroy, then Bulk delete jobs; Bulk refusing the job falls back to destroy', async () => {
  const rows = Array.from({ length: 450 }, (_, i) => ({ sobject: 'Contact', nodeId: 'c', ref: '', id: id18('003', i + 1) }));
  const { h, hid } = await historyWith(rows, [{ nodeId: 'c', sobject: 'Contact' }]);
  const client = bulkClient();
  const destroyed = [];
  client.destroy = async (_t, _so, ids) => { destroyed.push(ids.length); return ids.map((id) => ({ id, success: true, errors: [] })); };
  const res = await deleteRun({ client, history: h, hid, target: 'dev', minBulk: 300, jobRecords: 100, bulkOptions: { sleep: tick } });
  assert.deepEqual(destroyed, [200]);
  assert.deepEqual(client.jobs.map((j) => [j.operation, j.object, j.results.length]), [['delete', 'Contact', 100], ['delete', 'Contact', 100], ['delete', 'Contact', 50]]);
  assert.equal(parseCsv(client.jobs[0].csv)[0][0], 'Id');
  assert.deepEqual([res.deleted, res.remaining], [450, 0]);
  const x = await historyWith(rows, [{ nodeId: 'c', sobject: 'Contact' }]);
  const refusing = bulkClient({ openError: Object.assign(new Error('Salesforce: INVALIDENTITY'), { cause: { errorCode: 'INVALIDENTITY' } }) });
  const d2 = [];
  refusing.destroy = async (_t, _so, ids) => { d2.push(ids.length); return ids.map((id) => ({ id, success: true, errors: [] })); };
  const res2 = await deleteRun({ client: refusing, history: x.h, hid: x.hid, target: 'dev', minBulk: 300, jobRecords: 100, bulkOptions: { sleep: tick } });
  assert.deepEqual(d2, [200, 200, 50]);
  assert.equal(res2.deleted, 450);
});
