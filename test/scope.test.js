import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRecordScope, refState, recordChoices, loopMinIterations } from '../shared/scope.js';
import { slotKeys } from '../server/workflow/nodes.js';
import { wf, record, loop, branch } from './helpers.js';

const r = (id, alias = id) => record(id, 'Account', alias);

test('scope: always / last / maybe / after / otherBranch / disabled', () => {
  const w = wf([
    r('top'),
    loop('l', { count: 2 }, [r('inLoop'), r('beforeUse')]),
    loop('z', { mode: 'range', min: 0, max: 2 }, [r('zeroLoop')]),
    branch('b', {}, [r('yes'), r('useYes')], [r('no')]),
    { ...r('off'), disabled: true },
    r('use'),
    r('later'),
  ]);
  const scope = analyzeRecordScope(w, slotKeys);
  const at = (id, alias) => refState(scope, id, alias).state;
  assert.equal(at('use', 'top'), 'always');
  assert.equal(at('use', 'inLoop'), 'last');
  assert.equal(at('beforeUse', 'inLoop'), 'always');
  assert.equal(at('inLoop', 'beforeUse'), 'after');
  assert.equal(at('use', 'zeroLoop'), 'maybe');
  assert.equal(at('use', 'yes'), 'maybe');
  assert.equal(at('useYes', 'yes'), 'always');
  assert.equal(at('no', 'yes'), 'otherBranch');
  assert.equal(at('use', 'off'), 'disabled');
  assert.equal(at('use', 'later'), 'after');
  assert.equal(at('use', 'use'), 'after');
  assert.equal(at('use', 'nope'), 'unknown');
});

test('scope: recordChoices lists usable aliases nearest first, then the rest with a reason', () => {
  const w = wf([r('a'), r('b'), r('here'), r('c')]);
  const choices = recordChoices(analyzeRecordScope(w, slotKeys), 'here');
  assert.deepEqual(choices.map((c) => `${c.alias}:${c.usable ? c.state : `-${c.state}`}`), ['b:always', 'a:always', 'c:-after']);
});

test('scope: loopMinIterations', () => {
  assert.equal(loopMinIterations({ count: 3 }), 3);
  assert.equal(loopMinIterations({ count: 0 }), 0);
  assert.equal(loopMinIterations({}), 0);
  assert.equal(loopMinIterations({ mode: 'range', min: 0, max: 4 }), 0);
  assert.equal(loopMinIterations({ mode: 'range', max: 4 }), 1);
});
