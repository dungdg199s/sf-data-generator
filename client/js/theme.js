// Theme switch (docs/design/0008): "light" | "dark" | "system". A classic script loaded in <head>
// so the stored theme applies before the first paint. "system" removes `data-theme` and lets
// `prefers-color-scheme` decide (the CSS token blocks handle both). Changes in another tab are
// followed through the `storage` event. The select is drawn as a 32 px icon (design 0009 §2), so
// its `title` names the current choice.
(() => {
  const KEY = 'sfdg.theme';
  const VALUES = ['light', 'dark', 'system'];
  const LABELS = { system: 'Theo hệ thống', light: 'Sáng', dark: 'Tối' };
  const sync = (select, v) => {
    select.value = v;
    select.title = `Giao diện: ${LABELS[v]}`;
  };
  const read = () => {
    try {
      const v = localStorage.getItem(KEY);
      return VALUES.includes(v) ? v : 'system';
    } catch {
      return 'system';
    }
  };
  const apply = (v) => {
    if (v === 'light' || v === 'dark') document.documentElement.dataset.theme = v;
    else delete document.documentElement.dataset.theme;
  };
  apply(read());

  // Another tab changed the theme (or cleared storage): follow it, and keep the select in sync.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== null) return;
    const v = read();
    apply(v);
    const select = document.getElementById('theme-select');
    if (select) sync(select, v);
  });

  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('theme-select');
    if (!select) return;
    sync(select, read());
    select.addEventListener('change', () => {
      const v = VALUES.includes(select.value) ? select.value : 'system';
      apply(v);
      sync(select, v);
      try {
        if (v === 'system') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, v);
      } catch {
        /* private mode: the choice lasts until reload */
      }
    });
  });
})();
