import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSfCli } from '../server/sf/cli.js';
import { createSfClient } from '../server/sf/client.js';
import { insertRecords, toSObject } from '../server/sf/insert.js';
import { mapDescribe, mapQueryFields } from '../server/sf/describe-map.js';
import { createQueryCache, prefetchQueries, fingerprint } from '../server/sf/query.js';
import { WorkflowError } from '../server/workflow/schema.js';
import { wf, query, pick } from './helpers.js';

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
