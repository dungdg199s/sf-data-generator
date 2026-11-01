// Design 0012 I: hovering or focusing a chip that names another step (a variable chip of the
// inspector, a Lookup field chip on a Record card) outlines that step's card in the active view
// (`.is-ref-target`: dashed accent outline). It never scrolls nor changes the selection; the
// chip's title names the source, for a card that is off screen (or culled in Sơ đồ).

import { currentScope, stepById } from './store.js';
import { sourceStep } from '/shared/scope.js';
import { stepLabel } from './summary.js';

let target = null; // { id, chip }

/** Step id to outline (the chip that asked must still be in the page: re-renders drop it). */
export function refTargetId() {
  if (target && !target.chip.isConnected) target = null;
  return target?.id ?? null;
}

/**
 * Step providing the source of an analyzeScope reference (alias ⇒ its Record / Query / Chọn bản
 * ghi; loop variable or record being looped over ⇒ the Lặp), or null: unknown name (a red
 * chip), or the reference's own step (`this.*`).
 */
export function refSourceStep(ref) {
  if (!ref || ref.code === 'unknownName') return null;
  const scope = currentScope();
  if (!scope.sources[ref.source]) return null;
  const id = sourceStep(scope, ref.source);
  return id !== ref.nodeId && stepById(id) ? id : null;
}

/** `Nguồn: Record "acc"` for a chip's title. */
export const sourceTitle = (id) => `Nguồn: ${stepLabel(stepById(id))}`;

/** Outline step `id`'s card while `chip` is hovered or focused. */
export function bindRefTarget(chip, id) {
  if (!id) return chip;
  const on = () => {
    target = { id, chip };
    paintRefTarget();
  };
  const off = () => {
    if (target?.chip !== chip) return;
    target = null;
    paintRefTarget();
  };
  chip.addEventListener('pointerenter', on);
  chip.addEventListener('focus', on);
  chip.addEventListener('pointerleave', off);
  chip.addEventListener('blur', off);
  return chip;
}

/** Patch the outline on the cards of both views (only the active one has DOM). */
export function paintRefTarget() {
  const id = refTargetId();
  for (const c of document.querySelectorAll('.step-card.is-ref-target')) if (c.dataset.id !== id) c.classList.remove('is-ref-target');
  if (!id) return;
  for (const c of document.querySelectorAll(`#process .step-card[data-id="${CSS.escape(id)}"], #canvas .step-card[data-id="${CSS.escape(id)}"]`)) c.classList.add('is-ref-target');
}
