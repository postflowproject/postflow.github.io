// ────────────────────────────────────────────────────────────────────────────
// Early migrations (2026-04-23 Round 6)
//
// THIS FILE MUST LOAD AS A CLASSIC PARSER-BLOCKING SCRIPT *BEFORE* THE
// MODULE BUNDLE. Ordering constraint is enforced in index.html.
//
// Why this file exists
// --------------------
// popup_fixes.js already carries two one-shot migrations:
//   • smartDefaultV2Migration → humanLevel 1 → 2  (Round 4)
//   • randomizeBatchV1Migration → waitMinutes 5 → 3.5  (Round 5)
// Both gate on a marker stored in chrome.storage.local, which is ASYNC.
// Both also run inside popup_fixes.js which is loaded with `defer`. The
// React bundle is a `<script type="module">` which is *implicitly* deferred
// and — crucially — executes in document order BEFORE any `defer`-tagged
// classic scripts that follow it. Net effect:
//
//   1. console_filter.js runs (classic, sync)
//   2. main-Dkyi3l82.js executes → Zustand's `persist` middleware reads
//      localStorage['delivery-options'] and rehydrates in-memory state
//      with whatever was there (e.g. legacy humanLevel=1, waitMinutes=5).
//   3. popup_fixes.js's async IIFEs eventually resolve and REWRITE
//      localStorage['delivery-options'] to the new defaults.
//   4. But Zustand's in-memory store already hydrated in step 2 — it
//      ignores the later localStorage mutation. UI still shows Light /
//      5 min until a manual refresh.
//
// The user reported exactly this: screenshot showing the SMART BEHAVIOR
// slider still on Light despite the Round 4 migration. "הדיפולט צריך
// להיות Medium ב SMART BEHAVIOR — גם ב-UI וגם בביצוע של ההשהיות."
//
// The fix
// -------
// Run the migration SYNCHRONOUSLY, in a classic parser-blocking script,
// BEFORE the bundle loads. That way:
//   • localStorage is already correct when Zustand rehydrates.
//   • The in-memory store lands on Medium / 3.5-min on first paint.
//   • popup_fixes.js's async IIFEs short-circuit on the new v3 marker
//     (see the `_smartDefaultV3Applied` early-exit added there).
//
// Marker strategy
// ---------------
// We use a *localStorage* marker (`_smartDefaultV3Applied`) rather than
// chrome.storage.local — because chrome.storage is async and we need
// synchronous sequencing. Localhost-scoped popup storage is fine for this:
// the extension runs inside a single chrome-extension:// origin so
// localStorage is stable across popup opens. The OLD async markers
// (`_smartDefaultV2Applied`, `_randomizeBatchV1Applied`) continue to
// gate the popup_fixes.js IIFEs independently — new installs get both
// markers set (the v3 marker by THIS file, the v1/v2 markers by
// popup_fixes.js); legacy users who already ran v2/v1 get v3 applied
// once more, which is a no-op on data that's already correct.
//
// Rollback
// --------
// A user who *deliberately* picks Light or sets waitMinutes to 5 AFTER
// this migration runs once keeps their choice forever — the marker
// blocks any re-bump. Same contract as v2/v1.
// ────────────────────────────────────────────────────────────────────────────
(function earlyMigrations() {
  'use strict';
  const MARKER = '_smartDefaultV3Applied';
  const KEY = 'delivery-options';
  try {
    if (window.localStorage.getItem(MARKER) === '1') {
      // Already applied on a previous load — nothing to do. Zustand will
      // rehydrate from whatever the user has now, which is either (a) the
      // migrated defaults from a previous run, or (b) a deliberate user
      // choice that post-dated the migration. Either way we leave it alone.
      return;
    }

    const raw = window.localStorage.getItem(KEY);
    let touched = false;

    if (!raw) {
      // Fresh install. Seed the persist state directly so the very first
      // rehydration lands on the new defaults. Version 4 matches the
      // bumped persist version in useDeliveryOptions.ts Round 5. If the
      // bundle is older (persist version 2 or 3) Zustand's merge() still
      // reads our options correctly because the field shapes are a
      // strict superset and the TS merge fn normalises out-of-range values.
      const seed = {
        state: {
          options: {
            pacingEnabled: false,
            postsBefore: 1,
            waitMinutes: 3.5,
            randomizeWait: true,
            humanLevel: 2,
            postCount: 25,
            isNewAccount: false,
          },
        },
        version: 4,
      };
      window.localStorage.setItem(KEY, JSON.stringify(seed));
      touched = true;
    } else {
      // Existing state — bump ONLY the fields still sitting on the legacy
      // defaults. Zustand persist wraps state: { state: {...}, version: N }.
      // Some shapes wrap further in .options — handle both, same as the
      // bridge's extractModern and the popup_fixes migrations.
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
      const state = (parsed && parsed.state) || parsed;
      if (state && typeof state === 'object') {
        const opts = state.options || state;
        if (opts && typeof opts === 'object') {
          // Legacy humanLevel=1 (old default) → Medium (2).
          // Any other value (0/2/3) is a deliberate choice; respect it.
          if (opts.humanLevel === 1) {
            opts.humanLevel = 2;
            touched = true;
          }
          // Legacy waitMinutes=5 (old default) → 3.5.
          // Any other value is a deliberate choice; respect it.
          if (opts.waitMinutes === 5) {
            opts.waitMinutes = 3.5;
            touched = true;
          }
          if (touched) {
            window.localStorage.setItem(KEY, JSON.stringify(parsed));
          }
        }
      }
    }

    // Mark applied so we never re-run. Any user who post-dates this
    // migration by picking Light or waitMinutes=5 keeps that choice.
    window.localStorage.setItem(MARKER, '1');

    // The dual-store bridge in popup_fixes.js forwards MODERN fields to
    // chrome.storage.local['_userDeliveryOverride'] on load. That IIFE
    // runs AFTER us (it's in the deferred popup_fixes.js bundle) and
    // reads the same localStorage key — so it'll pick up our rewrite
    // automatically. No need to call __fbgbp_forwardDelivery from here.

    try {
      console.log('[early-migrations] smart-default v3 applied' +
                  (touched ? ' (localStorage rewritten — Medium + 3.5 min)' : ' (already aligned)'));
    } catch (_) { /* console_filter may suppress; ignore */ }
  } catch (e) {
    // A migration failure must never break popup boot. Log and move on —
    // Zustand will rehydrate from whatever's in storage, and the async
    // popup_fixes.js migrations will catch up on the next load.
    try { console.warn('[early-migrations] failed:', e); } catch (_) {}
  }
})();
