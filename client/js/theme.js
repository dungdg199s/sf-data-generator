// Theme switch (docs/design/0008): "light" | "dark" | "system". A classic script loaded in <head>
// so the stored theme applies before the first paint. "system" removes `data-theme` and lets
// `prefers-color-scheme` decide (the CSS token blocks handle both).
(() => {
  const KEY = 'sfdg.theme';
  const VALUES = ['light', 'dark', 'system'];
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

  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('theme-select');
    if (!select) return;
    select.value = read();
    select.addEventListener('change', () => {
      const v = VALUES.includes(select.value) ? select.value : 'system';
      apply(v);
      try {
        if (v === 'system') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, v);
      } catch {
        /* private mode: the choice lasts until reload */
      }
    });
  });
})();
