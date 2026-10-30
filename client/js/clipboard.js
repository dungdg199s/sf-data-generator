// Copy / paste of steps through the system clipboard (design 0012 B): the text format and its
// checks. Pure (no DOM, no store), so test/clipboard.test.js runs it in Node; the relative import
// resolves to /shared/ in the browser too. main.js wires the copy / cut / paste events.
//
// Format (text/plain, readable JSON):
//   { "sfdg": "steps", "version": 2, "from": "<workflow name>", "steps": [ step… ] }
// A whole workflow file { "version": 2, "steps": [ … ] } is accepted as well.

import { malformedSteps, countSteps } from '../../shared/workflow-tree.js';

export const PASTE_MAX_STEPS = 2000;
export const PASTE_MAX_BYTES = 5 * 1024 * 1024;

const fmt = (n) => Number(n).toLocaleString('vi-VN');

/** Clipboard text for `steps` (reading order) copied from the workflow named `name`. */
export function toClipboard(steps, name) {
  return JSON.stringify({ sfdg: 'steps', version: 2, from: name ?? '', steps }, null, 2);
}

/**
 * Read clipboard text. `meta`: /api/meta (step types known to this version).
 * → { steps, from } or { error, kind }: kind 'notSteps' (not ours: the caller decides whether to
 * say so), 'v1', 'malformed', 'unknownType', 'tooLarge'. Messages are the toasts of the design.
 */
export function parseClipboard(text, meta) {
  const notSteps = { kind: 'notSteps', error: 'Bộ nhớ tạm không chứa bước nào của SF Data Generator. Chọn bước rồi bấm Ctrl+C để sao chép.' };
  if (typeof text !== 'string' || !text.trim()) return notSteps;
  if (text.length > PASTE_MAX_BYTES) {
    return { kind: 'tooLarge', error: `Nội dung dán quá lớn (hơn ${fmt(PASTE_MAX_BYTES / 1024 / 1024)} MB). Dán tối đa ${fmt(PASTE_MAX_STEPS)} bước mỗi lần.` };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return notSteps;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return notSteps;
  if (data.version === 1 && Array.isArray(data.nodes)) {
    return { kind: 'v1', error: 'Đây là workflow version 1. Mở bằng Thư viện → Mở file JSON… để chuyển đổi.' };
  }
  const ours = data.sfdg === 'steps' || data.version === 2;
  if (!ours || !Array.isArray(data.steps) || !data.steps.length) return notSteps;
  const n = countSteps(data.steps); // at most 5 MB of text: counting all of it is cheap
  if (n > PASTE_MAX_STEPS) {
    return { kind: 'tooLarge', error: `Nội dung dán quá lớn (${fmt(n)} bước). Dán tối đa ${fmt(PASTE_MAX_STEPS)} bước mỗi lần.` };
  }
  const bad = malformedSteps(data);
  if (bad) return { kind: 'malformed', error: `Không dán được: ${bad}.` };
  const known = new Set((meta?.nodeTypes ?? []).map((t) => t.type));
  if (known.size) {
    const unknown = firstUnknownType(data.steps, known);
    if (unknown !== null) return { kind: 'unknownType', error: `Không dán được: bước loại "${unknown}" không có trong phiên bản này.` };
  }
  return { steps: data.steps, from: typeof data.from === 'string' ? data.from : typeof data.name === 'string' ? data.name : '' };
}

/** The first step type (reading order, nested included) not in `known`, or null. */
function firstUnknownType(steps, known) {
  const todo = [...steps].reverse();
  while (todo.length) {
    const s = todo.pop();
    if (!known.has(s.type)) return String(s.type);
    for (const list of Object.values(s.slots ?? {}).reverse()) todo.push(...[...list].reverse());
  }
  return null;
}
