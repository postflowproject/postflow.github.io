// ═══════════════════════════════════════════════════════════════════════════════
// worker_engine.js — Multi Group Poster Engine
// ═══════════════════════════════════════════════════════════════════════════════
//
// Runs inside worker.html — an always-open pinned extension tab.
// ALL fetch() calls happen from THIS tab (extension page context), NOT the SW:
//   ✅ declarativeNetRequest "xmlhttprequest" rule applies → Origin: facebook.com
//   ✅ credentials:'include' sends Facebook cookies automatically
//   ❌ SW fetch() is NOT classified as xmlhttprequest → Origin NOT modified
// ═══════════════════════════════════════════════════════════════════════════════

const LOG = (...a) => console.log('[worker]', ...a);
// Live "what's happening now" step for the popup progress screen (Fast/GraphQL path).
// PostProgressManager reads chrome.storage.local.currentPostStep (Safe/DOM writes it via
// content.js reportStep; the Fast engine writes it here too, so the screen describes the
// upload / publish / wait / comment phases instead of just a spinner).
// v2026-09-24: a QUEUED comment (EXECUTE_COMMENT) runs outside any campaign, and nothing clears
// the step after it — its "Uploading comment photo…" was still on screen when the NEXT campaign
// started (seen live). Muted for that dispatch only; a right-after comment inside a post still shows.
let _stepMuted = false;
const setStep = (label) => { if (_stepMuted) return; try { if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) chrome.storage.local.set({ currentPostStep: String(label) }); } catch (e) {} };
const WARN = (...a) => console.warn('[worker]', ...a);
const ERR = (...a) => console.error('[worker]', ...a);

// Structured crash-report breadcrumb, relayed to the service worker (which owns
// the only Sentry transport — mgp-engine.html loads this file with a plain
// <script src>, so there is no bundler here and no way to import an SDK).
// Same contract as content.js's cSentryBreadcrumb: `category` is a literal
// written at the call site and `data` is numbers / short fixed labels only —
// never post text, group names, or URLs. Fire-and-forget, never throws.
const engineSentryBreadcrumb = (category, data) => {
  try {
    chrome.runtime.sendMessage({
      action: 'telemetry_relay', kind: 'breadcrumb',
      category: String(category), level: 'warning', data: data || {},
    }).catch(() => {});
  } catch (e) {}
};

// v2026-08-19: the same relay, but at ERROR level so the service worker
// escalates it into a REAL Sentry issue (see telemetry_relay's own comment:
// "A breadcrumb alone is invisible — it only ships attached to a captured
// event"). Use this only for conditions we want to learn about WITHOUT the
// customer having to write in. Fingerprinted by category on the SW side, so N
// failing groups collapse into ONE issue rather than flooding.
const engineSentryError = (category, data) => {
  try {
    chrome.runtime.sendMessage({
      action: 'telemetry_relay', kind: 'breadcrumb',
      category: String(category), level: 'error', data: data || {},
    }).catch(() => {});
  } catch (e) {}
};

// Tiny content-fingerprint for diagnostic logs (FNV-1a 32-bit, base36).
// NOT the text itself — no PII in logs. Used to see if "the same text" passed
// through the pipeline unchanged between stages.
function _hash8(s) {
  if (!s) return '∅';
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 8);
}

// ── Session state ─────────────────────────────────────────────────────────────
const fbSession = {
  uid: null, actorId: null, dtsg: null,
  lsd: null, hsi: null,
  spin_r: null, spin_b: null, spin_t: null,
  jazoest: '25669',
  reqCounter: 1,
  lastRefresh: 0,
};
const FB_TOKEN_TTL_MS = 14 * 60 * 1000;

// ── doc_id table — defaults from competitor analysis, auto-updated by harvest ──
const FB_DOC_IDS = {
  ComposerStoryCreateMutation:        '9469644099759635', // text-only posts
  ComposerStoryCreateMutationMedia:   '9286110778162996', // posts with image/video attachments
  GroupCometVideoUploaderConfigQuery: '6293020010825217',
  CommentCreateMutation:              '2861490773896583', // RETIRED by FB (2026-05 — "document not found"). Kept for legacy harvest only.
  // CURRENT comment mutation (2026-05-31): FB retired CommentCreateMutation;
  // the live one is useCometUFICreateCommentMutation (verified in our remote
  // doc_id config + used by competitor ihkd). postFbComment uses THIS one.
  useCometUFICreateCommentMutation:   '26917309061273360', // first-comment / auto-comment
  // Link preview scrape — FB returns share_scrape_data (title + image + desc)
  // that we then attach to ComposerStoryCreateMutation so the post renders with
  // a rich preview card instead of raw URL text. Same query the real composer
  // uses when you paste a URL. Competitor uses doc_id 24010394355227871.
  ComposerLinkAttachmentPreviewQuery: '26986333450971880',
  // v2026-10-01 · LISTINGS for buy & sell groups — both captured live 30-Sep from Facebook's own composer
  // inside a buy & sell group, and the first proven end-to-end with MGP's own upload + request format.
  MarketplaceComposerCreateStoryMutation: '9766933466697549',
  MarketplaceSearchAddressDataSourceQuery: '9660140454040174', // the home listing's address search (read)
};

// v66 (pure, unit-tested): would applying `docId` under `name` clobber the BASE text
// mutation's doc_id with the MEDIA mutation's doc_id? A MEDIA post is sent with
// friendlyName 'ComposerStoryCreateMutation' but the …Media doc_id, so harvesting/applying
// it under the base key would silently break text-only posts. patchFetch, startup-harvest,
// and fetchGraphQL-promotion all guard against this; v66 adds the same guard to the
// runtime UPDATE_DOC_IDS handler (the 4th apply-path, which lacked it). `mediaDocId` is
// passed in (not read from a global) so the predicate is testable in isolation.
function isDocIdClobber(name, docId, mediaDocId) {
  return name === 'ComposerStoryCreateMutation' && !!mediaDocId && docId === mediaDocId;
}

// ── Smart doc_id retry — candidate list per friendly_name ─────────────────────
// When a post fails with "doc_id not recognized" (FB rotated, A/B test, regional
// variant), we retry with the next candidate. First success promotes itself to
// primary in FB_DOC_IDS so subsequent posts skip straight to the working value.
// Keyed by friendly_name; values are arrays of candidate doc_ids sorted best-first.
// Extra doc_ids to try when the primary one is rejected. fetchGraphQL walks these
// after FB_DOC_IDS[name] and before FB_DOC_IDS_BUILTIN[name], and PROMOTES the
// winner — the same "try them all, then remember" shape the competitor uses
// (its worker.js builds `[remote, ...builtins]` and persists the id that worked).
const FB_DOC_ID_CANDIDATES = {
  // The competitor ships this older link-preview query. Keeping it here means a
  // Facebook rotation that kills our harvested id has somewhere to fall back to.
  ComposerLinkAttachmentPreviewQuery: ['24010394355227871'],
};

// ── Captured variables template from real Facebook traffic ────────────────────
// When the user makes a real post on Facebook, background.js captures the exact
// variables structure and stores it. We use it as a template so we always match
// Facebook's current schema exactly.
let _capturedVariablesTemplate = null;

chrome.storage.local.get('fb_composer_variables_template', (items) => {
  if (items?.fb_composer_variables_template) {
    try {
      _capturedVariablesTemplate = JSON.parse(items.fb_composer_variables_template);
      LOG('Loaded captured variables template from storage');
    } catch (_) {}
  }
});

// Listen for template updates sent from background.js
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'UPDATE_VARIABLES_TEMPLATE' && msg.template) {
    _capturedVariablesTemplate = msg.template;
    LOG('Updated variables template from real Facebook traffic');
  }
  if (msg.type === 'UPDATE_DOC_IDS' && msg.docIds && typeof msg.docIds === 'object') {
    // Remote config from server. Accepts either array form ["id1","id2",...] sorted
    // best-first (new smart-retry format) or legacy string form "id" (back-compat).
    let applied = 0;
    const _mediaId = FB_DOC_IDS.ComposerStoryCreateMutationMedia;
    for (const [k, v] of Object.entries(msg.docIds)) {
      if (!/^[A-Za-z_]{3,80}$/.test(k)) continue;
      if (Array.isArray(v)) {
        // v66: drop any Media-doc_id that would clobber the base text key (see isDocIdClobber).
        const valid = v.filter((x) => typeof x === 'string' && /^\d{13,17}$/.test(x) && !isDocIdClobber(k, x, _mediaId));
        if (valid.length) {
          FB_DOC_IDS[k] = valid[0];
          FB_DOC_ID_CANDIDATES[k] = valid;
          applied++;
        }
      } else if (typeof v === 'string' && /^\d{13,17}$/.test(v) && !isDocIdClobber(k, v, _mediaId)) {
        FB_DOC_IDS[k] = v;
        FB_DOC_ID_CANDIDATES[k] = [v];
        applied++;
      }
    }
    if (applied) LOG(`Applied remote doc_id config: ${applied} entries`);
  }
});

// ── Auto-harvest doc_ids: wrap window.fetch to intercept our own GraphQL calls ─
(function patchFetch() {
  const _orig = window.fetch;
  window.fetch = function(url, opts) {
    try {
      const urlStr = typeof url === 'string' ? url
        : url instanceof Request ? url.url : '';
      if (urlStr.includes('/api/graphql')) {
        const body = opts?.body;
        if (typeof body === 'string') {
          const name  = body.match(/fb_api_req_friendly_name=([A-Za-z_]+)/)?.[1];
          const docId = body.match(/doc_id=(\d+)/)?.[1];
          if (name && docId && FB_DOC_IDS[name] !== docId &&
              // v25: a MEDIA post is sent with friendlyName='ComposerStoryCreateMutation' but the ...Media
              // doc_id — NEVER harvest the Media doc_id under the base/text key (it would clobber the
              // text-only doc_id). Compared to the LIVE Media property so a legitimately-rotated Media id
              // is still covered; a genuinely-new BASE doc_id (≠ Media, real drift) is still harvested.
              !(name === 'ComposerStoryCreateMutation' && docId === FB_DOC_IDS.ComposerStoryCreateMutationMedia)) {
            LOG(`doc_id captured: ${name} → ${docId}`);
            FB_DOC_IDS[name] = docId;
            chrome.storage.local.set({ [`fb_docid_${name}`]: docId });
          }
        }
      }
    } catch (_) {}
    return _orig.apply(this, arguments);
  };
})();

// Restore doc_ids on startup.
// PRIORITY ORDER (later wins, by design):
//   STEP 1 — Hardcoded defaults (FB_DOC_IDS literal at top)
//   STEP 2 — Remote config from server (quorum-shared candidate array)
//            Trustworthy but can lag if FB rotates and quorum hasn't caught up
//   STEP 3 — Local harvest (user's own FB traffic)
//            FRESHEST. Overrides remote so the user's actual session uses
//            FB's current doc_ids. Always promoted to front of candidates.
//
// v10 (2026-05-01): explicit per-source counters for diagnostics. If
// posts start failing for FB-rotation reasons, the startup log shows
// where each doc_id came from.
// v2026-10-23 · one right-after comment per post (claimRightAfterComment): the marks and how long they are kept
const CMT_ONCE_PREFIX = 'mgp_cmt1_';
const CMT_ONCE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

chrome.storage.local.get(null, (items) => {
  let _fromRemote = 0, _fromLocal = 0, _conflictsResolved = 0;

  // v2026-10-23 · the one-comment-per-post marks (claimRightAfterComment) are kept 3 days
  try {
    const _old = Object.keys(items || {}).filter((k) => k.startsWith(CMT_ONCE_PREFIX) && !(Date.now() - Number(items[k]) < CMT_ONCE_TTL_MS));
    if (_old.length) chrome.storage.local.remove(_old);
  } catch (_) {}

  // STEP 2 — Remote config (overrides hardcoded).
  const remoteCfg = items?._remoteDocIdConfig?.docIds;
  if (remoteCfg && typeof remoteCfg === 'object') {
    for (const [k, v] of Object.entries(remoteCfg)) {
      if (!/^[A-Za-z_]{3,80}$/.test(k)) continue;
      if (Array.isArray(v)) {
        const valid = v.filter((x) => typeof x === 'string' && /^\d{13,17}$/.test(x));
        if (valid.length) {
          FB_DOC_IDS[k] = valid[0];
          FB_DOC_ID_CANDIDATES[k] = valid;
          _fromRemote++;
        }
      } else if (typeof v === 'string' && /^\d{13,17}$/.test(v)) {
        FB_DOC_IDS[k] = v;
        FB_DOC_ID_CANDIDATES[k] = [v];
        _fromRemote++;
      }
    }
  }

  // STEP 3 — Local harvest (overrides remote). HIGHEST priority. Promote
  // to front of candidates so the retry loop tries it first; keep the
  // rest as fallback in case FB rolls back.
  for (const [k, v] of Object.entries(items || {})) {
    if (k.startsWith('fb_docid_') && v && /^\d{13,17}$/.test(v)) {
      const name = k.slice('fb_docid_'.length);
      // v25: a persisted BASE doc_id whose value EQUALS the ...Media doc_id is a STALE clobber from an
      // older build (media post mis-harvested under the base key). Ignore it (keep remote/default base)
      // AND remove the poisoned row so it can't re-poison on later restarts. Real base drift (a persisted
      // base ≠ Media) loads normally below.
      if (name === 'ComposerStoryCreateMutation' && v === FB_DOC_IDS.ComposerStoryCreateMutationMedia) {
        try { chrome.storage.local.remove(['fb_docid_ComposerStoryCreateMutation']); } catch (_) {}
        continue;
      }
      const wasFromRemote = FB_DOC_IDS[name] && FB_DOC_IDS[name] !== v;
      FB_DOC_IDS[name] = v;
      const rest = (FB_DOC_ID_CANDIDATES[name] || []).filter((x) => x !== v);
      FB_DOC_ID_CANDIDATES[name] = [v, ...rest];
      _fromLocal++;
      if (wasFromRemote) _conflictsResolved++;
    }
  }

  // Harvested session params (__rev, __hs, __spin_*) — separate from doc_ids.
  applyHarvestedParams(items);

  LOG(`doc_ids on startup: ${Object.keys(FB_DOC_IDS).length} total · ` +
      `${_fromRemote} from remote · ${_fromLocal} from local harvest · ` +
      `${_conflictsResolved} conflicts (local overrode remote)`);
  LOG('doc_ids full:', JSON.stringify(FB_DOC_IDS));
});

// Merge harvested signed params into fbSession. Safe to call repeatedly.
function applyHarvestedParams(items) {
  if (!items) return;
  const map = {
    fb_param___rev:    'rev',
    fb_param___hs:     'hs',
    fb_param___spin_r: 'spin_r',
    fb_param___spin_b: 'spin_b',
    fb_param___spin_t: 'spin_t',
  };
  for (const [storageKey, sessionKey] of Object.entries(map)) {
    const v = items[storageKey];
    if (v != null && v !== '') fbSession[sessionKey] = v;
  }
}

// Pick up newly harvested params without a full reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const next = {};
  for (const k of Object.keys(changes)) {
    if (k.startsWith('fb_param_')) next[k] = changes[k].newValue;
  }
  if (Object.keys(next).length) applyHarvestedParams(next);
});

// ── v10.7 (2026-05-02): cross-context stop signal + fetch timeout helpers ───
//
// Stop signal: the worker tab and the background SW are separate contexts.
// background.js writes `chrome.storage.local._stopRequested = true` when the
// user clicks Stop; we poll/listen for it from the worker side. Without
// this, the worker keeps grinding (re-upload, fetch, retry) until natural
// completion — up to 30s after the stop click during tier-1 retry.
//
// We also wire AbortController so in-flight fetches abort when stop fires.

let _stopAbortController = null;  // current in-flight fetch's controller, if any

async function _checkStopFlag() {
  try {
    // v76: bound the storage read (3s) so a wedged storage layer can't stall the post
    // loop on "Preparing post". Fail-open to "not stopped" (the same default as the catch);
    // a real Stop still aborts in-flight via the onChanged listener below.
    const { _stopRequested } = await _idbWithTimeout(chrome.storage.local.get('_stopRequested'), 3000, 'stopFlag');
    return !!_stopRequested;
  } catch (_) { return false; }
}

// Listen for storage changes so an in-flight fetch can abort the moment stop
// is clicked (no need to wait for the next polling check).
try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes._stopRequested) return;
    if (changes._stopRequested.newValue === true && _stopAbortController) {
      try { _stopAbortController.abort(); } catch (_) {}
    }
  });
} catch (_) { /* harmless if onChanged unavailable */ }

// fetchWithTimeout — wraps fetch() with a hard timeout (default 90s) AND
// hooks the active AbortController so the same request aborts on stop.
/**
 * v2026-08-28 — how long one media upload may take.
 * Floor of 2 minutes, then ~200 bytes/ms (about 1.6 Mbit/s), so a big file on a
 * slow line is not cut off mid-transfer and mis-reported as a missing file.
 */
function _uploadTimeoutFor(blob) {
  const size = (blob && Number(blob.size)) || 0;
  return Math.max(120_000, Math.ceil(size / 200));
}

/**
 * v2026-08-28 — retry an upload that never left the machine. TWO attempts, no more.
 *
 * Only a NETWORK failure is retried: a transient blip then resolves silently and
 * the customer never learns there was one. A Facebook rejection (`Photo upload
 * HTTP 4xx`) and an unreadable file are NOT retried — Facebook already answered,
 * and the bytes will not change.
 *
 * The pause is deliberately short. This runs mid-campaign, between two of the
 * customer's own posts, and must not read as the app hanging.
 */
const MEDIA_UPLOAD_ATTEMPTS = 2;
const MEDIA_RETRY_PAUSE_MS = 1200;

async function _withUploadRetry(label, fn) {
  let last = null;
  for (let attempt = 1; attempt <= MEDIA_UPLOAD_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!e || !e.mgpUploadNetwork || attempt === MEDIA_UPLOAD_ATTEMPTS) throw e;
      WARN(`⚠️ ${label} attempt ${attempt}/${MEDIA_UPLOAD_ATTEMPTS} did not reach Facebook — retrying once`);
      await new Promise((r) => setTimeout(r, MEDIA_RETRY_PAUSE_MS));
    }
  }
  throw last;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 90_000) {
  const controller = new AbortController();
  _stopAbortController = controller;
  const timeoutId = setTimeout(() => {
    // This callback is the ONLY place that distinguishes "this request timed
    // out" from "the user clicked Stop" — the manual-stop listener above aborts
    // the very same controller, so instrumenting where the AbortError is caught
    // would conflate the two. No URL is recorded: this path is the least
    // test-covered in the file and an endpoint adds nothing a stack won't say.
    try { engineSentryBreadcrumb('bounded-await-fallback', { fn: 'fetchWithTimeout', ms: timeoutMs }); } catch (_) {}
    try { controller.abort(); } catch (_) {}
  }, timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
    if (_stopAbortController === controller) _stopAbortController = null;
  }
}

// ── IndexedDB helpers (same origin as SW — shares MediaDB & permanentStore) ───
function openMediaDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('MediaDB', 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains('media'))
        r.result.createObjectStore('media', { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror   = () => reject(r.error);
  });
}
function getBlobById(db, id) {
  return new Promise((resolve, reject) => {
    const req = db.transaction('media', 'readonly').objectStore('media').get(id);
    req.onsuccess = () => resolve(req.result?.value?.blob || null);
    req.onerror   = () => reject(req.error);
  });
}
// v76: bound a LOCAL IndexedDB await so a locked/slow IDB on the user's machine fails
// the group cleanly (the per-item / outer try-catch records the failure → the campaign
// CONTINUES) instead of hanging "Preparing post N/M" forever. Bounds ONLY the local
// read — the FB UPLOAD keeps its own network timeouts and is untouched: video is
// still a fixed 180s, and photo is adaptive since v2026-08-28 (_uploadTimeoutFor:
// a 2-minute floor that grows with the file, because the old flat 90s demanded
// 2.2 Mbit/s of upload for a 25MB image and reported the AbortError as a missing file)
// timeouts and is untouched. On timeout the media_all_failed / expectedMediaCount guard
// refuses a text-only post, so a timed-out read is never a malformed post and never a
// duplicate — only a clean skip/fail. Generous read window so a legit large video on a
// slow disk never false-fails; only a true hang trips it. (Engine-core has no withTimeout —
// that helper lives in the SW.)
const IDB_OPEN_TIMEOUT_MS = 8_000;   // opening the DB handle is near-instant when healthy
const IDB_READ_TIMEOUT_MS = 30_000;  // a 100MB blob handle reads well under this; only a real stall hits it
function _idbWithTimeout(promise, ms, label) {
  let _t;
  const timer = new Promise((_, rej) => { _t = setTimeout(() => {
    // Reaching here IS the stall — a settled promise would already have cleared
    // this timer via .finally below. Synchronous + swallowed so the race is
    // untouched, and the rejection message stays byte-identical (other code and
    // the unit tests match on the "idb_timeout:" prefix).
    try { engineSentryBreadcrumb('bounded-await-fallback', { fn: '_idbWithTimeout', label, ms }); } catch (_) {}
    rej(new Error(`idb_timeout:${label}`));
  }, ms); });
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(_t)),
    timer,
  ]);
}
function getSnapshotById(snapshotId) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('permanentStore', 2);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('snapshots'))
        open.result.createObjectStore('snapshots', { keyPath: 'id' });
    };
    open.onsuccess = () => {
      const db = open.result;
      const req = db.transaction('snapshots', 'readonly').objectStore('snapshots').get(snapshotId);
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror   = () => { db.close(); reject(req.error); };
    };
    open.onerror = () => reject(open.error);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1 — Token extraction
// Fetches a Facebook page with credentials to harvest dtsg / uid / lsd.
// Tries multiple pages so one failure doesn't block everything.
// ═══════════════════════════════════════════════════════════════════════════════
async function extractFbTokens() {
  // Try restoring from session cache first (survives SW restart, not Chrome restart)
  try {
    const { fbSession: c } = await chrome.storage.session.get('fbSession');
    if (c?.dtsg && c?.uid && (Date.now() - (c.lastRefresh || 0)) < FB_TOKEN_TTL_MS) {
      Object.assign(fbSession, c);
      LOG(`Tokens from cache — uid:${fbSession.uid} dtsg:${fbSession.dtsg?.slice(0, 8)}…`);
      return true;
    }
  } catch (_) {}

  // Pages to try — homepage first, settings as fallback
  const pages = [
    'https://www.facebook.com/',
    'https://www.facebook.com/settings',
    'https://www.facebook.com/me',
  ];

  for (const pageUrl of pages) {
    LOG(`Fetching tokens from: ${pageUrl}`);
    let html;
    try {
      // v41: HARD 15s timeout. Previously a bare fetch() here could hang
      // FOREVER if the socket stalled (very common right after the machine
      // wakes from sleep — the TCP connection is dead but the request never
      // settles), wedging the whole post on "preparing/uploading" with no
      // recovery. fetchWithTimeout aborts via AbortController; the catch below
      // then moves on to the next page (or fails the post cleanly).
      const resp = await fetchWithTimeout(pageUrl, {
        credentials: 'include',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: 'https://www.facebook.com/',
        },
      }, 15000);
      LOG(`  → status ${resp.status}, final URL: ${resp.url}`);
      if (resp.url.includes('/login') || resp.url.includes('/checkpoint')) {
        WARN('  → redirected to login — user may not be logged in or 2FA pending');
        continue;
      }
      if (!resp.ok) {
        WARN(`  → HTTP ${resp.status}`);
        continue;
      }
      html = await resp.text();
      LOG(`  → got HTML, length: ${html.length}`);
    } catch (err) {
      ERR(`  → fetch error: ${err.message}`);
      continue;
    }

    // Recursive deep-find helper for JSON blobs
    function deepFind(obj, key) {
      if (!obj || typeof obj !== 'object') return null;
      if (Object.prototype.hasOwnProperty.call(obj, key)) return obj;
      for (const v of Object.values(obj)) {
        const f = deepFind(v, key);
        if (f) return f;
      }
      return null;
    }
    function fromJsonBlocks(html, objKey, fieldKey) {
      const pats = [
        /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g,
        /<script[^>]*data-content-type="application\/json"[^>]*>([\s\S]*?)<\/script>/g,
      ];
      for (const re of pats) {
        let m;
        while ((m = re.exec(html)) !== null) {
          try {
            const node = deepFind(JSON.parse(m[1]), objKey);
            if (node?.[fieldKey] !== undefined) return String(node[fieldKey]);
          } catch (_) {}
        }
      }
      return null;
    }

    // ── dtsg ──
    const dtsg = fromJsonBlocks(html, 'DTSGInitialData', 'token')
      || html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"\}/)?.[1]
      || html.match(/"token":"([^"]+)","async_get_token"/)?.[1]
      || html.match(/fb_dtsg[^"]*"value":"([^"]+)"/)?.[1]
      || html.match(/"fb_dtsg","([^"]+)"/)?.[1];

    // ── uid ──
    const uid = fromJsonBlocks(html, 'CurrentUserInitialData', 'USER_ID')
      || html.match(/"USER_ID":"(\d+)"/)?.[1]
      || html.match(/"userID":"(\d+)"/)?.[1]
      || html.match(/"viewer_actor_id":"(\d+)"/)?.[1];

    // ── lsd ──
    const lsd = html.match(/\["LSD",\[\],\{"token":"([^"]+)"\}/)?.[1]
      || html.match(/"lsd"\s*:\s*"([^"]+)"/)?.[1]
      || html.match(/"lsd","([^"]+)"/)?.[1];

    const hsi    = html.match(/"hsi"\s*:\s*"([^"]+)"/)?.[1] || null;
    const spin_r = html.match(/"__spin_r"\s*:\s*(\d+)/)?.[1] || null;
    const spin_b = html.match(/"__spin_b"\s*:\s*"([^"]+)"/)?.[1] || null;
    const spin_t = html.match(/"__spin_t"\s*:\s*(\d+)/)?.[1] || null;

    LOG(`  Parsed → dtsg:${dtsg?.slice(0,8) || 'NULL'} uid:${uid || 'NULL'} lsd:${lsd?.slice(0,6) || 'NULL'}`);

    if (!dtsg || !uid) {
      WARN(`  → could not find dtsg/uid in ${pageUrl}`);
      continue;
    }

    // Compute jazoest dynamically from fb_dtsg (Facebook's actual formula)
    let jazoest = '25669'; // fallback only
    if (dtsg) {
      let n = 0;
      for (let i = 0; i < dtsg.length; i++) n += dtsg.charCodeAt(i);
      jazoest = '25' + n;
    }

    const sessionData = {
      uid, actorId: uid, dtsg, lsd: lsd || '',
      hsi, spin_r, spin_b, spin_t,
      jazoest, reqCounter: 1,
      lastRefresh: Date.now(),
    };
    Object.assign(fbSession, sessionData);

    // Cache in session storage (survives SW restart)
    try { await chrome.storage.session.set({ fbSession: sessionData }); } catch (_) {}

    LOG(`✅ Tokens OK — uid:${uid} dtsg:${dtsg.slice(0, 8)}…`);
    return true;
  }

  ERR(`❌ extractFbTokens: all ${pages.length} FB pages failed to yield tokens (${pages.join(', ')}) — the user is likely NOT logged into Facebook, hit a checkpoint/2FA, or FB changed the token markers (dtsg/uid). Action: have the user open facebook.com and confirm they're logged in.`);
  return false;
}

