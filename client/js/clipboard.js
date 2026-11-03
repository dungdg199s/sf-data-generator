// Steps on the system clipboard (design 0012 B): pure functions, tested in Node
// (test/clipboard.test.js). The relative import resolves to /shared/ in the browser and to
// shared/ in Node.
//
// Format (text/plain, readable when pasted into a chat or an editor):
//   { "sfdg": "steps", "version": 2, "from": "<workflow name>", "steps": [ … ] }
// A whole workflow file { "version": 2, "steps": [ … ] } is accepted too.

import { malformedSteps, walkSteps } from '../../shared/workflow-tree.js';

export const CLIPBOARD_LIMITS = { maxSteps: 2000, maxBytes: 5 * 1024 * 1024 };

/** JSON text for the clipboard. */
export function toClipboard(steps, name) {
  return JSON.stringify({ sfdg: 'steps', version: 2, from: name ?? '', steps }, null, 2);
}

const fmt = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/**
 * Steps from clipboard text, checked against the catalogue `meta` ({ nodeTypes }).
 * → { steps } or { error: 'notSteps' | 'v1' | 'tooBig' | 'malformed' | 'unknownType', message }.
 * `notSteps` is said only when the user pasted into the tree (the caller decides).
 */
export function parseClipboard(text, meta) {
  const raw = String(text ?? '');
  const notSteps = { error: 'notSteps', message: 'Bộ nhớ tạm không chứa bước nào của SF Data Generator. Chọn bước rồi bấm Ctrl+C để sao chép.' };
  if (!raw.trim().startsWith('{')) return notSteps;
  if (raw.length > CLIPBOARD_LIMITS.maxBytes) return { error: 'tooBig', message: `Nội dung dán quá lớn (hơn ${fmt(Math.round(CLIPBOARD_LIMITS.maxBytes / 1048576))} MB). Dán tối đa ${fmt(CLIPBOARD_LIMITS.maxSteps)} bước mỗi lần.` };
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return notSteps;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return notSteps;
  if (obj.version === 1 && Array.isArray(obj.nodes)) return { error: 'v1', message: 'Đây là workflow version 1. Mở bằng Thư viện → Mở file JSON… để chuyển đổi.' };
  const ours = obj.sfdg === 'steps' || (obj.version === 2 && obj.sfdg === undefined);
  if (!ours || !Array.isArray(obj.steps) || !obj.steps.length) return notSteps;
  const bad = malformedSteps({ steps: obj.steps });
  if (bad) return { error: 'malformed', message: `Không dán được: ${bad}.` };
  let count = 0;
  let unknown = null;
  const types = new Set((meta?.nodeTypes ?? []).map((t) => t.type));
  walkSteps(obj.steps, (s) => {
    count++;
    if (unknown === null && !types.has(s.type)) unknown = s.type;
  });
  if (count > CLIPBOARD_LIMITS.maxSteps) return { error: 'tooBig', message: `Nội dung dán quá lớn (${fmt(count)} bước). Dán tối đa ${fmt(CLIPBOARD_LIMITS.maxSteps)} bước mỗi lần.` };
  if (unknown !== null) return { error: 'unknownType', message: `Không dán được: bước loại "${unknown}" không có trong phiên bản này.` };
  return { steps: obj.steps, from: typeof obj.from === 'string' ? obj.from : '' };
}
