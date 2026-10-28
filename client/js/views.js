// The two renderings of the same store (design 0003): "Quy trình" (process.js, the default) and
// "Sơ đồ" (canvas.js). Only the active view has DOM and renders; switching keeps the selection,
// opens collapsed frames around it, brings it into view and moves focus along when focus was in
// the view. Not an undoable edit, and the workflow does not change.
//
// The choice is saved in localStorage['sfdg.view'] above 720 px. Phones always open in Quy trình;
// Sơ đồ is in their ⋯ menu, and choosing it there is not saved.

import { state, emit, loadView, saveView, saveCollapsed } from './store.js';
import * as processView from './process.js';
import * as canvasView from './canvas.js';
import * as ops from './ops.js';
import { START_ID } from './layout.js';

export const VIEWS = [
  { value: 'process', label: 'Quy trình' },
  { value: 'canvas', label: 'Sơ đồ' },
];

const PHONE = window.matchMedia('(max-width: 720px)');

const rootOf = (view) => document.getElementById(view === 'canvas' ? 'canvas' : 'process');

export function initViews() {
  state.view = PHONE.matches ? 'process' : loadView() ?? 'process';
  processView.initProcess();
  canvasView.initCanvas();
  for (const b of document.querySelectorAll('.view-switch [data-view]')) b.onclick = () => setView(b.dataset.view);
  applyView();
}

function applyView() {
  const canvas = state.view === 'canvas';
  document.getElementById('process').hidden = canvas;
  document.getElementById('canvas-wrap').hidden = !canvas;
  for (const b of document.querySelectorAll('.view-switch [data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
}

export function setView(view) {
  if (view === state.view || !VIEWS.some((v) => v.value === view)) return;
  const hadFocus = rootOf(state.view).contains(document.activeElement);
  state.view = view;
  if (!PHONE.matches) saveView(view);
  if (view === 'canvas') processView.clearProcess();
  else canvasView.clearCanvas();
  applyView();
  const id = ops.selectedId();
  if (id && ops.expandAncestors(id)) saveCollapsed();
  emit('app', 'view'); // the new view renders
  const sel = state.selection;
  if (sel) ops.reveal(sel.kind === 'step' ? sel.id : START_ID, { focus: hadFocus });
  else if (hadFocus) focusSelected();
}

export const toggleView = () => setView(state.view === 'canvas' ? 'process' : 'canvas');

/** Esc in the inspector: back to the selected card of the active view. */
export const focusSelected = () => (state.view === 'canvas' ? canvasView.focusSelected() : processView.focusSelected());

/** "/" key: the "+" menu at the default insert position, in the active view. */
export const openAddMenuAtDefault = () => (state.view === 'canvas' ? canvasView.openAddMenuAtDefault() : processView.openAddMenuAtDefault());

export function paletteDragStart(e, type) {
  if (state.view === 'canvas') canvasView.paletteDragStart(e, type);
  else processView.paletteDragStart(e, type);
}

export function paletteDragEnd() {
  processView.paletteDragEnd();
  canvasView.paletteDragEnd();
}
