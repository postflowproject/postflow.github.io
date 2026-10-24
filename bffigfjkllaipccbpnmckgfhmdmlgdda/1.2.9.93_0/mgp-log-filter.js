// ────────────────────────────────────────────────────────────────────────────
// Console-warning filter
//
// Silences the two React Router v6 → v7 "Future Flag" deprecation notices
// emitted by the popup's React bundle (assets/main-*.js — Vite-built, source
// not in this repo). The proper fix would be to add
//   future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
// to the <BrowserRouter>, but since we ship the pre-built bundle here, we
// filter at the console layer instead.
//
// What we filter:
//   - "React Router Future Flag Warning: ..." (both messages)
//
// What we DO NOT touch:
//   - Any other console.warn / console.error / console.log call
//   - Errors, network warnings, our own [resume-banner] / [bg] logs
//
// Load order: this script MUST be the FIRST <script> in index.html, before
// the React bundle, so that console.warn is patched before React runs and
// emits its warnings. See index.html.
// ────────────────────────────────────────────────────────────────────────────
(() => {
  'use strict';
  // Defensive: bail if console isn't usable (older WebViews, sandboxed envs).
  if (typeof console === 'undefined' || typeof console.warn !== 'function') return;

  // Idempotency guard — patching twice would chain wrappers and cost cycles.
  if (window.__fbgbp_console_filter_init) return;
  window.__fbgbp_console_filter_init = true;

  const origWarn = console.warn;
  const SUPPRESS_PATTERNS = [
    'React Router Future Flag Warning',
  ];

  console.warn = function (...args) {
    try {
      const first = args[0];
      if (typeof first === 'string') {
        for (let i = 0; i < SUPPRESS_PATTERNS.length; i++) {
          if (first.indexOf(SUPPRESS_PATTERNS[i]) >= 0) return; // swallow
        }
      }
    } catch (_) {
      // Fall through to original on any unexpected error.
    }
    return origWarn.apply(this, args);
  };
})();
