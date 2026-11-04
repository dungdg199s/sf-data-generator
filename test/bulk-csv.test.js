// server/sf/bulk-csv.js (design 0011 §2): the CSV uploaded to Bulk API 2.0 jobs and how results are read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBulkCsv, parseCsv, parseResultCsv, parseBulkError, rowKey, bulkCell } from '../server/sf/bulk-csv.js';
import { toSObject, describeFailure, errorPattern } from '../server/sf/insert.js';

test('cells: null is empty, booleans true/false, numbers String(n), dates as generated, quotes, commas and line breaks quoted', () => {
  assert.equal(bulkCell(null), '');
  assert.equal(bulkCell(undefined), '');
  assert.equal(bulkCell(true), 'true');
  assert.equal(bulkCell(false), 'false');
  assert.equal(bulkCell(12.5), '12.5');
  assert.equal(bulkCell(0), '0');
  assert.equal(bulkCell('2025-06-15'), '2025-06-15');
  assert.equal(bulkCell('2025-06-15T12:00:00.000Z'), '2025-06-15T12:00:00.000Z');
  assert.equal(bulkCell('say "hi"'), '"say ""hi"""');
  assert.equal(bulkCell('a,b'), '"a,b"');
  assert.equal(bulkCell('line1\nline2'), '"line1\nline2"');
  assert.equal(bulkCell('a;b|c\td'), 'a;b|c\td', 'only quote, comma and line breaks need quoting');
});

test('columns are the union of fields in first-seen order (geolocation split, Lookups resolved, nulls dropped)', () => {
  const ids = new Map([['acc#1', '001000000000001AAA']]);
  const objs = [
    toSObject({ fields: { LastName: 'A', AccountId: { $ref: 'acc#1' }, Email: null } }, ids),
    toSObject({ fields: { LastName: 'B', Email: 'b@x.com', Loc__c: { latitude: 1.5, longitude: -2 }, Active__c: false } }, ids),
  ];
  const { columns, csv, keys } = toBulkCsv(objs);
  assert.deepEqual(columns, ['LastName', 'AccountId', 'Email', 'Loc__Latitude__s', 'Loc__Longitude__s', 'Active__c']);
  assert.equal(csv, 'LastName,AccountId,Email,Loc__Latitude__s,Loc__Longitude__s,Active__c\nA,001000000000001AAA,,,,\nB,,b@x.com,1.5,-2,false\n');
  assert.equal(keys.length, 2);
  // A row read back from Salesforce's result CSV gives the same key.
  const back = parseResultCsv(`sf__Id,sf__Error,${columns.join(',')}\n,X:y: --,B,,b@x.com,1.5,-2,false\n`).rows[0];
  assert.equal(rowKey(columns.map((c) => back[c])), keys[1]);
});

test('parseCsv round-trips quoted cells with commas, quotes and line breaks (LF and CRLF)', () => {
  const objs = [{ Description: 'x, "y"\nz', Name: 'n' }, { Description: '', Name: 'semi;colon|pipe' }];
  const { csv } = toBulkCsv(objs);
  assert.deepEqual(parseCsv(csv), [['Description', 'Name'], ['x, "y"\nz', 'n'], ['', 'semi;colon|pipe']]);
  assert.deepEqual(parseCsv('a,b\r\n"1\r\n2",3\r\n'), [['a', 'b'], ['1\r\n2', '3']]);
  assert.deepEqual(parseResultCsv('"sf__Id","sf__Created",Name\n001A,true,Acme\n\n').rows, [{ sf__Id: '001A', sf__Created: 'true', Name: 'Acme' }]);
  assert.deepEqual(parseResultCsv('').rows, []);
});

test('sf__Error parses to the SaveResult shape: same message, field and error group as a Collections failure', () => {
  const cases = [
    ['REQUIRED_FIELD_MISSING:Required fields are missing: [LastName]:LastName --', { statusCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [LastName]', fields: ['LastName'] }],
    ['DUPLICATE_VALUE:duplicate value found: Email__c duplicates value on record with id: 003000000000001AAA:-- ', { statusCode: 'DUPLICATE_VALUE', message: 'duplicate value found: Email__c duplicates value on record with id: 003000000000001AAA', fields: [] }],
    ['FIELD_CUSTOM_VALIDATION_EXCEPTION:Amount must be positive:Amount,Stage --', { statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Amount must be positive', fields: ['Amount', 'Stage'] }],
    ['something odd', { statusCode: null, message: 'something odd', fields: [] }],
  ];
  for (const [raw, want] of cases) assert.deepEqual(parseBulkError(raw), want, raw);
  const record = { fields: { LastName: null, FirstName: 'A' } };
  const viaBulk = describeFailure({ errors: [parseBulkError(cases[0][0])] }, record);
  const viaRest = describeFailure({ success: false, errors: [{ statusCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [LastName]', fields: ['LastName'] }] }, record);
  assert.deepEqual(viaBulk, viaRest);
  assert.deepEqual(viaBulk, { message: 'REQUIRED_FIELD_MISSING: Required fields are missing: [LastName] [LastName]', field: 'fields.LastName' });
  assert.equal(errorPattern(describeFailure({ errors: [parseBulkError(cases[1][0])] }, record).message), errorPattern(describeFailure({ errors: [{ statusCode: 'DUPLICATE_VALUE', message: 'duplicate value found: Email__c duplicates value on record with id: 003000000000009AAA' }] }, record).message));
});
