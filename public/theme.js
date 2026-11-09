"use strict";
/* Appearance: Automatic (follow the phone or computer), Light or Dark. Loaded in <head> so the page never flashes
   the wrong theme. The choice is per device (each phone at the desk can have its own). */
(function () {
  var KEY = "asklotus.theme";
  var BAR = { light: "#F2F2F7", dark: "#0B0B0C" };
  var dark = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;
  function read() {
    try { var v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "auto"; } catch (e) { return "auto"; }
  }
  function apply(mode) {
    var root = document.documentElement;
    if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode);
    else root.removeAttribute("data-theme");
    var shown = mode === "auto" ? (dark && dark.matches ? "dark" : "light") : mode;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", BAR[shown]);
  }
  window.getTheme = read;
  window.setTheme = function (mode) {
    try { if (mode === "auto") localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode); } catch (e) {}
    apply(mode);
    document.dispatchEvent(new CustomEvent("themechange", { detail: mode }));
  };
  if (dark && dark.addEventListener) dark.addEventListener("change", function () { if (read() === "auto") apply("auto"); });
  apply(read());
})();