async function ensureFbTokens() {
  const age = Date.now() - fbSession.lastRefresh;
  if (!fbSession.dtsg || age > FB_TOKEN_TTL_MS) {
    const ok = await extractFbTokens();
    if (!ok) throw new Error('fb_not_logged_in_or_token_parse_failed');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2 — Base params builder (appended to every GraphQL body)
// ═══════════════════════════════════════════════════════════════════════════════
function buildFbBaseParams() {
  const p = new URLSearchParams({
    av:                  fbSession.actorId,
    __user:              fbSession.uid,
    __a:                 '1',
    __req:               (fbSession.reqCounter++).toString(36),
    __hs:                fbSession.hs  || '19800.HYP:comet_pkg.2.1..2.1',
    dpr:                 '1',
    __ccg:               'EXCELLENT',
    __rev:               fbSession.rev || '1017506513',
    __comet_req:         '15',
    fb_dtsg:             fbSession.dtsg,
    jazoest:             fbSession.jazoest,
    lsd:                 fbSession.lsd || '',
    fb_api_caller_class: 'RelayModern',
    server_timestamps:   'true',
  });
  if (fbSession.spin_r) p.append('__spin_r', String(fbSession.spin_r));
  if (fbSession.spin_b) p.append('__spin_b', fbSession.spin_b);
  if (fbSession.spin_t) p.append('__spin_t', String(fbSession.spin_t));
  return p.toString();
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3 — GraphQL fetch
// POST /api/graphql/ with correct headers.
// X-FB-Friendly-Name & Referer are required for Facebook to accept the request.
// ═══════════════════════════════════════════════════════════════════════════════

// 🔴 v2026-09-26 · HTTP 429 means STOP. This used to wait 60 s and send the same request
// again (up to three times), and the campaign then carried on to the next group — more
// requests into an account Facebook had just told to slow down. GPP 2.10.45 stops the run
// on the first 429; so do we. The flag is per dispatch (reset in dispatchPost /
// dispatchComment): once Facebook answers 429, nothing else in that dispatch is sent — not
// the post after a refused link preview, not a Tier 1 / Tier 2 retry.
let _fbRateLimitHit = false;
function _rateLimitError(friendlyName, notSent) {
  const e = new Error(notSent
    ? `rate_limited: not sent — Facebook answered HTTP 429 (Too Many Requests) earlier in this post (${friendlyName})`
    : `rate_limited: Facebook answered HTTP 429 (Too Many Requests) to ${friendlyName} — the campaign stops; nothing is re-sent`);
  e.mgpRateLimited = true;
  e.errorType = 'CRITICAL';
  e.stopCampaign = true;
  return e;
}
/** The dispatch result for a 429: the campaign stops (no retry, no Safe failover — both skip
 *  stopCampaign results), with the halt card Facebook's own rate-limit code 1390008 gets. */
function _rateLimitResult(prev) {
  const _msg = String((prev && prev.error) || '');
  return {
    success: false,
    error: /^rate_limited/.test(_msg) ? _msg : 'rate_limited: Facebook answered HTTP 429 (Too Many Requests) — the campaign stops; nothing is re-sent',
    errorType: 'CRITICAL',
    stopCampaign: true,
    rateLimited: true,
  };
}

// `opts.singleShot` — the request CREATES something that carries no idempotence token Facebook
// is known to honour (a comment), so it is sent exactly once: no re-send on a 5xx, and any failure
// after the request left (timeout, dropped connection, a 5xx, an unreadable body) is marked
// `mgpMaybeSent` — it may have landed, and the caller must not send it again.
async function _fetchGraphQLOnce(docId, friendlyName, variables, opts) {
  const _singleShot = !!(opts && opts.singleShot);
  if (_fbRateLimitHit) throw _rateLimitError(friendlyName, true);
  const variablesJson = JSON.stringify(variables);
  const body = [
    buildFbBaseParams(),
    `fb_api_req_friendly_name=${encodeURIComponent(friendlyName)}`,
    `variables=${encodeURIComponent(variablesJson)}`,
    `server_timestamps=true`,
    `doc_id=${docId}`,
  ].join('&');

  // v10.3 (2026-05-01): log variables shape signature so we can identify
  // when the same friendlyName produces different variable shapes across
  // iterations (= drift bug). Hash is a 32-bit fold of the JSON.
  // v10.5 (2026-05-02): added a separate `[vars-hash]` log line so the user
  // can grep `[vars-hash]` after a campaign and see at a glance whether
  // variables shape drifted between successful (1, 3, 4, 5) and failed
  // (e.g., 6) posts. Identical hashes for all posts but only some fail
  // → confirms FB anti-spam ML decision (not a structural bug). Differing
  // hashes → captured-template drift, fixable in code.
  let hash = 0;
  for (let i = 0; i < variablesJson.length; i++) {
    hash = ((hash << 5) - hash + variablesJson.charCodeAt(i)) | 0;
  }
  const hashStr = hash.toString(36);
  const inputKeys = Object.keys(variables?.input || {}).sort().join(',');
  LOG(`fetchGraphQL → ${friendlyName} (doc_id: ${docId}) varsHash=${hashStr} inputKeys=[${inputKeys}]`);
  LOG(`[vars-hash] ${friendlyName} hash=${hashStr} len=${variablesJson.length} keys=${Object.keys(variables?.input || {}).length}`);

  for (let attempt = 0; attempt < 3; attempt++) {
    // v10.7: 90s timeout per attempt (previously infinite). A timeout throws, marked
    // mgpMaybeSent (v2026-09-26) — it is never re-sent from here.
    // #5 — measure round-trip time so a slow FB response (throttling / network)
    // is visible in the logs.
    const _t0 = Date.now();
    let resp;
    try {
      resp = await fetchWithTimeout('https://www.facebook.com/api/graphql/', {
        method:      'POST',
        credentials: 'include',
        headers: {
          'Content-Type':       'application/x-www-form-urlencoded',
          'X-FB-Friendly-Name': friendlyName,
          // v83 (GPP-parity): a real Comet composer POST always carries these two
          // headers; MGP previously sent LSD only in the BODY and never sent
          // X-ASBD-ID on the post (it set both only on the unrelated profile-switcher
          // read, mgp-service-worker.js:6265-6266). Their absence is a cheap,
          // deterministic "this is automation" tell that a manual UI post never has.
          // (Sec-Fetch-* are deliberately NOT set here — they are forbidden headers
          // the browser controls; setting them via fetch() is a no-op and itself a tell.)
          'X-FB-LSD':           (typeof fbSession !== 'undefined' && fbSession && fbSession.lsd) ? fbSession.lsd : '',
          'X-ASBD-ID':          '359341',
          'Referer':            'https://www.facebook.com/',
          'Origin':             'https://www.facebook.com',
          'Accept':             '*/*',
          'Accept-Language':    'en-US,en;q=0.9',
        },
        body,
      }, 90_000);
    } catch (netErr) {
      // The request may have reached Facebook before the timeout / the connection dropped.
      if (netErr && typeof netErr === 'object') netErr.mgpMaybeSent = true;
      throw netErr;
    }

    LOG(`  → attempt ${attempt + 1} status: ${resp.status} (took ${Date.now() - _t0}ms)`);

    if (resp.status === 429) {
      // Facebook refused the request before processing it — nothing was created. Stop here.
      _fbRateLimitHit = true;
      WARN(`  → rate limited (429) on ${friendlyName} — stopping, nothing is re-sent`);
      throw _rateLimitError(friendlyName, false);
    }
    if (resp.status >= 500) {
      if (_singleShot) {
        // A 5xx can come back AFTER Facebook made the comment. Re-sending is how a comment doubles.
        const e5 = new Error(`GraphQL HTTP ${resp.status} for ${friendlyName} — not re-sent (it may have gone through)`);
        e5.mgpMaybeSent = true;
        throw e5;
      }
      WARN(`  → server error (${resp.status}) — retrying in 5s`);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }
    if (!resp.ok) throw new Error(`GraphQL HTTP ${resp.status} for ${friendlyName}`);

    let text;
    try {
      text = await resp.text();
    } catch (bodyErr) {
      // Facebook answered 200 and the body was lost on the way — it processed the request.
      if (bodyErr && typeof bodyErr === 'object') bodyErr.mgpMaybeSent = true;
      throw bodyErr;
    }
    LOG(`  → response length: ${text.length}, preview: ${text.slice(0, 120)}`);
    // v10.3 (2026-05-01): on 1675012 (missing_required_variable) — log the
    // FULL variables that were sent. Compare with a successful post's
    // variables to find the drift. The user reported this error is hitting
    // multi-post campaigns even on text-only posts.
    if (friendlyName.indexOf('ComposerStoryCreate') !== -1 && /"errors"\s*:\s*\[/.test(text) && (/"severity"\s*:\s*"CRITICAL"[\s\S]{0,400}?"code"\s*:\s*1675012/.test(text) || /"code"\s*:\s*1675012[\s\S]{0,400}?"severity"\s*:\s*"CRITICAL"/.test(text))) { // v24/v26: scope to the POST mutation + require the 1675012 missing-variable error to be a CRITICAL entry (a REAL drift). Skips the benign "severity":"WARNING" missing_required_variable_value noise FB attaches to SUCCESSFUL FALLBACK posts, and skips posts that failed for a DIFFERENT code (3809006/1357006) but carry that WARNING noise. Both field-orders (severity↔code) covered. Real Charles drift = CRITICAL code 1675012 → still fires.
      // v18: surface a COMPACT, greppable field-key list. FB's error is GENERIC — it does NOT name the
      // missing field — so to fix schema-drift you diff these keys against FB's CURRENT real-composer
      // request and add what's new (then seed the remote variables-template). Keys only (no values) →
      // short + leaks zero content.
      let _vk = '?'; try { const _v = JSON.parse(variablesJson); const _ik = _v?.input ? Object.keys(_v.input) : []; _vk = 'input{' + _ik.join(',') + '} root{' + Object.keys(_v || {}).filter((k) => k !== 'input').join(',') + '}'; } catch (e) {}
      WARN(`[1675012-debug] SCHEMA DRIFT for ${friendlyName} — FB rejected our request shape (FB does NOT name the missing field). keys sent: ${_vk}`);
      WARN(`[1675012-debug] full variables sent:`, variablesJson.length > 4000 ? variablesJson.slice(0, 4000) + '…[truncated]' : variablesJson);
    }
    return text;
  }
  throw new Error(`GraphQL failed after retries: ${friendlyName}`);
}

// Detects GraphQL-level doc_id rejection (FB 200s with these errors when
// the persisted query is unknown/rotated). Network/HTTP errors are handled
// separately inside _fetchGraphQLOnce and do not reach this check.
function _isDocIdError(text) {
  if (!text) return false;
  const head = text.slice(0, 3000);
  if (/PersistedQueryNotFound|Invalid document|does not contain a query named|unknown doc_id|"errorSummary":"Invalid/i.test(head)) {
    return true;
  }
  // ── 1675012 / missing_required_variable_value ──
  // Facebook serves FIVE doc_id candidates and this loop knows how to walk
  // them, but this rejection was not in the list above — so the loop gave up
  // after the first candidate. Measured: 884 log lines, ZERO occurrences of
  // "trying next candidate". A different persisted query can have a schema our
  // variables DO satisfy, so it is worth trying the rest.
  //
  // ⛔⛔ THE DANGEROUS PART, AND WHY THIS IS NOT A ONE-LINE REGEX ADD:
  // parseStoryResponse's own comment records that Facebook returns
  // `missing_required_variable_value` as WARNING-severity NOISE **on
  // successful posts**. Matching that phrase alone would classify a post that
  // ALREADY PUBLISHED as a doc_id rejection, and the loop would immediately
  // re-send it under the next candidate — a DUPLICATE POST, the one failure
  // mode this codebase treats as unacceptable.
  //
  // Two independent guards, both required:
  //   1. The response must not contain a created story. If Facebook made a
  //      post, nothing here is a doc_id error, full stop.
  //   2. The rejection must be FATAL — `is_final: true` or CRITICAL severity —
  //      which is what distinguishes the real rejection from the warning noise
  //      (see the 1675012 branch in categorizeFbError).
  const _looks1675012 = /code["\s:]*1675012|missing_required_variable_value/i.test(head);
  if (!_looks1675012) return false;
  // ⚠️ Scans the FULL text, deliberately — NOT `head`. Everything else here is
  // capped at 3000 chars for speed, but a real Facebook success response is
  // several KB and the story node can sit well past that cap while an error
  // entry appears early. Checking only the head would report "not published"
  // for a post that DID publish, and the caller would send it again under the
  // next doc_id. Missing an error is harmless (we just don't retry); missing a
  // story is a duplicate post.
  // Must match a story that EXISTS, not merely the presence of the field name.
  // Facebook's rejection envelopes carry `"data":{"story_create":null}` — the
  // key is there, the story is not. Matching the bare key meant every real
  // 1675012 rejection looked "already published", so the candidate loop never
  // advanced and this whole fix silently did nothing. Caught by driving the
  // guard with a realistically-shaped envelope instead of a minimal fixture.
  // 🪤 No literal opening-brace character in this pattern on purpose — the
  // unit-test harness slices functions by brace-matching and counts braces
  // inside regex literals AND inside comments, so one here makes the whole
  // function unextractable and its tests silently vanish (0 tests, not a
  // failure). The negative lookahead says the same thing: story_create is
  // present and is NOT null.
  // v2026-10-23 · a COMMENT that Facebook made counts too ("comment_create" present and not null): the walk below
  // would otherwise send the same comment again under the next doc_id. A refused one (null) still walks.
  const _published = /"story_create"\s*:\s*(?!null)|"comment_create"\s*:\s*(?!null)|"legacy_story_hideable_id"\s*:\s*"[^"]|"story_id"\s*:\s*"[^"]|"legacy_fbid"\s*:\s*"[^"]/i.test(text);
  if (_published) return false;                                   // guard 1
  const _fatal = /"is_final"\s*:\s*true|"severity"\s*:\s*"CRITICAL"/i.test(head);
  return _fatal;                                                  // guard 2
}

// ── The shipped doc_ids, frozen at load ─────────────────────────────────────
// FB_DOC_IDS is MUTATED in place by the remote doc-config at startup ("Applied
// remote doc_id config: 177 entries"), and fetchGraphQL builds its candidate
// list from the mutated object. So a bad remote value does not just take
// priority — it makes the known-good built-in UNREACHABLE, permanently, with no
// way for the candidate loop to recover.
//
// Measured 2026-08-21: the built-in text doc_id is 9469644099759635 (the same
// one the competitor ships and posts with successfully). The remote config
// served 27300941309579835 instead. Every post fell back to text-only, got
// `missing_required_variable_value`, walked all five server-supplied
// candidates — and never once tried the correct id sitting in our own source.
// The media id was identical in both, which is exactly why media posts kept
// working while text-only did not.
const FB_DOC_IDS_BUILTIN = Object.freeze({ ...FB_DOC_IDS });

async function fetchGraphQL(docId, friendlyName, variables, opts) {
  // Build ordered candidate list: explicit arg first, then current primary,
  // then any additional server-provided candidates. Dedup, drop falsy.
  const seen = new Set();
  const candidates = [];
  const push = (id) => {
    if (typeof id === 'string' && /^\d{13,17}$/.test(id) && !seen.has(id)) {
      seen.add(id);
      candidates.push(id);
    }
  };
  push(docId);
  push(FB_DOC_IDS[friendlyName]);
  const extras = FB_DOC_ID_CANDIDATES[friendlyName];
  if (Array.isArray(extras)) for (const id of extras) push(id);
  // Last resort: the id we SHIPPED with. Pushed last so a good remote config
  // still wins on the first attempt and nothing about the normal path changes —
  // but a bad one can no longer hide it. `push` dedups, so when remote and
  // built-in agree (the common case) this adds nothing at all.
  push(FB_DOC_IDS_BUILTIN[friendlyName]);

  if (candidates.length === 0) {
    throw new Error(`fetchGraphQL: no valid doc_id for ${friendlyName}`);
  }

  let lastText = null;
  for (let i = 0; i < candidates.length; i++) {
    const tryId = candidates[i];
    const text = await _fetchGraphQLOnce(tryId, friendlyName, variables, opts);
    if (!_isDocIdError(text)) {
      // Promote if a non-primary candidate worked — persist locally so
      // subsequent calls (and future sessions) use the winner first.
      if (tryId !== FB_DOC_IDS[friendlyName] &&
          // v25: never PROMOTE the ...Media doc_id under the base/text key — a media post runs this loop
          // with friendlyName='ComposerStoryCreateMutation' and tryId=Media, which would clobber the text
          // doc_id (this path fires if patchFetch's guard above skipped the same clobber). Real base drift
          // (a winning candidate ≠ Media) still promotes normally.
          !(friendlyName === 'ComposerStoryCreateMutation' && tryId === FB_DOC_IDS.ComposerStoryCreateMutationMedia)) {
        LOG(`doc_id auto-promote: ${friendlyName} → ${tryId} (was ${FB_DOC_IDS[friendlyName]})`);
        FB_DOC_IDS[friendlyName] = tryId;
        try {
          chrome.storage.local.set({ [`fb_docid_${friendlyName}`]: tryId });
        } catch (_) {}
        // Also move tryId to front of candidates cache.
        const rest = candidates.filter(id => id !== tryId);
        FB_DOC_ID_CANDIDATES[friendlyName] = [tryId, ...rest];
      }
      return text;
    }
    WARN(`  → doc_id rejected for ${friendlyName} (${tryId}); trying next candidate`);
    lastText = text;
  }
  // All candidates failed with doc_id errors — return the last response so
  // callers can surface the original FB error message to the user.
  // v2026-10-16 · a comment under a post still waiting for the group admin's approval gets this same answer (measured live:
  // comment_create null + missing_required_variable_value) — that is not a stale doc_id, and support reading the log must
  // not be sent after one. Log wording only; the walk above and what the caller gets are unchanged.
  const _pendingLike = friendlyName === 'useCometUFICreateCommentMutation' && /"comment_create"\s*:\s*null/.test(String(lastText || '').slice(0, 3000));
  WARN(_pendingLike
    ? `fetchGraphQL: every doc_id (${candidates.length}) refused the comment (comment_create null). Normal while the post still waits for the admin's approval (the comment stays queued and is tried again later); on a post that is already live this points to a doc_id/variables problem. Last FB response: ${String(lastText || '').slice(0, 160)}`
    : `fetchGraphQL: all ${candidates.length} doc_id candidates REJECTED for ${friendlyName} — tried [${candidates.join(', ')}]. FB rotated the persisted-query id → needs a doc_id refresh (local harvest / remote config). Last FB response: ${String(lastText || '').slice(0, 160)}`);
  return lastText;
}

// ── Story ID normalizer ───────────────────────────────────────────────────────
// Facebook sometimes returns story IDs base64-encoded (e.g. "UzpfSToxMjM0NTY3ODkw").
// Decode to plain numeric ID so URLs can be constructed correctly.
function normalizeStoryId(storyId) {
  if (!storyId) return null;
  if (/^\d+$/.test(storyId)) return storyId; // already numeric — fast path
  try {
    const decoded = atob(storyId);
    const match = decoded.match(/(?:VK:|:)(\d+)(?:\D|$)/);
    return match?.[1] ?? storyId; // fallback: return as-is if can't parse
  } catch (_) { return storyId; }
}

// ── NDJSON parser ─────────────────────────────────────────────────────────────
function parseStoryResponse(text) {
  let foundStory       = null;
  let foundErrors      = null;
  let foundFbErrorCode = null;
  let foundFbErrorMid  = null;

  // Spam-flag-on-SUCCESS early-warning (2026, adopted from competitor analysis):
  // FB sometimes accepts a post (returns a real story_id) but silently marks it as
  // spam / shadow-limits it via `is_marked_as_spam` or `is_marked_as_spam_by_admin_assistant`.
  // That's the earliest signal the account is being throttled — detect it once on the
  // raw NDJSON so it survives BOTH the story-object path and the regex-fallback path.
  const spamFlagged = /"is_marked_as_spam(?:_by_admin_assistant)?"\s*:\s*true/.test(text);

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const json = JSON.parse(t);
      const storyCreate = json.data?.story_create;
      const story = storyCreate?.story;
      if (story && !foundStory) {
        // if_viewer_can_learn_more_about_pending_post is non-null when the post
        // is waiting for admin approval — not publicly visible yet.
        // (19-Oct audit) an OBJECT means pending; a boolean false or a string never does
        const isPending = !!story.if_viewer_can_learn_more_about_pending_post && typeof story.if_viewer_can_learn_more_about_pending_post === 'object';
        LOG('story fields → publishing_flow:', storyCreate?.publishing_flow,
            '| story_id:', storyCreate?.story_id,
            '| post_id:', storyCreate?.post_id,
            '| pending_field:', story.if_viewer_can_learn_more_about_pending_post,
            '| legacy_id:', story.legacy_story_hideable_id);
        foundStory = {
          id:        normalizeStoryId(story.legacy_story_hideable_id || story.id),
          url:       story.url || null,
          isPending,
        };
      }
      if (json.errors?.length > 0 && !foundErrors) {
        // FB returns WARNING "missing_required_variable_value" noise entries
        // even on successful posts. The real cause of a failure is the CRITICAL
        // entry (e.g. code 3809006 "Sorry, this feature isn't available right
        // now" = FB blocked posting at group/account level). Prefer CRITICAL.
        const critical = json.errors.find(e => e?.severity === 'CRITICAL');
        const picked = critical || json.errors[0];
        foundErrors = picked?.summary || picked?.description || picked?.message || 'graphql_error';
        // Capture FB's internal error code + mid for diagnostics. These are
        // FB's own identifiers (not user data) — surfaced in the result so
        // the calling code can include them in user-facing error messages or
        // local debug logs. Helps pinpoint patterns when many users hit the
        // same error (e.g. all 3809006 = group-type unsupported).
        if (critical) {
          foundFbErrorCode = critical.code || null;
          foundFbErrorMid  = Array.isArray(critical.mids) ? critical.mids[0] : null;
          LOG(`  → FB CRITICAL error: code=${foundFbErrorCode} mid=${foundFbErrorMid || 'none'}`);
        }
        // v2026-08-21: this used to dump the whole errors[] array at ERROR level
        // unconditionally — including on posts that LANDED. Facebook attaches
        // response-render errors to virtually every successful media post (the
        // photo-attachment renderer failing to inline-build the preview card in
        // the reply) and a batch of WARNING-severity
        // `missing_required_variable_value` entries to successful text posts.
        // The result was ~1.5KB of red ERROR text per SUCCESSFUL post: a clean
        // campaign's log looked full of failures, which is exactly the kind of
        // thing that sends support chasing a Facebook account for an hour.
        //
        // `foundStory` is already resolved at this point, so the two cases are
        // distinguishable. A post that landed gets one compact info line; a real
        // failure keeps the full dump, because that is where we actually need it.
        if (foundStory) {
          const _kinds = [...new Set(
            json.errors.map((e) => String(e?.message || e?.summary || 'error').slice(0, 90))
          )].slice(0, 2);
          LOG(`ℹ️ FB returned ${json.errors.length} non-fatal response error(s) on a post that LANDED — ${_kinds.join(' · ')}`);
        } else {
          ERR('GraphQL errors:', JSON.stringify(json.errors));
        }
      }
    } catch (_) {}
  }

  // Story found — check if pending admin approval
  if (foundStory) {
    if (foundStory.isPending) {
      LOG('⏳ Post pending admin approval — if_viewer_can_learn_more_about_pending_post is set');
      return { success: false, error: 'pending_approval', id: foundStory.id, url: foundStory.url };
    }
    return { success: true, id: foundStory.id, url: foundStory.url, spamFlagged };
  }

  // Fallback regex for id
  const id = text.match(/"legacy_story_hideable_id"\s*:\s*"(\d+)"/)?.[1]
           || text.match(/"story_id"\s*:\s*"([^"]+)"/)?.[1]   // v24: accept a BASE64 story_id too (not only numeric) — ASYNC_NOTIF media/video posts return a base64 node id; normalizeStoryId() below decodes it to the legacy numeric → real id (not 'processing') → first-comment works on video
           || text.match(/"legacy_fbid"\s*:\s*"(\d+)"/)?.[1];

  // ── 🔴 v1.2.9.66 · pending is checked BEFORE the bare id, not after ────────
  // The structured branch above only sees `if_viewer_can_learn_more_about_pending_post`
  // when `data.story_create.story` parses. When it does not — an NDJSON line
  // boundary, a different envelope, shape drift — this fallback ran, found a
  // `legacy_story_hideable_id` in the raw text, and returned a PLAIN SUCCESS.
  // The pending check sat below it and was never reached, so a moderated post
  // was reported as published.
  // 🔑 The competitor (GPP 2.10.4, worker.js) solves it exactly this way: it
  // tests the raw text for the field as an object when the parsed value is
  // absent, and also accepts `is_pending`. Adopted — a proven shape, not a guess.
  // v2026-10-19 (audit F5) · only the FIELDS set to true: the old free-text test matched `"is_pending":false`,
  // `"requires_approval":false`, and the post's own words that Facebook echoes back ("invoices awaiting approval"),
  // so a live post could be reported pending (no inline comment; later ones parked as waiting for approval).
  const _pendingInRaw =
    /"if_viewer_can_learn_more_about_pending_post"\s*:\s*\{/.test(text) ||
    /"(?:is_pending|requires_approval|pending_approval)"\s*:\s*true\b/.test(text);
  if (_pendingInRaw) {
    LOG('⏳ Post pending admin approval — found in the raw response (structured story did not parse)');
    return { success: false, error: 'pending_approval', id: id ? normalizeStoryId(id) : null, url: null };
  }

  if (id) return { success: true, id: normalizeStoryId(id), spamFlagged };

  // No story found — now errors matter
  if (foundErrors) return { success: false, error: foundErrors, fbErrorCode: foundFbErrorCode, fbErrorMid: foundFbErrorMid };

  // FB legacy envelope: `for (;;);{...}` — used for some error responses
  // instead of the GraphQL JSON shape. The user's logs showed this with
  // codes 1373034 ("Insufficient Permission for the specified Page") and
  // 1357032 ("Something Went Wrong"). Surface the real errorSummary +
  // errorDescription so the user can act on it instead of seeing
  // generic "parse_failed".
  const legacyMatch = text.match(/^for\s*\(;;\);(\{[\s\S]*\})$/);
  if (legacyMatch) {
    try {
      const env = JSON.parse(legacyMatch[1]);
      const summary = env.errorSummary || env.error_summary || null;
      const desc = env.errorDescription || env.error_description || null;
      const code = env.error || env.code || null;
      if (summary || desc) {
        const human = [summary, desc].filter(Boolean).join(': ');
        const errorMessage = code ? `${human} (code ${code})` : human;
        LOG('FB legacy envelope error:', errorMessage);
        return { success: false, error: errorMessage };
      }
    } catch (_) {}
  }

  ERR('parseStoryResponse: no story found (searched: story_create.story, legacy_story_hideable_id, story_id, pending_approval, for(;;) legacy envelope). Raw:', text.slice(0, 500));
  return { success: false, error: 'parse_failed (no story_create/story_id/pending/legacy-envelope in FB response — likely a mutation-shape change → needs a doc_id/template refresh)', raw: text.slice(0, 500) };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildFbComposedText(text) {
  const lines = (text || '').split('\n');
  return {
    blocks: lines.map(line => ({
      key:               Math.random().toString(36).slice(2, 7),
      text:              line,
      type:              'unstyled',
      depth:             0,
      inlineStyleRanges: [],
      entityRanges:      [],
      data:              {},
    })),
    block_types:   lines.map(() => 'unstyled'),
    block_depths:  lines.map(() => 0),
    block_data:    lines.map(() => ({})),
    entities:      [],
    entity_map:    {},
    inline_styles: [],
  };
}

function extractFbGroupId(url) {
  const num = url.match(/facebook\.com\/groups\/(\d+)/)?.[1];
  if (num) return num;
  try {
    const q = new URL(url).searchParams.get('id');
    if (q) return q;
  } catch (_) {}
  return url.match(/facebook\.com\/groups\/([^/?#]+)/)?.[1] || null;
}

// In-memory cache for slug → numeric ID resolution.
// FB GraphQL requires numeric group IDs; URLs with custom slugs (e.g.
// /groups/adehgames) must be resolved by fetching the group page and
// extracting the numeric ID from FB's embedded data.
const _groupIdCache = new Map();

// === SLUG→ID PATTERNS — keep IN SYNC with mgp-service-worker.js resolveGroupIdSW ===
// Extract a Facebook group's numeric ID from its page HTML. The list is ORDERED
// most-anchored (provably the PAGE's OWN group) → least; accept the first 6–17
// digit hit. SAFETY: never add an unanchored "id near __typename:Group" pattern —
// a group page embeds RECOMMENDED/sidebar groups carrying their own ids, so an
// unanchored match risks posting to the WRONG group. App-link / canonical metas
// are unambiguously the page's own group, so they lead. `slug` is escaped and the
// final two patterns require the page's own slug to sit beside the id.
function extractGroupIdFromHtml(html, slug) {
  if (!html) return null;
  const esc = String(slug || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    // 1. App-link meta (fb://group/<id> or fb://group/?id=<id>) — the page's own group.
    /<meta[^>]+(?:property|name)="al:(?:android|ios):url"[^>]+content="fb:\/\/group\/\??(?:id=)?(\d{6,17})"/i,
    /fb:\/\/group\/\??(?:id=)?(\d{6,17})/,
    // 2. Canonical / og:url meta that already carries the numeric id for this page.
    /<link[^>]+rel="canonical"[^>]+href="https:\/\/www\.facebook\.com\/groups\/(\d{6,17})/i,
    /"og:url"[^>]*content="https:\/\/www\.facebook\.com\/groups\/(\d{6,17})/i,
    // 3. Primary-group routing/entity keys FB emits for the focused group.
    /"groupID":"(\d{6,17})"/,
    /"groupId":"(\d{6,17})"/,
    /\\"groupID\\":\\"(\d{6,17})\\"/,
    /"group_id":"(\d{6,17})"/,
  ];
  // 4. Slug-anchored (only when we have a slug): the page's OWN slug sits right
  //    next to the id, so a sidebar recommended group cannot match.
  if (esc) {
    patterns.push(new RegExp('\\\\?/groups\\\\?/' + esc + '\\\\?/?"[\\s\\S]{0,400}?"(?:id|entity_id|node_id)":"(\\d{6,17})"'));
    patterns.push(new RegExp('"vanity":"' + esc + '"[\\s\\S]{0,200}?"id":"(\\d{6,17})"'));
  }
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// resolveGroupId._lastTransient distinguishes a PERMANENT failure (page fetched
// fine but carries no id → retrying won't help) from a TRANSIENT one (fetch threw
// / HTTP error → worth a retry). dispatchPost reads it to tag the thrown error.
async function resolveGroupId(url) {
  resolveGroupId._lastTransient = false;
  const raw = extractFbGroupId(url);
  if (!raw) return null;

  // Already numeric — no resolution needed.
  if (/^\d+$/.test(raw)) return raw;

  // Slug — check the in-memory cache first.
  if (_groupIdCache.has(raw)) {
    LOG(`  group slug "${raw}" → cached numeric: ${_groupIdCache.get(raw)}`);
    return _groupIdCache.get(raw);
  }

  // Best-effort: a prior "Sync with Facebook" may already hold this slug→id.
  // Cheap; avoids a fetch when it hits (rarely populated for slugs today).
  try {
    const { joinedFacebookGroups = [] } = await new Promise((r) =>
      chrome.storage.local.get('joinedFacebookGroups', r));
    const hit = Array.isArray(joinedFacebookGroups) && joinedFacebookGroups.find((g) =>
      g && g.id && /^\d+$/.test(String(g.id)) &&
      (String(g.url || '').match(/\/groups\/([^/?#]+)/)?.[1] === raw));
    if (hit) {
      _groupIdCache.set(raw, String(hit.id));
      LOG(`  group slug "${raw}" → numeric from joined-groups cache: ${hit.id}`);
      return String(hit.id);
    }
  } catch (_) {}

  // Fetch the group page from FB and extract the numeric ID.
  LOG(`  group slug "${raw}" — resolving via FB fetch...`);
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(`https://www.facebook.com/groups/${raw}/`, {
      credentials: 'include',
      signal: ac.signal,
    }).finally(() => clearTimeout(to));

    if (!res.ok) {
      WARN(`  group slug "${raw}" fetch failed: HTTP ${res.status}`);
      resolveGroupId._lastTransient = true; // HTTP error → retry-eligible
      return null;
    }

    const html = await res.text();
    const numeric = extractGroupIdFromHtml(html, raw);
    if (numeric) {
      LOG(`  group slug "${raw}" → resolved to numeric: ${numeric}`);
      _groupIdCache.set(raw, numeric);
      return numeric;
    }

    // Page fetched OK but no id present → PERMANENT (retry won't help).
    WARN(`  group slug "${raw}" — could not extract numeric ID from FB page (HTML length: ${html.length})`);
    resolveGroupId._lastTransient = false;
    return null;
  } catch (e) {
    WARN(`  group slug "${raw}" — fetch threw: ${e.message}`);
    resolveGroupId._lastTransient = true; // network/abort → retry-eligible
    return null;
  }
}

// Returns true if the URL should be treated as a personal profile/timeline post
// (not a group). Supports:
//   https://www.facebook.com/me
//   https://www.facebook.com/{username}   (no /groups/ segment)
//   the literal string "PROFILE"
function isProfileUrl(url) {
  if (!url) return false;
  if (url === 'PROFILE') return true;
  if (/facebook\.com\/groups\//.test(url)) return false;
  if (/facebook\.com\/(me|profile\.php)/.test(url)) return true;
  // Any bare facebook.com/{slug} without other known path segments → profile
  const m = url.match(/facebook\.com\/([^/?#]+)/);
  if (m && !['events','pages','marketplace','watch','gaming','fundraisers'].includes(m[1])) return true;
  return false;
}

// ── Rich-text HTML → FB ContentState parser ─────────────────────────────────
// Rich-text editors (our React RichTextEditor + any paste source) emit:
//   inline  : <b>/<strong>/<i>/<em>/<u>
//   block   : <h1>/<h2>, <p>/<div>, <br>
//   lists   : <ul>/<ol> wrapping <li>
// Without a parser, those tags would either:
//   (a) reach FB as literal characters in message.text → "<b>hello</b>"
//   (b) get serialised into composed_text.blocks with the markup baked in
// Both are visible-quality regressions vs. competitors that ship rich-text.
//
// Strategy:
//   1. Fast path — if no rich tags are detected, behaviour is BIT-FOR-BIT
//      identical to plain-text posts (zero regression risk).
//   2. Slow path — DOMParser walks the tree and emits Draft-style blocks
//      with per-block `type` (numeric for FB's wire format) and per-block
//      `styles` (inline ranges). Wrapped in try/catch with a defensive
//      plain-text fallback on any failure.
//
// Supported tag → FB mapping (reverse-engineered from competitor 2.1.9.2
// worker.js traffic — these numeric codes are what Facebook's GraphQL
// accepts in the composed_text.inline_styles JSON entries, VERIFIED by
// diffing working vs. failing POST_PAYLOAD requests):
//   Inline styles (numeric codes — FB's `inline_styles` range.style field):
//     <b>, <strong>         → style 1  (BOLD)
//     <i>, <em>             → style 2  (ITALIC)
//     <u>                   → style 4  (UNDERLINE — Draft.js bitmask value;
//                              competitor doesn't ship UL, so this one
//                              follows the Draft.js 1/2/4/8 convention and
//                              may silently fail on FB. If so, Bold/Italic
//                              still work and Underline degrades to plain.)
//   Block types (numeric codes — FB's `block_types` array values):
//     (default)             → 0  (unstyled paragraph)
//     <h1>                  → 5  (header-one)
//     <h2>                  → 6  (header-two)
//     <h3>/<h4>             → 5  (fallback to H1 — FB renders H1/H2 only)
//     <h5>/<h6>             → 6  (fallback to H2)
//     <ul><li>              → 2  (unordered-list-item / bullet)
//     <ol><li>              → 3  (ordered-list-item / numbered)
// All block-level tags (h1-h6, p, div, li) implicitly close any pending
// block so headers/lists never bleed into surrounding paragraphs.
// CRITICAL FIX (field_exception code 3809006): earlier revisions of this
// file used STRING style names ('BOLD'/'ITALIC'/'UNDERLINE'). FB's parser
// requires NUMERIC codes in the inline_styles JSON — string names triggered
// a CRITICAL field_exception server-side, so every formatted post failed
// with "Sorry, this feature isn't available right now". Numeric codes match
// competitor 2.1.9.2's verified-working payload format.
const _RICH_TAG_RE = /<\/?(b|strong|i|em|u|br|h[1-6]|p|div|ul|ol|li)\b/i;
const _STYLE_BOLD      = 1;
const _STYLE_ITALIC    = 2;
const _STYLE_UNDERLINE = 4;
const _RICH_TAG_TO_STYLE = {
  B: _STYLE_BOLD,      STRONG: _STYLE_BOLD,
  I: _STYLE_ITALIC,    EM:     _STYLE_ITALIC,
  U: _STYLE_UNDERLINE,
};
// FB block_type numeric constants (confirmed from competitor traffic).
const _BLOCK_TYPE_UNSTYLED = 0;
const _BLOCK_TYPE_UL_ITEM  = 2;
const _BLOCK_TYPE_OL_ITEM  = 3;
const _BLOCK_TYPE_H1       = 5;
const _BLOCK_TYPE_H2       = 6;
// Header tag → block_type. H3/H4 fall back to H1, H5/H6 to H2 (FB only
// renders two header levels; silent downgrade keeps the post sending).
const _HEADER_TAG_TO_BLOCK = {
  H1: _BLOCK_TYPE_H1,
  H2: _BLOCK_TYPE_H2,
  H3: _BLOCK_TYPE_H1,
  H4: _BLOCK_TYPE_H1,
  H5: _BLOCK_TYPE_H2,
  H6: _BLOCK_TYPE_H2,
};

// Walks the parsed DOM tree and returns an array of blocks, each block
// being { text: string, styles: [{offset, length, style}, ...], type: <number> }.
// Newlines (text-node \n or <br>) close the current block and start a new one;
// active inline styles auto-continue across blocks (FB emits them as
// independent per-block ranges, which matches Draft.js semantics).
// Each block carries a numeric `type` (0=unstyled, 2=ul-item, 3=ol-item,
// 5=H1, 6=H2) so buildComposedText can emit per-block block_types.
//
// Returns null on irrecoverable parse failure so the caller can fallback.
function _parseRichTextBlocks(text) {
  if (typeof document === 'undefined') return null; // SW context — no DOM
  // SOURCE FIX (2026-05-31, Ben Giles' truncation bug — adopted from competitor
  // ihkd's verified-robust parser): build the walkable root via
  // `document.createElement('div').innerHTML = text` (HTML fragment parsing with
  // the div as context) instead of the OLD
  //   `new DOMParser().parseFromString('<div>' + text + '</div>', 'text/html')`
  //   `doc.body.firstChild`
  // The old synthetic `<div>…</div>` wrapper BROKE on any embedded `</div>` in
  // the user's content (common when pasting from Quill/Word/rich editors): the
  // stray `</div>` closed the wrapper early, so `firstChild` held only the text
  // before it and the rest was hoisted as siblings our walk never visited —
  // truncating a 629-char post to its first sentence. Fragment parsing on a
  // detached div treats a stray `</div>` as an ignorable unmatched end tag and
  // keeps ALL content as children. The div is never attached to the live DOM
  // and innerHTML never executes <script> per spec → no XSS risk for the user's
  // own content. The walk(root) logic below is unchanged — it iterates
  // root.childNodes, which now contains the FULL content.
  const root = document.createElement('div');
  root.innerHTML = String(text == null ? '' : text);
  if (!root) return null;

  const blocks = [];
  let curText = '';
  let curStyles = [];
  // Current block's type — reset to UNSTYLED after each close. Header tags
  // (h1/h2) and list items (li) override this for the block they produce.
  let curType = _BLOCK_TYPE_UNSTYLED;
  // Stack of active inline ranges. Each entry: { style: 'BOLD', start: <offset in current block> }
  const active = [];

  // When closing a block, flush every active style as a finished range
  // (offset → curText.length), then prepare the entry for the next block
  // by resetting its start to 0 — so a <b> spanning two lines emits one
  // range per line, which is what FB's per-block model requires.
  function closeBlockAndContinueStyles() {
    for (const a of active) {
      if (a.start < curText.length) {
        curStyles.push({
          offset: a.start,
          length: curText.length - a.start,
          style: a.style,
        });
      }
      a.start = 0;
    }
    blocks.push({ text: curText, styles: curStyles, type: curType });
    curText = '';
    curStyles = [];
    // Default back to unstyled. Block-level tags re-set this before their
    // close-block call so the block carries the right type.
    curType = _BLOCK_TYPE_UNSTYLED;
  }

  // Emit each <li> inside a <ul>/<ol> as its own block with the given type.
  // Non-LI children of UL/OL (whitespace text nodes, stray elements) are
  // skipped — matches the competitor's behaviour (querySelectorAll('li')).
  function walkList(listEl, blockType) {
    if (curText.length > 0) closeBlockAndContinueStyles();
    for (const li of listEl.childNodes) {
      if (li.nodeType !== Node.ELEMENT_NODE) continue;
      if (li.tagName !== 'LI') continue;
      curType = blockType;
      walk(li);
      // Close even if the LI was empty — FB accepts empty list items (rare).
      closeBlockAndContinueStyles();
    }
  }

  function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        // Normalize non-breaking spaces (U+00A0) → regular space. `.textContent`
        // returns the raw U+00A0 char for every `&nbsp;` in the source HTML, and
        // nothing else in the composed_text path decodes it — so without this the
        // rich blocks reach FB with "hard" spaces that render differently from the
        // spaces the user typed. Length-preserving → inline-style offsets stay valid.
        const t = (child.textContent || '').replace(/ /g, ' ');
        // Text nodes can contain literal \n (e.g. when the contentEditable
        // pasted preformatted text). Split and emit one block per segment.
        const parts = t.split('\n');
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) closeBlockAndContinueStyles();
          curText += parts[i];
        }
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const tag = child.tagName;

      // <br> → block boundary (standalone newline).
      if (tag === 'BR') { closeBlockAndContinueStyles(); continue; }

      // Headers (h1/h2/h3-h6) — close any pending block, walk children,
      // close with the mapped header block_type.
      const headerType = _HEADER_TAG_TO_BLOCK[tag];
      if (headerType != null) {
        if (curText.length > 0) closeBlockAndContinueStyles();
        walk(child);
        curType = headerType;  // set right before close so this block carries it
        closeBlockAndContinueStyles();
        continue;
      }

      // Lists — each <li> becomes its own block with list-item block_type.
      if (tag === 'UL') { walkList(child, _BLOCK_TYPE_UL_ITEM); continue; }
      if (tag === 'OL') { walkList(child, _BLOCK_TYPE_OL_ITEM); continue; }

      // <li> outside <ul>/<ol> — rare, but handle gracefully as unstyled.
      // (Normal LI handling happens inside walkList.)
      if (tag === 'LI') {
        if (curText.length > 0) closeBlockAndContinueStyles();
        walk(child);
        closeBlockAndContinueStyles();
        continue;
      }

      // <p> and <div> introduce block boundaries on open (if we're mid-text)
      // and on close. Keeps paragraph semantics consistent with what users
      // type in contentEditable.
      const isBlockTag = (tag === 'P' || tag === 'DIV');
      const needLeadingBlock = isBlockTag && curText.length > 0;
      if (needLeadingBlock) closeBlockAndContinueStyles();

      // Inline style tags (<b>, <i>, <u>, etc.) — push a style range, walk
      // children, pop the range on close.
      const style = _RICH_TAG_TO_STYLE[tag];
      if (style) {
        const entry = { style, start: curText.length };
        active.push(entry);
        walk(child);
        if (curText.length > entry.start) {
          curStyles.push({
            offset: entry.start,
            length: curText.length - entry.start,
            style,
          });
        }
        // Pop this specific entry (lastIndexOf so nested same-style tags
        // don't pop each other in the wrong order).
        const idx = active.lastIndexOf(entry);
        if (idx !== -1) active.splice(idx, 1);
      } else {
        // Unknown tag (span, a, font, …) — transparent; recurse.
        walk(child);
      }
      if (isBlockTag) closeBlockAndContinueStyles();
    }
  }

  walk(root);
  // Flush trailing block (always at least one — even if empty input).
  for (const a of active) {
    if (a.start < curText.length) {
      curStyles.push({
        offset: a.start,
        length: curText.length - a.start,
        style: a.style,
      });
    }
  }
  blocks.push({ text: curText, styles: curStyles, type: curType });
  return blocks;
}

// Content-loss detector for the rich-text parser (added 2026-05-31 after Ben
// Giles' log captured the parser silently returning a 1-block result for a
// 629-char input — only the first sentence survived, both message.text and
// composed_text.blocks). Compares the parser's total output length to the
// input's tag-stripped length. ANY result < 70% of the raw text indicates
// the parser dropped content — most likely DOMParser hoisting something
// outside the synthetic wrapping <div> (e.g. <table>, <style>, malformed
// pattern). The callers fall back to the safe regex-strip path so the post
// goes out with full content (styling lost, content preserved).
function _parseLooksTruncated(parsed, rawText) {
  if (!parsed || parsed.length === 0) return true;
  const parsedTotal = parsed.reduce((n, b) => n + ((b && b.text) || '').length, 0);
  // Strip tags + collapse HTML entities to ~1 char each, then count. Tiny
  // inputs are exempt — for those a small diff is normal noise.
  const rawTextLen = String(rawText || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, '_')
    .length;
  if (rawTextLen <= 50) return false;
  return parsedTotal < rawTextLen * 0.7;
}

// One-time-per-session capture of the EXACT HTML input that tripped the
// parser. Stored under chrome.storage.local._lastTextLossSample so we can
// reproduce the parser bug offline without bothering the user for more
// data. Privacy: caps at 1KB and stores only the head — no full posts.
function _captureTextLossSample(rawText, parsed) {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    const head = String(rawText || '').slice(0, 1000);
    const parsedTotal = parsed
      ? parsed.reduce((n, b) => n + ((b && b.text) || '').length, 0)
      : 0;
    chrome.storage.local.set({
      _lastTextLossSample: {
        ts: Date.now(),
        inputLen: String(rawText || '').length,
        parsedBlocks: parsed ? parsed.length : 0,
        parsedTotal,
        inputHead: head,
        firstBlockText: parsed && parsed[0] ? String(parsed[0].text || '').slice(0, 200) : '',
      },
    });
  } catch (_) { /* best-effort */ }
}

// Public helper used by the call sites for the message.text field, which
// must NOT contain HTML tags (FB renders message.text as plain text).
// Fast path returns the input unchanged when no rich tags are present.
function stripFbHtml(text) {
  if (!text) return text || '';
  if (!_RICH_TAG_RE.test(text)) return text;
  try {
    const parsed = _parseRichTextBlocks(text);
    if (!parsed) return text.replace(/<[^>]+>/g, '');
    // Content-loss safety net (2026-05-31 — Ben Giles' truncation bug): if
    // the parser silently dropped most of the content, fall back to the
    // regex strip. We lose inline styling but PRESERVE the full text —
    // dramatically better than posting only the first sentence.
    if (_parseLooksTruncated(parsed, text)) {
      const stripped = text.replace(/<[^>]+>/g, '');
      const parsedTotal = parsed.reduce((n, b) => n + ((b && b.text) || '').length, 0);
      WARN(`⚠️ stripFbHtml — parser lost content (${parsedTotal}/${stripped.length} chars, ${parsed.length} block${parsed.length === 1 ? '' : 's'}). Using regex-strip fallback. Input head: ${text.slice(0, 120)}`);
      _captureTextLossSample(text, parsed);
      return stripped;
    }
    return parsed.map(b => b.text).join('\n');
  } catch (_) {
    return text.replace(/<[^>]+>/g, '');
  }
}

// Merge consecutive UNSTYLED (plain-paragraph) blocks from _parseRichTextBlocks
// into a single block, joining the lines with '\n'. Reason: FB renders each
// composed_text block as its OWN paragraph, with a blank-line gap between blocks.
// The parser emits one block PER LINE, so a user's single line break (e.g.
// between bullet lines) became a separate paragraph → double-spaced in the post
// (customer complaint). Keeping single line breaks as '\n' INSIDE one block makes
// them soft breaks (tight, as typed); only real blank lines separate paragraphs.
// Headers / list-items (type != 0) keep their own blocks. This also aligns
// composed_text with message.text (= blocks.join('\n')). Offsets of inline
// styles (bold/italic) are shifted to stay valid after the join.
function _cleanAndMergeBlocks(parsed) {
  // 1. Drop leading/trailing empty plain blocks (stray blank lines top/bottom).
  const a = parsed.slice();
  while (a.length && (a[0].type == null || a[0].type === 0) && !a[0].text) a.shift();
  while (a.length && (a[a.length - 1].type == null || a[a.length - 1].type === 0) && !a[a.length - 1].text) a.pop();
  // 2. Collapse runs of empty plain blocks → a single blank line (max 1).
  const b = [];
  for (const blk of a) {
    const isEmpty = (blk.type == null || blk.type === 0) && !blk.text;
    const prevEmpty = b.length && (b[b.length - 1].type == null || b[b.length - 1].type === 0) && !b[b.length - 1].text;
    if (isEmpty && prevEmpty) continue;
    b.push(blk);
  }
  // 3. Merge consecutive plain (type 0) blocks into ONE, joined by '\n'.
  const out = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    let text = '';
    const styles = [];
    for (let i = 0; i < buf.length; i++) {
      if (i > 0) text += '\n';
      const base = text.length;
      for (const s of (buf[i].styles || [])) {
        styles.push({ offset: base + s.offset, length: s.length, style: s.style });
      }
      text += buf[i].text;
    }
    out.push({ text, styles, type: _BLOCK_TYPE_UNSTYLED });
    buf = [];
  };
  for (const blk of b) {
    if (blk.type == null || blk.type === _BLOCK_TYPE_UNSTYLED) buf.push(blk);
    else { flush(); out.push(blk); }
  }
  flush();
  return out.length ? out : [{ text: '', styles: [], type: _BLOCK_TYPE_UNSTYLED }];
}

// A plain body's lines as the merge above sees them — one unstyled block per line.
function _plainLineBlocks(text) {
  return String(text || '').split('\n').map((line) => ({ text: line, styles: [], type: _BLOCK_TYPE_UNSTYLED }));
}

// v2026-10-12 · Facebook counts composed_text offsets in CODE POINTS (Draft's raw state). Ours were UTF-16 units,
// so every emoji before a bold word moved the bold one letter right — LIVE (LT5): in "🙂 Potong perkataan" the
// bold ran from "otong". Styles are converted once, after the merge.
function _stylesToCodePoints(text, styles) {
  const s = String(text == null ? '' : text);
  if (!Array.isArray(styles) || !styles.length || s.length === Array.from(s).length) return styles || [];
  return styles.map((st) => {
    const off = Array.from(s.slice(0, st.offset)).length;
    const len = Array.from(s.slice(st.offset, st.offset + st.length)).length;
    return { ...st, offset: off, length: len };
  });
}

// ── v2026-10-12 · a FORMATTED post with a link: the link was dead (customer report, Fast, bold + photo).
// LIVE in the private test group R1: Fast plain + photo → link ✓ · Safe bold + photo → link ✓ · Fast bold
// (+/- photo) → plain black url ✗ — and naming the url in composed_text did not help either (IMPLICIT_LINK 7
// and LINK 1 were accepted and ignored). Facebook links no url in a post it renders as formatted text.
// So a body that is formatted AND has a url goes as PLAIN text, the way Safe sends it: bold / italic as
// Unicode letters, list items as "• " / "1. ", headers bold — and the url, never restyled, stays a link.
const _URL_RE = /(?:https?:\/\/|www\.)[^\s<>"]+/gi;
const _UB = { A: 0x1D400, a: 0x1D41A, d: 0x1D7CE };   // bold
const _UI = { A: 0x1D434, a: 0x1D44E, d: null };      // italic (digits stay)
const _UBI = { A: 0x1D468, a: 0x1D482, d: 0x1D7CE };  // bold italic
function _unicodeStyled(ch, bold, italic) {
  const m = bold && italic ? _UBI : bold ? _UB : italic ? _UI : null;
  if (!m) return ch;
  const c = ch.charCodeAt(0);
  if (c >= 65 && c <= 90) return String.fromCodePoint(m.A + (c - 65));
  if (c >= 97 && c <= 122) return (m === _UI && ch === 'h') ? 'ℎ' : String.fromCodePoint(m.a + (c - 97));
  if (c >= 48 && c <= 57 && m.d) return String.fromCodePoint(m.d + (c - 48));
  return ch;
}
function _formattedLinkPostAsPlain(text) {
  if (!text || !_RICH_TAG_RE.test(text)) return null;
  _URL_RE.lastIndex = 0;
  if (!_URL_RE.test(text.replace(/<[^>]+>/g, ' '))) return null;
  let blocks;
  try { blocks = _parseRichTextBlocks(text); } catch (_) { return null; }
  if (!Array.isArray(blocks) || !blocks.length || _parseLooksTruncated(blocks, text)) return null;
  const formatted = blocks.some(b => (Array.isArray(b.styles) && b.styles.length > 0) || (b.type != null && b.type !== _BLOCK_TYPE_UNSTYLED));
  if (!formatted) return null;   // plain paragraphs: Facebook links the url itself — unchanged
  let olN = 0;
  return blocks.map((b) => {
    const t = String(b.text || '');
    const bold = new Uint8Array(t.length); const ital = new Uint8Array(t.length);
    const header = b.type === _BLOCK_TYPE_H1 || b.type === _BLOCK_TYPE_H2;
    for (const st of (b.styles || [])) {
      for (let i = Math.max(0, st.offset); i < Math.min(t.length, st.offset + st.length); i++) {
        if (st.style === _STYLE_BOLD) bold[i] = 1;
        if (st.style === _STYLE_ITALIC) ital[i] = 1;
      }
    }
    const keep = new Uint8Array(t.length);   // url characters are never restyled
    _URL_RE.lastIndex = 0; let m;
    while ((m = _URL_RE.exec(t)) !== null) for (let i = m.index; i < m.index + m[0].length; i++) keep[i] = 1;
    let out = '';
    for (let i = 0; i < t.length; i++) out += keep[i] ? t[i] : _unicodeStyled(t[i], header || !!bold[i], !!ital[i]);
    if (b.type === _BLOCK_TYPE_OL_ITEM) { olN++; return olN + '. ' + out; }
    olN = 0;
    return b.type === _BLOCK_TYPE_UL_ITEM ? '• ' + out : out;
  }).join('\n').replace(/^\n+|\n+$/g, '');
}

function buildComposedText(text) {
  // Fast path: no rich-text tags. _RICH_TAG_RE requires the '<' to be followed
  // by an actual tag name, so a body like "5 < 10 is true" never trips it.
  //
  // 🔴 v2026-09-15: this path used to send one block PER LINE "bit-for-bit" —
  // the very shape _cleanAndMergeBlocks exists to undo, because Facebook renders
  // every block as its own gapped paragraph. It stayed live for every plain body,
  // and a share's body is plain text (the sheet's textarea), so shared posts came
  // out double-spaced. Same merge as the rich path now: the lines of a plain body
  // travel inside ONE block, newlines and blank lines included — which is also
  // how the competitor sends a plain body.
  if (!text || !_RICH_TAG_RE.test(text)) {
    const blocks = _cleanAndMergeBlocks(_plainLineBlocks(text)).map(b => b.text);
    return {
      blocks,
      block_types:  blocks.map(() => _BLOCK_TYPE_UNSTYLED),
      block_depths: blocks.map(() => 0),
      block_data:   blocks.map(() => '{}'),
      entities:     blocks.map(() => '[]'),
      entity_map:   '{}',
      inline_styles: blocks.map(() => '[]'),
    };
  }

  // Slow path: parse HTML → emit per-block block_types + inline_styles.
  // Each block may carry a different type (header-one, list-item, etc.) —
  // that's what lets FB render <h1>/<h2>/<ul>/<ol> natively without Unicode
  // tricks, on every language (Hebrew, Arabic, CJK — all render as real
  // bold/italic/headers). Defensive try/catch → on ANY failure (DOMParser
  // unavailable, malformed HTML, exception), fall back to plain text.
  try {
    const parsed = _parseRichTextBlocks(text);
    if (!parsed || parsed.length === 0) throw new Error('empty parse');
    // Content-loss safety net (2026-05-31): if the parser swallowed >30% of
    // the input, route into the catch-block's regex-strip fallback. The
    // fallback splits the stripped text by \n into multiple plain blocks,
    // so the post gets the FULL CONTENT even though styling is dropped.
    if (_parseLooksTruncated(parsed, text)) {
      _captureTextLossSample(text, parsed);
      throw new Error('parse_truncated');
    }
    // Merge per-line plain blocks into per-paragraph blocks (single line breaks
    // → soft '\n' inside one block, not separate gapped paragraphs).
    const merged = _cleanAndMergeBlocks(parsed);
    const blockTexts = merged.map(b => b.text);
    return {
      blocks: blockTexts,
      // Per-block numeric types (0/2/3/5/6) — competitor-verified wire format.
      block_types:  merged.map(b => (b.type != null ? b.type : _BLOCK_TYPE_UNSTYLED)),
      block_depths: blockTexts.map(() => 0),
      block_data:   blockTexts.map(() => '{}'),
      entities:     blockTexts.map(() => '[]'),
      entity_map:   '{}',
      // FB expects each entry as a JSON-stringified array (mirrors the
      // `entities` field's encoding above — this is FB's wire format).
      inline_styles: merged.map(b => JSON.stringify(typeof _stylesToCodePoints === 'function' ? _stylesToCodePoints(b.text, b.styles || []) : (b.styles || []))),
    };
  } catch (e) {
    console.warn('[buildComposedText] rich-text parse failed, falling back to plain:', e?.message || e);
    const stripped = text.replace(/<[^>]+>/g, '');
    // Same paragraph merge as both paths above — a failed parse must not bring
    // back the block-per-line double spacing.
    const blocks = _cleanAndMergeBlocks(_plainLineBlocks(stripped)).map(b => b.text);
    return {
      blocks,
      block_types:  blocks.map(() => _BLOCK_TYPE_UNSTYLED),
      block_depths: blocks.map(() => 0),
      block_data:   blocks.map(() => '{}'),
      entities:     blocks.map(() => '[]'),
      entity_map:   '{}',
      inline_styles: blocks.map(() => '[]'),
    };
  }
}

// Merge captured FB template (real traffic from the user's own manual FB posts)
// into our built variables so any new required fields FB has added are included.
// Our per-post fields (actor_id, audience, message, attachments, idempotence_token,
// composed_text, groupID) MUST win — template is forward-compat fill only.
//
// v11 (2026-05-07): upgraded from shallow merge to recursive DEEP MERGE.
// Old shallow merge lost nested template fields. Example: if FB adds a new
// required field inside `message` (e.g., `message.formatted_ranges`), our
// `message: {text: '...'}` would override the whole `message` object,
// dropping `formatted_ranges`. Deep merge preserves it.
//
// Rules:
//   - Plain objects (not arrays, not Date, not null): recurse, merging keys
//   - Arrays: ours wins entirely (we never inherit array structure from template
//     because arrays in variables are often per-post: tracking[], attachments[],
//     inline_activities[], etc.)
//   - Primitives + null: ours wins if defined
function _isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}
function _deepMerge(template, ours) {
  // Special case: when only one side is a plain object, prefer the more specific value
  if (!_isPlainObject(template)) return ours;
  if (!_isPlainObject(ours))     return ours !== undefined ? ours : template;
  const out = { ...template };
  for (const [k, v] of Object.entries(ours)) {
    if (_isPlainObject(v) && _isPlainObject(template[k])) {
      out[k] = _deepMerge(template[k], v);
    } else {
      out[k] = v;  // ours wins for primitives, arrays, null
    }
  }
  return out;
}
function mergeVariables(template, ours) {
  if (!template || typeof template !== 'object') return ours;
  return _deepMerge(template, ours);
}

// UUID v4 generator — used for composer_session_id which FB requires to be
// a non-empty unique value. Sending empty string causes FB to reject Page
// posts with error 1357032 ("Something Went Wrong"). Verified by reading
// competitor ihkd's worker source which uses the same pattern.
//
// v10.5 (2026-05-02): added campaign-level override via _activeComposerSessionId.
// A real user composing posts has ONE session_id across the workflow — generating
// a fresh UUID per call makes 6 posts in a campaign look like 6 disjoint sessions
// to FB's anti-bot ML. background.js now generates one UUID at campaign start
// and passes it on every job (job.composerSessionId). dispatchPost reads it once
// and stores it here; _generateSessionUuid returns the override if set, or a
// fresh UUID for backward-compat (when no override is provided).
let _activeComposerSessionId = null;

function _generateSessionUuid() {
  if (_activeComposerSessionId) return _activeComposerSessionId;
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}

/**
 * A shared post should look like Facebook's own share: the card, and whatever
 * the user wrote. Not the raw permalink above it.
 *
 * 🔑 Why this lives HERE and not in the sheet's text builder. `post.text` is the
 * single body every path uses, and the DOM composer NEEDS the url in it —
 * Facebook builds the card from the text there, nothing names it. Two bodies
 * would mean the Fast→Safe failover (which re-types `expandedText` into the real
 * composer) could post a body with neither a card nor a link. So the text keeps
 * the permalink and the FAST path, which names its card explicitly, drops it at
 * the last moment.
 *
 * ⛔ `cardUrl` is non-null ONLY when scrapeLinkPreview actually returned a card
 * and it was attached. If the scrape failed, the url stays in the text: a post
 * with neither a card nor a link is the one outcome worse than a visible url.
 *
 * 🪤 Both slash forms match — the sheet stores the canonical permalink and
 * Facebook's own copy of it may differ by the trailing slash alone.
 */
/**
 * Which url the link card should carry, or null for no card.
 *
 * 🔴 Copy mode must never name the source. Its whole promise to the user, in the
 * sheet's own words, is "nothing links back to the original" — but a copy of a
 * TEXT-ONLY post has no attachments, so the card branch ran with
 * `linkPreviewUrl` still set and attached a card pointing straight back at the
 * post being copied. The images were what accidentally suppressed it.
 */
function shareCardUrlFor(job, scannedUrl) {
  if (job && job.shareMode === 'copy') return null;
  return (job && job.linkPreviewUrl) || scannedUrl || null;
}

function stripCardUrlFromText(text, cardUrl, isShareRun) {
  if (!isShareRun || !cardUrl) return text;
  const bare = String(cardUrl).replace(/\/+$/, '');
  if (!bare) return text;
  const esc = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out;
  try {
    // 🪤 The boundary check is not decoration. The permalink is a PREFIX of its
    // own commented form (`…/posts/123/?comment_id=9`), so a plain substring
    // removal left `?comment_id=9` dangling inside the user's caption. Anything
    // that could continue a url after the match means this is a DIFFERENT,
    // longer url — leave it whole.
    //
    // '.' is deliberately NOT in that set: cardUrl is always a canonical group
    // permalink (…/groups/<id>/posts/<id>/), and a url cannot continue with a
    // bare dot after that trailing slash — but a SENTENCE can, and "look: <link>."
    // is how people write. Keeping '.' out is what lets the period survive alone.
    out = String(text == null ? '' : text)
      .replace(new RegExp(esc + '\\/?(?![\\w\\-/?#=&%])', 'g'), '');
  } catch (_) {
    return text;                 // an unexpected url shape is not worth a throw
  }
  return out
    .replace(/[ \t]+$/gm, '')     // trailing spaces the url left behind
    .replace(/\n{3,}/g, '\n\n')   // the blank line it used to sit on
    .trim();
}

// ── Relay providers — ONE list, spread into both composers ──────────────────
// A `__relay_internal__pv__*` variable is a Relay "provided variable": Facebook's
// own client fills it from a `<Name>.relayprovider` module and sends it with every
// ComposerStoryCreateMutation. When a persisted query DECLARES one and does not
// get it, Facebook answers `missing_required_variable_value` — at WARNING when the
// field using it is nullable (the post still lands), at CRITICAL 1675012
// (data:null, nothing created) when it is not.
//
// 🔴 Measured 2026-09-23 on the live account with validation-only requests (no
// `input`, so nothing could be published): every doc_id the remote config serves
// (38236504355964544 first) declares 18 providers the old list lacked, and ONE is
// CRITICAL — StoriesShouldEnablePhotosensitiveContentWarning. Without it, profile
// AND group text posts were refused on all four remote ids and landed only on the
// fifth try, the built-in 9469644099759635 (an older query that declares none of
// them). With it alone, the first id passes. The other 19 new ones are what
// Facebook's own client sends (values read from its modules with
// require('<Name>.relayprovider').get()) and what GPP 2.10.34 sends on both its
// group and timeline branches: 17 of them clear the WARNINGs, 2 are not declared
// by the current id. Extras cost nothing — the built-in and the media ids accept
// this whole list (measured). 6 of the original 18 are no longer loaded by
// Facebook's client; kept, because the built-in id may still declare them.
//
// ⛔ Next time Facebook adds one: names from a live composer request (or GPP's
// worker.js), values from require('<Name>.relayprovider').get() in a facebook.com
// tab — add them HERE. The server template (/api/templates/config) can carry the
// same keys to installs already in the field, without a release.
// 🪤 It DOES: since 2026-09-23 it holds the 20 new ones (for 1.2.9.57). The merge
// lets these values win, but a key REMOVED here keeps arriving from the template —
// re-seed it too. To clear it, seed {input:{}}: an empty config is ignored.
const FB_COMPOSER_RELAY_PROVIDERS = Object.freeze({
  // ── sent since 2026-05, values unchanged ──
  __relay_internal__pv__CometUFIShareActionMigrationrelayprovider:                                            true,
  __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider:                                   false,
  __relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider:                                            false,
  __relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider:                           true,
  __relay_internal__pv__StoriesArmadilloReplyEnabledrelayprovider:                                            true,
  __relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider:                            true,
  __relay_internal__pv__IsWorkUserrelayprovider:                                                              false,
  __relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider:                               false,
  __relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider:                                        false,
  __relay_internal__pv__CometUFIShareActionMigrationV2relayprovider:                                          true,
  __relay_internal__pv__CometFeedStoryDynamicResolutionPhotoAttachmentRenderer_experimentWidthrelayprovider:  500,
  __relay_internal__pv__CometIsReplyPagerDisabledrelayprovider:                                               false,
  __relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider:                                           false,
  __relay_internal__pv__IsMergQAPollsrelayprovider:                                                           false,
  __relay_internal__pv__CometFeedPYMKHScrollInitialPaginationCountrelayprovider:                              10,
  __relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider:                               false,
  __relay_internal__pv__EventCometCardImage_prefetchEventImagerelayprovider:                                  false,
  __relay_internal__pv__GHLShouldChangeSponsoredAuctionDistanceFieldNamerelayprovider:                        false,
  // ── 2026-09-23: what Facebook's current composer adds ──
  // ⛔ REQUIRED — the CRITICAL one. Without it: 1675012 on every current doc_id.
  __relay_internal__pv__StoriesShouldEnablePhotosensitiveContentWarningrelayprovider:                         false,
  __relay_internal__pv__CometFeedShareMedia_shouldPrefetchShareImagerelayprovider:                            false,
  __relay_internal__pv__CometFeedStory_enable_post_permalink_white_space_clickrelayprovider:                  false,
  __relay_internal__pv__CometFeedStory_enable_reactor_facepilerelayprovider:                                  false,
  __relay_internal__pv__CometFeedStory_enable_social_bubblesrelayprovider:                                    false,
  __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider:                                true,
  __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider:                                      'AUTO_TRANSLATE',
  __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider:                               false,
  __relay_internal__pv__CometUFISingleLineUFIrelayprovider:                                                   true,
  __relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider:                           true,
  __relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider:                                true,
  __relay_internal__pv__GHLShouldUseSponsoredAuctionLabelFieldNameV1relayprovider:                            true,
  __relay_internal__pv__GHLShouldUseSponsoredAuctionLabelFieldNameV2relayprovider:                            false,
  __relay_internal__pv__GroupsCometGYSJFeedItemHeightrelayprovider:                                           206,
  __relay_internal__pv__ReelsIFUCard_reelsIFULikeCountrelayprovider:                                          false,
  __relay_internal__pv__ShouldEnableBakedInTextStoriesrelayprovider:                                          false,
  __relay_internal__pv__StoriesShouldIncludeFbNotesrelayprovider:                                             true,
  __relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider:                                     false,
  __relay_internal__pv__groups_comet_use_glvrelayprovider:                                                    false,
  __relay_internal__pv__relay_provider_comet_ufi_ssr_seo_deferrelayprovider:                                  true,
});

function composeGroupVariables(groupId, text, attachments, textFormatPresetId, stableIds, isPageMode = false) {
  // Stable idempotence IDs (passed from sendToWorker in background.js) survive
  // retries → FB dedupes via client_mutation_id + idempotence_token, preventing
  // duplicate posts when a retry fires after the first request actually succeeded.
  // Fallback to per-call random values preserves the original behaviour when the
  // caller does not supply stableIds (backward compat).
  const fallbackToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const mutationId    = stableIds?.mutationId || String(Math.floor(Math.random() * 9999));
  const idempotenceTk = stableIds?.idempotenceToken
    || `client:${fallbackToken}`;
  const atts       = attachments || [];
  const hasMedia   = atts.some(a => a && !a.link);

  LOG('composeGroupVariables: hasMedia=', hasMedia, 'attachments=', atts.length,
      'preset:', textFormatPresetId || '0', 'stable:', !!stableIds);
  // v2026-10-12: formatted + link → plain text with Unicode bold, so the link is clickable (_formattedLinkPostAsPlain).
  const _linkPlain = typeof _formattedLinkPostAsPlain === 'function' ? _formattedLinkPostAsPlain(text) : null;
  if (_linkPlain != null) { LOG('  formatted post with a link → sent as plain text (Unicode bold) so the link stays clickable'); text = _linkPlain; }

  return {
    input: {
      actor_id:                fbSession.actorId,
      audience:                { to_id: groupId },
      // message.text is rendered by FB as plain text — strip any rich-text
      // tags here so they don't show up literally. The structured styles
      // travel via composed_text.inline_styles instead.
      message:                 { text: stripFbHtml(text), ranges: [] },
      composed_text:           buildComposedText(text),
      text_format_preset_id:   textFormatPresetId || '0',
      // Declare the publishing flows the client supports — matches the real
      // Comet composer (and competitor ihkd). ASYNC_SILENT intentionally omitted
      // so group posts still notify normally. Hypothesis: declaring ASYNC_NOTIF
      // lets FB pick a non-FALLBACK flow, reducing dropped background-color posts
      // (we detect "publishing_flow":"FALLBACK" as a BG-drop signal below).
      publishing_flow:         { supported_flows: ['ASYNC_NOTIF', 'FALLBACK'] },
      source:                  'WWW',
      composer_type:           'group',
      composer_source_surface: 'group',
      composer_entry_point:    hasMedia ? 'publisher_bar_media' : 'inline_composer',
      client_mutation_id:      mutationId,
      idempotence_token:       idempotenceTk,
      attachments:             atts,
      with_tags_ids:           null,
      navigation_data: {
        attribution_id_v2: 'CometGroupDiscussionRoot.react,comet.group,tap_bookmark,,,,,',
      },
      tracking:              [null],
      event_share_metadata:  { surface: 'newsfeed' },
      inline_activities:     [],
      // 2026-05-01 v9.4: was empty string. FB rejects Page-mode posts with
      // 1357032 when composer_session_id is empty. UUID matches ihkd.
      // v10.7 (2026-05-02): hybrid — empty string for Personal mode (matches
      // competitor — less suspicious to FB anti-bot since real users start with
      // empty session) and UUID for Page mode (preserves v9.4 1357032 fix).
      logging:               { composer_session_id: isPageMode ? _generateSessionUuid() : '' },
    },
    feedLocation:   'GROUP',
    feedbackSource: 0,
    focusCommentID: null,
    // 2026-05-01 v9.4: ihkd sets gridMediaWidth=230 when media is present
    // (verified by reading their worker source). null was the wrong default.
    gridMediaWidth: hasMedia ? 230 : null,
    // 2026-05-01 v9.4: ihkd ALWAYS sets groupID = groupId. Our previous
    // logic (null when media present) was wrong — it caused FB to reject
    // Page posts. The earlier "competitor-verified" comment was stale.
    groupID:        groupId,
    scale:          1,
    privacySelectorRenderLocation: 'COMET_STREAM',
    checkPhotosToReelsUpsellEligibility: false,
    checkVideoToReelsUpsellEligibility: false,
    renderLocation: 'group',
    useDefaultActor: false,
    inviteShortLinkKey: null,
    isFeed:          false,
    isGroup:         true,
    isTimeline:      false,
    isFundraiser:    false,
    isFunFactPost:   false,
    isSocialLearning: false,
    isPageNewsFeed:  false,
    isProfileReviews: false,
    isWorkSharedDraft: false,
    hashtag:         null,
    canUserManageOffers: false,
    // v21: root-level variables Facebook began REQUIRING in 2026 — their absence is the cause of
    // customer "Charles"'s `missing_required_variable_value` (1675012) on text+image GROUP posts.
    // Matches the competitor's WORKING group-post mutation shape (worker.pretty.js:746): they send
    // all of these + post successfully, so FB accepts them. Mostly null/false (harmless when not
    // required, fix the error when they are). Root-level — siblings of `input`, NOT inside it.
    displayCommentsContextEnableComment:        null,
    displayCommentsContextIsAdPreview:          null,
    displayCommentsContextIsAggregatedShare:    null,
    displayCommentsContextIsStorySet:           null,
    UFI2CommentsProvider_commentsKey:           'CometGroupDiscussionRootSuccessQuery',
    isEvent:                                    false,
    ...FB_COMPOSER_RELAY_PROVIDERS,
  };
}

// ── Profile / Timeline post variables ───────────────────────────────────────
// Audience = EVERYONE (public post to the user's own timeline).
// Key differences vs group post:
//   composer_type: 'profile', isTimeline: true, isGroup: false
//   feedLocation: 'TIMELINE', groupID: null
//   audience: to_id = actorId (user posts to their own timeline)
/**
 * Timeline variables. `opts.pageFeed` = posting AS a Page INTO that Page's own
 * feed (Liran, 2026-09-11: "post through the business page into the business
 * page").
 *
 * 🔑 The Page-feed input is the shape GPP 2.10.4 ships for its timeline branch,
 * read from its worker.js: an explicit public `privacy` object instead of
 * `to_id`, no `composer_type`, the profile-timeline attribution, surface
 * 'newsfeed'. A Page's posts are public by definition, and `to_id` is the
 * write-on-someone's-wall form. The PERSONAL timeline keeps its existing input
 * untouched — nothing in this change was asked of it.
 */
function composeProfileVariables(text, attachments, textFormatPresetId, stableIds, opts = {}) {
  // Stable idempotence IDs — see composeGroupVariables for rationale.
  const fallbackToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const mutationId    = stableIds?.mutationId || String(Math.floor(Math.random() * 9999));
  const idempotenceTk = stableIds?.idempotenceToken
    || `client:${fallbackToken}`;
  const atts     = attachments || [];
  const hasMedia = atts.some(a => a && !a.link);

  LOG('composeProfileVariables: hasMedia=', hasMedia, 'attachments=', atts.length,
      'preset:', textFormatPresetId || '0', 'stable:', !!stableIds);
  // v2026-10-12: formatted + link → plain text with Unicode bold, so the link is clickable (_formattedLinkPostAsPlain).
  const _linkPlain = typeof _formattedLinkPostAsPlain === 'function' ? _formattedLinkPostAsPlain(text) : null;
  if (_linkPlain != null) { LOG('  formatted post with a link → sent as plain text (Unicode bold) so the link stays clickable'); text = _linkPlain; }

  const _vars = {
    input: {
      actor_id:                fbSession.actorId,
      // to_id = actorId → post to own timeline; privacy is controlled by account defaults.
      // Facebook honours the user's default audience setting (Everyone / Friends / etc.)
      audience:                { to_id: fbSession.actorId },
      // message.text must be plain (FB renders it literally); composed_text
      // carries the rich-text structure via per-block inline_styles.
      message:                 { text: stripFbHtml(text), ranges: [] },
      composed_text:           buildComposedText(text),
      text_format_preset_id:   textFormatPresetId || '0',
      // Match the real Comet composer's declared publishing flows (see group
      // composer note). ASYNC_SILENT omitted so timeline posts still notify.
      publishing_flow:         { supported_flows: ['ASYNC_NOTIF', 'FALLBACK'] },
      source:                  'WWW',
      composer_type:           'profile',
      composer_source_surface: 'timeline',
      composer_entry_point:    hasMedia ? 'publisher_bar_media' : 'inline_composer',
      client_mutation_id:      mutationId,
      idempotence_token:       idempotenceTk,
      attachments:             atts,
      with_tags_ids:           null,
      navigation_data: {
        attribution_id_v2: 'CometSinglePageHomeTimeline.react,comet.timeline,,,,,,',
      },
      tracking:              [null],
      event_share_metadata:  { surface: 'timeline' },
      inline_activities:     [],
      logging:               { composer_session_id: '' },
    },
    feedLocation:   'TIMELINE',
    feedbackSource: 1,
    focusCommentID: null,
    gridMediaWidth: null,
    groupID:        null,
    scale:          1,
    privacySelectorRenderLocation: 'COMET_STREAM',
    checkPhotosToReelsUpsellEligibility: false,
    renderLocation: 'timeline',
    useDefaultActor: false,
    inviteShortLinkKey: null,
    isFeed:           false,
    isGroup:          false,
    isTimeline:       true,
    isFundraiser:     false,
    isFunFactPost:    false,
    isSocialLearning: false,
    isPageNewsFeed:   false,
    isProfileReviews: false,
    isWorkSharedDraft: false,
    hashtag:          null,
    canUserManageOffers: false,
    // v21: same 2026 required-variable additions as the group path, but with the PROFILE/timeline
    // comments key (worker.pretty.js:734). Prevents 1675012 on profile/timeline text+image posts.
    displayCommentsContextEnableComment:        null,
    displayCommentsContextIsAdPreview:          null,
    displayCommentsContextIsAggregatedShare:    null,
    displayCommentsContextIsStorySet:           null,
    UFI2CommentsProvider_commentsKey:           'ProfileCometTimelineRoute',
    isEvent:                                    false,
    ...FB_COMPOSER_RELAY_PROVIDERS,
  };
  if (opts && opts.pageFeed) {
    const inp = _vars.input;
    inp.audience = { privacy: { allow: [], base_state: 'EVERYONE', deny: [], tag_expansion_state: 'UNSPECIFIED' } };
    delete inp.composer_type;
    inp.navigation_data = { attribution_id_v2: 'ProfileCometTimelineListViewRoot.react,comet.profile.timeline.list,via_cold_start,,,,,' };
    inp.event_share_metadata = { surface: 'newsfeed' };
  }
  return _vars;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4 — Photo upload
// upload.facebook.com/ajax/react_composer/attachments/photo/upload
// ═══════════════════════════════════════════════════════════════════════════════

// v10 (2026-05-01): auto-resize oversized images before upload. FB silently
// rejects images >10MB or with absurd dimensions, leaving the user
// confused about why their post failed. Mirror ihkd's behaviour:
//   • <2MB and ≤4096px: pass through untouched
//   • larger: shrink to fit ≤1920px on the long side, JPEG quality 0.85
//
// Uses OffscreenCanvas + createImageBitmap (both available in MV3 worker
// tabs and modern Chrome). Falls back to original blob if any step fails.
// ── Unreadable-format detection (H) ─────────────────────────────────────────
// The media picker now decode-tests every file it accepts, so nothing new can
// reach here in a format Chrome cannot read. This covers the blobs ALREADY in
// MediaDB from before that gate existed — iPhone HEIC photos, mostly, which
// uploaded to Facebook as opaque bytes and came back rejected with no clue why.
//
// Deliberately a cheap 12-byte SNIFF and not a decode: this sits in the hot
// upload path, once per image PER GROUP, so a createImageBitmap probe here
// would fully decode the same photo dozens of times in one campaign. A real
// decode runs only when the sniff already says HEIF-family — i.e. never for a
// normal JPEG/PNG/WebP/AVIF.
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

async function sniffHeifBrand(blob) {
  try {
    const buf = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (buf.length < 12) return null;
    // ISO-BMFF container: [box size:4]['f','t','y','p'][major brand:4]
    if (buf[4] !== 0x66 || buf[5] !== 0x74 || buf[6] !== 0x79 || buf[7] !== 0x70) return null;
    const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]).toLowerCase();
    return HEIF_BRANDS.has(brand) ? brand : null;
  } catch (_) { return null; }
}

async function detectUnreadableImage(blob) {
  try {
    const brand = await sniffHeifBrand(blob);
    if (!brand) return null;
    // Confirm with a real decode before rejecting anything. AVIF is deliberately
    // absent from the brand list because Chrome decodes it; this second step is
    // what keeps the check honest if Chrome ever ships HEIC support too — the
    // decode would simply start succeeding and we would stop rejecting.
    if (typeof createImageBitmap !== 'function') return brand;
    try {
      const bmp = await createImageBitmap(blob);
      bmp.close?.();
      return null;
    } catch (_) { return brand; }
  } catch (_) { return null; }  // fail-open: never block an upload on a bug in this check
}

async function resizeImageIfOversized(blob) {
  try {
    const isImage = blob.type && blob.type.startsWith('image/');
    if (!isImage) return blob;
    const TWO_MB = 2 * 1024 * 1024;
    const MAX_DIM = 1920;
    if (blob.size <= TWO_MB) return blob;

    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
      // Older browser — pass through, FB might still accept.
      return blob;
    }

    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    const longSide = Math.max(width, height);
    if (longSide <= MAX_DIM && blob.size <= 5 * 1024 * 1024) {
      // Image is reasonably-sized in pixels even if file is bigger than 2MB.
      // Re-encode at 90% quality to reduce file size without resizing dims.
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close?.();
      const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
      LOG(`resizeImageIfOversized: re-encoded ${blob.size} → ${out.size} bytes (${width}x${height} unchanged, q=0.92)`);
      return out.size < blob.size ? out : blob;
    }

    // Resize: scale down so long side = MAX_DIM
    const scale = MAX_DIM / longSide;
    const newW = Math.round(width * scale);
    const newH = Math.round(height * scale);
    const canvas = new OffscreenCanvas(newW, newH);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, newW, newH);
    bitmap.close?.();
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    LOG(`resizeImageIfOversized: ${width}x${height} → ${newW}x${newH} (${blob.size} → ${out.size} bytes)`);
    return out;
  } catch (e) {
    WARN('resizeImageIfOversized failed, using original:', e?.message);
    return blob;
  }
}

// per-upload image "entropy"/hash-busting REMOVED (2026-06). It perturbed pixels
// + re-encoded + appended random bytes so the same image uploaded with a different
// file hash each time — i.e. deliberate content manipulation to dodge Facebook's
// duplicate-image detection. That reads as fraud/tampering to FB's integrity
// systems (a likely account-flag trigger) for little real benefit (FB re-encodes
// + perceptual-hashes server-side anyway). Images now upload UNMODIFIED
// (resizeImageIfOversized only). Duplicate-image spread across groups is handled
// behaviorally (pacing, content variation), never by altering the user's file.

async function uploadFbPhoto(blob) {
  // Refuse a format Facebook cannot use, with a reason, instead of uploading
  // bytes that come back as an opaque rejection. Tagged so the media loop can
  // tell "unreadable file" apart from "blob missing" — the two look identical
  // downstream otherwise, and calling a HEIC "no longer in local storage" sent
  // one customer chasing the wrong problem for a day.
  const _unreadable = await detectUnreadableImage(blob);
  if (_unreadable) {
    const e = new Error(`media_unreadable_format: ${_unreadable}`);
    e.mgpUnreadable = true;
    throw e;
  }
  // Pre-flight resize. Returns original blob if not oversized or on error.
  blob = await resizeImageIfOversized(blob);
  setStep('Uploading image…');
  LOG(`Uploading photo, size: ${blob.size} bytes`);
  const formData = new FormData();
  formData.append('source',        '8');
  formData.append('profile_id',    fbSession.actorId);
  formData.append('waterfallxapp', 'comet');
  formData.append('upload_id',     `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  formData.append('farr',          blob, `image_${Math.random().toString(36).slice(2, 10)}.jpg`);

  // Timeout is adaptive (see _uploadTimeoutFor). The old flat 90s was fine for
  // the common <5MB photo but silently cut off a big file on a slow line — and
  // the AbortError that produced was then reported to the customer as "your
  // image is no longer in local storage", which is the opposite of true.
  const resp = await fetchWithTimeout(
    `https://upload.facebook.com/ajax/react_composer/attachments/photo/upload?${buildFbBaseParams()}`,
    {
      method:      'POST',
      credentials: 'include',
      headers: {
        Accept:           '*/*',
        Referer:          'https://www.facebook.com/',
        'X-FB-Friendly-Name': 'react_composer_photo_upload',
      },
      body: formData,
    },
    // v2026-08-28: adaptive, borrowed from the competitor (GPP `C`): a floor of
    // two minutes, growing with the file. The old flat 90s demanded 2.2 Mbps of
    // upload for a 25MB file, which a tethered or rural connection does not have
    // — and the AbortError it threw was then reported as "your image is gone".
    _uploadTimeoutFor(blob),
  ).catch((netErr) => {
    // The request never reached Facebook: blocked by antivirus / VPN / a DNS
    // filter, or aborted on timeout. That is NOT "the file is missing" and NOT
    // "Facebook said no" — and merging all three into one label is what told a
    // customer to re-upload a photo that was sitting right there, all day.
    const e = new Error(`photo_upload_network: ${netErr && netErr.message ? netErr.message : netErr}`);
    e.mgpUploadNetwork = true;
    throw e;
  });
  // v2026-10-12 · a 429 here is the same "slow down" as a 429 on the post itself — it stops the run
  // (it used to count as one more lost photo, and the next group uploaded again straight away).
  if (resp.status === 429) { _fbRateLimitHit = true; throw _rateLimitError('photo upload'); }
  // v2026-10-16 · WHY Facebook refused, kept on the error (mgpUploadCode / mgpUploadSummary) and carried to the row and
  // campaign_completed. A customer lost two runs (23 groups, every upload refused, 0 posts) and nothing anywhere said
  // what Facebook answered — only "refused".
  if (/facebook\.com\/(login|checkpoint)/.test(String(resp.url || ''))) {
    const e = new Error('photo_upload_signed_out');
    e.mgpUploadCode = /checkpoint/.test(String(resp.url || '')) ? 'checkpoint' : 'signed_out';
    e.mgpAuth = true;   // (review 3) a dead or checkpointed session, not a photo fault — the run stops (AUTH)
    throw e;
  }
  if (!resp.ok) { const e = new Error(`Photo upload HTTP ${resp.status}`); e.mgpUploadCode = 'http_' + resp.status; throw e; }
  const text = await resp.text();

  // Helper: accept only NON-ZERO, NUMERIC ids. FB sometimes returns "0"/""/null in
  // partial-failure responses; pushing those as attachments makes FB silently drop
  // the photo server-side. Validate before returning.
  const _isValidPid = (p) => p != null && /^\d+$/.test(String(p)) && String(p) !== '0';

  for (const line of text.split('\n')) {
    try {
      const json = JSON.parse(line.trim());
      const pid = json.payload?.photoID || json.payload?.fbid || json.data?.upload_image?.fbid;
      if (_isValidPid(pid)) { LOG('Photo uploaded, id:', pid); return { photo: { id: String(pid) } }; }
      if (pid != null) WARN(`Photo upload: rejecting suspicious id="${pid}" (not numeric / is "0") — will try next line / regex fallback`);
    } catch (_) {}
  }
  const pid = text.match(/"fbid"\s*:\s*"(\d+)"/)?.[1] || text.match(/"photoID"\s*:\s*"(\d+)"/)?.[1];
  if (_isValidPid(pid)) { LOG('Photo uploaded (regex), id:', pid); return { photo: { id: pid } }; }

  ERR('Photo upload response:', text.slice(0, 300));
  const _refusal = uploadRefusalOf(text);
  const _e = new Error('photo_id_not_found_in_upload_response' + (_refusal.code ? ' · facebook ' + _refusal.code : ''));
  _e.mgpUploadCode = _refusal.code ? 'fb_' + _refusal.code : 'no_id';
  if (_refusal.summary) _e.mgpUploadSummary = _refusal.summary;
  throw _e;
}

/**
 * v2026-10-16 · Facebook's own words in a refused photo upload: its numeric `error` and `errorSummary` (a generic title such
 * as "Photo upload failed" — never the user's content). Pure; {} when there is nothing to read.
 */
function uploadRefusalOf(text) {
  const out = {};
  try {
    let s = String(text || '').trim();
    if (s.startsWith('for (;;);')) s = s.slice(9);
    const line = s.split('\n').map((l) => l.trim()).find((l) => l.indexOf('"error"') >= 0) || s;
    const j = JSON.parse(line);
    const code = j && (j.error != null ? j.error : (j.payload && j.payload.error));
    if (/^\d{1,9}$/.test(String(code == null ? '' : code))) out.code = String(code);
    const sum = j && (j.errorSummary || (j.payload && j.payload.errorSummary));
    if (typeof sum === 'string' && sum.trim()) out.summary = sum.trim().slice(0, 80);
  } catch (_) {}
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 5 — Video upload (2-step: start session → rupload binary)
// ═══════════════════════════════════════════════════════════════════════════════

/** Strip Facebook's for(;;); anti-hijack prefix then parse JSON */
function parseFbJson(text) {
  const s = typeof text === 'string' && text.startsWith('for (;;);') ? text.slice(9) : text;
  try { return JSON.parse(s); } catch (_) { return null; }
}

// ── Step A: Get upload host + resumable service from GraphQL ─────────────────
async function getVideoUploadConfig() {
  const docId = FB_DOC_IDS.GroupCometVideoUploaderConfigQuery || '6293020010825217';
  const variables = {
    actorID:    fbSession.actorId,
    entryPoint: 'group',
    targetID:   '',
  };
  const raw = await fetchGraphQL(docId, 'GroupCometVideoUploaderConfigQuery', variables);

  let chunkStartHost      = 'www.facebook.com';
  let resumableServiceName = 'rupload.facebook.com';

  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const json = JSON.parse(t);
      const cfgStr = json.data?.viewer?.comet_composer_video_uploader_config;
      if (cfgStr) {
        const cfg = JSON.parse(cfgStr);
        const hostMatch = String(cfg.chunk_start_uri || '').match(/^https?:\/\/([^/]+)\//);
        if (hostMatch) chunkStartHost = hostMatch[1];
        if (cfg.resumable_service_name) {
          resumableServiceName = cfg.resumable_service_name.endsWith('.facebook.com')
            ? cfg.resumable_service_name
            : `${cfg.resumable_service_name}.facebook.com`;
        } else if (cfg.resumable_service_url) {
          const m = cfg.resumable_service_url.match(/^https?:\/\/([^/]+)/);
          if (m) resumableServiceName = m[1];
        }
        break;
      }
    } catch (_) {}
  }
  LOG('Video config — host:', chunkStartHost, 'rupload:', resumableServiceName);
  return { chunkStartHost, resumableServiceName };
}

// ── Step B: Start upload session → get video_id ──────────────────────────────
async function startVideoUploadSession(fileSize, host) {
  const url  = `https://${host}/ajax/video/upload/requests/start/?__a=1`;
  const body = [
    `file_size=${fileSize}`,
    'file_extension=mp4',
    `target_id=${fbSession.actorId}`,
    'source=composer',
    'composer_dialog_version',
    'waterfall_id=d',
    'composer_session_id=',
    'composer_entry_point_ref=group',
    'composer_work_shared_draft_mode',
    'has_file_been_replaced=false',
    'supports_chunking=true',
    'supports_file_api=true',
    'partition_start_offset=0',
    `partition_end_offset=${fileSize}`,
    'creator_product=2',
    'spherical=false',
    'video_publisher_action_source',
    buildFbBaseParams(),
  ].join('&');

  LOG('Video start session → host:', host);
  // v10.7: 30s timeout — start-session is a small request, finishes in <5s.
  const resp   = await fetchWithTimeout(url, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }, 30_000);
  const raw    = await resp.text();
  LOG('Video start status:', resp.status, '| raw:', raw.slice(0, 300));

  const parsed = parseFbJson(raw);
  const videoId = parsed?.payload?.video_id
               || raw.match(/"video_id"\s*:\s*"?(\d+)"?/)?.[1];
  if (!videoId) throw new Error(`video_id not found in start response: ${raw.slice(0, 300)}`);
  LOG('Video session id:', videoId);
  return videoId;
}

// ── Step C: Upload blob to rupload → get handle h ────────────────────────────
async function uploadVideoBlob(blob, ruploadHost) {
  const size       = blob.size;
  const randomName = Math.random().toString(36).slice(2);
  const url        = `https://${ruploadHost}/fb_video/${randomName}-0-${size}?${buildFbBaseParams()}`;

  LOG('Rupload URL:', url.split('?')[0]);
  // v10.7: 180s timeout — this is the actual blob upload. 25MB video on slow
  // network can take 60-90s; 180s gives a real ceiling without false positives.
  const resp = await fetchWithTimeout(url, {
    method: 'POST', credentials: 'include',
    headers: {
      accept:                 '*/*',
      'x-entity-length':      String(size),
      'x-entity-name':        'placeholder.mp4',
      'x-entity-type':        'application/octet-stream',
      'x-total-asset-size':   String(size),
      offset:                 '0',
      start_offset:           '0',
      end_offset:             String(size),
      product_media_id:       '2185810266545271',
    },
    body: blob,
  }, 180_000);
  const raw  = await resp.text();
  LOG('Rupload status:', resp.status, '| response:', raw.slice(0, 200));

  const parsed = parseFbJson(raw) || (() => { try { return JSON.parse(raw); } catch(_){return null;} })();
  if (!parsed?.h) throw new Error(`Rupload: h handle missing in response: ${raw.slice(0, 200)}`);
  LOG('Rupload handle h:', parsed.h);
  return parsed.h;
}

// ── Step D: Finalize — link handle to video_id ───────────────────────────────
async function finalizeVideoUpload(handle, videoId, host, size) {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="fbuploader_video_file_chunk"\r\n\r\n' +
    `${handle}\r\n` +
    `--${boundary}--\r\n`;

  const url = `https://${host}/ajax/video/upload/requests/receive/?` + [
    'composer_session_id=',
    `video_id=${videoId}`,
    'start_offset=0',
    `end_offset=${size}`,
    'source=composer',
    `target_id=${fbSession.actorId}`,
    'waterfall_id=d',
    'composer_entry_point_ref=group',
    'composer_work_shared_draft_mode',
    'composer_dialog_version',
    'has_file_been_replaced=false',
    'supports_chunking=true',
    'upload_speed',
    'partition_start_offset=0',
    `partition_end_offset=${size}`,
    buildFbBaseParams(),
  ].join('&');

  LOG('Video finalize → video_id:', videoId);
  // v10.7: 60s timeout — finalize is a small acknowledgement request.
  const resp = await fetchWithTimeout(url, {
    method: 'POST', credentials: 'include',
    headers: {
      accept:         '*/*',
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  }, 60_000);
  const text = await resp.text();
  LOG('Video finalize status:', resp.status, '| response:', text.slice(0, 200));

  const parsed = parseFbJson(text) || (() => { try { return JSON.parse(text); } catch(_){return null;} })();
  if (!parsed?.payload) throw new Error(`Video finalize failed: ${text.slice(0, 150)}`);
  // FB sometimes returns a populated payload that nonetheless carries an `error`
  // (e.g. transcoding_failed). Without this guard we'd log "Video finalize OK"
  // and return a broken video_id, then post would fire silently without the video.
  if (parsed.payload && typeof parsed.payload === 'object' && parsed.payload.error) {
    throw new Error(`Video finalize error from FB: ${typeof parsed.payload.error === 'string' ? parsed.payload.error : JSON.stringify(parsed.payload.error).slice(0, 120)}`);
  }
  LOG('Video finalize OK');
}

// ── Main video upload (4-step) ────────────────────────────────────────────────
async function uploadFbVideo(blob, groupId) {
  LOG(`Uploading video: ${blob.size} bytes, type: ${blob.type}`);

  const { chunkStartHost, resumableServiceName } = await getVideoUploadConfig();
  const videoId = await startVideoUploadSession(blob.size, chunkStartHost);
  const handle  = await uploadVideoBlob(blob, resumableServiceName);
  await finalizeVideoUpload(handle, videoId, chunkStartHost, blob.size);

  LOG('Video upload complete, id:', videoId);
  return { video: { id: String(videoId), notify_when_processed: false } };
}

// v10.5 (2026-05-02): re-upload all media (images + videos) from MediaDB or
// snapshot, returning fresh attachment objects with new FB upload IDs.
//
// Used by the tier-1 auto-retry path in dispatchPost: when FB rejects a
// video+text post with 1675012 (REQUEST_INVALID) or 3809006 (GROUP_BLOCKED),
// we first try re-uploading the media (fresh video_id, fresh photo upload_id)
// before falling back to the v10.4 text-only retry.
//
// Why: hypotheses we want to test —
//   1. Stale video_id between upload start and GraphQL post (token race)
//   2. FB invalidates the upload reference after a rejected POST
//   3. FB's per-upload_id anti-spam state — fresh ID may pass
//
// Returns an array of attachments. On per-item failure (e.g., one of two
// videos can't be re-uploaded), the rest still go through. Returns []
// if media cannot be retrieved at all — caller falls through to tier 2.
async function refreshMediaAttachments(job, groupId) {
  const fresh = [];
  if (job.snapshotId) {
    try {
      const snapshot = await getSnapshotById(job.snapshotId);
      // v53 Image Sets — re-upload ONLY the chosen set's items (match by `.key`,
      // in set order), mirroring the primary snapshot path so a tier-1 retry
      // sends the SAME media as the first attempt (idempotence-consistent).
      const _allItems = (snapshot && Array.isArray(snapshot.items)) ? snapshot.items : [];
      const _items = (Array.isArray(job.chosenSetItemIds) && job.chosenSetItemIds.length > 0)
        ? job.chosenSetItemIds.map((k) => _allItems.find((it) => it && it.key === k)).filter(Boolean)
        : _allItems;
      for (const item of _items) {
        // v10.7: bail mid-loop on stop — caller sees partial array and falls through
        if (await _checkStopFlag()) {
          LOG('🛑 Stop detected during re-upload (snapshot) — bailing with', fresh.length, 'items');
          return fresh;
        }
        if (!item?.value?.blob) continue;
        // Defensive: type might be missing/non-string in corrupt snapshots.
        // Coerce to string so .startsWith never throws.
        const itemType = typeof item.value.type === 'string' ? item.value.type : '';
        try {
          if (itemType.startsWith('image'))
            fresh.push(await _withUploadRetry('image re-upload', () => uploadFbPhoto(item.value.blob)));
          else if (itemType.startsWith('video'))
            fresh.push(await uploadFbVideo(item.value.blob, groupId || fbSession.actorId));
        } catch (e) { ERR('Media re-upload (snapshot):', e.message); }
      }
    } catch (e) { ERR('Snapshot lookup for re-upload failed:', e.message); }
  } else {
    let db;
    try {
      db = await _idbWithTimeout(openMediaDB(), IDB_OPEN_TIMEOUT_MS, 'openMediaDB'); // v76: bound DB-open
      for (const id of job.imageIds || []) {
        // v10.7: stop check between uploads
        if (await _checkStopFlag()) {
          LOG('🛑 Stop detected during photo re-upload — bailing with', fresh.length, 'items');
          break;
        }
        try {
          const blob = await _idbWithTimeout(getBlobById(db, id), IDB_READ_TIMEOUT_MS, 'getBlobById'); // v76: bound the local IDB read (generous — never trips a legit large blob)
          if (blob) fresh.push(await _withUploadRetry('image re-upload', () => uploadFbPhoto(blob)));
        } catch (e) { ERR('Photo re-upload', id, ':', e.message); }
      }
      for (const id of job.videoIds || []) {
        if (await _checkStopFlag()) {
          LOG('🛑 Stop detected during video re-upload — bailing with', fresh.length, 'items');
          break;
        }
        try {
          const blob = await _idbWithTimeout(getBlobById(db, id), IDB_READ_TIMEOUT_MS, 'getBlobById'); // v76: bound the local IDB read (generous — never trips a legit large blob)
          if (blob) fresh.push(await uploadFbVideo(blob, groupId || fbSession.actorId));
        } catch (e) { ERR('Video re-upload', id, ':', e.message); }
      }
    } catch (e) {
      ERR('MediaDB open for re-upload failed:', e.message);
    } finally {
      try { db && db.close(); } catch (_) {}
    }
  }
  return fresh;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 6 — Protection helpers
// ═══════════════════════════════════════════════════════════════════════════════

// ── Login Verification ────────────────────────────────────────────────────────
// HEAD request to /me — if Facebook redirects to login, session is expired.
async function verifyFbLogin() {
  try {
    // 10s timeout: this per-post liveness check ran with a bare fetch() and no
    // timeout — a network black-hole here would hang dispatchPost (and thus the
    // SW's sendToWorker await) indefinitely. On timeout the catch below fails
    // open (return true) and lets the real post mutation surface any error.
    const resp = await fetchWithTimeout('https://www.facebook.com/me', {
      method: 'HEAD', credentials: 'include', redirect: 'manual',
    }, 10_000);
    // Manual redirect: status 0 or 3xx with location containing "login"
    const loc = resp.headers?.get?.('location') || '';
    if (resp.type === 'opaqueredirect' || loc.includes('login') || loc.includes('checkpoint')) {
      throw new Error('Facebook session expired — please log in');
    }
    return true;
  } catch (e) {
    if (e.message.includes('login') || e.message.includes('checkpoint')) throw e;
    return true; // network error — assume still logged in, let the actual request fail
  }
}

// ── Error Classification ──────────────────────────────────────────────────────
// Returns { type, stop } — type: CRITICAL / AUTH / SOFT / WARNING / UNKNOWN
// ── Numeric-code classification (language-independent) ──────────────────────
// Facebook returns BOTH a numeric code and a human message; the message is
// localised. Every branch below this table matched English phrases, so a French
// customer's "Votre demande n'a pas pu être traitée" fell through to UNKNOWN —
// and shouldFastDomFailover only fails over on GROUP_BLOCKED / REQUEST_INVALID,
// so UNKNOWN meant no failover and the post was simply lost. Measured on one
// customer, same day: 11:50 classified UNKNOWN → 0 posted; 15:32 the identical
// error classified REQUEST_INVALID → 4 recovered via Safe.
//
// The code was already being captured (parseStoryResponse sets `fbErrorCode`)
// and already being LOGGED at the call site — it just never reached the
// classifier. This table is consulted first; the English phrase matching below
// stays exactly as it was, as the fallback for responses that carry no code.
//
// 🪤 1390008 and 1404078 keep stop:true — they are account-level blocks and
// stopping is deliberate. Do not "harmonise" them with the per-group codes.
// `note` carries the SAME operator guidance the English text branches below
// already print. Without it the code path would classify correctly and then say
// only "code X → TYPE", silently dropping the "what do I do about it" half —
// which is precisely the failure this whole round is about. Both paths now emit
// identical advice, so they cannot drift.
const FB_ERROR_CODE_MAP = {
  '1390008': { type: 'CRITICAL',        stop: true,  note: '  → code 1390008 → RATE_LIMITED (account-level action block): Facebook is throttling how often this account can post (anti-spam). The campaign STOPS — rest the account 24–48h, then post FEWER groups, SLOWER. Continuing now deepens the block.' },
  '1404078': { type: 'CRITICAL',        stop: true,  note: '  → code 1404078 → ACCOUNT RESTRICTED: Facebook has restricted this account (not a per-group block). The campaign STOPS. Continuing would deepen the restriction — rest the account and check facebook.com for a notice/appeal.' },
  '3809006': { type: 'GROUP_BLOCKED',   stop: false, note: '  → code 3809006 → GROUP_BLOCKED (per-group, campaign continues). NOTE: if EVERY group returns this, it is NOT a per-group block — it is an account/request-level rejection → rest the account 24–48h or switch to Safe Mode (DOM). Use Run Diagnostic to confirm account vs group.' },
  '1675012': { type: 'REQUEST_INVALID', stop: false, note: '  → code 1675012 / missing_required_variable_value → REQUEST_INVALID = SCHEMA DRIFT: Facebook changed a required field on this mutation → the app needs a variables/doc_id compatibility update (this is NOT an account block, and NOT GROUP_BLOCKED). Campaign continues; see [1675012-debug] for the full vars. Safe Mode (DOM) is unaffected.' },
  '1373034': { type: 'SOFT',            stop: false },  // insufficient permission for the specified Page
};

function classifyFbErrorCode(code) {
  const c = String(code == null ? '' : code).trim();
  if (!c) return null;
  if (FB_ERROR_CODE_MAP[c]) return { ...FB_ERROR_CODE_MAP[c], code: c };
  // 1357006 / 1357032 and neighbours — FB-side "Something went wrong", transient.
  // Matches the range the text branch below already covers.
  if (/^13570[0-3][0-9]$/.test(c)) return { type: 'WARNING', stop: false, code: c };
  return null;
}

// `context.fbCode` (optional) is Facebook's own numeric error code. When
// present it decides the classification and the localised message is not
// consulted at all.
function categorizeFbError(errorText, context) {
  // v2026-10-14 · 1349016 ("Invalid Parameter", field_exception) for a post made AS A PAGE: Facebook will not
  // take a post from this Page in this group. Seen live: the Page was not a member (as the Page, the group page
  // says "This content isn't available"), while the identical request from a group the Page belongs to matched
  // Facebook's own Page request field for field. It used to be UNKNOWN with the bare text "Invalid Parameter".
  if (context && context.actingAsPage && String(context.fbCode == null ? '' : context.fbCode).trim() === '1349016') {
    WARN('  → code 1349016 as a Page → GROUP_BLOCKS_PAGES: Facebook would not take a post from this Page in this group — usually the Page is not a member, or the group does not take posts from Pages. Join as the Page, or post as yourself. [matched by NUMERIC CODE — language-independent]');
    return { type: 'GROUP_BLOCKS_PAGES', stop: false };
  }
  const _byCode = classifyFbErrorCode(context && context.fbCode);
  if (_byCode) {
    // Same advice the text branch would have given, plus a marker that the
    // classification came from the code so a support reader knows the localised
    // message played no part in it.
    WARN(_byCode.note
      ? `${_byCode.note}  [matched by NUMERIC CODE ${_byCode.code} — language-independent]`
      : `  → FB code ${_byCode.code} → ${_byCode.type} (matched by NUMERIC CODE — language-independent)`);
    return { type: _byCode.type, stop: _byCode.stop };
  }
  // String() coercion: pre-existing fragility found in QA. `(x || '')` still
  // hands a NUMBER straight to .toLowerCase(), which throws — inside the one
  // function that decides whether a campaign stops or continues. No behaviour
  // change for the strings it actually receives today; String() on a string is
  // identity. It just cannot crash the posting loop any more.
  const e = String(errorText || '').toLowerCase();
  // Word-boundaried phrases that unambiguously come from FB's action-block/rate-limit
  // path. Tightened to avoid matching friendly copy like "You cannot edit this post
  // now" or generic network errors that happen to contain "rate" / "restricted".
  if (/\bratelimit\b|\brate[- ]limit\b|\btemporarily restricted\b|\bcan't post right now\b|\baccount (has been )?restricted\b|\baction blocked\b|\byou can't post right now\b|\byou'?re temporarily blocked\b|\byou'?re posting too (fast|quickly)\b|\bgoing too fast\b|\bblocked from (posting|commenting)\b|\bthis (action|feature) has been (temporarily )?blocked\b|\bslow down,? you'?re posting\b/.test(e))
    return { type: 'CRITICAL', stop: true };
  // v85: FB error code 1390008 / "You Can't Use This Feature Right Now" (api_error_code
  // 368) is FB's canonical action-block / posting-rate-limit — "we limit how often you
  // can post… to protect the community from spam", allow_user_retry:false, carries the
  // sentry_block enforcement payload. It is ACCOUNT-LEVEL frequency throttling (NOT
  // per-group like 3809006), so continuing to post only deepens the block. Classify it
  // with the rate-limit phrases above (CRITICAL → stop) so the campaign halts and the
  // account is rested, instead of slipping into the generic spam-WARNING bucket (which
  // let it keep hammering). A dedicated branch so the log NAMES the code, not "CRITICAL".
  if (/code["\s:]*1390008|\byou can'?t use this feature right now\b|\bwe limit how often you can post\b/i.test(errorText || '')) {
    WARN('  → code 1390008 → RATE_LIMITED (account-level action block): Facebook is throttling how often this account can post (anti-spam). The campaign STOPS — rest the account 24–48h, then post FEWER groups, SLOWER. Continuing now deepens the block.');
    return { type: 'CRITICAL', stop: true };
  }
  // v77: code 1404078 / "Your account is restricted". Found in real customer logs
  // (3 occurrences) while auditing language dependence — and it was classified
  // UNKNOWN with stop:false, so the campaign kept posting into a restricted
  // account, which is precisely what deepens a block.
  //
  // Why the existing rate-limit branch above missed it: that branch matches
  // "account restricted" / "account has been restricted", and Facebook's actual
  // wording is "account IS restricted" — one word apart. The numeric code is the
  // reliable half; the phrase is the English-only fast path, kept in the same
  // shape as its neighbours.
  //
  // ACCOUNT-level, like 1390008 (not per-group like 3809006) → stop the campaign.
  if (/code["\s:]*1404078|\byour account is restricted\b|\baccount is restricted\b/i.test(errorText || '')) {
    WARN('  → code 1404078 → ACCOUNT RESTRICTED: Facebook has restricted this account (not a per-group block). The campaign STOPS. Continuing would deepen the restriction — rest the account and check facebook.com for a notice/appeal.');
    return { type: 'CRITICAL', stop: true };
  }
  // 2026-05-01 refinement (v9.5): code 3809006 / "feature isn't available"
  // is FB's catch-all PER-GROUP rejection. Same user can post fine to one
  // group and get this for another. Treating it as CRITICAL stop-campaign
  // was wrong — it killed multi-group campaigns when only ONE group had a
  // restriction. Verified by user log: group 1 succeeded, group 2 returned
  // 3809006, campaign halted unnecessarily.
  // Always SOFT: skip this group, continue to next. The user sees a clear
  // per-group failure in PostProgressSummary.
  if (/\bfeature isn'?t available\b|code["\s:]*3809006|\bsorry,? this feature isn'?t available\b|\bthis content isn'?t available right now\b/i.test(errorText || '')) {
    WARN('  → code 3809006 → GROUP_BLOCKED (per-group, campaign continues). NOTE: if EVERY group returns this, it is NOT a per-group block — it is an account/request-level rejection → rest the account 24–48h or switch to Safe Mode (DOM). Use Run Diagnostic to confirm account vs group.');
    return { type: 'GROUP_BLOCKED', stop: false };
  }
  // FB's anti-bot heuristics phrase set — vague enough that retry is dangerous.
  if (/\bsuspicious activity\b|\bunusual activity\b|\bbot[- ]?detection\b|\bautomation detected\b/i.test(errorText || ''))
    return { type: 'CRITICAL', stop: true };
  if (/\bplease log in\b|\bnot logged in\b|\bsession (has )?expired\b|\bcheckpoint_required\b|\blogin_required\b|\btwo[- ]?factor\b|\bconfirm your identity\b|\bverify your identity\b|\baccount (is|has been) (temporarily )?locked\b|\blog in to facebook to continue\b/.test(e))
    return { type: 'AUTH', stop: true };
  if (/\bpermission\b|\bdoes_not_have_permission\b|\bnot allowed\b|\bonly members can post\b|\bposting (is|has been) turned off\b|\bcomments are turned off\b|\bthis group (is|has been) (archived|disabled)\b|\bgroup (no longer exists|isn'?t available)\b/.test(e))
    return { type: 'SOFT', stop: false };
  if (/\bspam\b|\bmarked_as_spam\b|\bduplicate\b|\blooks like spam\b|\bflagged as spam\b|\bsimilar to (a )?(post|content) that was (removed|reported)\b|\byou'?ve already (posted|shared) this\b/.test(e))
    return { type: 'WARNING', stop: false };
  // FB error code 1357006/1357032 = "Something went wrong" / internal —
  // transient. Don't escalate to CRITICAL but mark as WARNING so the retry
  // queue still knows it's a known FB-side issue rather than a network
  // blip. 1357032 was added 2026-05-01 after observing it in user logs
  // when posting duplicate-content rapidly.
  if (/code["\s:]*135700[0-9]|code["\s:]*135703[0-9]|\binternal[_ ]error\b|\bsomething went wrong\b/i.test(errorText || ''))
    return { type: 'WARNING', stop: false };
  // FB error code 1373034 = "Insufficient Permission for the specified Page"
  // — happens when actor_id doesn't match FB session active actor.
  // After v7 fix this shouldn't happen, but keep the classification just
  // in case (treat as SOFT — per-call, not account-wide).
  if (/code["\s:]*1373034|\binsufficient permission\b/i.test(errorText || ''))
    return { type: 'SOFT', stop: false };
  // v10.3 (2026-05-01): code 1675012 "Your Request Couldn't be Processed"
  // is FB rejecting our request shape — `missing_required_variable_value`
  // with `is_final: true`. Observed in multi-post campaigns even with
  // text-only posts (no media), making the previous MEDIA_BLOCKED
  // classification wrong. Reclassify as REQUEST_INVALID — the campaign
  // continues, but the failure is logged so we can diff variables across
  // success vs fail attempts and find what's missing.
  if (/code["\s:]*1675012|\byour request couldn'?t be processed\b/i.test(errorText || '')) {
    WARN('  → code 1675012 / missing_required_variable_value → REQUEST_INVALID = SCHEMA DRIFT: Facebook changed a required field on this mutation → the app needs a variables/doc_id compatibility update (this is NOT an account block, and NOT GROUP_BLOCKED). Campaign continues; see [1675012-debug] for the full vars. Safe Mode (DOM) is unaffected.');
    return { type: 'REQUEST_INVALID', stop: false };
  }
  return { type: 'UNKNOWN', stop: false };
}

// ── RUN DIAGNOSTIC (v1, fast-only) ────────────────────────────────────────────
// One-click self-test for support: runs ONE real fast (GraphQL) test post to the first synced group
// (labeled "diagnostic test — please ignore"), captures Facebook's response, classifies it with
// categorizeFbError, and returns a structured + human report the customer can Download/Copy and send
// to the owner — no DevTools needed. Answers "is my ACCOUNT blocked, or is FB rejecting the app's
// request (schema drift)?". CWS-safe: the extension's OWN posting path + diagnostic metadata only
// (no interception, no new permissions). If the test post succeeds, the user deletes it (auto-delete
// is a v2 add once the delete-story doc_id is captured).
// v82: a TRANSIENT FB error (code 1357xxx "Something went wrong / try again",
// or generic "temporary") is NOT an account block — it's a retryable hiccup.
// The diagnostic must retry on these before declaring failure, otherwise it
// FALSE-FAILS (real posting works fine — confirmed: code 1357032 fired on an
// account whose normal posting is healthy). Pure + testable.
function isTransientFbError(text) {
  return /1357\d{3}|something went wrong|try (again|refreshing)|temporar(y|ily)/i.test(String(text || ''));
}

/**
 * v2026-10-01 · The diagnostic's test group: the first synced group that is NOT a known buy & sell group —
 * from a profile Facebook takes only listings there, so its 3809006 would read as an account-wide block.
 * `types` = the worker's `_groupTypes` ({ [id-or-slug]: { t } }). Pure. Falls back to the first group.
 */
// v2026-10-12 · a customer's diagnostic tested in "Pasco Area Wedding Things" — a buy & sell group whose type
// was not known yet — got 1357006 twice and reported "Fast posting failed", while his account was fine. Facebook's
// own list of groups that take LISTINGS (`listingIds`, the worker's _listingGroups.ids) now marks a group as
// suspect too: the test goes to the first group known to be ordinary, else the first not on that list, else the
// first not known to be buy & sell, else the first.
function pickDiagnosticGroupUrl(groups, types, listingIds) {
  const list = Array.isArray(groups) ? groups : [];
  const T = (types && typeof types === 'object') ? types : {};
  const L = new Set((Array.isArray(listingIds) ? listingIds : []).map((x) => String(x).toLowerCase()));
  const keyOf = (u) => { const m = /\/groups\/([^/?#]+)/i.exec(String(u || '')); return m ? m[1].toLowerCase() : null; };
  const typeOf = (g) => (T[keyOf(g.url)] || {}).t;
  const usable = list.filter((g) => g && g.url);
  const pick = usable.find((g) => typeOf(g) && typeOf(g) !== 'BUY_AND_SELL')
    || usable.find((g) => !typeOf(g) && !L.has(keyOf(g.url)))
    || usable.find((g) => typeOf(g) !== 'BUY_AND_SELL')
    || list[0];
  return (pick && pick.url) || null;
}

async function mgpRunDiagnostic(opts) {
  opts = opts || {};
  const rep = { ok: true, timestamp: Date.now() };
  const add = (s) => { try { LOG('[diag]', s); } catch (e) {} };
  let version = '?';
  try { version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?'; } catch (e) {}
  const mode = (fbSession.actorId && fbSession.uid && String(fbSession.actorId) !== String(fbSession.uid)) ? 'PAGE' : 'personal';
  rep.identity = { uid: fbSession.uid || null, actorId: fbSession.actorId || null, mode, hasTokens: !!(fbSession.dtsg && fbSession.uid) };
  rep.environment = { extensionVersion: version, docIds: { ...FB_DOC_IDS } };
  add('identity uid=' + (fbSession.uid || '?') + ' mode=' + mode + ' · ext v' + version);
  // Pick a test group (first synced) unless one was passed in.
  let groupUrl = opts.groupUrl || null;
  try {
    if (!groupUrl) {
      const st = await chrome.storage.local.get(['joinedFacebookGroups', '_groupTypes', '_listingGroups']);
      const groups = Array.isArray(st.joinedFacebookGroups) ? st.joinedFacebookGroups : [];
      rep.groups = { syncedCount: groups.length };
      // v2026-10-01: never test in a known buy & sell group — from a profile Facebook takes only listings
      // there, so its 3809006 would read as "Facebook is blocking the FAST method on your account".
      groupUrl = pickDiagnosticGroupUrl(groups, st && st._groupTypes, st && st._listingGroups && st._listingGroups.ids);
    }
  } catch (e) {}
  if (!groupUrl) { rep.ok = false; rep.verdict = 'No synced groups — run "Find My Groups" first, then Run Diagnostic.'; add(rep.verdict); return rep; }
  rep.testGroupUrl = groupUrl;
  add('running a FAST test post → ' + groupUrl);
  // v82: UNIQUE + benign test text per attempt. The old fixed string
  // "diagnostic test — please ignore 🔧" is posted identically by every user of
  // this extension → Facebook learned it as spam and soft-blocks it specifically
  // (1357032 / 3809006), producing a FALSE "Fast posting failed" even when the
  // account's real posting is healthy. A unique, normal-looking message avoids
  // that pattern-match so the verdict reflects the ACCOUNT, not the test string.
  const _mkTestText = () => {
    let n = '';
    try { n = String(Math.floor(Math.random() * 9000) + 1000); } catch (e) { n = String((Date.now() % 9000) + 1000); }
    return 'Quick setup check ' + n;
  };
  // v82: retry once on a TRANSIENT FB error (1357xxx "try again") before declaring
  // failure — a transient hiccup must not read as an account block. Each attempt
  // uses fresh unique text, so a retry can never duplicate a post that landed.
  let r = {};
  let attempts = 0;
  const MAX_DIAG_ATTEMPTS = 2;
  while (attempts < MAX_DIAG_ATTEMPTS) {
    attempts++;
    try {
      let sid = null; try { sid = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ('diag-' + Date.now()); } catch (e) { sid = 'diag-' + Date.now(); }
      r = await dispatchPost({
        groupUrl,
        text: _mkTestText(),
        imageIds: [], videoIds: [],
        textFormatPresetId: '0',
        composerSessionId: sid,
        tokens: (fbSession.dtsg && fbSession.uid) ? { ...fbSession } : undefined,
      });
    } catch (e) {
      r = { success: false, error: (e && e.message) ? e.message : String(e), errorType: 'EXCEPTION' };
    }
    r = r || {};
    const _try = String(r.error || '') + ' ' + String(r._rawSample || '');
    if (r.success || !isTransientFbError(_try)) break; // definitive result (success or non-transient error)
    if (attempts < MAX_DIAG_ATTEMPTS) {
      add('transient FB error — retrying once');
      await new Promise((res) => setTimeout(res, 2500));
    }
  }
  rep.attempts = attempts;
  rep.fast = { success: !!r.success, id: r.id || r.postId || null, error: r.error || null, errorType: r.errorType || null, fbErrorCode: r.fbErrorCode || null, raw: String(r._rawSample || '').slice(0, 500) };
  const _txt = String(r.error || '') + ' ' + String(r._rawSample || '');
  if (r.success) {
    rep.verdict = '✅ Fast posting WORKS on this account — everything healthy. (Please delete the test post in the group.)';
  } else if (/missing_required_variable_value|\b1675012\b/i.test(_txt)) {
    rep.verdict = '🔄 Facebook changed a required field (SCHEMA DRIFT) → the app needs a compatibility update. Your account is fine. Use Safe Mode meanwhile.';
  } else if (/\b3809006\b|feature isn.?t available/i.test(_txt)) {
    rep.verdict = '⚠️ Facebook is blocking the FAST method on your account (3809006). Switch to Safe Mode (DOM), or rest the account 24–48h. Manual posting still works.';
  } else if (isTransientFbError(_txt)) {
    // NOT an account block — a temporary FB error (it even says "try again").
    rep.verdict = '⏳ Facebook returned a TEMPORARY error (e.g. 1357032 "Something went wrong"). This is transient — it does NOT mean your account is blocked, and your normal posting is likely fine. Wait a minute and run it again, or just post as usual.';
  } else {
    let cat = { type: r.errorType || 'UNKNOWN' };
    try { cat = categorizeFbError(r.error || r._rawSample || '', { diagnostic: true, fbCode: r.fbErrorCode }) || cat; } catch (e) {}
    rep.fast.classified = cat.type;
    rep.verdict = (cat.type === 'AUTH')
      ? '🔑 Session/login issue — re-authenticate in Facebook (log in / pass 2FA), then retry.'
      : '❌ Fast posting failed (' + cat.type + '). ' + (r.error ? String(r.error).slice(0, 140) : '');
  }
  add('verdict: ' + rep.verdict);
  return rep;
}
if (typeof window !== 'undefined') { try { window.mgpRunDiagnostic = mgpRunDiagnostic; } catch (e) {} }

// ── URL Safety Trick ──────────────────────────────────────────────────────────
// If text ends with a URL, append " *" (space + asterisk).
// Prevents Facebook's duplicate-link spam detection.
// ⛔ REMOVED 2026-08-30 — the ' *' url-safety marker.
// It appended a space and an asterisk to any post whose text ended with a link,
// to dodge Facebook's "ends-with-link" spam heuristic. Liran removed it: it was
// visible to every reader at the end of real posts, and the competitor ships no
// such marker at any tier. Do not reintroduce it without deciding that trade
// again — the cost was cosmetic, on the customer's own post.

// ── Link Preview Scrape ──────────────────────────────────────────────────────
// Posts with a URL but no media render as raw URL text unless we attach a
// scraped preview. FB's real composer calls a preview query on paste; we
// replicate the exact variable shape the competitor's extension uses, then
// push the returned share_scrape_data into the attachments array.
// Returns the first http(s) URL in the text, or null.
// 🔑 Our own attribution line carries a scheme now (parity with the competitor's).
// Naming the url on the job is what makes that safe — this is the belt for the
// day a path forgets to name one, because that failure is SILENT: the card would
// quietly become our own page in every group instead of the shared post.
// 🪤 Keyed on the ORIGIN, never on the path: the path moved once already
// (/share 404s on the live site) and a skip that silently stops matching is
// indistinguishable from no skip at all.
const MGP_OWN_ATTRIBUTION_URL = /^https?:\/\/(www\.)?multiplegroupposter\.com(\/|$)/i;

// v2026-09-30 · A WhatsApp link written WITHOUT https:// ("wa.me/972…") is not a link to
// Facebook. Captured live twice: Facebook's own composer skipped "wa.me/972500000000" on a
// line of its own and made its preview from the https://wa.me/… link after it — so a
// customer's "WhatsApp: wa.me/…" could never be clicked, in either mode or even posted by
// hand. With the scheme it is a link. Only WhatsApp's own hosts (+ wa.link), only where the
// address starts a word, and never twice: "https://wa.me/…" is left exactly as it is.
// ⚠️ mgp-content.js carries the same function for Safe — keep the two identical.
const _MGP_BARE_WA_RE = /(^|[\s(>"'“«:;,‎‏‪-‮])((?:wa\.me|wa\.link|(?:api|chat|web)\.whatsapp\.com)\/[^\s<>"']*)/gi;
function addSchemeToBareWhatsAppLinks(text) {
  if (text == null) return text;
  return String(text).replace(_MGP_BARE_WA_RE, (m, pre, link) => pre + 'https://' + link);
}

function extractFirstUrl(text, skipRe) {
  if (!text) return null;
  // v2026-10-14 · invisible characters end a link too: the worker glues a zero-width space to a link that ends the post
  // (keepTrailingLinkVisible — always on now), and Facebook was asked to preview "https://…\u200B".
  const all = String(text).match(/https?:\/\/[^\s<>"'\u200B-\u200D\u2060\uFEFF\u3164]+/gi);
  if (!all) return null;
  for (const raw of all) {
    const url = raw.replace(/[),.;!?]+$/, '');
    if (skipRe && skipRe.test(url)) continue;
    return url;
  }
  return null;
}

/**
 * The card data out of a ComposerLinkAttachmentPreviewQuery answer: `{ scrape, multipart }`,
 * `scrape` null when the answer is valid but previews nothing. Throws when nothing in it is JSON.
 *
 * 🔴 v2026-09-15: one JSON.parse over the whole answer. Facebook sends GraphQL as NDJSON
 * when a query has deferred parts — parseStoryResponse below splits lines for exactly
 * that — and may prefix `for (;;);`. 1.2.9.56: 208 `query_failed` from 7 users, every one
 * a facebook.com post link (a share; external links never failed), 157 groups posted as a
 * bare link. Each line is read on its own; the first carrying link_preview wins.
 * `multipart` says the answer came in parts — with no card that may be a cut stream rather
 * than an empty preview, so the caller reports it apart.
 */
function parseLinkPreviewResponse(raw) {
  const body = String(raw == null ? '' : raw).replace(/^\s*for \(;;\);/, '');
  let parsedAny = false;
  let firstErr = null;
  const tryOne = (chunk) => {
    try {
      const json = JSON.parse(chunk);
      parsedAny = true;
      return json?.data?.link_preview?.share_scrape_data || null;
    } catch (e) {
      if (!firstErr) firstErr = e;
      return null;
    }
  };
  const whole = tryOne(body);
  if (whole) return { scrape: whole, multipart: false };
  if (parsedAny) return { scrape: null, multipart: false };
  for (const line of body.split('\n')) {
    const t = line.trim().replace(/^for \(;;\);/, '');
    if (!t) continue;
    const hit = tryOne(t);
    if (hit) return { scrape: hit, multipart: true };
  }
  if (!parsedAny) throw firstErr || new Error('link preview: empty answer');
  return { scrape: null, multipart: true };
}

async function scrapeLinkPreview(url) {
  if (!url) return null;
  const variables = {
    feedLocation:                   'FEED_COMPOSER',
    focusCommentID:                 null,
    goodwillCampaignId:             '',
    goodwillCampaignMediaIds:       [],
    goodwillContentType:            null,
    params:                         { url },
    privacySelectorRenderLocation:  'COMET_COMPOSER',
    renderLocation:                 'composer_preview',
    parentStoryID:                  null,
    scale:                          1,
    useDefaultActor:                false,
    shouldIncludeStoryAttachment:   false,
    __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider:                       false,
    __relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider:                                false,
    __relay_internal__pv__IsWorkUserrelayprovider:                                                  false,
    __relay_internal__pv__CometFeedStoryDynamicResolutionPhotoAttachmentRenderer_experimentWidthrelayprovider: 500,
    __relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider:                   false,
    __relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider:                               false,
    __relay_internal__pv__IsMergQAPollsrelayprovider:                                               false,
    __relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider:               true,
    __relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider:                true,
  };

  // 🔴 2026-08-29: this used to build its OWN candidate list as
  //     [ FB_DOC_IDS.X || '26986…', '24010…' ]
  // The `||` is the bug. The remote config MUTATES FB_DOC_IDS in place
  // (applyDocIdConfig above), so a stale server value is truthy — the built-in
  // id we shipped and know works is then UNREACHABLE, and a share silently goes
  // out as a bare URL with no card. Measured against the competitor: its
  // worker.js CONCATENATES `[remote, ...builtins]` and walks all of them.
  //
  // fetchGraphQL already implements exactly that walk, plus FB_DOC_IDS_BUILTIN
  // as the last resort and auto-promotion of whichever id wins. Use it.
  try {
    const raw   = await fetchGraphQL(null, 'ComposerLinkAttachmentPreviewQuery', variables);
    const parsed = parseLinkPreviewResponse(raw);
    const scrape = parsed.scrape;
    if (scrape) {
      LOG('  link preview scraped — url:', url);
      return scrape; // stringified JSON blob
    }
    // A valid doc_id that simply has nothing to preview. Not a doc_id failure —
    // fetchGraphQL cannot see this, so it is reported here. A MULTI-PART answer with no
    // card may be a cut stream, not an empty preview — reported apart so it stays visible.
    _reportLinkPreviewMiss(url, parsed.multipart ? 'no_scrape_data_multipart' : 'no_scrape_data');
  } catch (e) {
    WARN('  link preview failed:', e.message);
    // v2026-09-13: pass the error THROUGH. `reason:'query_failed'` alone said the
    // preview failed but never why, so 9 events across 2 users could not be told
    // apart: a rotated/dead doc_id, a rejected request, and a network blip all
    // reported identically. The message is what separates them.
    _reportLinkPreviewMiss(url, 'query_failed', e);
  }
  return null;
}

/**
 * A missing link preview used to be a single LOG line — invisible in Sentry and
 * invisible to the user. For a normal post that is a cosmetic downgrade; for a
 * SHARE it means the whole feature silently degraded to posting a naked URL,
 * which is exactly the complaint that sent us looking. The competitor surfaces
 * this to its user ("Link preview unavailable, using plain link"); we surface it
 * to telemetry so it is measurable across the install base.
 */
function _reportLinkPreviewMiss(url, reason, err) {
  LOG('  link preview unavailable (' + reason + ') — falling back to plain URL text');
  try {
    const isInternal = /^https:\/\/([a-z-]+\.)?facebook\.com\//i.test(String(url || ''));
    engineSentryError('link-preview-unavailable', {
      reason,
      internal: isInternal,          // an internal permalink is a SHARE — far worse
      docId: FB_DOC_IDS.ComposerLinkAttachmentPreviewQuery || null,
      builtin: FB_DOC_IDS_BUILTIN.ComposerLinkAttachmentPreviewQuery || null,
      // The discriminator. Our own fetch layer's message (never page content),
      // capped so a long GraphQL error body cannot ride along.
      why: err ? String(err.message || err).slice(0, 140) : null,
    });
  } catch (_) { /* telemetry must never break a post */ }
}


// ── First Comment ─────────────────────────────────────────────────────────────
// 🔴 v2026-09-26 · the id of the comment Facebook MADE, or null. The old test matched the bare
// field name `comment_create` — and Facebook's refusal carries that field too, set to null
// ("comment_create":null), so a refused comment could be counted as sent. Now a comment counts
// only when the reply carries the comment itself: a non-null comment_create AND the comment's id
// (legacy_fbid, or its "comment:"-prefixed base64 node id). GPP 2.10.45 reads the id the same way.
// 🪤 No literal brace characters in the patterns below — the test harness slices functions by
// brace-matching (see _isDocIdError); `(?!null)` says "present and not null" without one.
function createdCommentId(raw) {
  const s = String(raw || '');
  if (!/"comment_create"\s*:\s*(?!null)/.test(s)) return null;
  const fbid = (s.match(/"legacy_fbid"\s*:\s*"(\d+)"/) || [])[1];
  if (fbid && fbid !== '0') return fbid;
  const node = (s.match(/"id"\s*:\s*"(Y29tbWVudDo[A-Za-z0-9+\/=_-]+)"/) || [])[1];
  return node || null;
}

// v2026-10-23 · ONE right-after comment per Facebook post, whatever delivers the post job again.
// A customer: "a delay in posting a comment under the post and then it posts 3 times the same comment". The comment rides
// inside the post job; when the engine goes quiet during its 15–45 s wait (a sleeping Mac, a frozen tab), the worker sends
// the same job again (up to 3 tries), then the retry queue sends it again, and a resumed run after the Mac wakes sends it
// again. The post itself is deduped by Facebook (same idempotence token → the same post id); the comment is not. So the
// engine writes a mark per post id RIGHT BEFORE it sends the comment, in storage that outlives its tab, and an engine that
// finds the mark does not send it again. A job whose first engine died before commenting still comments once (no mark).
// Storage that cannot answer in 5 s does not block the comment (the behaviour before this fix).
async function claimRightAfterComment(postId) {
  const key = CMT_ONCE_PREFIX + String(postId || '');
  if (!postId) return true;
  const within = (p) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('storage_timeout')), 5000); })]).finally(() => clearTimeout(t)); };
  try {
    const got = await within(chrome.storage.local.get(key));
    if (got && got[key]) return false;
    await within(chrome.storage.local.set({ [key]: Date.now() }));
  } catch (_) { /* storage unavailable — send as before */ }
  return true;
}

// Posts a comment on a story immediately after it's created.
// feedbackId = the numeric story ID returned by dispatchPost.
// Non-fatal: if the comment fails, the post is still counted as successful.
// Returns { posted: boolean, skipped?: string }. Never throws (auto-comment is
// always non-fatal to the campaign). The post-not-live detection here is the
// second line of defence — the caller already runs a pre-flight guard so we
// don't even reach this with a known-dead post; this catches the rarer race
// where the post is removed/blocked between create and comment.
async function postFbComment(feedbackId, text, opts = {}) {
  // v2026-09-23: `opts.photoBlob` — the comment's one photo (uploaded to /ajax/ufi/upload/ for THIS
  // post, see uploadFbCommentPhoto); `opts.clientMutationId` — the queue task's own id, so a retry of
  // the same task can never read as a second comment. A photo comment may have no text (Facebook's
  // own composer allows it — proven live 23-Sep).
  const _hasPhoto = !!(opts && opts.photoBlob);
  if (!feedbackId || (!text?.trim() && !_hasPhoto)) return { posted: false, skipped: 'no_target_or_text' };
  setStep('Adding first comment…');
  LOG('  posting first comment — feedbackId:', feedbackId, 'text:', String(text || '').slice(0, 60), _hasPhoto ? '| + photo' : '');
  // 2026-05-31: FB RETIRED the old CommentCreateMutation (doc_id 2861490773896583
  // → "The GraphQL document … was not found"). The CURRENT mutation is
  // useCometUFICreateCommentMutation, which expects a DIFFERENT variable shape:
  // an `input` wrapper with a base64 `feedback_id` ("feedback:<postId>"),
  // `actor_id`, and `client_mutation_id` — verified against FB's live composer +
  // competitor ihkd's working implementation. The old flat `{feedbackId, message,
  // tracking, feedLocation, feedbackSource}` shape no longer applies.
  let _feedbackB64;
  try {
    _feedbackB64 = (typeof btoa === 'function')
      ? btoa('feedback:' + feedbackId)
      : Buffer.from('feedback:' + feedbackId).toString('base64'); // node/test fallback
  } catch (_) {
    _feedbackB64 = null;
  }
  // v2026-09-23: the photo is uploaded first — the upload is bound to this post's feedback id,
  // so one photo in 50 groups is 50 uploads, each at its own comment's time.
  let _photoFbid = null;
  if (_hasPhoto) {
    try {
      _photoFbid = await uploadFbCommentPhoto(opts.photoBlob, _feedbackB64);
    } catch (e) {
      WARN('  comment photo upload failed —', e?.message || e);
      return { posted: false, skipped: e?.mgpUnreadable ? 'photo_unreadable' : 'photo_upload_failed' };
    }
    if (!_photoFbid) return { posted: false, skipped: 'photo_upload_failed' };
  }
  const variables = {
    input: {
      feedback_id: _feedbackB64,
      message: { ranges: [], text: addSchemeToBareWhatsAppLinks(String(text || '').trim()) },
      ...(_photoFbid ? { attachments: [{ media: { id: String(_photoFbid) } }] } : {}),
      actor_id: fbSession.actorId,
      // v66: a UNIQUE client_mutation_id. The old Math.random()*1e3 had only 1000 values,
      // so two comments in a campaign could collide on the same id and FB might swallow the
      // second as a duplicate. Tie it to the post's feedbackId + a random suffix → unique.
      // v2026-09-23: a queued comment passes its own stable id (the task id), so the same
      // task can never read as two different comments.
      client_mutation_id: (opts && opts.clientMutationId)
        ? String(opts.clientMutationId).slice(0, 64)
        : 'c_' + String(feedbackId) + '_' + Math.random().toString(36).slice(2, 10),
    },
    useDefaultActor: false,
    scale: 1,
  };
  try {
    const docId = FB_DOC_IDS.useCometUFICreateCommentMutation || '26917309061273360';
    // singleShot: sent once — a comment carries no token Facebook is known to dedupe on.
    const raw = await fetchGraphQL(docId, 'useCometUFICreateCommentMutation', variables, { singleShot: true });
    // Success = the reply carries the comment Facebook created (createdCommentId), not merely the
    // field name — the refusal envelope has "comment_create":null.
    const _createdId = createdCommentId(raw);
    if (_createdId) {
      const _commentId = /^\d+$/.test(_createdId) ? _createdId : null;
      // v2026-09-23: a photo comment counts as posted WITH its photo only when Facebook's reply
      // carries the photo we attached (measured live: it returns the fbid and "__typename":"Photo").
      // Created without it = posted, photo dropped — reported, never retried (a retry would duplicate).
      if (_photoFbid && !String(raw || '').includes(String(_photoFbid))) {
        WARN('  ⚠️ comment posted but Facebook did not keep its photo — not retrying (a retry would duplicate the comment)');
        return { posted: true, photoDropped: true, commentId: _commentId };
      }
      LOG('  ✅ comment posted' + (_photoFbid ? ' with its photo' : '') + ' — response snippet:', raw.slice(0, 160));
      return { posted: true, commentId: _commentId };
    }
    // Distinguish the REAL failure causes (don't blanket-call everything
    // "post not live" — that masked the dead-doc_id bug for months):
    if (/document with ID .* was not found|doc_?id .* not found/i.test(raw || '')) {
      WARN('  ❌ comment doc_id rejected by FB — useCometUFICreateCommentMutation may have rotated; will recover on next remote doc_id sync. Raw:', (raw || '').slice(0, 160));
      return { posted: false, skipped: 'comment_docid_stale' };
    }
    if (/isn'?t available|content isn'?t available|isn'?t currently available|post is pending|pending approval|requires_approval/i.test(raw || '')) {
      WARN('  comment skipped — post is not live (removed/pending/unavailable); not retrying');
      return { posted: false, skipped: 'post_not_live' };
    }
    // v2026-09-26: Facebook said no, in so many words — an error list and no comment. It did NOT
    // land, so this is a refusal, not "maybe posted"; and it is not retried either.
    if (/"comment_create"\s*:\s*null/.test(raw || '') && /"errors"\s*:\s*\[/.test(raw || '')) {
      WARN('  comment refused by Facebook — raw:', (raw || '').slice(0, 200));
      return { posted: false, skipped: 'comment_refused' };
    }
    // Unknown non-success — surface the raw so we can diagnose.
    WARN('  ⚠️ comment not confirmed created — raw:', (raw || '').slice(0, 200));
    return { posted: false, skipped: 'comment_unconfirmed' };
  } catch (e) {
    // 🔴 v2026-09-26 · three different failures, three different answers:
    //   429            → Facebook refused before creating anything — safe to try later, after a rest.
    //   after sending  → it may have landed (timeout, dropped connection, a 5xx): NEVER sent again.
    //   before sending → nothing left this computer — request_error, which the queue may retry.
    if (e && e.mgpRateLimited) {
      WARN('  comment not sent — Facebook is rate-limiting this account (HTTP 429)');
      return { posted: false, skipped: 'rate_limited' };
    }
    if (e && e.mgpMaybeSent) {
      WARN('  ⚠️ comment may have been posted (' + (e.message || 'no answer') + ') — not sending it again (a retry could duplicate it)');
      return { posted: false, skipped: 'comment_unconfirmed' };
    }
    ERR('  comment failed (non-fatal):', e.message);
    return { posted: false, skipped: 'request_error' };
  }
}

/**
 * v2026-09-23 — a first comment's photo. Facebook's own comment composer uploads to
 * `www.facebook.com/ajax/ufi/upload/` (NOT the post endpoint on upload.facebook.com) with
 * `source=19`, the actor as `av`/`profile_id`/`target_id`, and the post's base64 feedback id —
 * the upload is bound to that ONE post. Read from Facebook's code 22-Sep, proven live 23-Sep.
 * 🔴 From this extension page the request only succeeds with the Origin rewrite in
 * mgp-network-rules.json (rule 6); without it Facebook answers 1357004 (measured).
 * Returns the photo's fbid, or throws.
 */
async function uploadFbCommentPhoto(blob, feedbackB64) {
  const _unreadable = await detectUnreadableImage(blob);
  if (_unreadable) {
    const e = new Error(`media_unreadable_format: ${_unreadable}`);
    e.mgpUnreadable = true;
    throw e;
  }
  blob = await resizeImageIfOversized(blob);
  setStep('Uploading comment photo…');
  const qs = buildFbBaseParams() + '&' + new URLSearchParams({
    feedback_id: String(feedbackB64 || ''),
    profile_id:  String(fbSession.actorId || ''),
    source:      '19',
    target_id:   String(fbSession.actorId || ''),
  }).toString();
  const fd = new FormData();
  fd.append('file', blob, `comment_${Math.random().toString(36).slice(2, 10)}.jpg`);
  const resp = await fetchWithTimeout(
    `https://www.facebook.com/ajax/ufi/upload/?${qs}`,
    { method: 'POST', credentials: 'include', headers: { Accept: '*/*' }, body: fd },
    _uploadTimeoutFor(blob),
  ).catch((netErr) => {
    const e = new Error(`photo_upload_network: ${netErr && netErr.message ? netErr.message : netErr}`);
    e.mgpUploadNetwork = true;
    throw e;
  });
  if (!resp.ok) throw new Error(`Comment photo upload HTTP ${resp.status}`);
  const text = await resp.text();
  let fbid = null;
  try { fbid = JSON.parse(text.replace(/^\s*for \(;;\);/, ''))?.payload?.fbid || null; } catch (_) {}
  if (!fbid) fbid = (text.match(/"fbid"\s*:\s*"(\d+)"/) || [])[1] || null;
  if (!fbid || !/^\d+$/.test(String(fbid)) || String(fbid) === '0') {
    ERR('Comment photo upload response:', text.slice(0, 300));
    throw new Error('comment_photo_fbid_not_found');
  }
  LOG('Comment photo uploaded, fbid:', fbid);
  return String(fbid);
}

/**
 * v2026-09-23 — one queued comment (the worker's comment queue), sent as EXECUTE_COMMENT.
 * Never as anyone but the identity the post was made as: the worker switches to it first
 * (withPageActor) and this refuses if the session is someone else.
 */
async function dispatchComment(job) {
  _fbRateLimitHit = false;   // per dispatch — see _rateLimitError
  if (job.tokens?.dtsg && job.tokens?.uid) {
    Object.assign(fbSession, job.tokens);
    fbSession.lastRefresh = Date.now();
  } else {
    await ensureFbTokens();
  }
  if (!fbSession.actorId) return { posted: false, skipped: 'fb_tokens_unavailable' };
  if (job.actorId && String(fbSession.actorId) !== String(job.actorId)) {
    WARN('  queued comment NOT sent — session is', fbSession.actorId, 'but the post was made as', job.actorId);
    return { posted: false, skipped: 'identity_mismatch', sessionActor: String(fbSession.actorId) };
  }
  let photoBlob = null;
  if (job.imageId) {
    let db = null;
    try {
      db = await _idbWithTimeout(openMediaDB(), IDB_OPEN_TIMEOUT_MS, 'openMediaDB');
      photoBlob = await _idbWithTimeout(getBlobById(db, job.imageId), IDB_READ_TIMEOUT_MS, 'getBlobById');
    } catch (e) {
      WARN('  comment photo read failed —', e?.message || e);
    } finally { try { db && db.close(); } catch (_) {} }
    if (!photoBlob || !photoBlob.size) {
      if (!String(job.text || '').trim()) return { posted: false, skipped: 'photo_missing' };
      WARN('  comment photo is gone from local storage — posting the text alone');
      photoBlob = null;
    }
  }
  const r = await postFbComment(job.postId, job.text || '', { photoBlob, clientMutationId: job.clientMutationId });
  // v2026-10-15 · say it: the worker logged "posted with its photo" for a comment that went up as text alone (live QA F1)
  if (job.imageId && !photoBlob && r && r.posted) r.photoMissing = true;
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════════
// v2026-10-01 · LISTINGS — buy & sell groups (from a profile, Facebook takes only listings there)
// ═══════════════════════════════════════════════════════════════════════════════
// Captured live 30-Sep from Facebook's own "Sell Something" composer inside a buy & sell group, and
// proven end-to-end with MGP's own photo upload + request format: a listing in a private test group
// went Active ~10 minutes later ("This listing is in review" first), in the group only — not Marketplace.
//   MarketplaceComposerCreateStoryMutation  { input: { actor_id, client_mutation_id,
//     attachments: [{ product_item }, { photo: { id } }…], audiences: [{ wall: { to_id: <first group> } }],
//     composer_entry_point: 'groupCommerceComposerHelper', composer_source_surface: 'group_feed_from_tab',
//     source: 'WWW', navigation_data: { attribution_id_v2 } } }
//   product_item.xpost_target_ids = the other groups (Facebook's own limit: 20 groups per listing).
//   Marketplace is never among them — MGP lists in groups only.
// ⛔ Facebook has no idempotence here: the request is sent ONCE (singleShot); an answer lost after sending is
//    "unconfirmed" and is never sent again.
// ⛔ A Page cannot create a listing (measured: 1357010 field_exception) — the worker never asks for one.
const LISTING_DOC_NAME = 'MarketplaceComposerCreateStoryMutation';
const LISTING_MAX_PHOTOS = 10;
const LISTING_CATEGORY = { vehicle: '807311116002614', home: '1468271819871448' };
const LISTING_ITEM_CONDITIONS = ['new', 'used_like_new', 'used_good', 'used_fair'];
const LISTING_HOME_TYPE_LABEL = { house: 'House', townhouse: 'Townhouse', 'apartment-condo': 'Apartment/condo', 'private_room-shared_room': 'Room only' };

/** Pure: digits (and one decimal point) of a price the user typed — "₪1,200" → "1200". */
function listingPrice(v) {
  const s = String(v == null ? '' : v).replace(/[^\d.]/g, '');
  const m = /^\d+(?:\.\d{1,2})?/.exec(s);
  return m ? String(Number(m[0])) : '';
}

/** Pure: the listing's title — as typed for an item; built the way Facebook builds it for a vehicle or a home. */
function listingTitleOf(l) {
  const x = l || {};
  const typed = String(x.title || '').trim();
  if (typed) return typed.slice(0, 100);
  if (x.kind === 'vehicle') {
    const v = x.vehicle || {};
    return [v.year, v.make, v.model].map((p) => String(p == null ? '' : p).trim()).filter(Boolean).join(' ').slice(0, 100);
  }
  if (x.kind === 'home') {
    const h = x.home || {};
    const beds = String(h.bedrooms || '').trim(); const baths = String(h.bathrooms || '').trim();
    const type = LISTING_HOME_TYPE_LABEL[h.propertyType] || '';
    return [beds && `${beds} Beds`, baths && `${baths} Bath`, type].filter(Boolean).join(' ').slice(0, 100);
  }
  return '';
}

/** Pure: what `listing` is missing before it can be sent ([] = complete). The same rules Facebook's form applies. */
function listingProblems(l) {
  const x = l || {};
  const out = [];
  if (!['item', 'vehicle', 'home'].includes(x.kind)) return ['kind'];
  if (!listingPrice(x.price) || Number(listingPrice(x.price)) <= 0) out.push('price');
  if (!listingTitleOf(x)) out.push('title');
  if (x.kind === 'item' && !LISTING_ITEM_CONDITIONS.includes(x.condition)) out.push('condition');
  if (x.kind === 'vehicle') {
    const v = x.vehicle || {};
    const y = Number(v.year);
    if (!Number.isInteger(y) || y < 1901 || y > new Date().getFullYear() + 1) out.push('year');
    if (!String(v.make || '').trim()) out.push('make');
    if (!String(v.model || '').trim()) out.push('model');
    const km = Number(String(v.mileage || '').replace(/\D/g, ''));
    if (!(km >= 300 && km <= 1000000)) out.push('mileage');
    if (!['coupe', 'truck', 'sedan', 'hatchback', 'suv', 'convertible', 'wagon', 'minivan', 'small_car', 'other'].includes(v.bodyStyle)) out.push('bodyStyle');
  }
  if (x.kind === 'home') {
    const h = x.home || {};
    if (!LISTING_HOME_TYPE_LABEL[h.propertyType]) out.push('propertyType');
    const beds = Number(h.bedrooms); if (!Number.isInteger(beds) || beds < 0 || beds > 120) out.push('bedrooms');
    const baths = Number(h.bathrooms); if (!(baths > 0 && baths <= 30 && Math.round(baths * 4) === baths * 4)) out.push('bathrooms');
    const a = h.address || {};
    if (!(typeof a.latitude === 'number' && typeof a.longitude === 'number' && String(a.fullAddress || '').trim())) out.push('address');
    // Facebook's rental form requires a description ("Please add a rental description.") — the post text.
    if (!String(x.description || '').trim()) out.push('description');
  }
  return out;
}

/** Pure: where the listing is placed — a home at its picked address, anything else at the account's sell location. null = unknown. */
function listingLocationOf(l, job) {
  const x = l || {}; const j = job || {};
  if (x.kind === 'home') {
    const a = (x.home && x.home.address) || {};
    return (Number.isFinite(a.latitude) && Number.isFinite(a.longitude)) ? { lat: a.latitude, lng: a.longitude } : null;
  }
  return (Number.isFinite(j.lat) && Number.isFinite(j.lng)) ? { lat: j.lat, lng: j.lng } : null;
}

/** Pure: `serialized_verticals_data` for a vehicle or a home (a JSON STRING, keys as Facebook's composer sends). */
function listingVerticalsData(l, ctx) {
  const x = l || {}; const c = ctx || {};
  if (x.kind === 'vehicle') {
    const v = x.vehicle || {};
    return JSON.stringify({
      conversionPostID: '', conversionSource: '', engineSize: '', exteriorColor: String(v.exteriorColor || ''),
      fuelType: String(v.fuelType || ''), horsepower: '', interiorColor: String(v.interiorColor || ''),
      isKM: c.isMetric !== false, isManualTransmission: v.transmission === 'manual',
      make: String(v.make || '').trim(), mileage: String(v.mileage || '').replace(/\D/g, ''), model: String(v.model || '').trim(),
      numberOfOwners: '', titleStatus: v.cleanTitle ? 'CLEAN' : '', trim: '', type: 'autos',
      vehicleCategory: 'car&truck/', vehicleCondition: String(v.condition || ''), vehicleFeatures: [],
      vehicleType: String(v.bodyStyle || ''), vin: '', year: Number(v.year) || 0,
    });
  }
  if (x.kind === 'home') {
    const h = x.home || {}; const a = h.address || {};
    return JSON.stringify({
      // Units follow the form Facebook serves (Israel's says "Property square feet" and sends sqft, measured).
      acType: String(h.acType || ''), areaSize: String(h.areaSize || '').replace(/\D/g, ''), areaUnits: 'sqft',
      availableDate: h.availableDate || null, bathrooms: String(h.bathrooms || ''), bedrooms: String(h.bedrooms || ''),
      builtUpAreaSize: '', catFriendly: !!h.catFriendly, co2EmissionRatingEU: '', condoFee: null,
      ...(h.dogFriendly ? { dogFriendly: true } : {}),
      energyRatingEU: '', fullAddress: String(a.fullAddress || ''), furnishingType: '', heatingType: String(h.heatingType || ''),
      laundryType: String(h.laundryType || ''), leaseDurationInMonths: '', listedBy: '', mapEligible: true,
      numberOfCoRenters: '', parkingSpaces: '', parkingType: String(h.parkingType || ''), privateRoomBathroomType: '',
      propertyTax: null, propertyType: String(h.propertyType || ''), rentalRoomType: null, rooms: '',
      streetAddress: String(a.streetAddress || a.fullAddress || ''), type: 'real_estate',
    });
  }
  return null;
}

/** Pure: the `product_item` Facebook's group composer sends for this listing. */
function buildListingProductItem(l, ctx) {
  const x = l || {}; const c = ctx || {};
  const price = listingPrice(x.price);
  const description = { text: String(x.description || '').slice(0, 5000) };
  const xpost = Array.isArray(c.xpostIds) ? c.xpostIds.map(String) : [];
  if (x.kind === 'item') {
    return {
      attribute_data_json: JSON.stringify({ condition: x.condition }),
      commerce_shipping_carrier: null, commerce_shipping_carriers: [], comparable_price: 'null', cost_per_additional_item: null,
      delivery_types: ['IN_PERSON'], description, draft_type: null, hidden_from_friends_visibility: 'VISIBLE_TO_EVERYONE',
      is_personalization_required: null, is_photo_order_set_by_seller: false, is_preview: false,
      item_price: { currency: String(c.currency || ''), price },
      latitude: c.lat, listing_email_id: null, longitude: c.lng,
      min_acceptable_checkout_offer_price: 'null', personalization_info: null, product_hashtag_names: [], quantity: null,
      shipping_calculation_logic_version: null, shipping_cost_option: 'BUYER_PAID_SHIPPING', shipping_cost_range_lower_cost: null,
      shipping_cost_range_upper_cost: null, shipping_label_price: '0', shipping_label_rate_type: null, shipping_offered: false,
      shipping_options_data: [], shipping_package_weight: null, shipping_price: 'null', shipping_service_type: null,
      sku: '', source_type: 'marketplace_unknown', suggested_hashtag_names: [], surface: 'composer',
      title: listingTitleOf(x), variants: [], video_ids: [], xpost_target_ids: xpost, comments_disabled: false,
    };
  }
  // A vehicle or a home: the vertical fields ride in serialized_verticals_data; the price carries no currency.
  const a = (x.kind === 'home' && x.home && x.home.address) || null;
  return {
    category_id: LISTING_CATEGORY[x.kind],
    ...(x.kind === 'vehicle' ? { comments_disabled: false } : {}),
    description, draft_type: null, is_photo_order_set_by_seller: false, item_price: { price },
    latitude: a ? a.latitude : c.lat, listing_email_id: null, longitude: a ? a.longitude : c.lng,
    serialized_verticals_data: listingVerticalsData(x, c), source_type: 'buy_sell_group_mall',
    title: listingTitleOf(x), video_ids: [], xpost_target_ids: xpost,
  };
}

/** Pure: the whole mutation input — one wall group, the rest as cross-posts, photos as attachments. */
function buildListingInput(l, ctx) {
  const c = ctx || {};
  return {
    actor_id: String(c.actorId || ''),
    client_mutation_id: String(c.clientMutationId || '1'),
    attachments: [{ product_item: buildListingProductItem(l, c) }]
      .concat((Array.isArray(c.photoIds) ? c.photoIds : []).map((id) => ({ photo: { id: String(id) } }))),
    audiences: [{ wall: { to_id: String(c.wallGroupId || '') } }],
    composer_entry_point: 'groupCommerceComposerHelper',
    composer_source_surface: 'group_feed_from_tab',
    source: 'WWW',
    navigation_data: { attribution_id_v2: String(c.attributionId || '') },
  };
}

/** Pure: Facebook's answer → { ok, storyId, url, listingId } or { ok:false, code, message, docIdStale }. */
function parseListingResponse(raw) {
  const text = String(raw || '');
  let json = null;
  try { json = JSON.parse(text.split('\n')[0].replace(/^for \(;;\);/, '')); } catch (_) { json = null; }
  const story = json && json.data && json.data.story_create && json.data.story_create.story;
  if (story && (story.id || story.url)) {
    const att = Array.isArray(story.attachments) ? story.attachments[0] : null;
    return { ok: true, storyId: story.id || null, url: story.url || null, listingId: (att && att.target && att.target.id) || null };
  }
  if (/document with ID .* was not found|doc_?id .* not found/i.test(text)) return { ok: false, docIdStale: true };
  const e = json && Array.isArray(json.errors) && json.errors[0];
  if (e) return { ok: false, code: e.code || null, message: String(e.message || e.summary || '').slice(0, 200) };
  return { ok: false, code: null, message: text.slice(0, 200) };
}

/** The listing's photos as Facebook photo ids — MGP's own upload (proven accepted). Images only, ≤10. */
async function uploadListingPhotos(job) {
  const blobs = [];
  if (job.snapshotId) {
    const snapshot = await getSnapshotById(job.snapshotId);
    const items = (snapshot && Array.isArray(snapshot.items)) ? snapshot.items : [];
    const chosen = Array.isArray(job.chosenSetItemIds) && job.chosenSetItemIds.length
      ? job.chosenSetItemIds.map((k) => items.find((it) => it && it.key === k)).filter(Boolean) : items;
    for (const it of chosen) {
      const b = it && it.value && it.value.blob;
      if (b && b.size && String(it.value.type || b.type || '').startsWith('image')) blobs.push(b);
    }
  } else {
    let db = null;
    try {
      db = await _idbWithTimeout(openMediaDB(), IDB_OPEN_TIMEOUT_MS, 'openMediaDB');
      for (const id of job.imageIds || []) {
        const b = await _idbWithTimeout(getBlobById(db, id), IDB_READ_TIMEOUT_MS, 'getBlobById');
        if (b && b.size && String(b.type || 'image/').startsWith('image')) blobs.push(b);
      }
    } finally { try { db && db.close(); } catch (_) {} }
  }
  const ids = [];
  for (const b of blobs.slice(0, LISTING_MAX_PHOTOS)) {
    try {
      const att = await _withUploadRetry('listing photo', () => uploadFbPhoto(b));
      const id = att && att.photo && att.photo.id;
      if (id) ids.push(String(id));
    } catch (e) { WARN('  listing photo upload failed —', e?.message || e); }
  }
  return ids;
}

/**
 * ONE listing to up to 20 buy & sell groups (the first as the wall, the rest cross-posted). Answers
 * { sent: true, storyId, url, listingId } | { sent: false, reason } (nothing was created) |
 * { sent: 'unknown', reason: 'listing_unconfirmed' } (it may exist — the worker never sends it again).
 */
async function dispatchListing(job) {
  _fbRateLimitHit = false;
  if (job.tokens?.dtsg && job.tokens?.uid) {
    Object.assign(fbSession, job.tokens);
    fbSession.lastRefresh = Date.now();
  } else {
    await ensureFbTokens();
  }
  if (!fbSession.actorId) return { sent: false, reason: 'fb_tokens_unavailable' };
  if (job.actorId && String(fbSession.actorId) !== String(job.actorId)) {
    WARN('  listing NOT sent — the session acts as', fbSession.actorId, 'but the listing belongs to', job.actorId);
    return { sent: false, reason: 'identity_mismatch' };
  }
  const groups = (Array.isArray(job.groupIds) ? job.groupIds : []).map(String).filter((g) => /^\d+$/.test(g)).slice(0, 20);
  if (!groups.length) return { sent: false, reason: 'no_groups' };
  if (listingProblems(job.listing).length) return { sent: false, reason: 'listing_incomplete', problems: listingProblems(job.listing) };
  // No place to put it (the account has no Marketplace sell location yet) — nothing is sent.
  if (!listingLocationOf(job.listing, job)) return { sent: false, reason: 'no_location' };
  setStep('Uploading listing photos…');
  const photoIds = await uploadListingPhotos(job);
  if (!photoIds.length) return { sent: false, reason: 'photos_failed' };
  const input = buildListingInput(job.listing, {
    actorId: fbSession.actorId, clientMutationId: job.clientMutationId || ('l_' + Date.now().toString(36)),
    wallGroupId: groups[0], xpostIds: groups.slice(1), photoIds,
    lat: job.lat, lng: job.lng, currency: job.currency, isMetric: job.isMetric,
    attributionId: 'CometGroupDiscussionRoot.react,comet.group,via_cold_start,' + Date.now() + ',' + Math.floor(Math.random() * 900000 + 100000) + ',2361831622,,',
  });
  setStep('Sending the listing…');
  let raw;
  try {
    raw = await fetchGraphQL(FB_DOC_IDS[LISTING_DOC_NAME] || '9766933466697549', LISTING_DOC_NAME, { input }, { singleShot: true });
  } catch (e) {
    if (e && e.mgpRateLimited) return { sent: false, reason: 'rate_limited' };
    if (e && e.mgpMaybeSent) {
      WARN('  ⚠️ the listing may have been created (' + (e.message || 'no answer') + ') — never sending it again');
      return { sent: 'unknown', reason: 'listing_unconfirmed' };
    }
    return { sent: false, reason: 'request_error', error: String(e?.message || e).slice(0, 200) };
  }
  const r = parseListingResponse(raw);
  if (r.ok) {
    LOG('  ✅ listing created — ' + (r.url || r.storyId) + ' · ' + groups.length + ' group(s) · in Facebook review first');
    return { sent: true, storyId: r.storyId, url: r.url, listingId: r.listingId, photos: photoIds.length };
  }
  if (r.docIdStale) return { sent: false, reason: 'listing_docid_stale' };
  if (r.code || r.message) {
    WARN('  listing refused by Facebook —', r.code || '', r.message || '');
    return { sent: false, reason: 'listing_refused', fbCode: r.code || null, error: r.message || null };
  }
  return { sent: 'unknown', reason: 'listing_unconfirmed' };
}

/** A home listing's address: Facebook's own address search (a read). Answers up to 6 { fullAddress, streetAddress, city, latitude, longitude }. */
async function searchListingAddress(job) {
  if (job.tokens?.dtsg && job.tokens?.uid) { Object.assign(fbSession, job.tokens); fbSession.lastRefresh = Date.now(); }
  else await ensureFbTokens();
  const q = String(job.query || '').trim().slice(0, 120);
  if (!q) return { ok: true, results: [] };
  const variables = { params: {
    caller: 'MARKETPLACE', geocode_fallback: true, integration_strategy: 'STRING_MATCH', provider: 'HERE_THRIFT', query: q,
    result_ordering: 'ADDRESS_FIRST', search_type: 'STREET_PLACE_TYPEAHEAD',
    viewer_coordinates: { latitude: Number(job.lat) || 0, longitude: Number(job.lng) || 0 },
  } };
  const raw = await fetchGraphQL(FB_DOC_IDS.MarketplaceSearchAddressDataSourceQuery || '9660140454040174', 'MarketplaceSearchAddressDataSourceQuery', variables);
  return { ok: true, results: parseAddressResults(raw) };
}

/** Pure: the address search's answer → [{ fullAddress, streetAddress, city, latitude, longitude }] (≤6, deduplicated). */
function parseAddressResults(raw) {
  let json = null;
  try { json = JSON.parse(String(raw || '').split('\n')[0]); } catch (_) { return []; }
  const edges = (((json || {}).data || {}).city_street_search || {}).street_results;
  const out = []; const seen = new Set();
  for (const e of ((edges && edges.edges) || [])) {
    const n = e && e.node; const loc = n && n.location;
    if (!n || !loc || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') continue;
    const full = String(n.single_line_address || '').trim();
    if (!full || seen.has(full)) continue;
    seen.add(full);
    out.push({ fullAddress: full, streetAddress: String((n.multi_line_address || [])[0] || full), city: String((loc.reverse_geocode_detailed || {}).city || ''),
      latitude: loc.latitude, longitude: loc.longitude });
    if (out.length >= 6) break;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 7 — Main post execution
// ═══════════════════════════════════════════════════════════════════════════════
// v2026-08-20 (E): set when a post goes out with FEWER attachments than the
// user intended. Everything else about media already reaches telemetry — a
// total media failure surfaces as MEDIA_LOST/MEDIA_UNREADABLE in the campaign's
// error_types histogram. A PARTIAL loss does not: those posts are recorded as
// plain successes, so a user quietly losing 3 of 5 images on every group is
// invisible to us and looks fine to them until they open the post. One flag,
// set only in that case, so the happy path carries nothing extra.
let _partialMediaSummary = null;

async function dispatchPost(job) {
  _partialMediaSummary = null;   // per-dispatch; never leak the previous group's numbers
  _fbRateLimitHit = false;       // per dispatch — see _rateLimitError
  setStep('Preparing post…');
  LOG('▶ dispatchPost start, groupUrl:', job.groupUrl, 'text length:', (job.text || '').length);
  // Diagnostic entry-line: stamps the EXACT shape of what arrived from SW.
  // Length+hash+media counts. If text or media shrinks/disappears later in the
  // pipeline, comparing this line with the pre-mutation line shows exactly where.
  LOG(`▶ job in — textLen=${(job.text||'').length} hash=${_hash8(job.text)} snapshotId=${job.snapshotId||'none'} imageIds=${job.imageIds?.length||0} videoIds=${job.videoIds?.length||0} expectedMedia=${job.expectedMediaCount||0}`);

  // v10.7 (2026-05-02): bail at entry if stop was requested. Prevents starting
  // any work on a campaign the user has already cancelled.
  if (await _checkStopFlag()) {
    LOG('🛑 Stop detected at dispatchPost entry — aborting before work');
    return { success: false, error: 'stopped', errorType: 'STOPPED', stopCampaign: false };
  }

  // v10.5 (2026-05-02): adopt the campaign-level composer_session_id if
  // background.js attached one to the job. All posts in the same campaign
  // now share one session_id, mimicking a real human composer flow.
  // Falls back to per-call random UUID when no override is supplied
  // (single-post invocations, scheduled-posts before this update lands).
  _activeComposerSessionId = job.composerSessionId || null;
  if (_activeComposerSessionId) {
    LOG('  composer_session_id (campaign-level):', _activeComposerSessionId);
  }

  // ── Login check ──
  await verifyFbLogin();

  // Prefer tokens pre-fetched by background SW (CORS bypass — most reliable).
  // Extension pages cannot read Facebook HTML responses (no CORS headers) so
  // extractFbTokens() from worker.html context will silently fail.
  if (job.tokens?.dtsg && job.tokens?.uid) {
    Object.assign(fbSession, job.tokens);
    fbSession.lastRefresh = Date.now();
    LOG('  using tokens from background SW, uid:', fbSession.uid);
  } else {
    // Fallback: try extracting ourselves (may fail due to CORS on HTML pages)
    await ensureFbTokens();
  }
  LOG('  tokens ready — uid:', fbSession.uid);

  // ── Brand Mode (v7, 2026-05-01) ─────────────────────────────────────────
  // We DO NOT override actor_id from a UI selection anymore. The previous
  // approach forced actor_id=<UI-picked Page>, but Facebook's GraphQL
  // checks: "does the current session have permission to post AS this
  // actor?". The session's permission set is determined by who FB is
  // currently representing in the cookie/session, NOT by what we send.
  //
  // Result of the old approach: when UI=Page A but FB session is on Page B
  // (or Personal), FB returned error 1373034 "Insufficient Permission for
  // the specified Page". This is the bug the user kept hitting.
  //
  // Correct behaviour (matches competitor `ihkd` which posts reliably):
  // ALWAYS use fbSession.actorId — i.e., whoever FB is currently signed in
  // as. The user controls posting identity by switching profile in FB
  // itself; auto-follow then keeps the extension UI in sync.
  //
  // We still log brandMode info for debugging — it tells us what the UI
  // intended. If brandMode.actorId !== fbSession.actorId, the popup shows
  // a mismatch warning before submitting (added in v7).
  const brandMode = job.brandMode || null;
  if (brandMode) {
    LOG('  Brand Mode info — UI intent:', brandMode.actorType,
        'actorId:', brandMode.actorId, 'name:', brandMode.pageName || '',
        '| FB session active:', fbSession.actorId);
  }

  // ── Posting-identity diagnostics (personal vs business/Page) ─────────────
  // The engine ALWAYS posts as fbSession.actorId — whoever FB's session is
  // currently representing. When actorId === uid the post goes out as the
  // user's personal profile; when actorId !== uid FB is currently switched to
  // a Page, so the post goes out AS that Page. This single line answers the
  // recurring "did it post as personal or business?" question in the logs.
  // v36: when the user switches via the i_user cookie, FB reports the acting
  // actor as BOTH uid and actorId, so the old actorId!==uid test mislabels a
  // Page post as "personal". Trust the UI intent first (brandMode=page matching
  // the session actor), then fall back to actorId!==uid for manual FB switches.
  // LABEL-ONLY — does not change which actor the post uses.
  const _identityMode = (
    (brandMode && brandMode.actorType === 'page' && String(brandMode.actorId || '') === String(fbSession.actorId || ''))
    || (fbSession.actorId && fbSession.uid && String(fbSession.actorId) !== String(fbSession.uid))
  ) ? 'PAGE' : 'personal';
  LOG(`  identity — sessionActor=${fbSession.actorId} uid=${fbSession.uid} mode=${_identityMode} uiIntent=${brandMode?.actorType || 'none'}`);
  if (brandMode && brandMode.actorId && String(brandMode.actorId) !== String(fbSession.actorId)) {
    WARN(`  ⚠️ identity mismatch — UI wanted ${brandMode.actorId}/${brandMode.actorType} but FB session is ${fbSession.actorId}; posting as the FB session actor`);
  }

  // Determine whether this is a group post or a profile/timeline post.
  // The path is now decided purely by the URL — only true profile URLs
  // (e.g. https://www.facebook.com/profile.php?id=...) take the timeline
  // path. The previous "Post on this Page only" checkbox forced the timeline
  // path for Pages, but it shipped buggy variables and was removed in v6.5.
  // ⛔ Someone else's profile or Page. Facebook will not let us post there, and
  // before this the url fell into isProfileUrl's "any non-group slug" branch —
  // posting to the CURRENT actor's own timeline instead, silently. Refused here,
  // before any request, so it fails through the normal result path.
  if (job.targetKind === 'foreign') {
    const _e = new Error('Not your profile or a Page you manage — Facebook only allows posting to your own timeline or your own Pages');
    _e.errorType = 'NOT_YOUR_PAGE';
    throw _e;
  }
  // Could not tell what this non-group link is (a network error, or not a
  // timeline page at all — a post, a photo).
  // Before, it fell to "any slug = profile" — the CURRENT actor's timeline — so a
  // Page the check could not reach would have been posted on the wrong feed.
  if (job.targetKind === 'unknown') {
    const _e = new Error('Could not confirm this link is your profile or a Page you manage — it is not a group, and an unconfirmed feed could be the wrong one. Nothing was posted.');
    _e.errorType = 'TARGET_UNVERIFIED';
    throw _e;
  }
  const postToProfile = job.targetKind === 'page_feed' || isProfileUrl(job.groupUrl);
  let groupId = null;
  if (job.targetKind === 'page_feed') {
    // ⛔ Posting to a Page's feed is only right when the session IS that Page.
    // The service worker switches to it before this job and the tokens above
    // were read after the switch — but Facebook resets a Page session when
    // other Facebook tabs are open (the competitor warns about exactly this),
    // and posting anyway would put the Page's post on the PERSONAL timeline.
    if (!job.pageId || String(fbSession.actorId || '') !== String(job.pageId)) {
      const _e = new Error('Page session not active — acting as ' + (fbSession.actorId || 'unknown') + ', wanted Page ' + (job.pageId || '?'));
      _e.errorType = 'PAGE_SESSION_NOT_ACTIVE';
      throw _e;
    }
    LOG('  → Page-feed post (as Page', job.pageId, ')');
  } else if (postToProfile) {
    LOG('  → Profile/timeline post (actorId:', fbSession.actorId, ')');
  } else {
    groupId = await resolveGroupId(job.groupUrl);
    if (!groupId) {
      // Tag the error so the SW retry classifier (shouldRetryResult) can tell a
      // PERMANENT "no id in this page" failure (GROUP_UNRESOLVABLE → no retry)
      // from a TRANSIENT fetch/network failure (EXCEPTION → retry once).
      const _err = new Error(`Cannot resolve group ID from: ${job.groupUrl}`);
      _err.errorType = resolveGroupId._lastTransient ? 'EXCEPTION' : 'GROUP_UNRESOLVABLE';
      // No group URL or slug in the crumb — the classification is the signal.
      // GROUP_UNRESOLVABLE means the page loaded but held no id (a dead or
      // renamed group); EXCEPTION means we never got the page at all.
      try { engineSentryBreadcrumb('group-resolve', { event: 'resolve_failed', kind: _err.errorType }); } catch (_) {}
      throw _err;
    }
    LOG('  group ID:', groupId);
  }

  const attachments = [];
  // Counts images rejected for being in a format the browser cannot read, so
  // the all-failed guard below can name the real cause instead of defaulting to
  // "the media is gone from local storage" — which would be wrong and would
  // send the user re-uploading files that are already there.
  let _unreadableMedia = 0;
  // v2026-10-12 · a file that is NOT in this browser vs an upload Facebook REFUSED (HTTP status, no photo id).
  // Both used to end as MEDIA_LOST — "the saved copies of your images are no longer in this browser" — and a
  // single refused upload (group 16 of 43, the rest posted) sent people re-uploading files that were there.
  let _missingMedia = 0;
  let _rejectedMedia = 0;
  let _authMedia = 0;              // v2026-10-16 (review 3) · an upload answered by Facebook's sign-in / checkpoint page
  let _lastUploadCode = null;      // v2026-10-16 · Facebook's code on the last refused upload (uploadRefusalOf)
  let _lastUploadSummary = null;
  let _networkMedia = 0;   // v2026-08-28: uploads that never reached Facebook

  if (job.snapshotId) {
    // Scheduled post — read blobs from permanentStore
    LOG('  scheduled post — reading from snapshot:', job.snapshotId);
    const snapshot = await getSnapshotById(job.snapshotId);

    // B1 fix (2026-04-30): generation-mismatch detection. If the user
    // edited this schedule between cron dispatch and worker fetch, the
    // snapshot's gen field bumped past expectedGen. Bail out — the dispatch
    // captured stale text/groups/time, and we don't want to post with that.
    // The next cron iteration will re-dispatch with the new gen.
    if (snapshot && Number(snapshot.gen || 0) > Number(job.expectedGen || 0)) {
      WARN('snapshot edited mid-fire — aborting post for this iteration',
           'expectedGen:', job.expectedGen, 'currentGen:', snapshot.gen);
      return {
        success: false,
        error: 'snapshot_changed_during_fire',
        errorType: 'WARNING',
        stopCampaign: false,
      };
    }

    // S2 fix (2026-04-30): media-loss guard. The previous code did
    //   `for (const item of snapshot?.items || []) ...`
    // which silently iterated zero items when the snapshot was missing
    // (deleted by a concurrent edit/delete, or wiped by a stale-cleanup
    // race). Result: post fired without the user's images/videos. Fail
    // loudly instead — the user expected media; we'd rather skip the post
    // than send it text-only and lose their visual.
    //
    // Detection: job.expectedMediaCount is stamped by background.js when
    // dispatching from triggerPostFromSnapshot (see line ~4520+). A zero
    // expected count is also treated as text-only and OK.
    const expectedMediaCount = Number(job.expectedMediaCount || 0);
    // v53 Image Sets — when the SW chose ONE set for this (fire, group), upload
    // ONLY that set's items, matched by snapshot-item `.key` (== the MediaDB id
    // stored on the set) and IN the set's order. Absent → all snapshot items
    // (today's single-media behavior). uploadFbPhoto/uploadFbVideo and every
    // guard below are unchanged — only WHICH items enter the loop differs.
    const _allSnapItems = (snapshot && Array.isArray(snapshot.items)) ? snapshot.items : [];
    const _useChosenSet = Array.isArray(job.chosenSetItemIds) && job.chosenSetItemIds.length > 0;
    const _toUpload = _useChosenSet
      ? job.chosenSetItemIds.map((k) => _allSnapItems.find((it) => it && it.key === k)).filter(Boolean)
      : _allSnapItems;
    if (_useChosenSet) {
      LOG(`  image set — uploading ${_toUpload.length}/${_allSnapItems.length} snapshot items (set keys: ${job.chosenSetItemIds.join(',')})`);
    }
    const actualItemCount = _toUpload.length;

    if (!snapshot && expectedMediaCount > 0) {
      ERR('snapshot_missing_media — refusing to post without expected media',
          'expected:', expectedMediaCount, 'job:', job.snapshotId);
      return {
        success: false,
        error: 'snapshot_missing_media',
        errorType: 'CRITICAL',
        stopCampaign: false, // single-post failure, not a campaign-wide stop
      };
    }
    if (snapshot && expectedMediaCount > 0 && actualItemCount === 0) {
      ERR('snapshot_empty_media — items[] empty though media was expected',
          'expected:', expectedMediaCount, 'job:', job.snapshotId);
      return {
        success: false,
        error: 'snapshot_empty_media',
        errorType: 'CRITICAL',
        stopCampaign: false,
      };
    }

    // Per-item upload with loud diagnostics:
    //  • log entry (size+type+index) so the user sees which item we're uploading
    //  • guard against stale/zero-byte blobs (the IDB-decay signature for recurring
    //    scheduled posts whose blob was persisted days ago and silently invalidated)
    //  • log success (id) or enriched failure (size+type+index+error)
    // The loop still continues on per-item failures, but the POST-LOOP GUARD
    // below catches the "0 uploaded though we expected N" case loudly.
    let _idx = 0;
    for (const item of _toUpload) {
      const _itemIdx = _idx++;
      const _type = item?.value?.type || 'unknown';
      const _blob = item?.value?.blob;
      const _size = _blob?.size || 0;
      if (!_blob) {
        WARN(`⚠️ media[${_itemIdx}] missing blob — skipping (type=${_type})`);
        _missingMedia++;
        continue;
      }
      if (_size === 0) {
        // Zero-byte Blob = the classic IDB-decay signature. Surfaces it as a
        // real failure instead of silently skipping (which is what would mask
        // the bug for the customer's recurring scheduled posts).
        ERR(`❌ media[${_itemIdx}] stale_blob — size=0 type=${_type} (IDB-persisted blob lost its data; user must re-add media in the scheduled post)`);
        _missingMedia++;
        continue;
      }
      // Size cap guard (FB undocumented but observed limits: ~10MB image, ~500MB
      // video). Skip oversized items with a clear ERR rather than letting them
      // fail deep inside the upload stack with an opaque message.
      const _MAX_IMG = 10 * 1024 * 1024;
      const _MAX_VID = 500 * 1024 * 1024;
      if (_type.startsWith('image') && _size > _MAX_IMG) {
        ERR(`❌ media[${_itemIdx}] oversized image — size=${_size}B (>${_MAX_IMG}B / 10MB FB limit). Skipping.`);
        continue;
      }
      if (_type.startsWith('video') && _size > _MAX_VID) {
        ERR(`❌ media[${_itemIdx}] oversized video — size=${_size}B (>${_MAX_VID}B / 500MB FB limit). Skipping.`);
        continue;
      }
      LOG(`  ▶ media[${_itemIdx}] start — type=${_type} size=${_size}B`);
      try {
        if (_type.startsWith('image')) {
          const att = await _withUploadRetry(`media[${_itemIdx}]`, () => uploadFbPhoto(_blob));
          attachments.push(att);
          LOG(`  ✅ media[${_itemIdx}] uploaded — id=${att?.photo?.id || '?'}`);
        } else if (_type.startsWith('video')) {
          // 🔴 v1.2.9.66: photos go through _withUploadRetry, videos did not — so a
          // single transient rupload failure DROPPED the clip and the loop carried
          // on. The post then went out with the photos only, reporting success.
          const att = await _withUploadRetry(`media[${_itemIdx}] video`, () => uploadFbVideo(_blob, groupId || fbSession.actorId));
          attachments.push(att);
          LOG(`  ✅ media[${_itemIdx}] uploaded — id=${att?.video?.id || '?'}`);
        } else {
          WARN(`⚠️ media[${_itemIdx}] unknown type=${_type} — skipping`);
        }
      } catch (e) {
        if (e?.mgpAuth) _authMedia++;
        else if (e?.mgpUnreadable) _unreadableMedia++;
        else if (e?.mgpUploadNetwork) _networkMedia++;
        else _rejectedMedia++;
        if (e?.mgpUploadCode) { _lastUploadCode = e.mgpUploadCode; _lastUploadSummary = e.mgpUploadSummary || null; }   // v2026-10-16
        ERR(`❌ media[${_itemIdx}] upload failed — type=${_type} size=${_size}B :: ${e?.message || e}`);
        if (_fbRateLimitHit) break;   // v2026-10-12 · after a 429 nothing more is sent in this dispatch
      }
    }
  } else {
    // Immediate post — look up by key in MediaDB
    const db = await _idbWithTimeout(openMediaDB(), IDB_OPEN_TIMEOUT_MS, 'openMediaDB'); // v76: bound DB-open; a timeout here throws → group fails cleanly → media_all_failed guard refuses text-only → campaign continues
    let _imIdx = 0;
    for (const id of job.imageIds || []) {
      const _itemIdx = _imIdx++;
      try {
        const blob = await _idbWithTimeout(getBlobById(db, id), IDB_READ_TIMEOUT_MS, 'getBlobById'); // v76: bound the local IDB read (generous — never trips a legit large blob)
        const _size = blob?.size || 0;
        if (!blob) { WARN(`⚠️ image[${_itemIdx}] blob not found in MediaDB — id=${id}`); _missingMedia++; continue; }
        if (_size === 0) { ERR(`❌ image[${_itemIdx}] stale_blob — size=0 id=${id}`); _missingMedia++; continue; }
        LOG(`  ▶ image[${_itemIdx}] start — size=${_size}B id=${id}`);
        const att = await _withUploadRetry(`image[${_itemIdx}]`, () => uploadFbPhoto(blob));
        attachments.push(att);
        LOG(`  ✅ image[${_itemIdx}] uploaded — id=${att?.photo?.id || '?'}`);
      } catch (e) {
        if (e?.mgpAuth) _authMedia++;
        else if (e?.mgpUnreadable) _unreadableMedia++;
        else if (e?.mgpUploadNetwork) _networkMedia++;
        else if (/^idb_timeout:/.test(String(e?.message || ''))) _missingMedia++;   // a stalled local read is not a Facebook refusal
        else _rejectedMedia++;
        if (e?.mgpUploadCode) { _lastUploadCode = e.mgpUploadCode; _lastUploadSummary = e.mgpUploadSummary || null; }   // v2026-10-16
        ERR(`❌ image[${_itemIdx}] upload failed — id=${id} :: ${e?.message || e}`);
        if (_fbRateLimitHit) break;   // v2026-10-12 · after a 429 nothing more is sent in this dispatch
      }
    }
    let _vidIdx = 0;
    for (const id of job.videoIds || []) {
      const _itemIdx = _vidIdx++;
      try {
        const blob = await _idbWithTimeout(getBlobById(db, id), IDB_READ_TIMEOUT_MS, 'getBlobById'); // v76: bound the local IDB read (generous — never trips a legit large blob)
        LOG('  video blob retrieved:', blob ? `${blob.size} bytes, type=${blob.type}` : 'NULL');
        if (!blob) { WARN(`⚠️ video[${_itemIdx}] blob not found in MediaDB — id=${id}`); _missingMedia++; continue; }
        if (blob.size === 0) { ERR(`❌ video[${_itemIdx}] stale_blob — size=0 id=${id}`); _missingMedia++; continue; }
        const att = await uploadFbVideo(blob, groupId || fbSession.actorId);
        attachments.push(att);
        LOG(`  ✅ video[${_itemIdx}] uploaded — id=${att?.video?.id || '?'}`);
      } catch (e) {
        ERR(`❌ video[${_itemIdx}] upload failed — id=${id} :: ${e?.message || e}`);
        return { success: false, error: `video_upload_failed: ${e.message}`, videoId: id };
      }
    }
    db.close();
  }

  // ── POST-LOOP GUARD: media expected but nothing uploaded ────────────────────
  // The root cause of the customer's "post fires without the image" bug. Without
  // this guard, the loop above silently swallows all per-item failures and the
  // post fires text-only (or with a scraped link preview that masks the missing
  // image). Now: if media was expected and 0 real attachments came through,
  // FAIL LOUDLY — the post is queued for retry, the user sees a clear error,
  // and we never silently produce a text-only post when media was intended.
  const _expectedFromJob = job.snapshotId
    ? Number(job.expectedMediaCount || 0)
    : (Number(job.imageIds?.length || 0) + Number(job.videoIds?.length || 0));
  const _realMediaCount = attachments.filter(a => a && !a.link).length;
  if (_expectedFromJob > 0 && _realMediaCount === 0 && _unreadableMedia > 0) {
    // Distinct from media_all_failed below: the blobs are PRESENT, they are just
    // in a format the browser cannot read (HEIC/HEIF from an iPhone). Telling
    // this user to "upload the media again" would send them round in a circle —
    // re-uploading the same .heic changes nothing. They need to convert it.
    ERR(`❌ media_unreadable — ${_unreadableMedia} of ${_expectedFromJob} file(s) are in a format Facebook can't accept (HEIC/HEIF). Refusing to post text-only.`);
    try { engineSentryError('media-unreadable', { expected: _expectedFromJob, unreadable: _unreadableMedia }); } catch (_) {}
    return {
      success: false,
      error: 'media_unreadable_format',
      // Same behaviour contract as MEDIA_LOST: this group fails, the campaign
      // continues, and it is never auto-retried — the bytes will not become
      // readable on a second attempt.
      errorType: 'MEDIA_UNREADABLE',
      stopCampaign: false,
    };
  }
  if (_expectedFromJob > 0 && _realMediaCount === 0 && _networkMedia > 0) {
    // The blobs were READ successfully — only the request carrying them failed.
    // Unlike a missing file, this is recoverable: Safe/DOM hands the image to
    // Facebook's own file input and never touches upload.facebook.com, so the
    // post can still go out WITH its image. shouldFastDomFailover lets this one
    // through; MEDIA_LOST and MEDIA_UNREADABLE stay blocked, because there a
    // second attempt cannot help.
    ERR(`❌ media_upload_network — ${_networkMedia} of ${_expectedFromJob} upload(s) never reached Facebook (blocked or timed out). The files are fine.`);
    try { engineSentryError('media-upload-network', { expected: _expectedFromJob, network: _networkMedia }); } catch (_) {}
    return {
      success: false,
      error: 'media_upload_network',
      errorType: 'MEDIA_UPLOAD_NETWORK',
      stopCampaign: false,
    };
  }
  if (_expectedFromJob > 0 && _realMediaCount === 0 && _fbRateLimitHit) return _rateLimitResult({});
  // v2026-10-16 (review 3) · the photo upload landed on Facebook's sign-in or checkpoint page: the session is gone — every
  // later group would do the same (a photo request to a login page, then a signed-out Safe window). AUTH stops the run.
  if (_expectedFromJob > 0 && _realMediaCount === 0 && _authMedia > 0) {
    ERR(`❌ photo upload answered by Facebook's ${_lastUploadCode === 'checkpoint' ? 'checkpoint' : 'sign-in'} page — the Facebook session is not usable; stopping.`);
    return { success: false, error: 'not logged in — the photo upload was sent to Facebook\'s ' + (_lastUploadCode === 'checkpoint' ? 'checkpoint' : 'sign-in') + ' page', errorType: 'AUTH', stopCampaign: true, uploadCode: _lastUploadCode || 'signed_out' };
  }
  if (_expectedFromJob > 0 && _realMediaCount === 0 && _rejectedMedia > 0 && _missingMedia === 0) {
    // v2026-10-12 · the files were READ — Facebook refused the upload (an HTTP status, or an answer with
    // no photo id). Not "your images are gone": the next group usually works (one refused upload in a
    // 43-group run), and Safe hands the file to Facebook's own composer, so the failover may post it.
    ERR(`❌ media_upload_rejected — Facebook refused ${_rejectedMedia} of ${_expectedFromJob} upload(s)${_lastUploadCode ? ' (' + _lastUploadCode + (_lastUploadSummary ? ': ' + _lastUploadSummary : '') + ')' : ''}; the files are fine.`);
    try { engineSentryBreadcrumb('media', { event: 'media_upload_rejected', expected: _expectedFromJob, rejected: _rejectedMedia }); } catch (_) {}
    return {
      success: false,
      error: 'media_upload_rejected' + (_lastUploadCode ? ' (' + _lastUploadCode + ')' : ''),
      errorType: 'MEDIA_UPLOAD_REJECTED',
      ...(_lastUploadCode ? { uploadCode: _lastUploadCode } : {}),
      ...(_lastUploadSummary ? { uploadSummary: _lastUploadSummary } : {}),
      stopCampaign: false,
    };
  }
  if (_expectedFromJob > 0 && _realMediaCount === 0) {
    ERR(`❌ media_all_failed — expected ${_expectedFromJob} attachments, got 0 (silent IDB-decay or upload rejects). Refusing to post text-only.`);
    // Every attachment for this group died — either the local blobs decayed or
    // Facebook rejected each upload. Counts only, no filenames or URLs.
    try { engineSentryBreadcrumb('media', { event: 'media_all_failed', expected: _expectedFromJob, got: 0 }); } catch (_) {}
    // v2026-08-19 — THE DIAGNOSTIC THAT WAS MISSING.
    // Two customers hit this and both investigations stalled on the same
    // unanswerable question: was the media store WIPED (nothing left at all),
    // or were these specific ids deleted while other media survived? The first
    // points at Chrome evicting the origin's IndexedDB; the second points at
    // our own code deleting by id. Reconstructing it after the fact took hours
    // of log forensics. Capture it AT THE MOMENT OF FAILURE instead:
    //   remaining === 0  → whole store gone (eviction / user cleared site data)
    //   remaining  >  0  → selective delete, and the count says how much survived
    // Plus Chrome's own quota view, which is what decides eviction. Counts and
    // byte totals only — never a key, filename, or blob.
    try {
      (async () => {
        let remaining = null;
        try {
          const _db = await openMediaDB();
          remaining = await new Promise((res) => {
            try {
              const _r = _db.transaction('media', 'readonly').objectStore('media').getAllKeys();
              _r.onsuccess = () => res((_r.result || []).length);
              _r.onerror = () => res(null);
            } catch (_) { res(null); }
          });
          try { _db.close(); } catch (_) {}
        } catch (_) {}
        let usageMB = null, quotaMB = null, persisted = null;
        try {
          if (navigator?.storage?.estimate) {
            const est = await navigator.storage.estimate();
            usageMB = Math.round((est.usage || 0) / 1048576);
            quotaMB = Math.round((est.quota || 0) / 1048576);
          }
          if (navigator?.storage?.persisted) persisted = await navigator.storage.persisted();
        } catch (_) {}
        // v2026-08-21: did we ever ASK for persistence, and what did Chrome say?
        // `persisted: true` on its own already proves eviction is not the
        // explanation, but `false` is ambiguous — never asked, or asked and
        // denied? Written by requestPersistentStorage() in the service worker
        // on every boot. This is the field that closes the eviction-vs-disk-
        // corruption question the next time this fires.
        let persistAsk = 'unknown';
        try {
          const _sp = (await chrome.storage.local.get('_storagePersist'))?._storagePersist;
          if (_sp) {
            persistAsk = !_sp.supported ? 'unsupported'
              : (_sp.requested ? (_sp.persisted ? 'granted' : 'denied') : (_sp.persisted ? 'already' : 'unknown'));
          } else {
            persistAsk = 'never-asked';
          }
        } catch (_) {}
        // 🔑 Was it US? `remaining > 0` says a selective delete happened, and the
        // only selective deleter in this extension is cleanupStaleMediaDB — which
        // now records every pass. Reading it here turns "probably the sweep" into
        // a fact the event carries itself.
        // v2026-10-13 · what the campaign's start saw, and who removed media last (see the worker's _preflightMedia).
        let pfTotal = -2, pfMissing = -2, pfAgoSec = -1, pfSets = 'unknown', lastDelete = 'unknown';
        try {
          const _pd = await chrome.storage.local.get(['_preflightMedia', '_lastMediaDelete']);
          const pf = _pd && _pd._preflightMedia;
          if (pf && typeof pf.ts === 'number') { pfTotal = Number(pf.total); pfMissing = Number(pf.missing); pfAgoSec = Math.max(0, Math.round((Date.now() - pf.ts) / 1000)); pfSets = !!pf.sets; }
          const ld = _pd && _pd._lastMediaDelete;
          lastDelete = ld && typeof ld.ts === 'number' ? String(ld.source || '?').slice(0, 30) + '/' + (Number(ld.count) >= 0 ? Number(ld.count) : '?') + '/' + Math.max(0, Math.round((Date.now() - ld.ts) / 1000)) + 's ago' : 'none';
        } catch (_) {}
        let sweptPurged = null, sweptAgoSec = null;
        try {
          const _lms = (await chrome.storage.local.get('_lastMediaSweep'))?._lastMediaSweep;
          if (_lms && typeof _lms.ts === 'number') {
            sweptPurged = Number(_lms.purged) || 0;
            sweptAgoSec = Math.max(0, Math.round((Date.now() - _lms.ts) / 1000));
          }
        } catch (_) {}
        WARN(`[media-loss] store has ${remaining === null ? '?' : remaining} item(s) left · storage ${usageMB ?? '?'}MB / ${quotaMB ?? '?'}MB · persisted=${persisted === null ? '?' : persisted} · persist_ask=${persistAsk}`);
        // ERROR level on purpose — this is the one signal that tells us a
        // customer's media vanished, and we want it to reach us before they do.
        // -1 / 'unknown' instead of null: sentryScrubData drops null values
        // outright (`if (v == null) continue`), and a MISSING `remaining` is
        // exactly the case we must be able to tell apart from `remaining: 0`.
        // 0 = the whole store is gone (eviction / user cleared site data);
        // >0 = a selective delete, i.e. our own code. Losing that distinction
        // would put us right back to guessing.
        try {
          engineSentryError('media-lost', {
            remaining: (typeof remaining === 'number') ? remaining : -1,
            usage_mb: (typeof usageMB === 'number') ? usageMB : -1,
            quota_mb: (typeof quotaMB === 'number') ? quotaMB : -1,
            persisted: (typeof persisted === 'boolean') ? persisted : 'unknown',
            persist_ask: persistAsk,
            expected: _expectedFromJob,
            // Counts and flags only — still never a key, a filename or a blob.
            from_snapshot: !!(job && job.snapshotId),
            // v2026-10-15 · sent by the retry queue (mgp-service-worker.js processRetryQueue), not by a run.
            from_retry: !!(job && job._retry),
            swept_purged: (typeof sweptPurged === 'number') ? sweptPurged : -1,
            swept_ago_sec: (typeof sweptAgoSec === 'number') ? sweptAgoSec : -1,
            preflight_total: pfTotal, preflight_missing: pfMissing, preflight_ago_sec: pfAgoSec, sets_on: pfSets,
            last_delete: lastDelete,
          });
        } catch (_) {}
      })();
    } catch (_) {}
    return {
      success: false,
      error: 'media_all_failed',
      // v2026-08-18: was 'SOFT'. The BEHAVIOUR was right (per-call failure,
      // campaign continues, no automatic retry — a missing blob won't come back)
      // but SOFT is also what Facebook permission/group-state rejections map to,
      // and it carries that bucket's wording. A customer lost a whole day to
      // "SOFT" while the actual cause was local: their media pool had been wiped.
      // Same behaviour, honest name — MEDIA_LOST is added alongside SOFT in
      // shouldRetryResult (mgp-service-worker.js) so it still never auto-retries.
      errorType: 'MEDIA_LOST',
      stopCampaign: false,
    };
  }

  // v66: PARTIAL-media surface. The guard above catches the ALL-failed case (got 0).
  // This surfaces the silent PARTIAL case — some media uploaded, some didn't (a stale
  // IDB blob or a single upload timeout) — so the user sees it in the downloadable log
  // instead of a quietly-shorter post. We still POST what uploaded (FB accepts a subset;
  // refusing would lose the whole post).
  // 🔴 v1.2.9.66: this used to skip image-set posts, on the premise that "the
  // chosen set legitimately has fewer items than the total expectedMediaCount".
  // That premise is FALSE — the worker already scopes the count to the drawn set
  // (`_expectedMediaCount = _chosenSetKeys.length`), so it could never
  // false-fire. Suppressing it is exactly why a set whose video upload failed
  // published photos-only, in silence, on every group in the campaign.
  if (_expectedFromJob > 0 && _realMediaCount > 0 && _realMediaCount < _expectedFromJob) {
    WARN(`⚠️ partial-media: expected ${_expectedFromJob} attachments, only ${_realMediaCount} uploaded — posting with ${_realMediaCount} (some media dropped; re-add if it matters).`);
    // Same condition as the warning above — deliberately reusing it rather than
    // re-deriving, so the number we report can never disagree with the log line.
    _partialMediaSummary = { expected: _expectedFromJob, uploaded: _realMediaCount };
  }

  // ── Link preview: if the text contains a URL AND no media was attached,
  // scrape a rich preview and push it as an attachment. FB will then render a
  // preview card (title + thumbnail + description) instead of raw URL text.
  // Media attachments take priority — FB disallows both in the same post.
  // GATE (2026, image-fix): only fall back to link-preview when the user did NOT
  // intend media. Otherwise a failed media post would silently turn into a link
  // post, which is exactly the bug we're fixing. (The post-loop guard above
  // already aborts when expected>0 and got=0, so this branch is now reached
  // only when expected=0 — but keep the guard explicit for clarity.)
  let _cardUrl = null;
  // v2026-10-02: never on a colour post — a background post is text on a coloured card, and Facebook's own
  // composer adds no link card to one; sending both risks Facebook dropping the colour (the post goes out plain).
  const _wantsBg = !!job.textFormatPresetId && job.textFormatPresetId !== '0';
  if (attachments.length === 0 && _expectedFromJob === 0) {
    // 🔑 A share run NAMES its url. Deriving the card from "the first url in the
    // text" made the card depend on text ORDER, which is why the attribution
    // line had to be written without a scheme — with one it would have been
    // picked first and the card would have become our own homepage in every
    // group. Naming it removes that coupling entirely; the scan stays as the
    // fallback for ordinary link posts.
    // v2026-10-11: the user removed the link preview in the composer ("Remove video") — no card, the link
    // stays in the text as typed. (A share run always names its card; that is not this switch.)
    const url = (_wantsBg || (job.noLinkCard && !job.shareRun)) ? null : shareCardUrlFor(job, extractFirstUrl(addSchemeToBareWhatsAppLinks(job.text), MGP_OWN_ATTRIBUTION_URL));
    if (url) {
      try {
        const shareScrape = await scrapeLinkPreview(url);
        if (shareScrape) {
          attachments.push({ link: { share_scrape_data: shareScrape } });
          _cardUrl = url;          // the card carries it ⇒ the text need not
        }
      } catch (e) {
        WARN('  link preview threw — posting without preview:', e.message);
      }
    }
  }

  LOG('  attachments count:', attachments.length);

  // Distinguish real media (photo/video uploads — use Media mutation) from
  // link-only attachments (use regular mutation, FB accepts the link shape
  // there). Competitor treats these the same way.
  const hasMedia = attachments.some(a => a && !a.link);
  const docId    = hasMedia
    ? (FB_DOC_IDS.ComposerStoryCreateMutationMedia || '9286110778162996')
    : (FB_DOC_IDS.ComposerStoryCreateMutation      || '9469644099759635');
  // ── Decode HTML entities from UI input, then apply URL safety trick ──
  const decodedText = (job.text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/ /g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
  // A share run carries nothing we did not put there on purpose — the line for
  // a free account, and that is all. See the note at the marker's SW site.
  const safeText  = addSchemeToBareWhatsAppLinks(stripCardUrlFromText(decodedText, _cardUrl, !!job.shareRun));
  // Pipeline diagnostic — see if text length/hash changed after decode + URL-safety.
  // If safeText.len < job.text.len significantly, the HTML-entity decode shrunk
  // it (normal — entities expand to single chars). hash differs from job.text
  // hash when content changed.
  LOG(`  ▶ text after decode+URL-safety — len=${safeText.length} hash=${_hash8(safeText)}`);
  // Forward stable idempotence IDs (attached by background.js#sendToWorker) so
  // retries re-use the same client_mutation_id + idempotence_token and FB dedupes.
  const stableIds = (job._stableMutationId || job._stableIdempotenceToken)
    ? { mutationId: job._stableMutationId, idempotenceToken: job._stableIdempotenceToken }
    : null;
  // v10.7: derive isPageMode from brandMode for hybrid composer_session_id.
  // Personal mode → empty string (matches competitor); Page mode → UUID
  // (preserves v9.4 fix that prevents 1357032 in Page-mode group posts).
  const isPageMode = !!(brandMode && brandMode.actorType === 'page');

  // v10.10 (2026-05-02): cleanVariables flag re-enabled with corrected hexes.
  // The UI palette now sends FB's actual preset hexes (#18191a, #e2013b,
  // #c600ff, #ff6323, etc.) extracted from competitor's popup.html. With
  // the right hex values, FB accepts text_format_preset_id without dropping
  // to FALLBACK. cleanVariables = no template merge, no idempotence,
  // fixed mutation_id "3" — matches competitor's exact GraphQL shape.
  const cleanVars = !!job.cleanVariables;
  const effectiveStableIds = cleanVars
    ? { mutationId: '3', idempotenceToken: null }
    : stableIds;
  if (cleanVars) {
    LOG('🧪 Clean variables mode (skipping template merge + idempotence) | preset:', job.textFormatPresetId);
  }

  const baseVariables = postToProfile
    ? composeProfileVariables(safeText, attachments, job.textFormatPresetId, effectiveStableIds, { pageFeed: job.targetKind === 'page_feed' })
    : composeGroupVariables(groupId, safeText, attachments, job.textFormatPresetId, effectiveStableIds, isPageMode);
  // v10.10: in clean mode, also delete idempotence_token from input.
  if (cleanVars && baseVariables?.input) {
    delete baseVariables.input.idempotence_token;
  }
  // Forward-compat: if FB has silently added a required field, the captured
  // template (from the user's own real FB traffic) supplies it. Our per-post
  // fields take precedence — template only fills gaps.
  // v10.10: when cleanVars set, SKIP merge to match competitor's bare shape.
  const variables = (cleanVars || !_capturedVariablesTemplate)
    ? baseVariables
    : mergeVariables(_capturedVariablesTemplate, baseVariables);

  // Concise pre-send diagnostic: everything needed to understand WHAT we're
  // about to post and AS WHOM, on one line, right before the mutation fires.
  const _target = postToProfile ? `profile/${fbSession.actorId}` : `group/${groupId}`;
  const _mediaCount = Array.isArray(attachments) ? attachments.filter(a => a && !a.link).length : 0;
  // Final-text diagnostic — what's actually in `variables.input.message.text`,
  // the literal string FB receives. If this is shorter than the `▶ job in` log
  // earlier, text was lost somewhere in the pipeline.
  const _finalMsgLen = (variables?.input?.message?.text || '').length;
  const _finalMsgHash = _hash8(variables?.input?.message?.text || '');
  const _composedBlocks = variables?.input?.composed_text?.blocks?.length || 0;
  // #1 — post provenance: scheduled(daily) vs immediate.
  const _src = job.scheduleInfo?.source === 'scheduled'
    ? `scheduled(${job.scheduleInfo.frequency || '?'})`
    : (job.scheduleInfo?.source === 'immediate' ? 'immediate' : 'unknown');
  // #4 — doc_id source: dynamic (remote-config / harvest) vs hardcoded fallback.
  // If the resolved docId is present in the live FB_DOC_IDS map it came from
  // the remote config / capture; otherwise we fell back to the hardcoded id.
  const _docKey = hasMedia ? 'ComposerStoryCreateMutationMedia' : 'ComposerStoryCreateMutation';
  const _docSrc = (FB_DOC_IDS[_docKey] && FB_DOC_IDS[_docKey] === docId) ? 'dynamic' : 'hardcoded';
  // #3 — token freshness: age since last refresh vs TTL.
  const _tokAgeS = fbSession.lastRefresh ? Math.round((Date.now() - fbSession.lastRefresh) / 1000) : -1;
  setStep(_mediaCount > 0 ? 'Publishing the post (with media)…' : 'Publishing the post…');
  LOG(`▶ posting → src=${_src} docId=${docId}(${_docSrc}) target=${_target} actor=${fbSession.actorId}(${_identityMode}) media=${_mediaCount} msgText.len=${_finalMsgLen} hash=${_finalMsgHash} blocks=${_composedBlocks} tokenAge=${_tokAgeS}s`);
  LOG('  calling ComposerStoryCreateMutation with doc_id:', docId, 'hasMedia:', hasMedia, 'profile:', postToProfile);
  const raw    = await fetchGraphQL(docId, 'ComposerStoryCreateMutation', variables);

  // ── 🔒 did everything we sent actually LAND? ─────────────────────────────
  // The guard above this function counts UPLOAD failures. It cannot see the
  // other way media goes missing: Facebook accepting the post and silently
  // dropping an attachment. That matters now that a set may hold photos AND a
  // video — a combination never proven against the live API — because the
  // failure would be invisible: 200 OK, a real post, missing media, across
  // every group in the campaign.
  //
  // 🪤 Calibrated to only speak when it has EVIDENCE. Facebook does not
  // guarantee it echoes upload ids, so "none of them appear" means we cannot
  // tell, not that they were dropped. Only a PARTIAL echo — some ids present,
  // others absent — is a real signal.
  try {
    const _sentIds = (attachments || [])
      .map((a) => (a && (a.photo?.id || a.video?.id)) || null)
      .filter(Boolean).map(String);
    if (_sentIds.length > 1 && typeof raw === 'string') {
      const _echoed = _sentIds.filter((id) => raw.includes(id));
      // v2026-10-12 · Facebook's answer lists at most MEDIA_ECHO_MAX (5) of the photos — 1.2.9.84 flagged 3,988 posts
      // "partial" with exact whole numbers dropped (1–5, peaking at 5) on ~every multi-photo post that landed. Fewer
      // than min(sent, 5) echoed is the only evidence of a drop.
      const MEDIA_ECHO_MAX = 5;
      if (_echoed.length > 0 && _echoed.length < Math.min(_sentIds.length, MEDIA_ECHO_MAX)) {
        WARN(`⚠️ MEDIA_PARTIAL: sent ${_sentIds.length} attachments, Facebook's response only references `
           + `${_echoed.length}. The post went out with less media than requested.`);
        _partialMediaSummary = { expected: _sentIds.length, uploaded: _echoed.length, stage: 'server-drop' };
      }
    }
  } catch (_) { /* a diagnostic must never break a post that succeeded */ }

  const result = parseStoryResponse(raw);
  // Always attach a raw sample so background.js can log it for debugging
  result._rawSample = raw.slice(0, 8000);

  // v10.8 (2026-05-02): detect FB silently dropping the BG color.
  // Symptoms in `_rawSample`:
  //   "story_id":null    + "post_id":null    + "publishing_flow":"FALLBACK"
  // For BG color posts (we sent text_format_preset_id !== '0'), this is
  // a signal that FB rejected the BG and rendered as plain text. Caller
  // (background.js) sees `_bgDropped: true` and falls back to the DOM
  // path so the user gets a real BG-rendered post.
  const wantedBg = job.textFormatPresetId && job.textFormatPresetId !== '0';
  if (wantedBg && result.success) {
    const dropIndicators =
      /"story_id"\s*:\s*null/.test(raw) &&
      /"post_id"\s*:\s*null/.test(raw) &&
      /"publishing_flow"\s*:\s*"FALLBACK"/.test(raw);
    if (dropIndicators) {
      // v2026-10-02: NOT a drop. Live in the QA Chrome, a blue (1365883126823705) and a black (1881421442117417)
      // post both came back FALLBACK with story_id/post_id null — and both show their colour on Facebook. The
      // signal was right in May 2026, when hex codes were sent; with numeric preset ids it means nothing.
      LOG('🎨 colour post: Facebook answered FALLBACK + no story_id (normal for colour posts — the colour renders)');
    } else {
      LOG('✅ BG color likely rendered (no FALLBACK signal)');
    }
  }

  // FALLBACK-WITH-MEDIA diagnostic (added 2026-05-31 after Ben Giles' log):
  // when FB falls back during a MEDIA post + spawns field_exception errors
  // on the photo-attachment-rendering path, the photo often doesn't render
  // even though we got a legacy_story_id back. Surface this loudly so the
  // user (and future logs) can see exactly what happened.
  if (hasMedia && /"publishing_flow"\s*:\s*"FALLBACK"/.test(raw)) {
    const fieldExceptionCount = (
      raw.match(/"severity"\s*:\s*"ERROR"[\s\S]{0,300}?photo_attachment_resolution_renderer/g) || []
    ).length;
    if (fieldExceptionCount > 0) {
      // BENIGN (confirmed 2026-05-31 — user verified the image DOES appear on
      // the FB post despite these errors). The field_exception is FB's
      // RESPONSE renderer failing to inline-build the story-preview card in the
      // mutation reply — it does NOT mean the photo failed to attach. Logged at
      // info level so it stops looking like a failure.
      LOG(`ℹ️ FB used FALLBACK publish flow for this media post (${fieldExceptionCount} response-render field_exception) — image still attaches; benign.`);
    } else {
      LOG('ℹ️ FB used FALLBACK publish flow for this media post (no field_exception) — benign.');
    }
  }

  // Video posts often return success without a story_id (video still processing)
  // Guard: don't swallow pending_approval — parseStoryResponse already flagged
  // that case and background.js needs to see the signal to mark the row as
  // "pending" in Posting Results (not "successful").
  if (!result.success && hasMedia && result.error !== 'pending_approval') {
    const hasCritical = raw.includes('"severity":"CRITICAL"');
    const hasStoryObject = /"story_create"\s*:\s*\{/.test(raw);
    if (!hasCritical && hasStoryObject) {
      LOG('  media post — no story_id yet but no critical errors, treating as success');
      const fallbackUrl = postToProfile
        ? `https://www.facebook.com/${fbSession.actorId}/`
        : `https://www.facebook.com/groups/${groupId}/`;
      return { success: true, id: 'processing', url: fallbackUrl };
    }
  }

  if (result.success) {
    // Ensure a full post URL is always available — Facebook sometimes returns
    // a relative URL or null. Fall back to constructing it from groupId + storyId.
    if (!result.url?.startsWith('http') && result.id && result.id !== 'processing') {
      result.url = postToProfile
        ? `https://www.facebook.com/${fbSession.actorId}/`
        : `https://www.facebook.com/groups/${groupId}/permalink/${result.id}/`;
    }
    LOG('✅ Post success — id:', result.id, 'url:', result.url);
    if (result.warning) WARN('Post warning:', result.warning);
    // Early ban-risk warning: the post went up but FB flagged it as spam / shadow-limited.
    // We do NOT stop — just surface the signal so the user can slow down / vary content.
    if (result.spamFlagged) {
      WARN('⚠️ Posted but FB flagged it as SPAM (shadow-limited) — slow down / vary content (Spintax) to avoid a block');
    }
    // ── Auto-comment pre-flight: only comment when the post is genuinely LIVE ──
    // The post-create result is the authoritative source of liveness (our
    // parseStoryResponse already extracts the pending / processing signals).
    // Commenting onto a placeholder / pending / non-real id is a wasted call
    // and a bot-pattern signal, so we gate on a real numeric feedback id and
    // the absence of any pending/processing flag.
    if (job.commentText || job.commentImageId) {
      const fid = String(result.id ?? '');
      const isRealFeedbackId = /^\d{6,}$/.test(fid); // FB story ids are long numerics
      const isPlaceholder = fid === 'processing' || fid === '';
      const isPendingOrUnavailable =
        result.warning === 'pending_approval' ||
        result.error === 'pending_approval' ||
        /pending|approval|isn'?t available|not available/i.test(String(result.warning || ''));
      const commentTargetLive = isRealFeedbackId && !isPlaceholder && !isPendingOrUnavailable;

      if (!commentTargetLive) {
        WARN('  auto-comment skipped — post not confirmed live (id:', fid || '∅',
             '| warning:', result.warning || '∅', ') — not commenting, not retrying');
      } else {
        // Random 15–45s human delay before the auto-comment (per Liran's request).
        // A real person doesn't comment the instant they post; this matches the
        // competitor's post→comment window. Trade-off (chosen on purpose): it adds
        // up to 45s to every post-that-has-a-comment, so it DOES eat into the
        // campaign's pacing budget. Revert to base-3s+jitter if it's too slow.
        const COMMENT_DELAY_MIN_MS = 15000;
        const COMMENT_DELAY_MAX_MS = 45000;
        const commentDelay = COMMENT_DELAY_MIN_MS
          + Math.floor(Math.random() * (COMMENT_DELAY_MAX_MS - COMMENT_DELAY_MIN_MS + 1));
        setStep('Posted ✓ — waiting ' + Math.round(commentDelay / 1000) + 's before first comment…');
        LOG('  auto-comment: post live — waiting', commentDelay, 'ms (15–45s random) before commenting');
        await new Promise(r => setTimeout(r, commentDelay)); // let Facebook index the new post
        // v2026-09-23: the right-after comment may carry a photo (read by key from MediaDB), and
        // uses one stable mutation id per post, so a retried request cannot read as a second comment.
        let _cPhoto = null;
        if (job.commentImageId) {
          let _cdb = null;
          try {
            _cdb = await _idbWithTimeout(openMediaDB(), IDB_OPEN_TIMEOUT_MS, 'openMediaDB');
            _cPhoto = await _idbWithTimeout(getBlobById(_cdb, job.commentImageId), IDB_READ_TIMEOUT_MS, 'getBlobById');
          } catch (e) { WARN('  comment photo read failed —', e?.message || e); }
          finally { try { _cdb && _cdb.close(); } catch (_) {} }
          if (!_cPhoto || !_cPhoto.size) { _cPhoto = null; WARN('  comment photo not found in local storage — text only'); }
        }
        let cres;
        if (!(job.commentText || _cPhoto)) cres = { posted: false, skipped: 'photo_missing' };
        else if (!(await claimRightAfterComment(result.id))) {
          // v2026-10-23 · an earlier delivery of this same post already sent (or started) its comment — see claimRightAfterComment
          WARN('  auto-comment NOT sent again — this post already got its comment from an earlier try of the same job (it may be under the post); never twice');
          cres = { posted: false, skipped: 'comment_already_sent' };
        } else {
          cres = await postFbComment(result.id, job.commentText || '', { photoBlob: _cPhoto, clientMutationId: 'c_' + String(result.id) + '_0' });
        }
        if (cres && cres.posted === false) {
          WARN('  auto-comment not posted —', cres.skipped || 'unknown', '(non-fatal, campaign continues)');
        }
        // Surfaced on the result so the worker can log and count it (it was invisible before).
        result._comment = cres ? { posted: !!cres.posted, skipped: cres.skipped || null, photoDropped: !!cres.photoDropped } : null;
      }
    }
  } else {
    // Single actionable failure line: WHERE it failed, FB's own code + mid,
    // and the human-readable reason — the "why a post failed" the user asked
    // for. fbErrorCode/fbErrorMid come straight from FB's CRITICAL error entry.
    // pending_approval is NOT a real failure — it lands here only because of
    // the success-flag shape, so log it as ⏳ pending (background.js still marks
    // the row "pending" via its own result.error check, unchanged).
    const _failTarget = postToProfile ? `profile/${fbSession.actorId}` : `group/${groupId}`;
    if (result.error === 'pending_approval') {
      LOG(`⏳ Pending admin approval — ${_failTarget} (submitted, awaiting moderator)`);
    } else {
      ERR(`❌ Post failed — ${_failTarget} code=${result.fbErrorCode || 'none'} mid=${result.fbErrorMid || 'none'} :: ${result.error}`, result.raw || '');
    }
    // Classify so background can decide whether to stop campaign. Pass
    // context so 3809006-in-Brand-Mode gets the per-group treatment instead
    // of the account-wide 24h cooldown.
    const cls = categorizeFbError(result.error, {
      brandModeActive: !!(brandMode && brandMode.actorType === 'page'),
      actingAsPage: _identityMode === 'PAGE',
      fbCode: result.fbErrorCode,   // language-independent classification
    });
    result.errorType = cls.type;
    result.stopCampaign = cls.stop;
    // Turn the bucket into a plain "what to do" hint so the log reads as advice,
    // not just a code. Additive — does not change retry/stop behaviour.
    const _hint = ({
      GROUP_BLOCKED:      'this group restricts posting (FB anti-spam) — skipped, campaign continues',
      GROUP_BLOCKS_PAGES: 'this group blocks posts from Pages — switch to your personal profile to post here',
      AUTH:               'session expired / 2FA — open Facebook, complete verification, then retry',
      CRITICAL:           'account-level rate-limit/block — pause posting 1–2h, slow the pacing, add Spintax variations',
      WARNING:            'spam-pattern or transient FB error — vary the text (Spintax), wait, then retry',
      SOFT:               'permission/group-state issue — posting may be off or members-only; skipped',
      MEDIA_LOST:         'the image/video is no longer in local storage — remove the media from the post, upload it again, then re-run',
      // v2026-08-28: the files are PRESENT. Saying "upload them again" here is
      // what sent one customer round in circles for a day.
      MEDIA_UPLOAD_NETWORK: 'your images are fine, but the upload could not reach Facebook — check antivirus, VPN or firewall settings (Safe Mode avoids that endpoint entirely)',
      MEDIA_UPLOAD_REJECTED: 'Facebook refused the photo upload for this group — the file is fine; Safe mode uploads it through Facebook\'s own composer',
      MEDIA_UNREADABLE:   'the photo is in a format Facebook cannot accept (HEIC/HEIF from an iPhone) — save or export it as JPEG and add it again',
      REQUEST_INVALID:    'FB rejected the request shape (bad media/variables) — auto-retry will attempt fixes',
      UNKNOWN:            'unrecognized FB response — see the raw block above for details',
    })[cls.type] || 'see raw response above';
    if (result.error !== 'pending_approval') {
      LOG(`  → classified ${cls.type} (stop=${cls.stop}) — ${_hint}`);
    }
    if (cls.stop) ERR('🔴 CRITICAL error type:', cls.type, '— background should stop campaign');
    else if (cls.type === 'GROUP_BLOCKS_PAGES') WARN('🟡 Group rejected Page post — skipping group, continuing campaign');
    else if (cls.type === 'REQUEST_INVALID') WARN('🟡 FB rejected request shape — see [1675012-debug] log for diff investigation');

    // v10.5 (2026-05-02): two-tier auto-retry when FB rejects a media post
    // with REQUEST_INVALID (code 1675012) or GROUP_BLOCKED (code 3809006).
    //
    //   Tier 1 (NEW): re-upload all media (fresh video_id / photo upload_id)
    //                 and retry WITH attachments. If FB's first rejection
    //                 was a token race / stale upload reference, this
    //                 succeeds and the user gets the video posted.
    //   Tier 2 (v10.4 behavior, REMOVED v2026-10-12): dropped the media and
    //                 retried text-only — a post without its photos counted
    //                 as a success. See the note where it used to run.
    //
    // The two-tier order matters: we'd rather post the video than fall
    // back to text. Tier 1 only runs when there IS media to re-upload.
    // Both tiers skipped for text-only original requests — there's nothing
    // to drop or re-upload, so retry would just repeat the same call.
    //
    // User evidence (log 1777718139910): in a 6-group campaign, post 6
    // (group 690205029606436) failed with 1675012, the v10.4 text-only
    // fallback succeeded → user got text but lost the video. Tier 1 gives
    // that video a second chance.
    if ((cls.type === 'REQUEST_INVALID' || cls.type === 'GROUP_BLOCKED') && hasMedia) {
      const blockReason = cls.type === 'REQUEST_INVALID'
        ? '1675012 (request shape rejected)'
        : '3809006 (anti-spam ML)';
      const reasonSlug = cls.type === 'GROUP_BLOCKED' ? 'group_block' : 'request_invalid';

      // ── Tier 1 — re-upload media + retry WITH attachments ────────────────
      // Wrapped in a 90-second hard timeout so a hung FB connection (no
      // built-in fetch timeout in this codebase) can't stall the campaign
      // forever. Worst case: tier-1 times out at 90s, falls through to
      // tier-2 (text-only, ~5s). Total worst case per failed group: ~95s.
      let tier1Won = false;
      let tier1TimedOut = false;   // v2026-10-12 · see below — a late Tier 1 may still land
      try {
        LOG(`🔁 Tier 1 — re-uploading media after ${blockReason} and retrying with fresh attachments...`);
        const TIER1_TIMEOUT_MS = 90 * 1000;
        const tier1Logic = async () => {
          const fresh = await refreshMediaAttachments(job, groupId);
          const freshHasMedia = Array.isArray(fresh) && fresh.some(a => a && !a.link);
          if (!freshHasMedia) return { _skipped: true, reason: 'no_media' };
          const reuploadDocId = FB_DOC_IDS.ComposerStoryCreateMutationMedia || '9286110778162996';
          const freshVars = postToProfile
            ? composeProfileVariables(safeText, fresh, job.textFormatPresetId, stableIds, { pageFeed: job.targetKind === 'page_feed' })
            : composeGroupVariables(groupId, safeText, fresh, job.textFormatPresetId, stableIds, isPageMode);
          const freshMerged = _capturedVariablesTemplate
            ? mergeVariables(_capturedVariablesTemplate, freshVars)
            : freshVars;
          const tier1Raw = await fetchGraphQL(reuploadDocId, 'ComposerStoryCreateMutation', freshMerged);
          const tier1Result = parseStoryResponse(tier1Raw);
          return { tier1Raw, tier1Result };
        };

        const tier1Outcome = await Promise.race([
          tier1Logic(),
          new Promise((_, rej) =>
            setTimeout(
              () => rej(new Error(`tier1_timeout_after_${TIER1_TIMEOUT_MS}ms`)),
              TIER1_TIMEOUT_MS
            )
          ),
        ]);

        if (tier1Outcome._skipped) {
          WARN('Tier 1 skipped — re-upload returned no media (MediaDB cleared or all uploads failed)');
        } else {
          const { tier1Raw, tier1Result } = tier1Outcome;
          // Mirror the same "media post returned 200 but no story_id yet"
          // tolerance the original path uses (line ~1844). FB sometimes
          // accepts the post but defers the story_id while the video is
          // processed. Treat that as success.
          if (tier1Result.success) {
            LOG('✅ Tier 1 succeeded with fresh media — id:', tier1Result.id);
            tier1Result._mediaReuploaded = true;
            tier1Result.warning = `media_reuploaded_after_${reasonSlug}`;
            Object.assign(result, tier1Result, { errorType: undefined, stopCampaign: false });
            tier1Won = true;
          } else if (tier1Result.error === 'pending_approval') {
            // pending_approval = FB accepted the post, group has post-approval
            // enabled, awaiting moderator. Treat as tier 1 win — the video WAS
            // submitted to the group, just pending. Don't fall through to
            // tier 2 (which would drop the media). background.js's
            // `workerPending` check (line ~2552) reads result.error to mark
            // this row as "pending" in Posting Results.
            LOG('✅ Tier 1 — media post accepted, pending admin approval');
            Object.assign(result, tier1Result, {
              _mediaReuploaded: true,
              errorType: undefined,
              stopCampaign: false,
            });
            tier1Won = true;
          } else {
            const t1Critical = tier1Raw.includes('"severity":"CRITICAL"');
            const t1Story    = /"story_create"\s*:\s*\{/.test(tier1Raw);
            if (!t1Critical && t1Story) {
              LOG('✅ Tier 1 — media post accepted, story_id pending');
              const fbUrl = postToProfile
                ? `https://www.facebook.com/${fbSession.actorId}/`
                : `https://www.facebook.com/groups/${groupId}/`;
              Object.assign(result, {
                success: true, id: 'processing', url: fbUrl,
                _mediaReuploaded: true,
                warning: `media_reuploaded_after_${reasonSlug}`,
                errorType: undefined, stopCampaign: false,
              });
              tier1Won = true;
            } else {
              WARN('Tier 1 (re-upload) also failed:', tier1Result.error);
            }
          }
        }
      } catch (e) {
        WARN('Tier 1 (re-upload) threw:', e?.message);
        if (/^tier1_timeout_after_/.test(String(e?.message || ''))) tier1TimedOut = true;
      }

      // ── v2026-10-12 · Tier 2 (drop the media, post text-only) is GONE ─────────────────────
      // It recorded a post WITHOUT its photos/video as a plain success: `_mediaDropped` was read
      // nowhere, so the user saw "successful" for a post that went out with none of what they
      // attached, and no telemetry counted it. For 1675012 it also took the place of the Safe
      // failover, which posts WITH the media through Facebook's own composer. And every refused
      // group cost one more automated attempt on an account Facebook was already refusing.
      // The original refusal now stands (GROUP_BLOCKED: the group refuses; REQUEST_INVALID: the
      // worker sends it through Safe).
      // A Tier 1 that ran out of time may still land (nothing aborts its request): the outcome is
      // UNKNOWN, so nothing re-sends this group — no Safe failover, no duplicate.
      if (!tier1Won && tier1TimedOut) {
        WARN('Tier 1 ran out of time — its post may still land; this group is not sent again');
        Object.assign(result, {
          success: false,
          error: 'media re-upload retry timed out — the post may still appear in the group',
          errorType: 'UNKNOWN',
          stopCampaign: false,
          _tier1Uncertain: true,
        });
      }
    }
  }

  // Brand Mode: restore fbSession.actorId to the user's real uid so the
  // next post (which may be Personal-mode or a different Page) doesn't
  // inherit this iteration's override. Safe no-op when brandMode wasn't set.
  if (brandMode && brandMode.actorType === 'page') {
    fbSession.actorId = fbSession.uid;
    LOG(`  identity override reset to session actor (${fbSession.uid}) after Page-mode post`);
  }

  // v10.5 (2026-05-02): defensive reset of campaign-level composer_session_id.
  // Each dispatchPost overwrites this at entry (line ~1716) so a leak across
  // campaigns is theoretically already prevented, but in case some path
  // bypasses the entry (single-post message handler from a future feature,
  // unforeseen call site), explicit cleanup at exit is cheap insurance.
  _activeComposerSessionId = null;

  return result;
}

// v2026-08-09: structural backstop, independent of whatever caused an overlap
// on the SW side. This handler previously accepted a second EXECUTE_POST
// while dispatchPost() was still running one — the heartbeat branch above
// answers 'alive' immediately even mid-post (by design, so a slow-but-alive
// post isn't mistaken for a dead tab), so nothing here ever refused a second
// job. Two concurrent dispatchPost() calls would share mutable module-level
// state (fbSession, _activeComposerSessionId). 'worker_busy' isn't
// stopCampaign/WARNING/SOFT/GROUP_BLOCKED/GROUP_UNRESOLVABLE, so it flows
// through the existing 1-retry-eligible-failure path with no special-casing
// needed on the SW side.
let _dispatchBusy = false;

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'heartbeat') {
    sendResponse({ status: 'alive' });
    return;
  }
  if (msg.type === 'EXECUTE_POST') {
    if (_dispatchBusy) {
      LOG('📨 EXECUTE_POST rejected — already dispatching:', msg.groupUrl);
      sendResponse({ success: false, error: 'worker_busy', errorType: 'EXCEPTION' });
      return;
    }
    LOG('📨 Received EXECUTE_POST job:', msg.groupUrl);
    _dispatchBusy = true;
    dispatchPost(msg)
      .then(r  => {
        // 🔴 v2026-09-26 · a 429 anywhere in this dispatch (a Tier 1/2 retry, the video config, the
        // link preview) ends it as a campaign stop, whatever the first answer was — unless the
        // post itself went out, which is a success like any other.
        if (_fbRateLimitHit && !(r && r.success)) r = _rateLimitResult(r);
        // The one place a result crosses back to the SW, so the one place this
        // needs attaching. Only ever present on a partial-media post.
        if (_partialMediaSummary && r && typeof r === 'object') {
          r._mediaExpected = _partialMediaSummary.expected;
          r._mediaUploaded = _partialMediaSummary.uploaded;
        }
        // v2026-09-23: WHO the post was made as — a queued comment must go out as the same identity.
        if (r && typeof r === 'object' && fbSession && fbSession.actorId) r._actorId = String(fbSession.actorId);
        LOG('📤 Sending result:', r.success);
        sendResponse(r);
      })
      .catch(e => {
        ERR('📤 Sending error:', e.message);
        // v2026-09-26: a 429 stops the campaign (CRITICAL + stopCampaign — the same halt card and
        // no-retry path as Facebook's own rate-limit code 1390008).
        if (e?.mgpRateLimited || _fbRateLimitHit) { sendResponse(_rateLimitResult({ error: e.message })); return; }
        sendResponse({ success: false, error: e.message, errorType: e?.errorType || 'EXCEPTION' }); // v23 (M6): typed → histogram shows EXCEPTION not UNKNOWN; v64: honour e.errorType (e.g. GROUP_UNRESOLVABLE)
      })
      .finally(() => { _dispatchBusy = false; });
    return true; // keep channel open for async
  }
  // v2026-10-01: ONE listing (buy & sell groups). Same one-job-at-a-time rule as a post; a busy
  // engine answers before anything is sent, so the worker may ask again.
  if (msg.type === 'EXECUTE_LISTING') {
    if (_dispatchBusy) {
      sendResponse({ sent: false, reason: 'worker_busy' });
      return;
    }
    LOG('📨 Received EXECUTE_LISTING job —', (msg.groupIds || []).length, 'group(s)');
    _dispatchBusy = true;
    dispatchListing(msg)
      .then((r) => sendResponse(r || { sent: 'unknown', reason: 'listing_unconfirmed' }))
      .catch((e) => { ERR('listing dispatch threw:', e?.message || e); sendResponse({ sent: 'unknown', reason: 'listing_unconfirmed', error: String(e?.message || e) }); })
      .finally(() => { _dispatchBusy = false; });
    return true;
  }
  // v2026-10-01: a home listing's address search (a read — never busy-gated).
  if (msg.type === 'EXECUTE_ADDRESS_SEARCH') {
    // Never while a post / comment / listing is being sent: the search rewrites the shared session (fbSession).
    if (_dispatchBusy) {
      sendResponse({ ok: false, error: 'busy', results: [] });
      return;
    }
    searchListingAddress(msg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e), results: [] }));
    return true;
  }
  // v2026-09-23: one queued comment (the worker's comment queue). Same one-job-at-a-time rule
  // as a post: a busy engine answers worker_busy and the queue simply tries again next minute.
  if (msg.type === 'EXECUTE_COMMENT') {
    if (_dispatchBusy) {
      sendResponse({ posted: false, skipped: 'worker_busy' });
      return;
    }
    LOG('📨 Received EXECUTE_COMMENT job:', msg.taskId);
    _dispatchBusy = true;
    _stepMuted = true;
    dispatchComment(msg)
      .then((r) => sendResponse(r || { posted: false, skipped: 'comment_unconfirmed' }))
      .catch((e) => { ERR('comment dispatch threw:', e?.message || e); sendResponse({ posted: false, skipped: 'request_error', error: String(e?.message || e) }); })
      .finally(() => { _dispatchBusy = false; _stepMuted = false; });
    return true;
  }
});

// ── Lifeline — reconnects when background SW restarts ────────────────────────
// C5: added ping/pong. Background sends {type:'ping'} every 20s; we answer
// with {type:'pong'}. An actively-trafficked port prevents the SW from going
// idle during long campaigns, on top of the existing chrome.alarms keep-alive.
function connectLifeline() {
  try {
    const p = chrome.runtime.connect({ name: 'worker-lifeline' });
    p.onMessage.addListener((m) => {
      if (m && m.type === 'ping') {
        try { p.postMessage({ type: 'pong' }); } catch (_) {}
      }
    });
    p.onDisconnect.addListener(() => setTimeout(connectLifeline, 1000));
  } catch (_) { setTimeout(connectLifeline, 3000); }
}
connectLifeline();

LOG('engine ready — waiting for EXECUTE_POST jobs');
