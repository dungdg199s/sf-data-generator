// Platform key labels of the variable picker (design 0014 §6): client/js/keys.js is pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMac, isPickerKey, pickerKeys, PICKER_SHORTCUTS } from '../client/js/keys.js';

test('isMac: macOS, iPhone and iPad through userAgentData or platform; others are not', () => {
  assert.equal(isMac({ platform: 'MacIntel' }), true);
  assert.equal(isMac({ platform: 'iPhone' }), true);
  assert.equal(isMac({ platform: 'iPad' }), true);
  assert.equal(isMac({ userAgentData: { platform: 'macOS' }, platform: 'MacIntel' }), true);
  assert.equal(isMac({ userAgentData: { platform: 'Windows' }, platform: 'Win32' }), false);
  assert.equal(isMac({ platform: 'Win32' }), false);
  assert.equal(isMac({ platform: 'Linux x86_64' }), false);
  // userAgentData missing (Firefox, Safari) or with an empty platform: fall back to navigator.platform.
  assert.equal(isMac({ userAgentData: { platform: '' }, platform: 'MacIntel' }), true);
  assert.equal(isMac({ userAgentData: undefined, platform: 'Win32' }), false);
  assert.equal(isMac({}), false);
  assert.equal(isMac(undefined), false);
});

test('isPickerKey: Alt+↓ and Ctrl+Space open the picker; plain ↓, Alt+↑, Ctrl+Alt+↓ do not', () => {
  assert.equal(isPickerKey({ altKey: true, key: 'ArrowDown' }), true);
  assert.equal(isPickerKey({ ctrlKey: true, code: 'Space', key: ' ' }), true);
  assert.equal(isPickerKey({ ctrlKey: true, key: ' ' }), true);
  assert.equal(isPickerKey({ key: 'ArrowDown' }), false);
  assert.equal(isPickerKey({ altKey: true, key: 'ArrowUp' }), false);
  assert.equal(isPickerKey({ altKey: true, ctrlKey: true, key: 'ArrowDown' }), false);
  assert.equal(isPickerKey({ altKey: true, metaKey: true, key: 'ArrowDown' }), false);
  assert.equal(isPickerKey({ key: ' ', code: 'Space' }), false);
});

test('pickerKeys: Mac labels say ⌥↓ (no Ctrl+Space); others list Alt+↓ and Ctrl+Space', () => {
  const mac = pickerKeys(true);
  assert.equal(mac.template, 'Chèn biến (gõ {{ hoặc ⌥↓)');
  assert.equal(mac.path, 'Chọn biến (↓ hoặc ⌥↓)');
  assert.match(mac.number, /⌥↓/);
  assert.match(mac.shortcut, /^Trong ô Mẫu \/ ô biến: \{\{ hoặc ⌥↓ mở bảng chọn biến$/);
  for (const v of Object.values(mac)) assert.ok(!v.includes('Ctrl+Space'), v);
  const pc = pickerKeys(false);
  assert.equal(pc.template, 'Chèn biến (gõ {{, Alt+↓ hoặc Ctrl+Space)');
  assert.equal(pc.path, 'Chọn biến (↓, Alt+↓ hoặc Ctrl+Space)');
  assert.match(pc.number, /Alt\+↓ hoặc Ctrl\+Space/);
  assert.match(pc.shortcut, /Alt\+↓ hoặc Ctrl\+Space mở bảng chọn biến$/);
  assert.equal(PICKER_SHORTCUTS, 'Alt+ArrowDown Control+Space');
});
