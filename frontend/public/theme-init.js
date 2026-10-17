// pick the theme before first paint so there is no dark/light flash (mirrors src/theme.tsx).
// A separate file (not inline) so the Content-Security-Policy can forbid inline scripts.
(function () {
  var m = null;
  try { m = localStorage.getItem("bd-theme"); } catch (e) {}
  if (m !== "light" && m !== "dark") m = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = m;
})();
