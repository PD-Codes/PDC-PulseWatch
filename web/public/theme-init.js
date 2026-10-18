// Applies the stored theme before first paint (external file because the CSP forbids inline scripts).
(function () {
  try {
    var p = localStorage.getItem('pw.theme') || 'system';
    var dark = p === 'dark' || (p === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) { /* storage unavailable */ }
})();
