// ────────────────────────────────────────────────────────────────────────────
// Diagnostic fallback — captures errors and renders an on-screen report
// if React fails to mount within 2.5 seconds. Loaded BEFORE the React
// module bundle so it can capture every error from the start.
// ────────────────────────────────────────────────────────────────────────────
(function diagnostic() {
  'use strict';
  const captured = { errors: [], rejections: [], logs: [] };

  // Mirror console.error / console.warn so we see them later.
  const _err = console.error.bind(console);
  const _warn = console.warn.bind(console);
  console.error = function () {
    try {
      captured.logs.push({
        level: 'error',
        msg: Array.from(arguments)
          .map((a) => String((a && a.stack) || a))
          .join(' '),
      });
    } catch (_) {}
    _err.apply(console, arguments);
  };
  console.warn = function () {
    try {
      captured.logs.push({
        level: 'warn',
        msg: Array.from(arguments)
          .map((a) => String((a && a.stack) || a))
          .join(' '),
      });
    } catch (_) {}
    _warn.apply(console, arguments);
  };

  window.addEventListener('error', function (e) {
    captured.errors.push({
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: (e.error && e.error.stack) || null,
    });
  });
  window.addEventListener('unhandledrejection', function (e) {
    captured.rejections.push({
      reason: String((e.reason && e.reason.stack) || e.reason),
    });
  });

  function checkMount() {
    const root = document.getElementById('root');
    if (root && root.children.length > 0) return; // React mounted ✓

    // The most severe failure there is: the popup never rendered, so the
    // customer cannot use the extension at all. This screen already existed —
    // but only the customer ever saw it, and only if they sent a screenshot.
    // Counts only; the captured error text stays on the device.
    //
    // v2026-08-09: level was hardcoded 'error' even when error_count and
    // rejection_count are both 0 — i.e. nothing actually threw, this is just
    // the 2.5s poll winning a race against a slow-but-healthy cold start
    // (busy service worker, first paint under load). That shape is real
    // evidence AGAINST a crash, not for one. Only escalate to 'error' when
    // there's real evidence (a captured error or rejection); a clean timeout
    // is a 'warning' so it doesn't inflate the same Sentry issue as genuine
    // broken-popup reports.
    const _hasRealEvidence = captured.errors.length > 0 || captured.rejections.length > 0;
    try {
      chrome.runtime.sendMessage({
        action: 'telemetry_relay', kind: 'breadcrumb',
        category: 'popup-mount-failed', level: _hasRealEvidence ? 'error' : 'warning',
        data: {
          error_count: captured.errors.length,
          rejection_count: captured.rejections.length,
          script_count: document.scripts.length,
        },
      });
    } catch (_) {}

    const scripts = Array.from(document.scripts).map((s) => ({
      src: s.src || '(inline)',
      type: s.type || 'classic',
    }));

    const html = [
      '<div style="font-family:Inter,system-ui,sans-serif;background:#fee;color:#222;padding:14px;width:380px;min-height:580px;overflow:auto;font-size:12px;line-height:1.45">',
      '<h2 style="margin:0 0 8px;color:#dc2626;font-size:16px">⚠ React did not mount</h2>',
      '<p style="margin:0 0 12px;color:#555">Diagnostic info below — copy this and send to dev.</p>',
      '<div style="background:#fff;padding:8px;border-radius:6px;margin-bottom:8px"><strong>Errors (' +
        captured.errors.length +
        '):</strong><pre style="white-space:pre-wrap;margin:4px 0;font-size:10px">' +
        (captured.errors.length ? JSON.stringify(captured.errors, null, 2) : '(none)') +
        '</pre></div>',
      '<div style="background:#fff;padding:8px;border-radius:6px;margin-bottom:8px"><strong>Rejections (' +
        captured.rejections.length +
        '):</strong><pre style="white-space:pre-wrap;margin:4px 0;font-size:10px">' +
        (captured.rejections.length ? JSON.stringify(captured.rejections, null, 2) : '(none)') +
        '</pre></div>',
      '<div style="background:#fff;padding:8px;border-radius:6px;margin-bottom:8px"><strong>Console (' +
        captured.logs.length +
        '):</strong><pre style="white-space:pre-wrap;margin:4px 0;font-size:10px">' +
        (captured.logs.length ? JSON.stringify(captured.logs, null, 2) : '(none)') +
        '</pre></div>',
      '<div style="background:#fff;padding:8px;border-radius:6px;margin-bottom:8px"><strong>Document:</strong><pre style="margin:4px 0;font-size:10px">readyState=' +
        document.readyState +
        ' rootChildren=' +
        (root ? root.children.length : 'NO ROOT') +
        '</pre></div>',
      '<div style="background:#fff;padding:8px;border-radius:6px"><strong>Scripts loaded:</strong><pre style="white-space:pre-wrap;margin:4px 0;font-size:10px">' +
        JSON.stringify(scripts, null, 2) +
        '</pre></div>',
      '</div>',
    ].join('');

    if (root) root.innerHTML = html;
    else document.body.innerHTML = html;
  }

  // Wait 2.5s for React to mount; if root is still empty, render diagnostic.
  setTimeout(checkMount, 2500);
})();
