// Variable-picker keys per platform (design 0014 §6): client/js/keys.js is pure, so it loads in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMac, pickerKeys, isPickerOpenKey, PICKER_ARIA_KEYS } from '../client/js/keys.js';

test('isMac: macOS, iPhone and iPad (also through userAgentData), not Windows / Linux / Android', () => {
  assert.equal(isMac({ platform: 'MacIntel' }), true);
  assert.equal(isMac({ platform: 'iPhone' }), true);
  assert.equal(isMac({ platform: 'iPad' }), true);
  assert.equal(isMac({ userAgentData: { platform: 'macOS' }, platform: 'MacIntel' }), true);
  assert.equal(isMac({ platform: 'Win32' }), false);
  assert.equal(isMac({ userAgentData: { platform: 'Windows' }, platform: 'Win32' }), false);
  assert.equal(isMac({ platform: 'Linux x86_64' }), false);
  assert.equal(isMac({ userAgentData: { platform: 'Android' } }), false);
});

test('isMac: missing userAgentData (Safari, Firefox) falls back to navigator.platform; no navigator at all is not a Mac', () => {
  assert.equal(isMac({ platform: 'MacIntel', userAgentData: undefined }), true);
  assert.equal(isMac({ userAgentData: { platform: '' }, platform: 'MacIntel' }), true);
  assert.equal(isMac({}), false);
  assert.equal(isMac(undefined), false);
  assert.equal(isMac(null), false);
});

test('pickerKeys: ⌥↓ on a Mac; Alt+↓ and Ctrl+Space elsewhere', () => {
  const mac = pickerKeys(true);
  assert.equal(mac.template, 'Chèn biến (gõ {{ hoặc ⌥↓)');
  assert.equal(mac.path, 'Chọn biến (↓ hoặc ⌥↓)');
  assert.match(mac.shortcut, /\{\{ hoặc ⌥↓ mở bảng chọn biến/);
  assert.doesNotMatch(JSON.stringify(mac), /Ctrl\+Space/);
  const pc = pickerKeys(false);
  assert.equal(pc.template, 'Chèn biến (gõ {{, Alt+↓ hoặc Ctrl+Space)');
  assert.equal(pc.path, 'Chọn biến (↓, Alt+↓ hoặc Ctrl+Space)');
  assert.match(pc.shortcut, /\{\{, Alt\+↓ hoặc Ctrl\+Space mở bảng chọn biến/);
  assert.equal(PICKER_ARIA_KEYS, 'Alt+ArrowDown Control+Space');
});

test('isPickerOpenKey: Ctrl+Space and Alt+↓ open; plain ↓, Ctrl+↓ and Alt+↑ do not', () => {
  const k = (o) => ({ ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, key: '', code: '', ...o });
  assert.equal(isPickerOpenKey(k({ ctrlKey: true, key: ' ', code: 'Space' })), true);
  assert.equal(isPickerOpenKey(k({ altKey: true, key: 'ArrowDown' })), true);
  assert.equal(isPickerOpenKey(k({ key: 'ArrowDown' })), false);
  assert.equal(isPickerOpenKey(k({ ctrlKey: true, key: 'ArrowDown' })), false);
  assert.equal(isPickerOpenKey(k({ altKey: true, key: 'ArrowUp' })), false);
  assert.equal(isPickerOpenKey(k({ altKey: true, shiftKey: true, key: 'ArrowDown' })), false);
  assert.equal(isPickerOpenKey(k({ key: ' ', code: 'Space' })), false);
});
