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
  /* Hotel color. One accent drives --accent, --accent2, --accentsoft, --on-accent, --accent-text and the page glow.
     null = Lotus gold, which the stylesheet already defines for light and dark, so the inline overrides are simply removed. */
  var W = [255, 255, 255], INK = [28, 24, 16], NAMES = ["--accent", "--accent2", "--accentsoft", "--on-accent", "--accent-text", "--page"];
  function rgb(h) { var m = /^#?([0-9a-f]{6})$/i.exec(String(h || "").trim()); if (!m) return null; var n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function hexOf(c) { return "#" + c.map(function (v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"); }).join("").toUpperCase(); }
  function mix(c, d, t) { return c.map(function (v, i) { return v + (d[i] - v) * t; }); }
  function lum(c) { var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
  function ratio(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function rgba(c, o) { return "rgba(" + c.map(Math.round).join(",") + "," + o + ")"; }
  function shownDark() { var m = document.documentElement.getAttribute("data-theme"); return m === "dark" || (m !== "light" && !!(dark && dark.matches)); }
  var curAccent = null;
  function applyAccent(hex) {
    var base = rgb(hex), st = document.documentElement.style;
    curAccent = base ? hexOf(base) : null;
    if (!base) { NAMES.forEach(function (n) { st.removeProperty(n); }); return; }
    var d = shownDark(), acc = d ? mix(base, W, 0.38) : base, acc2 = mix(acc, W, d ? 0.25 : 0.28);
    var on = ratio(acc, W) >= ratio(acc, INK) ? "#FFFFFF" : "#1C1810";
    // Small text in the accent must read on the glass: darken (light mode) or lighten (dark mode) until it passes 4.5.
    var glass = d ? [30, 24, 16] : [255, 253, 248], txt = acc, t = 0;
    while (ratio(txt, glass) < 4.5 && t < 1) { t += 0.05; txt = mix(acc, d ? W : INK, t); }
    var page = d
      ? "radial-gradient(1100px 700px at 10% -10%," + rgba(base, 0.42) + " 0%,transparent 60%),radial-gradient(900px 650px at 100% 0%," + rgba(base, 0.22) + " 0%,transparent 55%),radial-gradient(1000px 800px at 55% 115%," + rgba(base, 0.3) + " 0%,transparent 60%),linear-gradient(160deg,#121010,#0A0909)"
      : "radial-gradient(1200px 700px at 8% -10%," + rgba(mix(base, W, 0.55), 0.55) + " 0%,transparent 60%),radial-gradient(900px 600px at 95% 10%," + rgba(mix(base, W, 0.45), 0.45) + " 0%,transparent 55%),radial-gradient(1000px 800px at 60% 110%," + rgba(mix(base, W, 0.5), 0.5) + " 0%,transparent 60%),linear-gradient(160deg,#FCFAF7," + hexOf(mix(base, W, 0.86)) + ")";
    st.setProperty("--accent", hexOf(acc)); st.setProperty("--accent2", hexOf(acc2)); st.setProperty("--accentsoft", rgba(acc, 0.16));
    st.setProperty("--on-accent", on); st.setProperty("--accent-text", hexOf(txt)); st.setProperty("--page", page);
  }
  var AK = "asklotus.accent.";
  function cacheKey() { try { var h = localStorage.getItem("asklotus.hotel"); return h ? AK + h : null; } catch (e) { return null; } }
  window.applyAccent = applyAccent;
  window.accentMath = { rgb: rgb, hexOf: hexOf, mix: mix, lum: lum, ratio: ratio };
  // Remember a hotel's color on this device so the next page load paints it before the app has loaded anything.
  window.cacheAccent = function (hotel, hex) {
    try { if (hex) localStorage.setItem(AK + hotel, hex); else localStorage.removeItem(AK + hotel); } catch (e) {}
  };
  window.getTheme = read;
  window.setTheme = function (mode) {
    try { if (mode === "auto") localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode); } catch (e) {}
    apply(mode);
    document.dispatchEvent(new CustomEvent("themechange", { detail: mode }));
  };
  // Light and dark lift the accent differently, so a theme change repaints it.
  document.addEventListener("themechange", function () { if (curAccent) applyAccent(curAccent); });
  if (dark && dark.addEventListener) dark.addEventListener("change", function () { if (read() === "auto") apply("auto"); if (curAccent) applyAccent(curAccent); });
  apply(read());
  var k = cacheKey(), cached = null;
  try { cached = k && localStorage.getItem(k); } catch (e) {}
  if (cached) applyAccent(cached);
})();
