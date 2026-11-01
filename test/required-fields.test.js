// "Thiếu n field bắt buộc" (design 0012 F2): client/js/required-fields.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingRequired, requiredHintText } from '../client/js/required-fields.js';

const described = {
  sobject: 'Opportunity',
  fields: [
    { name: 'Name', type: 'text', required: true },
    { name: 'StageName', type: 'picklist', required: true },
    { name: 'Amount', type: 'currency', required: false },
    { name: 'CloseDate', type: 'date', required: true },
    { name: 'AccountId', type: 'lookup', required: false },
  ],
};

test('missing required fields: in describe order, names compared ignoring case, optional ones ignored', () => {
  const fields = [{ name: 'name', type: 'text' }, { name: 'Amount', type: 'currency' }];
  assert.deepEqual(missingRequired(fields, described).map((f) => f.name), ['StageName', 'CloseDate']);
  assert.deepEqual(missingRequired([...fields, { name: 'STAGENAME' }, { name: 'CloseDate' }], described), []);
  assert.deepEqual(missingRequired([{ name: '  ' }, null], described).map((f) => f.name), ['Name', 'StageName', 'CloseDate'], 'blank / broken entries do not count');
  assert.deepEqual(missingRequired(undefined, null), []);
});

test('the hint sentence names the sObject, the org and the fields', () => {
  assert.equal(requiredHintText(missingRequired([], described).slice(1), 'Opportunity', 'dev-sb'), 'Thiếu 2 field bắt buộc của Opportunity trong dev-sb: StageName, CloseDate.');
});
