// What a step card shows about runs, shared by both views: the stat chip (design 0012 D live
// counts while a run goes on, H estimate before a run, else the last result) and the insert-error
// tag `⊗ lỗi n`. Views call paintCardRun from their decoration pass, so a progress event only
// patches these two elements (no rebuild: focus and scroll stay).
//
// state.runLive (main.js) while a run goes on:
//   { phase: 'generate', byStep }                    preview, or the dry pass before an insert
//   { phase: 'insert', base, insertByStep }          insert (base: the confirmed preview)

import { h, toast } from './dom.js';
import { state, slotKeys, workflowRevision, stepsById } from './store.js';
import { statChip, estimateChip } from './summary.js';
import { walkSteps } from '/shared/workflow-tree.js';
import { fmt, showInsertErrorsFor } from './results.js';

let staleCache = { revision: -1, workflow: null, lastRunSteps: undefined, value: false };
/**
 * The workflow changed since the last run (chips and tags of that run are old). Serializes the
 * steps once per workflow revision and run, not once per card or progress event.
 */
export function resultStale() {
  const c = staleCache;
  if (c.revision !== workflowRevision() || c.workflow !== state.workflow || c.lastRunSteps !== state.lastRunSteps) {
    staleCache = {
      revision: workflowRevision(), workflow: state.workflow, lastRunSteps: state.lastRunSteps,
      value: state.lastRunSteps !== null && state.lastRunSteps !== JSON.stringify(state.workflow.steps),
    };
  }
  return staleCache.value;
}

/** id → step of the whole workflow (store.js), re-exported for the two views. */
export { stepsById };

const STALE_TITLE = 'Số liệu của lần xem trước gần nhất; workflow đã đổi sau đó.';

/** → { text, cls, title } of the card's chip, or null. */
export function cardChip(step, stale) {
  const live = state.runLive;
  if (live) {
    if (live.phase === 'insert' && step.type === 'record') {
      const total = live.base?.stats?.byStep?.[step.id]?.records;
      if (total === undefined) return null;
      const done = live.insertByStep?.[step.id]?.inserted ?? 0;
      return { text: `insert ${fmt(done)}/${fmt(total)}`, cls: 'stat live', title: 'Đang insert: số bản ghi của bước này đã insert / tổng.' };
    }
    // Frames keep the counts of the dry pass during the insert (the confirmed preview's).
    const text = statChip(step, live.phase === 'insert' ? live.base?.stats?.byStep : live.byStep ?? {});
    return text ? { text, cls: 'stat live', title: 'Số liệu của lần chạy đang diễn ra.' } : null;
  }
  const est = !state.result || stale ? estimateChip(step) : null;
  if (est) return { text: est.text, cls: 'stat est', title: est.title };
  const text = state.result ? statChip(step, state.result.stats?.byStep) : null;
  if (!text) return null;
  return { text, cls: `stat${stale ? ' stale' : ''}`, title: stale ? STALE_TITLE : 'Số liệu của lần xem trước gần nhất.' };
}

/** Records of step `id` the insert refused (children skipped because of a failed parent included). */
export function insertFailed(id) {
  const live = state.runLive;
  if (live) return live.insertByStep?.[id]?.failed ?? 0;
  return state.result?.insert?.byStep?.[id]?.failed ?? 0;
}

/** Insert failures of the steps inside a container (a collapsed frame shows them). */
export function innerInsertFailed(step) {
  let n = 0;
  walkSteps(Object.values(step.slots ?? {}).flat(), (s) => { n += insertFailed(s.id); }, slotKeys);
  return n;
}

/**
 * Patch the chip and the insert-error tag of `card` (step `step`): both live in `parent`, before
 * `before` (null: at the end). Elements are reused, so nothing is rebuilt when nothing changed.
 * `tabindex`: of the tag button (Sơ đồ: '-1').
 */
export function paintCardRun(card, step, { stale, parent, before = null, tabindex }) {
  const want = cardChip(step, stale);
  let chip = parent.querySelector(':scope > .stat');
  if (!want) chip?.remove();
  else {
    if (!chip) {
      chip = h('span', {});
      parent.insertBefore(chip, before);
    }
    if (chip.className !== want.cls) chip.className = want.cls;
    if (chip.textContent !== want.text) chip.textContent = want.text;
    if (chip.title !== want.title) chip.title = want.title;
  }
  const failed = insertFailed(step.id);
  let tag = parent.querySelector(':scope > .tag-insert-err');
  if (!failed) {
    tag?.remove();
    return;
  }
  const label = `${fmt(failed)} bản ghi của bước này insert lỗi. Bấm để xem nhóm lỗi.`;
  if (!tag) {
    tag = h('button', {
      type: 'button',
      class: 'tag-insert-err',
      tabindex, // Sơ đồ: '-1' (one tab stop per tree, keys reach the card)
      onclick: (e) => {
        e.stopPropagation();
        openInsertErrors(step.id);
      },
    });
    parent.insertBefore(tag, chip?.isConnected ? chip.nextSibling : before);
  }
  tag.classList.toggle('stale', Boolean(stale) && !state.runLive);
  if (tag.textContent !== `lỗi ${fmt(failed)}`) tag.textContent = `lỗi ${fmt(failed)}`;
  tag.title = label;
  tag.setAttribute('aria-label', label);
}

/** Tag click: the "Lỗi insert" tab at the first group of the step (only once the insert ended). */
function openInsertErrors(id) {
  if (state.runLive || !state.result?.insert) {
    toast('Nhóm lỗi hiện ở tab "Lỗi insert" khi insert xong.');
    return;
  }
  showInsertErrorsFor(id);
}

/** "3 bước bên trong · 1 lỗi" (+ " · lỗi insert 12") of a collapsed frame's note. */
export function noteText(base, step) {
  const failed = innerInsertFailed(step);
  return failed ? `${base} · lỗi insert ${fmt(failed)}` : base;
}
