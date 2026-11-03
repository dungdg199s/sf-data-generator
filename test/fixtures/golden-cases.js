// Workflows whose records were recorded with the collect-everything executor (before design 0004
// turned it into a generator). test/stream.test.js checks that the streamed records are still
// byte-identical for the same seed and `now`: the palette samples plus nested cases covering
// random Lookups (count-only pools), Chọn bản ghi from generated and Query pools, branch/loop
// nesting, unique values and pick "skip". Cases added later (the each-loop sample and nested
// case of design 0010, the two cases of design 0013) were recorded when added; adding them changed
// none of the earlier hashes.
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
  {
    // Design 0010, recorded when each-loops were added (every case above kept its hash).
    name: 'each loops over generated, Query and pick pools, nested (0010)',
    workflow: wf([
      record('acc', 'Account', 'acc', [name], { count: 3 }),
      query('q', 'accs', { fields: ['Id', 'Name', 'Industry'] }),
      loop('ea', { mode: 'each', from: 'acc', itemAlias: 'a', alias: 'i' }, [
        record('opp', 'Opportunity', 'opp', [lookup('AccountId', 'a'), { name: 'Name', type: 'template', options: { template: '{{a.Name}} {{i.index}}/{{i.count}} #{{a.$n}}' } }], { count: 2 }),
        loop('eq', { mode: 'each', from: 'accs', itemAlias: 'row' }, [
          branch('b', { kind: 'chance', probability: 0.5 }, [
            record('task', 'Task', 'task', [lookup('WhatId', 'row'), lookup('WhoId', 'opp'), { name: 'Subject', type: 'template', options: { template: '{{row.Industry}} {{loop.index0}}' } }]),
          ]),
        ]),
      ]),
      loop('l', { count: 4 }, [pick('p', 'pk', 'accs', { mode: 'random' })]),
      loop('ep', { mode: 'each', from: 'pk', itemAlias: 'it', alias: 'k' }, [
        record('con', 'Contact', 'con', [lookup('AccountId', 'it'), lookup('Other__c', 'opp', 'random')]),
      ]),
    ]),
    queryResults: { q: accRows(3) },
  },
  {
    // Design 0013, recorded when added (every case above kept its hash).
    name: 'each extras: filter, shuffle, limit over Query and Record pools (0013)',
    workflow: wf([
      query('q', 'accs', { fields: ['Id', 'Name', 'Industry'] }),
      query('qc', 'cons', { sobject: 'Contact', fields: ['Id', 'AccountId', 'LastName'] }),
      record('gen', 'Account', 'gen', [name, { name: 'Industry', type: 'picklist', options: { values: ['Banking', 'Retail'] } }], { count: 8 }),
      loop('la', { mode: 'each', from: 'accs', itemAlias: 'acc' }, [
        loop('lc', { mode: 'each', from: 'cons', itemAlias: 'con', alias: 'k', filter: 'compare', filterField: 'AccountId', filterOp: 'eq', filterValue: '{{acc.Id}}', order: 'shuffle', limit: 2 }, [
          record('task', 'Task', 'task', [lookup('WhoId', 'con'), lookup('WhatId', 'acc'), { name: 'Subject', type: 'template', options: { template: '{{con.LastName}} {{k.index}}/{{k.count}}' } }]),
        ]),
      ]),
      loop('lg', { mode: 'each', from: 'gen', itemAlias: 'g', filter: 'compare', filterField: 'Industry', filterOp: 'neq', filterValue: 'Banking', order: 'shuffle' }, [
        record('opp', 'Opportunity', 'opp', [lookup('AccountId', 'g'), { name: 'Amount', type: 'currency', options: {} }]),
      ]),
      loop('ll', { mode: 'each', from: 'gen', itemAlias: 'g2', limit: 3 }, [record('case', 'Case', 'cs', [lookup('AccountId', 'g2')])]),
    ]),
    queryResults: {
      q: accRows(4),
      qc: rows(Array.from({ length: 11 }, (_, i) => ({ Id: `003${String(i).padStart(15, '0')}`, AccountId: `001${String(i % 5).padStart(15, '0')}`, LastName: `L${i}` })), 'Contact'),
    },
  },
  {
    name: 'values loop, number-variable counts, branch right variable, weighted pick, run vars (0013)',
    workflow: wf([
      query('q', 'accs', { fields: ['Id', 'Name', 'Employees'] }),
      loop('lv', { mode: 'values', values: ['Hot', 'Warm', 'Cold'], alias: 'r' }, [
        record('lead', 'Lead', 'lead', [{ name: 'Rating', type: 'copy', options: { path: 'r.value' } }, { name: 'Description', type: 'template', options: { template: 'Batch {{run.seed}} {{run.today}} {{r.index}}' } }]),
      ]),
      loop('la', { mode: 'each', from: 'accs', itemAlias: 'acc' }, [
        loop('ln', { count: '{{acc.Employees}}', alias: 'n' }, [
          record('con', 'Contact', 'con', [lookup('AccountId', 'acc'), { name: 'Amount__c', type: 'number', options: { min: 0, max: 10 } }]),
          branch('b', { kind: 'compare', left: 'con.Amount__c', op: 'gt', right: '{{n.count}}' }, [record('t', 'Task', 'task', [lookup('WhatId', 'acc')])], []),
        ]),
        loop('lr', { mode: 'range', min: 1, max: '{{accs.$count}}' }, [record('ev', 'Event', 'ev', [])]),
      ]),
      loop('lw', { count: 6 }, [pick('p', 'big', 'accs', { mode: 'weighted', weightField: 'Employees' }), record('opp', 'Opportunity', 'opp', [lookup('AccountId', 'big'), { name: 'When__c', type: 'copy', options: { path: 'run.now' } }])]),
    ]),
    queryResults: { q: rows(Array.from({ length: 5 }, (_, i) => ({ Id: `001${String(i).padStart(15, '0')}`, Name: `Org ${i}`, Employees: [3, 0, '', 2, 7][i] }))) },
  },
];

export const GOLDEN_SEEDS = [42, 7];
export const GOLDEN_NOW = NOW;
