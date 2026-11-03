// Design 0012 I: while a variable chip (0005) or a Lookup field chip is hovered or focused, the
// card of the step it points at gets `.is-ref-target` (dashed accent outline) in the view on
// screen. No scroll, no selection change; a card out of view (Quy trình) or culled (Sơ đồ) gets
// nothing more: the chip's title names the source instead.

import { state, stepById, currentScope } from './store.js';
import { sourceStep } from '/shared/scope.js';
import { stepLabel } from './summary.js';

/** Step id providing the reference of `ref` (analyzeScope), or null (unknown, global, this.*). */
export function refSourceStep(ref) {
  if (!ref || ref.source === undefined || ref.viaThis || ref.code === 'unknownName') return null;
  const scope = currentScope();
  const src = scope.sources[ref.source];
  if (!src || src.global) return null;
  const id = sourceStep(scope, ref.source);
  return stepById(id) ? id : null;
}

/** " · Nguồn: Record "acc"" for a chip's title, or ''. */
export function sourceTitle(stepId) {
  const step = stepId ? stepById(stepId) : null;
  return step ? ` · Nguồn: ${stepLabel(step)}` : '';
}

function mark(stepId) {
  for (const el of document.querySelectorAll('.step-card.is-ref-target')) el.classList.remove('is-ref-target');
  if (!stepId || !state.workflow) return;
  document.querySelector(`.view-wrap .step-card[data-id="${CSS.escape(stepId)}"]`)?.classList.add('is-ref-target');
}

/** Wires hover / focus of `el` to highlight the card of `stepId` (nothing for null). */
export function linkRefTarget(el, stepId) {
  if (!stepId) return el;
  el.dataset.refTarget = stepId;
  const on = () => mark(stepId);
  const off = () => mark(null);
  el.addEventListener('pointerenter', on);
  el.addEventListener('focus', on);
  el.addEventListener('pointerleave', off);
  el.addEventListener('blur', off);
  return el;
}

/** Drops every highlight (the chip went away with a re-render). */
export const clearRefTarget = () => mark(null);
