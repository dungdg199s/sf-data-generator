import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSfCli } from '../server/sf/cli.js';
import { createSfClient } from '../server/sf/client.js';
import { insertRecords, toSObject } from '../server/sf/insert.js';
import { mapDescribe } from '../server/sf/describe-map.js';

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
