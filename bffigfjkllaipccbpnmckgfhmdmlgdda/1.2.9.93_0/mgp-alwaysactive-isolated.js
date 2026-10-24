// mgp-alwaysactive-isolated.js
// ISOLATED-world, document_start. Registered dynamically ONLY while a Safe/DOM campaign
// is active, then unregistered. Mirror of the competitor's alwaysActiveIsolated.js
// (fb_focus_visibility_code.md Part 2).
//
// mgp-content.js was already written EXPECTING this override (see its comment near the
// isTabActuallyFocused() helper: "With the ISOLATED world override, document.hidden is
// always false, so we need this to detect actual background state"). Real focus state for
// timing decisions comes from isTabActuallyFocused() (a worker query), NOT document.hidden,
// so spoofing here is safe and intended. FB's own JS runs in the MAIN world (covered by
// mgp-alwaysactive-main.js); this only affects the extension's isolated reads.
(function () {
  if (window.__mgp_aa_iso) return;
  window.__mgp_aa_iso = true;

  try {
    var _visDesc = { configurable: true, get: function () { return 'visible'; } };
    var _hidDesc = { configurable: true, get: function () { return false; } };
    Object.defineProperty(document, 'visibilityState', _visDesc);
    Object.defineProperty(document, 'webkitVisibilityState', _visDesc);
    Object.defineProperty(document, 'hidden', _hidDesc);
    Object.defineProperty(document, 'webkitHidden', _hidDesc);
  } catch (e) { /* fail-open */ }

  // Block inactivity events at capture phase (window-level blur/focus only — never
  // document.blur, which breaks the Lexical editor focus; never pagehide, which breaks BFCache).
  try {
    var _blk = function (e) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
    document.addEventListener('visibilitychange', _blk, true);
    document.addEventListener('webkitvisibilitychange', _blk, true);
    window.addEventListener('blur', function (e) { if (e.target === window) _blk(e); }, true);
    window.addEventListener('focus', function (e) { if (e.target === window) _blk(e); }, true);
    window.addEventListener('mouseout', _blk, true);
    window.addEventListener('mouseleave', _blk, true);
    window.addEventListener('lostpointercapture', _blk, true);
  } catch (e) { /* fail-open */ }

  // v20: Neutralize beforeunload (backup for the MAIN-world neutralizer) — stop FB's "Leave site?"
  // prompt that freezes the JS loop mid-post. Capture-phase, NO preventDefault (that triggers it).
  try {
    window.addEventListener('beforeunload', function (e) {
      try { e.stopImmediatePropagation(); e.stopPropagation(); delete e.returnValue; } catch (_) {}
    }, true);
    try { window.onbeforeunload = null; } catch (_) {} // v22: plain assignment, no descriptor tell
  } catch (e) { /* fail-open */ }
})();
