// Applies the stored theme before first paint (external file because the CSP forbids inline scripts).
// Keep the lists in sync with web/src/themes/registry.ts.
(function () {
  var both = ['classic', 'smooth', 'mono', 'contrast'];
  var darkOnly = ['dark', 'nord', 'cyberpunk', 'scifi', 'lcars', 'terminal'];
  var chrome = { classic: ['#4f46e5', '#0f172a'], smooth: ['#f9f5f0', '#1c1b22'], mono: ['#fafafa', '#0a0a0a'], contrast: ['#ffffff', '#000000'], dark: [0, '#111315'], nord: [0, '#242933'], cyberpunk: [0, '#0d0714'], scifi: [0, '#00101e'], lcars: [0, '#030100'], terminal: [0, '#000500'] };
  var root = document.documentElement;
  var get = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  var known = function (v) { return both.indexOf(v) >= 0 || darkOnly.indexOf(v) >= 0; };
  // status pages start neutral (Classic, system mode); the page then applies its own theme
  var pub = /^\/status\//.test(location.pathname);
  var id = pub ? 'classic' : get('pw.theme.id');
  if (!known(id)) id = get('pw.theme.default');
  if (!known(id)) id = 'classic';
  var p = pub ? 'system' : get('pw.theme') || 'system';
  var dark = darkOnly.indexOf(id) >= 0 || p === 'dark' || (p === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.setAttribute('data-theme', id);
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  var meta = document.querySelector('meta[name="theme-color"]');
  var c = chrome[id][dark ? 1 : 0];
  if (meta && c) meta.setAttribute('content', c);
})();
