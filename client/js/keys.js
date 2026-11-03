// Keyboard labels that depend on the platform (design 0014 §6). Pure: no DOM, so node:test loads it.
//
// macOS uses Ctrl+Space to switch input sources (Telex / VNI), so the key never reaches the page.
// Alt+↓ (⌥↓ on a Mac) opens the variable picker on every platform: it is the combobox "open the
// list" key (ARIA APG). The other `Ctrl+…` labels stay: main.js accepts Ctrl and ⌘ for them.

/** True on macOS, iPhone and iPad (`nav` is `navigator` or a stand-in with the same fields). */
export function isMac(nav) {
  const platform = nav?.userAgentData?.platform || nav?.platform || '';
  return /Mac|iPhone|iPad/i.test(platform);
}

/** The keydown opens the variable picker: Alt+↓ (⌥↓) or Ctrl+Space. */
export function isPickerKey(e) {
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowDown') return true;
  return Boolean(e.ctrlKey && !e.altKey && (e.code === 'Space' || e.key === ' '));
}

/** `aria-keyshortcuts` of a field with the picker (both keys, every platform). */
export const PICKER_SHORTCUTS = 'Alt+ArrowDown Control+Space';

/**
 * Labels of the picker keys for one platform: the {x} button's `title` per field mode, and the
 * line of the "Phím tắt" list.
 */
export function pickerKeys(mac) {
  if (mac) {
    return {
      template: 'Chèn biến (gõ {{ hoặc ⌥↓)',
      number: 'Chọn biến kiểu Số (gõ {{ hoặc ⌥↓)',
      path: 'Chọn biến (↓ hoặc ⌥↓)',
      shortcut: 'Trong ô Mẫu / ô biến: {{ hoặc ⌥↓ mở bảng chọn biến',
    };
  }
  return {
    template: 'Chèn biến (gõ {{, Alt+↓ hoặc Ctrl+Space)',
    number: 'Chọn biến kiểu Số (gõ {{, Alt+↓ hoặc Ctrl+Space)',
    path: 'Chọn biến (↓, Alt+↓ hoặc Ctrl+Space)',
    shortcut: 'Trong ô Mẫu / ô biến: {{, Alt+↓ hoặc Ctrl+Space mở bảng chọn biến',
  };
}
