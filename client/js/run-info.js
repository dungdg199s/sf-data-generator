// Design 0012 D: what the step cards show about a run, while it runs and after it.
//
// main.js feeds `progress` events (server-throttled to 4 per second) into setLiveRun; both views
// draw a card's chip and insert-error tag with chipFor / insertErrors, and paintRunInfo patches
// those two parts in place (by data-id), without rebuilding the DOM, so focus and scroll stay.
//   preview / dry pass  statChip(step, ev.byStep)    ("1 200 bản ghi", "300 lần lặp")
//   insert              Record: "insert 1 200/5 000" (total: the confirmed preview's byStep);
//                       containers keep the chip of the dry pass
//   done                the result as before (state.result.stats.byStep), tags from insert.byStep
// No aria-live on the cards: the progress is read out in the results header.

import { h } from './dom.js';
import { state, stepById, slotKeys } from './store.js';
import { statChip, estimateChip } from './summary.js';
import { walkSteps } from '/shared/workflow-tree.js';

const fmt = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** { phase: 'generate' | 'insert', byStep (generate), insertByStep, totals: { [id]: records } } or null. */
let live = null;

/** A run started (`totals`: records per Record step of the confirmed preview, for an insert). */
export function startLiveRun({ totals = null } = {}) {
  live = { phase: 'generate', byStep: null, insertByStep: null, totals };
}

/** A progress event of the running run. → true when the cards should be repainted. */
export function liveProgress(ev) {
  if (!live || ev?.type !== 'progress') return false;
  if (ev.phase === 'generate' && ev.byStep) {
    live.byStep = ev.byStep;
    return true;
  }
  if (ev.phase === 'insert') {
    live.phase = 'insert';
    if (ev.byStep) live.insertByStep = ev.byStep;
    return true;
  }
  return false;
}

/** The run ended: cards go back to the result (state.result) on the next render. */
export function endLiveRun() {
  live = null;
}

export const isLive = () => Boolean(live);

/** The chip of a card: { text, class, title } or null. `stale`: the workflow changed since the last run. */
export function chipFor(step, { stale = false } = {}) {
  if (live) {
    const ins = live.phase === 'insert' ? live.insertByStep?.[step.id] : null;
    if (live.phase === 'insert' && step.type === 'record' && live.totals?.[step.id] !== undefined) {
      // Inserted only (review 0012 N4); the failures are the "lỗi n" tag next to it.
      return { text: `insert ${fmt(ins?.inserted ?? 0)}/${fmt(live.totals[step.id])}`, class: 'stat live', title: 'Đang insert: số bản ghi của bước này đã insert / tổng của bản xem trước (bản ghi lỗi ở tag "lỗi").' };
    }
    const text = live.byStep ? statChip(step, live.byStep) : null;
    if (text) return { text, class: 'stat live', title: 'Đang chạy: số liệu cập nhật trực tiếp.' };
    if (!live.byStep) return chipAfterRun(step, stale);
    return null;
  }
  return chipAfterRun(step, stale);
}

function chipAfterRun(step, stale) {
  const est = !state.result || stale ? estimateChip(step) : null;
  if (est) return { text: est.text, class: 'stat est', title: est.title };
  const text = state.result ? statChip(step, state.result.stats?.byStep) : null;
  if (!text) return null;
  return { text, class: `stat${stale ? ' stale' : ''}`, title: stale ? 'Số liệu của lần xem trước gần nhất; workflow đã đổi sau đó.' : 'Số liệu của lần xem trước gần nhất.' };
}

/** Insert failures of a Record step (live, else the last result's insert.byStep). */
export function insertErrors(id) {
  const by = live ? live.insertByStep : state.result?.insert?.byStep;
  return by?.[id]?.failed ?? 0;
}

/** Insert failures of the Record steps inside a container (a collapsed frame's note). */
export function innerInsertErrors(id) {
  const step = stepById(id);
  let n = 0;
  if (step) walkSteps(Object.values(step.slots ?? {}).flat(), (s) => { n += insertErrors(s.id); }, slotKeys);
  return n;
}

/** The insert-error tag of a card, or null. `onOpen(id)` opens the "Lỗi insert" tab at the step. */
export function insertErrorTag(id, { stale = false, onOpen } = {}) {
  const n = insertErrors(id);
  if (!n) return null;
  const label = `${fmt(n)} bản ghi của bước này insert lỗi. Bấm để xem nhóm lỗi.`;
  return h('button', {
    class: `tag-insert-err${stale ? ' stale' : ''}`,
    'data-errors-of': id,
    title: label,
    'aria-label': label,
    onclick: (e) => {
      e.stopPropagation();
      onOpen?.(id);
    },
  }, `lỗi ${fmt(n)}`);
}

/**
 * Patch the chip and the insert-error tag of every card of `root` (one view) in place.
 * `place(card, el, kind)` puts a new element where that view draws it ('chip' | 'tag').
 */
export function paintRunInfo(root, { stale = false, place, onOpen }) {
  for (const card of root.querySelectorAll('.step-card[data-id]')) {
    const step = stepById(card.dataset.id);
    if (!step) continue;
    const c = chipFor(step, { stale });
    let chip = card.querySelector('.stat');
    if (!c) chip?.remove();
    else {
      if (!chip) {
        chip = h('span', {});
        place(card, chip, 'chip');
      }
      chip.className = c.class;
      chip.title = c.title;
      if (chip.textContent !== c.text) chip.textContent = c.text;
    }
    const old = card.querySelector('.tag-insert-err');
    const tag = step.type === 'record' ? insertErrorTag(step.id, { stale, onOpen }) : null;
    if (!tag) old?.remove();
    else if (old) {
      if (old.textContent !== tag.textContent) old.replaceWith(tag);
    } else place(card, tag, 'tag');
  }
}
