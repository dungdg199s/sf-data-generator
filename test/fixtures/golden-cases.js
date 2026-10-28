// Workflows whose records were recorded with the collect-everything executor (before design 0004
// turned it into a generator). test/stream.test.js checks that the streamed records are still
// byte-identical for the same seed and `now`: the palette samples plus nested cases covering
// random Lookups (count-only pools), Chọn bản ghi from generated and Query pools, branch/loop
// nesting, unique values and pick "skip".
//
// To re-record after a deliberate data change: node test/fixtures/golden-record.js > test/fixtures/golden-hashes.json

import { SAMPLES } from '../../client/js/samples.js';
import { wf, record, loop, branch, query, pick, rows, NOW } from '../helpers.js';

const name = { name: 'Name', type: 'text', options: { mode: 'company', unique: true } };
const lookup = (field, ref, mode = 'current') => ({ name: field, type: 'lookup', options: { mode, ref } });
const accRows = (n) => rows(Array.from({ length: n }, (_, i) => ({ Id: `001${String(i).padStart(15, '0')}`, Name: `Org ${i}`, Industry: i % 2 ? 'Banking' : 'Retail' })));

export const GOLDEN_CASES = [
  ...SAMPLES.map((s) => ({ name: `sample: ${s.label}`, workflow: s.workflow, prefetch: true })),
  {
    name: 'random lookups across nested loops and branches',
    workflow: wf([
      record('top', 'Account', 'top', [{ name: 'Name', type: 'text', options: { mode: 'company' } }], { count: 4 }),
      loop('la', { mode: 'range', min: 2, max: 6, alias: 'i' }, [
        record('acc', 'Account', 'acc', [name, lookup('ParentId', 'top', 'random'), { name: 'Num', type: 'autonumber', options: {} }]),
        loop('lc', { mode: 'range', min: 0, max: 3 }, [
          branch('b', { kind: 'chance', probability: 0.6 }, [
            record('con', 'Contact', 'con', [
              { name: 'LastName', type: 'text', options: { mode: 'lastName' } },
              { name: 'Email', type: 'email', options: { mode: 'fromName' } },
              lookup('AccountId', 'acc'),
              { name: 'Title', type: 'template', options: { template: '{{acc.Name}} #{{loop.index}}/{{i.count}} n{{this.$n}}' } },
            ]),
          ], [
            record('opp', 'Opportunity', 'opp', [lookup('AccountId', 'acc', 'random'), { name: 'Amount', type: 'currency', options: {} }, { name: 'CloseDate', type: 'date', options: { from: '-1y', to: 'today' } }]),
          ]),
        ]),
      ]),
      record('task', 'Task', 'task', [lookup('WhatId', 'opp', 'random'), lookup('WhoId', 'con', 'random')], { count: 7 }),
    ]),
  },
  {
    name: 'pick from a generated pool (unique, filtered) and lookups to the pick',
    workflow: wf([
      record('acc', 'Account', 'acc', [name, { name: 'Industry', type: 'picklist', options: { values: ['Banking', 'Retail'] } }], { count: 12 }),
      loop('l', { count: 15 }, [
        pick('p', 'pa', 'acc', { mode: 'unique', filter: 'compare', filterField: 'Industry', filterOp: 'eq', filterValue: 'Banking' }),
        record('con', 'Contact', 'con', [lookup('AccountId', 'pa'), lookup('Other__c', 'acc', 'random'), { name: 'Title', type: 'template', options: { template: '{{pa.Name}}' } }]),
      ]),
      pick('p2', 'again', 'pa', { mode: 'sequential' }),
      record('case', 'Case', 'cs', [lookup('AccountId', 'again'), lookup('ContactId', 'pa', 'random')], { count: 3 }),
    ]),
  },
  {
    name: 'Query pool, pick random and lookup random into the pool',
    workflow: wf([
      query('q', 'accs', { fields: ['Id', 'Name', 'Industry'] }),
      loop('l', { mode: 'range', min: 3, max: 8 }, [
        pick('p', 'acc', 'accs'),
        record('con', 'Contact', 'con', [lookup('AccountId', 'acc'), { name: 'Desc', type: 'template', options: { template: '{{acc.Name}} of {{accs.$count}}' } }]),
        record('opp', 'Opportunity', 'opp', [lookup('AccountId', 'accs', 'random'), lookup('ContactId', 'con', 'random')]),
      ]),
    ]),
    queryResults: { q: accRows(9) },
  },
  {
    name: 'pick skip ends the iteration; disabled steps draw nothing',
    workflow: wf([
      record('acc', 'Account', 'acc', [name], { count: 3 }),
      loop('l', { count: 6 }, [
        pick('p', 'pa', 'acc', { mode: 'unique' }),
        record('con', 'Contact', 'con', [lookup('AccountId', 'pa')]),
        { ...record('off', 'Lead', 'ld', [{ name: 'LastName', type: 'text', options: {} }]), disabled: true },
      ]),
      record('after', 'Lead', 'lead', [lookup('X__c', 'acc', 'random')], { count: 2 }),
    ]),
  },
  {
    name: 'random Lookup into a pick alias, and a copy of a Lookup (added after review; recorded with the old executor)',
    workflow: wf([
      record('acc', 'Account', 'acc', [name], { count: 6 }),
      loop('l', { mode: 'range', min: 4, max: 9 }, [
        pick('p', 'pa', 'acc', { mode: 'random' }),
        record('con', 'Contact', 'con', [lookup('AccountId', 'pa'), lookup('Other__c', 'pa', 'random')]),
        record('opp', 'Opportunity', 'opp', [
          lookup('ContactId', 'con', 'random'),
          { name: 'AccountId', type: 'copy', options: { path: 'con.AccountId' } },
          { name: 'Ref__c', type: 'copy', options: { path: 'con.Other__c' } },
        ]),
      ]),
      record('task', 'Task', 'task', [lookup('WhatId', 'pa', 'random'), { name: 'WhoId', type: 'copy', options: { path: 'opp.ContactId' } }], { count: 3 }),
    ]),
  },
];

export const GOLDEN_SEEDS = [42, 7];
export const GOLDEN_NOW = NOW;
