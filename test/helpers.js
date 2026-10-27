// Small builders so tests read like the workflows a user builds (workflow JSON version 2).

export function wf(steps, extra = {}) {
  return { version: 2, name: 'test', steps, ...extra };
}

export function record(id, sobject, alias, fields = [], extra = {}) {
  return { id, type: 'record', config: { sobject, alias, fields, ...extra } };
}

export function loop(id, config = {}, body = []) {
  return { id, type: 'loop', config, slots: { body } };
}

export function branch(id, config = {}, yes = [], no = []) {
  return { id, type: 'branch', config, slots: { true: yes, false: no } };
}

export const NOW = Date.parse('2025-06-15T12:00:00Z');
