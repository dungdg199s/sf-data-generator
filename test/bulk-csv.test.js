// server/sf/bulk-csv.js (design 0011): CSV of Bulk jobs and the parsing of their results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBulkCsv, parseBulkError, rowKey, idsCsv, dataOf } from '../server/sf/bulk-csv.js';
import { toSObject, describeFailure, errorPattern } from '../server/sf/insert.js';
import { parseCsv } from './fake-salesforce.js';

test('toBulkCsv: union of columns, null empty, booleans, numbers, dates, quotes, line breaks, geolocation', () => {
  const ids = new Map([['acc#1', '001000000000001AAA']]);
  const rows = [
    toSObject({ fields: { LastName: 'O"Neil, Jr.', AccountId: { $ref: 'acc#1' }, Email: null, DoNotCall: true, Amount__c: 12.5 } }, ids),
    toSObject({ fields: { LastName: 'Line\nbreak', Birthdate: '1990-02-03', Loc__c: { latitude: 10.5, longitude: -3 }, DoNotCall: false } }, ids),
  ];
  const { columns, csv } = toBulkCsv(rows);
  assert.deepEqual(columns, ['LastName', 'AccountId', 'DoNotCall', 'Amount__c', 'Birthdate', 'Loc__Latitude__s', 'Loc__Longitude__s']);
  assert.ok(!columns.includes('Email'), 'a field null in every row is no column');
  assert.ok(csv.endsWith('\n') && !csv.includes('\r'));
  const parsed = parseCsv(csv);
  assert.deepEqual(parsed[1], ['O"Neil, Jr.', '001000000000001AAA', 'true', '12.5', '', '', '']);
  assert.deepEqual(parsed[2], ['Line\nbreak', '', 'false', '', '1990-02-03', '10.5', '-3']);
  assert.equal(idsCsv(['001A', '001B']), 'Id\n001A\n001B\n');
});

test('sf__Error gives the same message, field and group key as a SaveResult', () => {
  const bulk = parseBulkError('REQUIRED_FIELD_MISSING:Required fields are missing: [LastName]:LastName --');
  assert.deepEqual(bulk, { statusCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [LastName]', fields: ['LastName'] });
  const rec = { fields: { LastName: null, FirstName: 'A' } };
  const viaBulk = describeFailure({ errors: [bulk] }, rec);
  const viaRest = describeFailure({ errors: [{ statusCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [LastName]', fields: ['LastName'] }] }, rec);
  assert.deepEqual(viaBulk, viaRest);
  assert.equal(viaBulk.field, 'fields.LastName');
  assert.equal(errorPattern(viaBulk.message), errorPattern(viaRest.message));
  assert.deepEqual(parseBulkError('FIELD_CUSTOM_VALIDATION_EXCEPTION:Phone: must be set: --'), { statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Phone: must be set', fields: [] });
  assert.deepEqual(parseBulkError('ENTITY_IS_DELETED:entity is deleted:--'), { statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted', fields: [] });
});

test('a failed result line is matched back to the uploaded row by content', () => {
  const row = { LastName: 'A', DoNotCall: true, N: 3 };
  const cols = ['LastName', 'DoNotCall', 'N', 'Email'];
  const echoed = dataOf({ sf__Id: '', sf__Error: 'X:y: --', LastName: 'A', DoNotCall: 'true', N: '3', Email: '' });
  assert.equal(rowKey(echoed, cols), rowKey(row, cols));
});
