// Small builders so tests read like the workflows a user would draw.

export function wf(nodes, edges, extra = {}) {
  return { version: 1, nodes: [{ id: 'start', type: 'start' }, ...nodes], edges, ...extra };
}

export function edge(from, to, fromPort = 'next') {
  return { from, to, fromPort };
}

export function record(id, sobject, alias, fields = [], extra = {}) {
  return { id, type: 'record', config: { sobject, alias, fields, ...extra } };
}

export const NOW = Date.parse('2025-06-15T12:00:00Z');
