// Platform-dependent key labels (design 0014 §6). Pure: no DOM, so node:test can load it.
// macOS takes Ctrl+Space to switch input sources (Telex / VNI users), so the variable picker
// also opens with Alt+↓ (⌥↓), the standard "open the list" key of a combobox, on every platform.

/**
 * True on macOS, iPhone and iPad (`nav` defaults to the browser's navigator). Case-insensitive:
 * `userAgentData.platform` says "macOS", `navigator.platform` "MacIntel" / "iPhone" / "iPad".
 */
export function isMac(nav = globalThis.navigator) {
  const platform = nav?.userAgentData?.platform || nav?.platform || '';
  return /mac|iphone|ipad/i.test(platform);
}

/** The keys a field with the variable picker accepts (both, whatever the platform). */
export const PICKER_ARIA_KEYS = 'Alt+ArrowDown Control+Space';

/**
 * Labels of the picker keys: `template` / `path` are the {x} button titles, `shortcut` the line
 * of the "Phím tắt" list. On a Mac only ⌥↓ is shown (Ctrl+Space usually switches the input source).
 */
export function pickerKeys(mac) {
  return mac
    ? {
      template: 'Chèn biến (gõ {{ hoặc ⌥↓)',
      path: 'Chọn biến (↓ hoặc ⌥↓)',
      shortcut: 'Trong ô Mẫu / ô biến: {{ hoặc ⌥↓ mở bảng chọn biến',
    }
    : {
      template: 'Chèn biến (gõ {{, Alt+↓ hoặc Ctrl+Space)',
      path: 'Chọn biến (↓, Alt+↓ hoặc Ctrl+Space)',
      shortcut: 'Trong ô Mẫu / ô biến: {{, Alt+↓ hoặc Ctrl+Space mở bảng chọn biến',
    };
}

/** True for the keys that open the picker from its field: Ctrl+Space, or Alt+↓ (⌥↓) alone. */
export function isPickerOpenKey(e) {
  if (e.ctrlKey && (e.code === 'Space' || e.key === ' ')) return true;
  return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === 'ArrowDown';
}
