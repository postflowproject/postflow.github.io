// mgp-alwaysactive-main.js
// MAIN-world, document_start. Registered dynamically (chrome.scripting.registerContentScripts)
// ONLY while a Safe/DOM campaign is active, then unregistered. Runs BEFORE Facebook's own
// JS so FB never sees the posting window as hidden during its initial render (the late
// post-`complete` executeScript missed this → composer wasn't rendered → composer-open-failed).
//
// This is the competitor's alwaysActive.js approach (fb_focus_visibility_code.md Part 2),
// folded together with the extra keepalive MGP already had (Web Lock + rAF→MessageChannel +
// silent audio). Near-twin of mgpSafeKeepaliveMain() in mgp-service-worker.js — whichever runs
// first wins, so both must behave the same and a fix to one belongs in the other.
// ⚠️ They are NOT byte-identical, and saying they were is how a fix lands in only one of them.
// Known divergences (audited 2026-09-16):
//   · the worker copy has the IntersectionObserver interceptor (its section 6); this file does not
//   · this file has the v20 `beforeunload` neutraliser; the worker copy does not
//   · the pacing branch: the worker copy always `_pump()`s, this one hands a VISIBLE window back
//     to a real timer — the same behaviour in a hidden window, which is the case that matters
//
// ⚠ FB-facing visibility/focus spoof — raises account-detection risk; built at the user's
// explicit opt-in to replicate the competitor. NOT hash-busting/fingerprinting (declined).
(function () {
  if (window.__mgp_safe_keepalive) return;
  window.__mgp_safe_keepalive = true;

  // (3) rAF → native when TRULY visible, else a MessageChannel pump (NOT throttled, unlike
  // setTimeout which Chrome clamps to ~1s in a hidden/occluded window). FB's Lexical editor +
  // feed commit via rAF; routing the hidden case through MessageChannel keeps the occluded
  // window's DOM updating at FULL speed WITHOUT bringing it to the front — we don't need PAINT,
  // only a current DOM (to read the permalink / type into the composer). When truly visible we
  // use native rAF (efficient, real vsync). We capture the REAL hidden getter + native rAF/cAF
  // HERE, before the visibility spoof below replaces document.hidden (so _reallyHidden reads the
  // genuine occlusion state, not the spoofed "visible"). This is the "fake focus that keeps
  // performance" — pure in-page scheduling: no network, no fetch patch, no worker file/CSP.
  // (setTimeout(16) — what the competitor uses — is clamped to ~1s when occluded → 1fps → the
  // Lexical reconciler/feed stalls. MessageChannel macrotasks are never clamped.)
  try {
    var _nativeRAF = window.requestAnimationFrame.bind(window);
    var _nativeCAF = (window.cancelAnimationFrame || function () {}).bind(window);
    var _realHiddenGet = null;
    try { var _hd = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden'); if (_hd && _hd.get) _realHiddenGet = _hd.get; } catch (e) {}
    var _reallyHidden = function () { try { return _realHiddenGet ? !!_realHiddenGet.call(document) : false; } catch (e) { return false; } };
    var _mc = new MessageChannel();
    var _rafQ = [];
    var _rafSeq = 1000000000;          // offset so our ids never collide with native rAF ids
    var _cancelled = Object.create(null);
    var _pumpOn = false;
    var _lastFrame = 0;
    var _pump = function () { if (_pumpOn) return; _pumpOn = true; try { _mc.port2.postMessage(0); } catch (e) {} };
    _mc.port1.onmessage = function () {
      _pumpOn = false;
      var now = (window.performance && performance.now) ? performance.now() : Date.now();
      // Pace ~60fps. ⚠️ How we wait for the rest of the frame MATTERS:
      //   hidden  → keep the MessageChannel re-pump. setTimeout is clamped to
      //             ~1s in a background tab, which is the entire reason this
      //             pump exists; deferring here would reintroduce the stall it
      //             was built to avoid.
      //   visible → a real timer. Its clamp is ~4ms, and it hands the CPU back
      //             instead of spinning a tight message loop for up to 16ms of
      //             every frame for the whole post.
      if (now - _lastFrame < 16) {
        if (_rafQ.length) {
          var _wait = 16 - (now - _lastFrame);
          // 🔴 v2026-09-16: this asked `document.visibilityState`, which THIS FILE spoofs to
          // 'visible' ~50 lines below — so the hidden branch was unreachable and every paced
          // frame went through the clamped timer, i.e. the exact stall the pump exists to
          // defeat (~1 fps, and one frame per MINUTE once Chrome's intensive throttling kicks
          // in after 5 minutes hidden). Sentry: 13 of 13 scheduled video posts failing at
          // hh:mm:10. `_reallyHidden()` reads the getter captured BEFORE the spoof.
          // 🪤 `|| !_realHiddenGet` is currently UNREACHABLE — rAF below only queues into
          // `_rafQ` when `_reallyHidden()` is true, which already requires the getter. It is
          // kept so that if that guard is ever relaxed, the unknown case lands on the pump and
          // not on the timer Chrome clamps. Do not "simplify" it away without changing rAF too.
          if (_reallyHidden() || !_realHiddenGet) _pump();
          else setTimeout(_pump, _wait > 0 ? _wait : 0);
        }
        return;
      }
      _lastFrame = now;
      var q = _rafQ; _rafQ = [];
      for (var i = 0; i < q.length; i++) {
        if (_cancelled[q[i].id]) { delete _cancelled[q[i].id]; continue; }
        try { q[i].cb(now); } catch (e) {}
      }
      if (_rafQ.length) _pump();
    };
    window.requestAnimationFrame = function (cb) {
      // 🪤 `&& _realHiddenGet` (v2026-09-16, from the adversarial review): without the real
      // getter we cannot tell a hidden window from a visible one — this file's own spoof makes
      // every other signal say 'visible'. Handing the frame to native rAF on that guess is the
      // fatal direction (a hidden window then runs at ~1 frame per minute and the post fails);
      // using the pump when we did not need to costs some CPU for the length of one post.
      // ⚠️ The pacing branch's twin guard below is unreachable while this one stands — it is
      // kept so the two read the same way if this one is ever relaxed.
      if (!_reallyHidden() && _realHiddenGet) { try { return _nativeRAF(cb); } catch (e) {} }
      var id = ++_rafSeq;
      _rafQ.push({ id: id, cb: cb });
      _pump();
      return id;
    };
    window.cancelAnimationFrame = function (id) {
      if (typeof id === 'number' && id >= 1000000000) { _cancelled[id] = true; return; }
      try { return _nativeCAF(id); } catch (e) {}
    };
  } catch (e) { /* fail-open */ }

  // (4) Web Lock — Chrome suppresses background throttling for a tab holding a
  // lock. Held (shared) for the page lifetime; never steals focus.
  try {
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request('__mgp_safe_active', { mode: 'shared' }, function () {
        return new Promise(function () {});
      });
    }
  } catch (e) { /* fail-open */ }

  // (5) [removed] Silent audio (gain 0) — web research confirmed a SILENT track does NOT
  // mark a tab "audible" and grants NO throttle exemption, so it did nothing. The real
  // anti-throttle is the MessageChannel rAF pump above. (An audible track WOULD exempt the
  // tab, but we won't play sound at the user.)

  // (1) visibility/focus spoof — make Facebook's own JS see the tab as visible+focused
  // even when the window is in the background, so FB doesn't pause its timers/render.
  // The rAF override above captured the real hidden getter BEFORE this, so it keeps working.
  try {
    // v22 REVERTED to competitor-parity after a runtime test disproved the "improvement":
    //  • hasFocus: a `new Proxy(nativeHasFocus, {apply})` is NATIVE-INDISTINGUISHABLE — VERIFIED that
    //    BOTH `fn.toString()` AND `Function.prototype.toString.call(fn)` return "...[native code]" in V8
    //    (the Proxy delegates to its native target). A plain replacement function LEAKS its source via
    //    `Function.prototype.toString.call` → MORE detectable. So the Proxy is correct.
    //  • webkit* aliases: kept. The working competitor (alwaysActive.js:36,48) spoofs them too; dropping
    //    them risks an inconsistency tell (webkitHidden returning the real value while hidden is spoofed).
    var _visDesc = { configurable: true, get: function () { return 'visible'; } };
    var _hidDesc = { configurable: true, get: function () { return false; } };
    Object.defineProperty(Document.prototype, 'visibilityState', _visDesc);
    Object.defineProperty(Document.prototype, 'webkitVisibilityState', _visDesc);
    Object.defineProperty(Document.prototype, 'hidden', _hidDesc);
    Object.defineProperty(Document.prototype, 'webkitHidden', _hidDesc);
    Document.prototype.hasFocus = new Proxy(Document.prototype.hasFocus, {
      apply: function () { return true; }
    });
  } catch (e) { /* fail-open */ }

  // (2) Block inactivity events FB listens on (capture-phase + stopImmediatePropagation
  // so they never reach FB's handlers). The competitor (alwaysActive.js) blocks pagehide
  // too — we now match it: the Safe posting window is ephemeral (closes after the post), so
  // there's no BFCache to protect, and pagehide is one of the signals FB uses to pause.
  // Still NOT document.blur (breaks the Lexical editor's input focus/blur).
  try {
    var _blk = function (e) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
    document.addEventListener('visibilitychange', _blk, true);
    document.addEventListener('webkitvisibilitychange', _blk, true);
    window.addEventListener('pagehide', _blk, true);
    window.addEventListener('blur', function (e) { if (e.target === window) _blk(e); }, true);
    window.addEventListener('focus', function (e) { if (e.target === window) _blk(e); }, true);
    window.addEventListener('mouseout', _blk, true);
    window.addEventListener('mouseleave', _blk, true);
    window.addEventListener('lostpointercapture', _blk, true);
  } catch (e) { /* fail-open */ }

  // (3) v20: Neutralize beforeunload (FB's "Leave site? — unsaved changes" prompt). When our posting
  // tab is brought to front mid-post, FB's beforeunload handler (installed because the composer has an
  // unsaved video+text) fires → Chrome shows the MODAL "Leave site?" dialog → that FREEZES the JS event
  // loop → the composer never closes → the post hangs (the 121s freeze / "window keeps popping" bug).
  // A capture-phase listener stops FB's addEventListener-based handler BEFORE it runs (NO preventDefault —
  // calling preventDefault would ITSELF trigger the prompt) + clears returnValue, and we block
  // window.onbeforeunload from being assigned. Mirrors the competitor's `window.onbeforeunload = null`.
  try {
    window.addEventListener('beforeunload', function (e) {
      try { e.stopImmediatePropagation(); e.stopPropagation(); delete e.returnValue; } catch (_) {}
    }, true);
    // v22: plain assignment (competitor-parity, NO defineProperty descriptor tell). The capture-phase
    // listener above already blocks FB's addEventListener-based handler; this clears the property form.
    try { window.onbeforeunload = null; } catch (_) {}
  } catch (e) { /* fail-open */ }
})();
