/* worker_ui.js — loaded before worker_engine.js so the console override is
   active before the engine emits its first log lines.
   Must be an external file — extension CSP blocks inline scripts. */
(function () {
  'use strict';

  /* ── DOM refs ──────────────────────────────────────────────────────────── */
  const logBody    = document.getElementById('logBody');
  const logEmpty   = document.getElementById('logEmpty');
  const logBadge   = document.getElementById('logBadge');
  const logCountEl = document.getElementById('logCountEl');
  let logCount = 0;
  const MAX_LOG = 600;

  /* ── Persistent log history (survives reloads / tab close) ──────────────
     The visible panel is in-memory and capped at MAX_LOG; this separate
     history keeps a full, timestamped record of the retention window in
     chrome.storage.local so the "Download logs" button can export it. */
  // 🔑 The COUNT is the real size limit; the window is a second bound that
  // usually does not bite. pruneHistory() applies both, so the stored size is
  // always min(what fits in the window, LOG_HISTORY_MAX) — which is why widening
  // the window costs nothing on its own.
  //
  // ⚠️ What this costs is not disk (3MB is nothing) but the REWRITE: saveHistory
  // re-serialises the whole array on every flush, at most once per 4s. Measured:
  // 8000 → 1.21MB / 4.4ms · 20000 → 3.04MB / 11.1ms · 100000 → 15.19MB / 47.1ms.
  // ⛔ That last row is why the cap is 20000 and not "a lot" — past it the flush
  // starts competing with the campaign it is logging.
  const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const LOG_HISTORY_MAX  = 20000;                   // the real ceiling — see above
  /** 🪤 Every user-facing mention of the window is DERIVED, never typed. The old
   *  code stated "24 hours" in five places, including the header inside the file
   *  the customer downloads — widening the window would have left all five lying. */
  const LOG_WINDOW_LABEL = (LOG_RETENTION_MS / 3600000 >= 48)
    ? String(Math.round(LOG_RETENTION_MS / 86400000)) + ' days'
    : String(Math.round(LOG_RETENTION_MS / 3600000)) + ' hours';
  // ⛔ The '24h' in this key is HISTORICAL and must stay. Renaming it would
  // orphan the saved history of every existing user — their logs would silently
  // vanish on update. The window lives in LOG_RETENTION_MS, not in this name.
  const LOG_STORE_KEY    = 'mgpEngineLogs24h';
  let logHistory = [];   // [{ t:<epoch ms>, level, msg }]
  let _saveTimer = null;

  function pruneHistory() {
    const cutoff = Date.now() - LOG_RETENTION_MS;
    let i = 0;
    while (i < logHistory.length && logHistory[i].t < cutoff) i++;
    if (i > 0) logHistory.splice(0, i);
    if (logHistory.length > LOG_HISTORY_MAX) {
      logHistory.splice(0, logHistory.length - LOG_HISTORY_MAX);
    }
  }

  function saveHistory() {
    _saveTimer = null;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        pruneHistory();
        chrome.storage.local.set({ [LOG_STORE_KEY]: logHistory });
      }
    } catch (_) {}
  }

  function scheduleSave() {
    if (_saveTimer) return;
    _saveTimer = setTimeout(saveHistory, 4000); // throttle writes
  }

  /**
   * 🔑 TWO clocks, deliberately.
   *
   *   t         — when the thing HAPPENED, stamped by whoever it happened to
   *               (the page for [DOM] lines, the worker otherwise).
   *   arrivedAt — when this page received it.
   *
   * `arrivedAt - t` IS the throttling measurement, taken on the customer's own
   * machine while the campaign runs. Before this, only the buffered path
   * stamped a source time and the live path re-stamped on arrival, so the log
   * silently mixed two clocks and looked perfectly monotonic while hiding the
   * lag we were trying to find. Fixing the instrument IS the detector.
   */
  function recordHistory(msg, level, t) {
    const _now = Date.now();
    const _src = Number(t) || _now;
    logHistory.push({ t: _src, arrivedAt: _now, level: level || 'dim', msg: String(msg) });
    pruneHistory();
    // v14: persist errors/warnings IMMEDIATELY (the 4s throttle could lose them on a fast tab close);
    // throttle only the verbose info lines.
    if (level === 'error' || level === 'warn') saveHistory(); else scheduleSave();
  }

  // Restore persisted history on load, then merge with anything logged before
  // the async read returned, and prune to the retention window.
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      // v14: also merge the service-worker fallback buffer (_sw_log_buffer) — logs that arrived while
      // THIS engine page was closed mid-campaign — then clear it, so "Download logs" survives the
      // engine tab closing.
      chrome.storage.local.get([LOG_STORE_KEY, '_sw_log_buffer'], function (res) {
        const saved = res && res[LOG_STORE_KEY];
        const swBuf = res && res['_sw_log_buffer'];
        let merged = false;
        if (Array.isArray(saved) && saved.length) { logHistory = saved.concat(logHistory); merged = true; }
        if (Array.isArray(swBuf) && swBuf.length) {
          logHistory = logHistory.concat(swBuf);
          merged = true;
          try { chrome.storage.local.remove('_sw_log_buffer'); } catch (_) {}
        }
        if (merged) {
          logHistory.sort(function (a, b) { return a.t - b.t; });
          pruneHistory();
          saveHistory();
        }
      });
    }
  } catch (_) {}

  // Flush on tab close / hide so nothing is lost.
  window.addEventListener('pagehide', saveHistory);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') saveHistory();
  });

  /* ── Helpers ────────────────────────────────────────────────────────────── */
  function ts() {
    return new Date().toLocaleTimeString('en-GB', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* ── Log renderer ───────────────────────────────────────────────────────── */
  // Heuristic: a message is "expandable" when it has structured content
  // (newlines, JSON-like braces) OR is too long to fit a single line.
  function needsRawBlock(msg) {
    return msg.length > 100 || /\n|[{}\[\]]/.test(msg);
  }

  function addLog(msg, level, t) {
    recordHistory(msg, level, t);   // persist to the saved history first (panel-independent)
    if (!logBody) return;
    if (logEmpty) logEmpty.style.display = 'none';

    const entry = document.createElement('div');
    entry.className = 'log-entry';

    const tsEl = document.createElement('span');
    tsEl.className = 'log-ts';
    tsEl.textContent = ts();

    const lvlEl = document.createElement('div');
    lvlEl.className = 'log-lvl lvl-' + level;

    // Truncated single-line message — CSS handles the ellipsis
    const msgEl = document.createElement('span');
    msgEl.className = 'log-msg ' + level;
    msgEl.textContent = msg;          // textContent auto-escapes HTML

    entry.appendChild(tsEl);
    entry.appendChild(lvlEl);
    entry.appendChild(msgEl);

    // Expandable raw block — only when message is long/structured.
    // Hidden by default; shown when Reveal toggle is on (.log-body.revealed).
    if (needsRawBlock(msg)) {
      const rawEl = document.createElement('pre');
      rawEl.className = 'log-raw';
      rawEl.textContent = msg;
      entry.appendChild(rawEl);
    }

    logBody.appendChild(entry);

    // Trim old entries
    while (logBody.children.length > MAX_LOG + 1) {
      const first = logBody.querySelector('.log-entry');
      if (first) logBody.removeChild(first);
    }

    logBody.scrollTop = logBody.scrollHeight;
    logCount++;
    const label = logCount + (logCount === 1 ? ' entry' : ' entries');
    if (logBadge)   logBadge.textContent   = label;
    if (logCountEl) logCountEl.textContent = logCount;
  }

  /* ── Console capture (active NOW, before worker_engine.js loads) ─────────── */
  const _log  = console.log.bind(console);
  const _warn = console.warn.bind(console);
  const _err  = console.error.bind(console);

  console.log = function () {
    _log.apply(console, arguments);
    const msg = Array.from(arguments).map(a =>
      typeof a === 'object' ? JSON.stringify(a) : String(a)
    ).join(' ');
    const lv = msg.includes('✅') ? 'success'
             : msg.includes('❌') || msg.includes('ERROR') ? 'error'
             : msg.startsWith('[worker]') || msg.startsWith('[mgp]') ? 'info'
             : msg.startsWith('[bg]') || msg.startsWith('[FB') ? 'system'
             : 'dim';
    addLog(msg, lv);
  };
  console.warn = function () {
    _warn.apply(console, arguments);
    addLog(Array.from(arguments).join(' '), 'warn');
  };
  console.error = function () {
    _err.apply(console, arguments);
    addLog(Array.from(arguments).join(' '), 'error');
  };

  /* Boot message */
  addLog('Engine started — ready to post.', 'success');

  /* ── Button / toggle handlers (replaces forbidden inline onclick=) ──────── */
  // Reveal toggle: when ON, expandable raw blocks (.log-raw) appear under
  // long messages. When OFF (default), entries stay strictly on one line
  // with ellipsis truncation.
  const revealToggle = document.getElementById('revealToggle');
  if (revealToggle) {
    revealToggle.addEventListener('change', function () {
      if (logBody) logBody.classList.toggle('revealed', this.checked);
    });
  }

  const clearBtn = document.getElementById('clearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      const entries = logBody.querySelectorAll('.log-entry');
      entries.forEach(e => e.remove());
      logCount = 0;
      if (logBadge)   logBadge.textContent   = '0 entries';
      if (logCountEl) logCountEl.textContent  = '0';
      if (logEmpty)   logEmpty.style.display  = '';
      addLog('Log cleared.', 'dim');
    });
  }

  /* ── Download logs ──────────────────────────────────────────────────────
     Exports the persistent timestamped history as a .txt file. The window is
     LOG_RETENTION_MS, stated through LOG_WINDOW_LABEL — never hard-coded. */
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtTs(t) {
    const d = new Date(t);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  const downloadLogsBtn = document.getElementById('downloadLogsBtn');
  if (downloadLogsBtn) {
    downloadLogsBtn.addEventListener('click', function () {
      pruneHistory();
      const cutoff = Date.now() - LOG_RETENTION_MS;
      const rows = logHistory.filter(function (e) { return e.t >= cutoff; });
      if (!rows.length) {
        addLog('No logs in the last ' + LOG_WINDOW_LABEL + ' to download.', 'dim');
        return;
      }
      // 🔑 v1.2.9.59: stamp the BUILD. A customer sent a 3,000-line log and there
      // was no way to tell which version produced it — which meant we could not
      // tell "this bug is fixed in a build they don't have yet" from "this bug is
      // live". Every diagnosis started with a guess.
      let _ver = 'unknown';
      try { _ver = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || 'unknown'; } catch (_) {}
      let _ua = '';
      try {
        const _m = String(navigator.userAgent || '').match(/Chrome\/(\d+)/);
        _ua = (_m ? ' · Chrome ' + _m[1] : '') + ' · ' + (navigator.platform || '');
      } catch (_) {}
      const header =
        'MultiGroupPoster — Engine logs (last ' + LOG_WINDOW_LABEL + ')\n' +
        'Version: ' + _ver + _ua + '\n' +
        'Generated: ' + fmtTs(Date.now()) + '\n' +
        'Entries: ' + rows.length + '\n' +
        '============================================================\n\n';
      // 🔑 Surface the two-clock gap. `+1.8s` after a line means it took that
      // long to travel from where it happened to this page — i.e. how hard the
      // machine was throttling the posting tab at that moment. Shown only when
      // it is big enough to mean something; noise below the threshold would
      // bury the signal instead of revealing it.
      const LAG_FLOOR_MS = 750;
      let _lagSeen = 0, _lagMax = 0;
      const body = rows.map(function (e) {
        const lag = (typeof e.arrivedAt === 'number' && typeof e.t === 'number') ? (e.arrivedAt - e.t) : 0;
        let tail = '';
        if (lag >= LAG_FLOOR_MS) {
          _lagSeen++; if (lag > _lagMax) _lagMax = lag;
          tail = '   (+' + (lag / 1000).toFixed(1) + 's to reach the engine)';
        }
        return '[' + fmtTs(e.t) + '] [' + String(e.level || '').toUpperCase() + '] ' + e.msg + tail;
      }).join('\n');
      const lagNote = _lagSeen
        ? 'Throttling: ' + _lagSeen + ' line(s) arrived late, worst ' + (_lagMax / 1000).toFixed(1) + 's.\n' +
          'A large gap means the browser was starving the posting tab — not that the post was slow.\n\n'
        : '';
      const blob = new Blob([header + lagNote + body + '\n'], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const n = new Date();
      const fname = 'mgp-engine-logs-' + n.getFullYear() + pad2(n.getMonth() + 1) + pad2(n.getDate()) +
        '-' + pad2(n.getHours()) + pad2(n.getMinutes()) + pad2(n.getSeconds()) + '.txt';
      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
      addLog('Downloaded ' + rows.length + ' log entries (last ' + LOG_WINDOW_LABEL + ').', 'success');
    });
  }

  // 🔍 Run Diagnostic — one-click fast self-test → downloadable/copyable report for support.
  const runDiagnosticBtn = document.getElementById('runDiagnosticBtn');
  if (runDiagnosticBtn) {
    runDiagnosticBtn.addEventListener('click', async function () {
      if (typeof window.mgpRunDiagnostic !== 'function') { addLog('Diagnostic not available yet (engine still loading) — try again in a moment.', 'warn'); return; }
      runDiagnosticBtn.disabled = true;
      const _orig = runDiagnosticBtn.textContent;
      runDiagnosticBtn.textContent = '⏳ Running…';
      addLog('🔍 Running diagnostic — one fast test post (labeled "diagnostic test")…', 'info');
      let rep = null;
      try { rep = await window.mgpRunDiagnostic({}); }
      catch (e) { addLog('Diagnostic error: ' + (e && e.message ? e.message : String(e)), 'error'); }
      runDiagnosticBtn.disabled = false;
      runDiagnosticBtn.textContent = _orig;
      if (!rep) return;
      addLog('🔍 DIAGNOSTIC — ' + (rep.verdict || '(no verdict)'), (rep.fast && rep.fast.success) ? 'success' : 'warn');
      const L = [];
      L.push('MultiGroupPoster — Diagnostic report');
      L.push('Generated: ' + fmtTs(rep.timestamp || Date.now()));
      L.push('============================================================');
      L.push('VERDICT: ' + (rep.verdict || ''));
      L.push('');
      L.push('Identity: ' + JSON.stringify(rep.identity || {}));
      L.push('Environment: ext v' + ((rep.environment && rep.environment.extensionVersion) || '?'));
      L.push('Synced groups: ' + ((rep.groups && rep.groups.syncedCount) != null ? rep.groups.syncedCount : '?'));
      L.push('Test group: ' + (rep.testGroupUrl || '(none)'));
      L.push('');
      L.push('Fast result: ' + JSON.stringify(rep.fast || {}, null, 2));
      L.push('');
      L.push('doc_ids: ' + JSON.stringify((rep.environment && rep.environment.docIds) || {}, null, 2));
      const text = L.join('\n');
      try {
        const blob = new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const n = new Date();
        const fname = 'mgp-diagnostic-' + n.getFullYear() + pad2(n.getMonth() + 1) + pad2(n.getDate()) + '-' + pad2(n.getHours()) + pad2(n.getMinutes()) + pad2(n.getSeconds()) + '.txt';
        const a = document.createElement('a'); a.href = url; a.download = fname; document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
        addLog('📄 Diagnostic report downloaded (also copied to clipboard) — send it to support. If the test post succeeded, delete it in the group.', 'success');
      } catch (e) { addLog('Could not download the report: ' + (e && e.message ? e.message : String(e)), 'warn'); }
      try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(function () {}); } catch (e) {}
    });
  }

  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      addLog('Refreshing session…', 'info');
      chrome.runtime.sendMessage({ action: 'refreshFbSession' }, function () {
        loadUser();
        addLog('Session refreshed.', 'success');
      });
    });
  }

  /* ── Uptime counter ─────────────────────────────────────────────────────── */
  const t0 = Date.now();
  const uptimeEl = document.getElementById('uptimeEl');
  setInterval(function () {
    if (!uptimeEl) return;
    const s   = Math.floor((Date.now() - t0) / 1000);
    const h   = String(Math.floor(s / 3600)).padStart(2, '0');
    const m   = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    uptimeEl.textContent = h + ':' + m + ':' + sec;
  }, 1000);

  /* ── User / session info ────────────────────────────────────────────────── */
  function loadUser() {
    chrome.storage.sync.get(['user'], function (d) {
      const u     = d.user || {};
      const name  = u.displayName || u.name  || 'Unknown';
      const email = u.email || '';
      const photo = u.photoURL || u.picture  || '';
      const id    = u.uid    || u.id         || '';

      const nameEl = document.getElementById('userNameEl');
      const subEl  = document.getElementById('userSubEl');
      const avEl   = document.getElementById('avatarEl');

      if (nameEl) nameEl.textContent = name;
      if (subEl)  subEl.textContent  = email || (id ? 'ID: ' + id : '—');

      if (avEl) {
        if (photo) {
          const img = document.createElement('img');
          img.src = photo;
          img.alt = '';
          img.addEventListener('error', function () {
            avEl.textContent = name[0] ? name[0].toUpperCase() : '?';
          });
          avEl.innerHTML = '';
          avEl.appendChild(img);
        } else {
          avEl.textContent = name[0] ? name[0].toUpperCase() : '?';
        }
      }
    });
  }
  loadUser();

  /* ── Status polling ─────────────────────────────────────────────────────── */
  function setConnBadge(active) {
    const dot   = document.getElementById('connDot');
    const text  = document.getElementById('connText');
    const badge = document.getElementById('connBadge');
    if (!dot || !text || !badge) return;

    if (active) {
      dot.style.background   = '#fbbf24';
      dot.style.boxShadow    = '0 0 0 2px oklch(60% 0.15 80 / .4)';
      text.textContent       = 'Posting…';
      badge.style.color      = '#fbbf24';
      badge.style.borderColor = 'oklch(50% 0.12 80 / .4)';
      badge.style.background  = 'oklch(28% 0.08 80 / .2)';
    } else {
      dot.style.background   = '#34d399';
      dot.style.boxShadow    = '0 0 0 2px oklch(40% 0.12 160 / .4)';
      text.textContent       = 'Connected';
      badge.style.color      = '#34d399';
      badge.style.borderColor = 'oklch(40% 0.1 160 / .3)';
      badge.style.background  = 'oklch(28% 0.08 160 / .2)';
    }
  }

  function poll() {
    chrome.storage.local.get(
      ['postingStatus', 'isPostingInProgress', 'postsCompleted'],
      function (d) {
        const active = !!d.isPostingInProgress;
        const done   = Array.isArray(d.postsCompleted) ? d.postsCompleted.length : null;

        const statusEl = document.getElementById('postingStatusEl');
        if (statusEl) {
          statusEl.textContent = active ? 'Posting…' : 'Idle';
          statusEl.className   = 'stat-val ' + (active ? 'val-amber' : 'val-muted');
        }

        const sentEl = document.getElementById('postsSentEl');
        if (sentEl) sentEl.textContent = done !== null ? done : '—';

        setConnBadge(active);
      }
    );
  }
  poll();
  setInterval(poll, 3000);

  /* ── Live storage updates ───────────────────────────────────────────────── */
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;

    if (changes.postingStatus) {
      const msg = changes.postingStatus.newValue;
      if (msg) {
        // #2 (2026-05-31) — countdown throttle. The SW writes "Next post will
        // continue in N seconds" EVERY second (so the live UI countdown is
        // smooth). Without throttling, a 3-minute pacing pause produced ~180
        // near-identical log lines that buried everything else (Ben Giles'
        // 178-entry log was ~130 countdown lines). The LIVE display (via the
        // 3s poll) is unaffected — we only throttle what lands in the
        // persistent Activity log + the download to at most one line per 20s.
        var isCountdown = /Next post will continue in/i.test(msg);
        if (isCountdown) {
          var nowTs = Date.now();
          if (typeof window.__lastCountdownLogTs !== 'number') window.__lastCountdownLogTs = 0;
          if (nowTs - window.__lastCountdownLogTs < 20000) {
            return; // suppress this countdown tick from the log
          }
          window.__lastCountdownLogTs = nowTs;
        }
        const lv = msg.includes('✅') || msg.toLowerCase().includes('success') ? 'success'
                 : msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail') ? 'error'
                 : 'info';
        addLog(msg, lv);
      }
    }

    if (changes.isPostingInProgress) poll();
  });

  /* ── Service-worker log bridge ──────────────────────────────────────────────
     The background service worker runs in a separate context; its console.*
     never reaches this page. For high-level campaign summaries it broadcasts
     {type:'__ENGINE_LOG'} so they land in this Activity log + the download. */
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg && msg.type === '__ENGINE_LOG' && msg.msg) {
      addLog(String(msg.msg), msg.level || 'info', msg.t);
      // 🔴 v1.2.9.59: this MUST answer. A listener that returns without calling
      // sendResponse makes Chrome close the port and set
      // chrome.runtime.lastError = "message port closed before a response was
      // received" — even though the line above already ran. engineLog reads that
      // as "nobody received it" and buffers a SECOND copy, which the page then
      // merges back with no dedupe. Measured in a customer's log: 453 of 3,047
      // lines were exact duplicates, halving the history window they get.
      try { sendResponse({ ok: true }); } catch (_) {}
      return; // sync response — do NOT return true (that would hold the port open)
    }
  });

})();
