// Load configuration (remote or default) and initialize the script
let config = null;

// ── DEBUG RELAY: sends content-script logs to the background console ──────────
// Background handles action:'content_debug_log' and console.logs them there.
// This lets us see all [MSG]/[ocai]/[inject] logs even when the tab closes fast.
function cLog(...args) {
  console.log(...args); // keep local log
  try {
    const msg = args.map(a => {
      try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch(e) { return String(a); }
    }).join(' ');
    chrome.runtime.sendMessage({ action: 'content_debug_log', msg }).catch(() => {});
  } catch (e) {}
}

// Like cLog, but FLAGS the line for relay into the worker's persistent,
// downloadable 24h engine log (level 'warn'|'error'). Use at failure/abort
// points so a Safe/DOM bug stays diagnosable AFTER the posting tab closes
// (its console is gone). Verbose cLog stays console-only → no log flooding.
function cReport(msg, level = 'warn') {
  try { console.log('[REPORT]', msg); } catch (e) {}
  try {
    // 🔑 `t` is stamped HERE, in the page, at the instant the thing happened.
    // The engine page stamps its own arrival time; the DIFFERENCE between the
    // two is a live measurement of how hard this machine is throttling the
    // occluded tab — the question we could not answer for
    // one customer. Without it the log is a mix of two clocks
    // and looks monotonic while hiding seconds of lag.
    chrome.runtime.sendMessage({ action: 'content_debug_log', msg: String(msg), relay: true, level, t: Date.now() }).catch(() => {});
  } catch (e) {}
}

// Structured crash-report breadcrumb, relayed to the service worker (which owns
// the only Sentry transport — this file cannot import an SDK, and a content
// script talking to a third party from inside facebook.com is not something we
// want regardless).
//
// `category` MUST be a literal written here at the call site, and `data` numbers
// or short fixed labels — never text read from the page. Post text and group
// names/URLs must never enter this pipe; the SW scrubs anyway, but the intent is
// that there is nothing to scrub. Fire-and-forget, never throws, never awaited.
function cSentryBreadcrumb(category, data) {
  try {
    chrome.runtime.sendMessage({
      action: 'telemetry_relay', kind: 'breadcrumb',
      category: String(category), level: 'warning', data: data || {},
    }).catch(() => {});
  } catch (e) {}
}

// reportStep(label): surface the CURRENT human-readable step to the user's popup
// (live, while they wait) AND to the downloadable log. The popup
// (PostProgressManager) listens to chrome.storage.local.currentPostStep and shows
// it under the spinner; the worker clears the key between posts.
let _lastStepLabel = ''; // v18: last reportStep — surfaced in post-unconfirmed so the log shows WHICH phase stalled.
/**
 * 🔑 Set while a post is in flight so every reported step re-arms the
 * post-confirm watchdog. Without it the watchdog is a single fixed timer and a
 * flow that is MOVING — just slowly — is killed exactly like a wedged one.
 * Cleared in the finally that clears the watchdog itself.
 */
/**
 * 🌍 Facebook's "we did not publish this" wording, in the 13 languages our
 * customers actually post in. We used to carry THREE, all English — so on a
 * German or Spanish account Facebook rejected the post and we reported success.
 * This codebase has already been burnt twice by English-only decision text.
 *
 * ⛔ These DECIDE: a match writes operationDone:'failed'. So the three
 * single-word tokens (fehlgeschlagen · échec · gagal) are anchored to word
 * boundaries — unanchored they would match inside unrelated words and turn a
 * SUCCESSFUL post into a reported failure, which is exactly how
 * "anonym posten".includes("post") once made the extension click Facebook's
 * anonymous-posting toggle for every German customer.
 */
const FB_PUBLISH_FAILURE_PHRASES = [
  // en
  "couldn't be posted", 'failed to post', 'something went wrong',
  // de
  'konnte nicht gepostet', 'etwas ist schiefgelaufen',
  // es
  'no se pudo publicar', 'no se ha podido publicar', 'algo salió mal',
  // fr
  "n'a pas pu être publié", "une erreur s'est produite",
  // hi
  'पोस्ट नहीं किया जा सका', 'कुछ गलत हो गया',
  // hu
  'nem sikerült közzétenni', 'valami hiba történt',
  // id
  'tidak dapat diposting', 'terjadi kesalahan',
  // it
  'non è stato possibile pubblicare', 'qualcosa è andato storto',
  // pl
  'nie udało się opublikować', 'coś poszło nie tak',
  // pt
  'não foi possível publicar', 'algo deu errado',
  // tl
  'hindi na-post', 'may nangyaring mali',
  // vi
  'không thể đăng', 'đã xảy ra lỗi',
];
/** Single words — real rejection text, but only as WHOLE words. */
const FB_PUBLISH_FAILURE_WORDS = ['fehlgeschlagen', 'échec', 'gagal'];

/** True when a visible node's text is Facebook telling us the post did NOT go out. */
function looksLikePublishFailure(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  if (FB_PUBLISH_FAILURE_PHRASES.some((p) => t.includes(p.toLowerCase()))) return true;
  // ⛔ Word-anchored, and only for the standalone words above.
  return FB_PUBLISH_FAILURE_WORDS.some((w) => new RegExp('(^|[^\\p{L}])' + w + '($|[^\\p{L}])', 'iu').test(t));
}

let _postWatchdogRearm = null;

/**
 * 🔑 Set the moment publication is CONFIRMED — before the settle poll, the
 * permalink hunt and the first-comment pipeline, which are all enrichment of a
 * record that is already decided.
 *
 * ⛔ Deliberately NOT `operationDone:'successful'`. Writing that here is a bug
 * this codebase already had and fixed: the worker sees success, closes the
 * window, and the first-comment pipeline dies mid-flight ("comment: attempting"
 * with no outcome — see the RACE FIX note in waitForPostCompletion's finish()).
 * This flag is read ONLY by our own watchdog, so the worker keeps waiting for
 * the real operationDone and the comment still gets to finish.
 */
let _postLanded = false;
// v2026-09-15: has this post already sent its post-unconfirmed to Sentry? Reset with _postLanded.
let _postUnconfirmedSent = false;
// v2026-10-13 · "could not confirm" reaches Sentry from the WORKER, once per post, after it searched the group for the
// post (verifySafePostLanded). On 1.2.9.87 every unconfirmed post sent 2–3 events (post-unconfirmed, then
// timeout-no-completion or video-verify-failed) whether or not it had gone out, and a video that landed during the
// longer wait still had its post-unconfirmed. The page keeps the FIRST report of the post; the worker sends it or not.
let _unconfirmedHeld = false;
function _holdUnconfirmedReport(msg) {
  if (_unconfirmedHeld) return;
  _unconfirmedHeld = true;
  try { chrome.storage.local.set({ _unconfirmedReport: { t: Date.now(), msg: String(msg || '').slice(0, 700) } }); } catch (_) {}
}

/**
 * ⏱ Phase timing, free: reportStep already marks every boundary, so the only
 * thing missing was writing the clock down.
 *
 * One line per post turns "it was slow" into a diagnosis, and each reading has a
 * known fix: `text` in minutes → the paste ladder's 11 waits under a throttled
 * clock; `media` in minutes → the upload is the neck (adaptive timeout);
 * `composer` in minutes → the composer never opened (detection/language);
 * everything inflated evenly → the CLOCK itself is throttled, and only then is
 * the Web Lock / ISOLATED work justified.
 */
let _phaseMarks = [];
const _PHASE_OF = [
  // ⚠️ Specific first — 'other' is a diagnosis that tells us nothing.
  [/attaching the video/i, 'media'],
  [/uploading the video/i, 'media'],
  [/finishing the post/i, 'settle'],   // v2026-10-13 · the wait for the post's link after Post
  [/link preview/i, 'link'],
  [/preparing to publish/i, 'pace'],   // 🔑 OUR humanized wait, never Facebook's
  [/verifying the post content/i, 'verify'],
  [/composer/i, 'composer'],
  [/uploading image/i, 'media'],
  [/typing/i, 'text'],
  [/publishing/i, 'click'],
  [/reading the feed/i, 'settle'],
  [/first comment/i, 'comment'],
];
function _phaseName(label) {
  for (const [re, name] of _PHASE_OF) if (re.test(label)) return name;
  return 'other';
}
/** Emit the summary, once, at the end of a post. Never throws. */
function emitPhaseSummary() {
  try {
    if (_phaseMarks.length < 2) { _phaseMarks = []; return; }
    const totals = new Map();
    for (let i = 0; i < _phaseMarks.length; i++) {
      const cur = _phaseMarks[i];
      const end = (i + 1 < _phaseMarks.length) ? _phaseMarks[i + 1].at : Date.now();
      const name = _phaseName(cur.label);
      totals.set(name, (totals.get(name) || 0) + Math.max(0, end - cur.at));
    }
    const parts = [...totals.entries()].map(([k, v]) => k + ' ' + v + 'ms');
    const total = [...totals.values()].reduce((a, b) => a + b, 0);
    cReport('phases: ' + parts.join(' · ') + '  |  total ' + Math.round(total / 100) / 10 + 's', 'warn');
  } catch (e) { /* a diagnostic must never affect a post */ }
  _phaseMarks = [];
}

function reportStep(label) {
  try { _lastStepLabel = String(label); } catch (e) {}
  try { cReport('▸ ' + label, 'info'); } catch (e) {}
  // v1.2.9.62 · B.2 — the same beat, with a TIME on it, written from the TAB.
  // Everything the worker uses to decide "is this campaign alive" is written by
  // the worker's own timers, and MV3 kills that process on purpose. This stamp
  // survives it: a customer's log kept emitting [DOM] lines for 117 SECONDS after
  // we had declared her engine dead and taken her campaign apart.
  try { chrome.storage.local.set({ currentPostStep: String(label), _domStepAt: Date.now() }); } catch (e) {}
  try { _phaseMarks.push({ label: String(label), at: Date.now() }); } catch (e) {}
  // Progress → the flow is alive → give it a fresh window (bounded by the
  // absolute ceiling inside the re-arm itself).
  try { if (_postWatchdogRearm) _postWatchdogRearm(); } catch (e) {}
}

// v18: _domFailSnapshot — a SANITIZED snapshot of what's on screen at a DOM failure (the open
// dialog's visible button aria-labels + heading), capped ~600 chars. Lets the owner SEE the composer
// state from the log alone (language/selector drift). Labels/structure ONLY — never post text, feed,
// or personal data. Adopts the competitor's snapshot-on-failure technique, sanitized.
// v85: text of any visible FB notice / alert / toast surface (a block banner like
// "Sorry, this feature isn't available right now" / "unusual activity", a success
// toast "posted", or a "pending review" notice). This is THE signal that separates
// an FB BLOCK from a missed-success from a silent paint-stall — all three otherwise
// log identically. Notice/announcement text ONLY (role=alert / snackbar / toast /
// aria-live live regions) — never composer, post, feed, or personal data; capped 120.
// ── 🔴 v1.2.9.59 · the chat exclusion this function always needed ────────────
// A customer's log contained a line reading, verbatim:
//     notice: "Loading...Wed 4:04 PM Ok, I haven't either. Enter, Message sent
//              Wednesday 4:04pm"
// That is her private Messenger conversation. Facebook renders incoming chat
// into an aria-live region, this scanned `document` with no filter, and the
// FIRST match in DOM order wins — the docked chat rail sits early in the tree,
// so it beat every real Facebook toast. On the three error paths that embed
// this string the text is uploaded to Sentry with her email attached, which
// breaks the one promise the privacy policy makes ("we never see the text you
// write"). It is also a CORRECTNESS bug: this text decides outcomes
// (_isBlockNotice fails a post, hasSuccessToast confirms one), so an ordinary
// word in a chat message — "posted", "live", "your post" — could flip a real
// post's result.
//
// 🔑 The exclusion set below is not new. isForbiddenTarget (:4294) already uses
// exactly these selectors to keep the composer from resolving into Messenger;
// it was simply never applied here.
// 🪤 And the competitor is the proof it costs nothing: GPP 2.10.4 matches
// `role="alert"` only and does not read aria-live at all.
const _NOTICE_EXCLUDE = 'div[aria-label*="chat" i], div[aria-label*="message" i], div[aria-label*="messenger" i], [data-pagelet*="Chat"], [data-pagelet*="Inbox"], [data-pagelet*="MercuryFixedBottomPerch"], [role="complementary"], [role="navigation"], [role="banner"]';
function _visibleNoticeText() {
  try {
    const sels = '[role="alert"],[data-testid="snackbar"],[data-testid="toast"],[aria-live="assertive"],[aria-live="polite"]';
    // 🪤 An earlier draft ALSO narrowed this to the composer dialog. That was a
    // worse trade than it looked: Facebook renders block banners and toasts at
    // document level, OUTSIDE the dialog, and _isBlockNotice is what turns one
    // into a failure. Missing a block would keep a campaign posting into a live
    // restriction — far costlier than the leak being fixed. The exclusion list
    // is the fix; the scope stays the page.
    const nodes = Array.from(document.querySelectorAll(sels)).filter((n) => {
      if (n.offsetParent === null) return false;
      try { if (n.closest(_NOTICE_EXCLUDE)) return false; } catch (_) {}
      return true;
    });
    for (const n of nodes) {
      const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, 120);
    }
    return '';
  } catch (_) { return ''; }
}
// v86 (Part B): UNAMBIGUOUS Facebook block/banner phrases — mirrors the engine's proven
// vocabulary (mgp-engine-core.js categorizeFbError, the Fast-path strings FB actually
// returns). Used ONLY to turn a lingering-dialog "success" into a failure when a block
// banner is on screen. Deliberately NARROW: every phrase is an FB BLOCK string, NONE can
// appear in a success/pending notice ("posted"/"live"/"submitted"/"pending"/"approval"/
// "sharing" are absent). English-phrase-only for v86 (the banner renders English in most
// locales; the engine classifier is English-phrase-based and is the proven baseline).
// ⚠️ A wrong/too-broad add here causes a false-NEGATIVE → the user may MANUALLY repost
// (user-caused dup) — extend ONLY with real non-English block-banner samples in hand.
// English block phrases. This is the FAST path, not the only one — a banner is
// localised, so anything that relies on reading it is language-bound by nature.
// The structural check in _postDidNotPublish() is what actually holds in every
// language; this regex just recognises the common case sooner.
const _FB_BLOCK_RE = /\bfeature isn'?t available\b|\byou can'?t use this feature right now\b|\bthis content isn'?t available right now\b|\bunusual activity\b|\bsuspicious activity\b|\baction blocked\b|\byou'?re temporarily blocked\b|\bcan'?t post right now\b|\byou'?re posting too (fast|quickly)\b|\bgoing too fast\b|\bwe limit how often you can post\b|\bblocked from posting\b|\bcouldn'?t (post|share|publish)\b/i;
// Non-English block phrases, added ONLY with evidence — each one below was taken
// verbatim from a real customer engine log, never translated by hand. A guessed
// translation that never matches is worse than no entry: it reads as coverage.
//
// pl: 84 occurrences of FB code 3809006 in ~/Downloads/mgp-engine-logs-*.txt, 74
// of them in Polish. The English 10 matched the regex above; these 74 did not —
// same code, same block, opposite outcome. That is the whole case for this list.
//
// No \b anchors: JS \w is ASCII-only, so a boundary next to "ę"/"ą" behaves
// unintuitively. The phrases are long enough that a substring match is safe
// (verified against innocent Polish strings containing "funkcja"/"dostępna").
const _FB_BLOCK_RE_INTL = /ta funkcja nie jest obecnie dostępna|funkcja nie jest dostępna/i;
/**
 * Group type, read from the JSON Facebook embeds in the page's own <script> tags.
 *
 * A "Buy and Sell" (commerce) group does not accept an ordinary post, and the
 * extension has been completely blind to that: the Fast engine gets error 3809006
 * back, which is Facebook's catch-all and is indistinguishable from an anti-spam
 * block, so these attempts have been invisible in the logs and in the numbers.
 *
 * Read from the embedded JSON rather than the visible UI on purpose. The tab
 * label ("Buy and Sell") and the "Sell Something" button are translated, and
 * matching translated text is exactly what caused localised Facebook blocks to be
 * reported as successful posts. `feedType` is the same token in every language.
 *
 * Returns null for "could not tell" — never guessed as DISCUSSION. The null count
 * is reported separately so the reliability of this detection is itself
 * measurable rather than assumed.
 *
 * Pure: takes the HTML/script text, touches no DOM, so the Fast engine can reuse
 * it later on a fetched page and it stays unit-testable.
 */
function detectGroupFeedType(html) {
  try {
    const m = /"feedType"\s*:\s*"([A-Z_]{2,40})"/.exec(String(html || ''));
    return m ? m[1] : null;
  } catch (_) { return null; }
}

/**
 * Same question, asked of the live page. Reads only <script> contents — never
 * rendered text — so nothing here depends on the interface language.
 *
 * Returns 'BUY_AND_SELL' | 'DISCUSSION' | … | null (null = unknown).
 */
function readGroupFeedTypeFromPage() {
  try {
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      // Skip src-only tags: no inline body to read.
      const t = s.textContent;
      if (!t || t.indexOf('feedType') === -1) continue;
      const found = detectGroupFeedType(t);
      if (found) return found;
    }
    return null;
  } catch (_) { return null; }
}

/** True when a visible notice looks like a Facebook block, in any covered language. */
// v2026-10-12 · set when a dialog after the Post click carried Facebook's block notice (waitForPostCompletion) —
// the caller then reports 'post-blocked' instead of waiting more and writing 'timeout-no-completion' over it.
let _mgpPostBlockedNotice = false;
// v2026-10-19 · the text of the post being published (normalized), so a "notice" that is really OUR post's own words —
// shown in the composer, the feed or a preview — never decides failed/blocked (the false-"pending" bug's twins).
let _mgpOwnPostNorm = '';
let _mgpOwnPostHtml = '';   // v2026-10-19 · the same post as typed (detectPendingApproval's own-words check reads it)
function _ownNormOf(v) {
  // (audit F2) a skeleton: letters and digits only, NFKC — bold glyphs and emoji images compare equal to what we typed
  return String(v || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
/**
 * Facebook's "we did not publish this" on screen after a video post, or null. v2026-10-19 · never the composer's own
 * text box, nor a span that is just our post's words: a video post saying "something went wrong?" (or "gagal") was a
 * "video-publish-failed" while it was live.
 */
function _findPublishFailureAlert() {
  try {
    // (audit F3) …nor Messenger / the Notifications panel / anything hidden — a friend's chat saying "something went
    // wrong" must not fail a live video post
    const _panel = (e) => { try { const d = e.closest('[role="dialog"]'); return !!(d && d.querySelector('a[href*="/notifications"], [role="grid"]')); } catch (_) { return false; } };
    return Array.from(document.querySelectorAll('[role="alert"], [role="dialog"] span'))
      .find((e) => e.offsetParent !== null && !e.closest('[contenteditable="true"], [role="textbox"]')
        && !e.closest(_NOTICE_EXCLUDE) && !e.closest('[hidden]') && !_panel(e)
        && looksLikePublishFailure(e.textContent) && !_isOwnPostText(e.textContent)) || null;
  } catch (_) { return null; }
}
/** The post being published (set when the Safe post starts). */
function _setOwnPostText(html) { try { _mgpOwnPostNorm = _ownNormOf(html); } catch (_) { _mgpOwnPostNorm = ''; } _mgpOwnPostHtml = String(html || ''); _confirmToastPending = false; }
// v2026-10-19 · the toast Facebook showed right after Post said the post waits for the admins ("submitted to group
// admins for approval"). It is gone a few seconds later, so the settle could miss it and wait 12 s for the page text.
let _confirmToastPending = false;
/**
 * The moment Facebook's toast shows right after Post: run the SAME detector the settle runs (its exclusions and its
 * own-words check, nothing looser) and remember a surface verdict for this post — the toast may be gone by the first
 * settle poll. Cleared when the next post starts (_setOwnPostText).
 */
function _noteConfirmToast() {
  try { if (detectPendingApproval(_mgpOwnPostHtml, true) === 'surface') _confirmToastPending = true; } catch (_) {}
  return _confirmToastPending;
}
/** Before the Post click: did anything on the page already say "pending"? Then the early page rule stays off for this
 *  post (a surface, the page text, or an unreadable page all count as "it was there"). */
function _pendingBeforeClick(html) {
  try { return detectPendingApproval(html, true) !== false; } catch (_) { return true; }
}
/**
 * v2026-10-19 · decide "pending" before the end of the 12 s settle. 'toast' = Facebook's toast right after Post said so;
 * 'page_new' = page text that says so and was NOT there before our click, seen in 3 polls in a row over 1.5 s, while
 * our post's own link has not shown — not even after the first hover-reveal of its lazy timestamp link (1.5 s). A surface notice is decided by the caller as before (null here).
 */
function _earlyPendingDecision(o) {
  if (!o || o.pd === 'surface') return null;
  if (o.toastPending) return 'toast';
  if (o.pd === 'page' && !o.beforeClick && o.run >= 3 && (o.now - o.since) >= 1500 && o.hovered >= 1) {
    try { if (o.hasLink && o.hasLink()) return null; } catch (_) { return null; }
    return 'page_new';
  }
  return null;
}
/** True when `text` (a notice we read) is just part of the post we are publishing. */
function _isOwnPostText(text) {
  const t = _ownNormOf(text);
  return !!(t && t.length >= 8 && _mgpOwnPostNorm && _mgpOwnPostNorm.includes(t));
}
function _isBlockNotice(text) {
  const t = String(text || '');
  if (_isOwnPostText(t)) return false;
  return _FB_BLOCK_RE.test(t) || _FB_BLOCK_RE_INTL.test(t);
}

/**
 * OBSERVATION ONLY — this must never decide whether a post failed.
 *
 * The idea is sound: instead of reading a banner (language-bound), notice that
 * the composer still holds the text while Facebook is saying something, which
 * would mean the post never left. The problem is certainty. `_visibleNoticeText`
 * reads any visible `[role=alert]`/`aria-live` region, and Facebook uses those
 * for plenty of harmless things — chat, notification counts, loading messages.
 * A composer that legitimately still holds text mid-flight plus one unrelated
 * live-region update would be enough to call a successful post failed.
 *
 * Getting that wrong is far more expensive than the bug it fixes: a false block
 * marks good posts as failed for every user, in every language, including the
 * English majority that has no problem today. So the rule is the one the owner
 * set — if we are not certain it is a block, keep posting.
 *
 * It therefore only REPORTS. The reports carry no post content (a boolean and a
 * category), and once real data shows how often this fires alongside a confirmed
 * block, it can be promoted to a decision on evidence rather than on reasoning.
 *
 * Success/pending banners are excluded so the signal is not diluted by the very
 * cases it is meant to be distinguished from.
 *
 * Fail-open on any exception: a bug in here must never affect a campaign.
 */
function _looksUnpublishedStructurally() {
  try {
    const dlg = findPostComposerDialog();
    if (!dlg) return false;                       // composer gone → accepted
    const ed = dlg.querySelector('[data-lexical-editor="true"], [role="textbox"][contenteditable="true"]');
    if (!ed) return false;                        // no editor → cannot tell
    if (!((ed.innerText || ed.textContent || '').trim().length > 0)) return false; // emptied → accepted
    // Still mid-flight? Then this is slow, not failed.
    if (dlg.querySelector('[data-visualcompletion="loading-state"], [role="progressbar"]')) return false;
    const notice = _visibleNoticeText();
    if (!notice) return false;
    // A success/pending banner is the opposite of the thing being looked for.
    if (/thanks|submitted|posted|live|sharing|publishing|success|your post|pending|review|approval/i.test(notice)) return false;
    return true;
  } catch (_) { return false; }
}
// ── v2026-09-16 · why the composer could not be opened ─────────────────────────────────
// 🔴 1,976 events / 121 users, and every one of them carried the SAME prose sentence and
// nothing else. Reading 60 of them was the only way to learn that 41 were "opener found 0/6 —
// no dialog on screen" (the page has no entry point we recognise at all, so 6 attempts × 4 s is
// pure waste) and that two were a Close/Report/Continue interstitial — in Indonesian and Greek,
// which surfaced only because those two happened to be in the sample.
// The same defect as media-lost: a report that cannot be decided is not a report. These are the
// facts a reader needs, and none of them existed in the event before.
// ⛔ No page TEXT and no urls — `sentryScrubData` would drop them and they are the user's
// content. Shapes, counts and roles only.
function _realDocHidden() {
  try {
    const d = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    return !!(d && d.get && d.get.call(document) === 'hidden');
  } catch (_) { return false; }
}

function _composerFailFacts() {
  try {
    const vis = (el) => !!el && el.offsetParent !== null;
    const dlgs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(vis);
    // Anything that even LOOKS like a place to write, by shape rather than by words.
    const editable = document.querySelectorAll('[contenteditable="true"],[role="textbox"],[data-lexical-editor]');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    // The structural anchor P4b uses — its absence is the single most useful fact here.
    let anchors = 0;
    try {
      for (const sp of document.querySelectorAll('span[style*="-webkit-line-clamp"]')) {
        const b = sp.closest('[role="button"]');
        if (b && vis(b) && !b.closest('[role="article"]') && !b.closest('[role="dialog"]')) anchors++;
      }
    } catch (_) {}
    return {
      lang: String(document.documentElement.getAttribute('lang') || '?').slice(0, 12),
      // ⚠️ path SHAPE, never the url: /groups/<id>/ → 'groups', anything else → 'other'.
      surface: /^\/groups\//.test(location.pathname) ? 'groups' : 'other',
      dialogs: dlgs.length,
      dialog_buttons: dlgs.length ? dlgs.map((d) => d.querySelectorAll('[role="button"]').length).join(',') : '0',
      editables: editable.length,
      file_inputs: fileInputs.length,
      line_clamp_anchors: anchors,
      feed_posts: document.querySelectorAll('[role="article"]').length,
      vw: Math.round(window.innerWidth), vh: Math.round(window.innerHeight),
      hidden: document.visibilityState === 'hidden' ? 1 : 0,
      // v2026-10-11: the REAL visibility — the Safe spoof makes `document.visibilityState` say "visible" in this
      // world, so `hidden` above was always 0. Read through the prototype's own getter, past the spoof.
      real_hidden: (typeof _realDocHidden === 'function' && _realDocHidden()) ? 1 : 0,
    };
  } catch (e) { return { facts_error: String((e && e.message) || e).slice(0, 60) }; }
}

/** One short string, because cReport relays a MESSAGE — `k=v` pairs the reader can scan. */
/**
 * v2026-10-16 · Facebook's listing-type picker ("Item for sale · Vehicle · Home · Sale event"), told apart from the post
 * composer by shape alone (any language): no text box or file input, and 3–6 options without an aria-label, each with
 * an icon and at least two text lines (a title and its description). The Close button carries an aria-label.
 */
function _looksLikeListingPicker(dlg) {
  try {
    if (!dlg || !dlg.querySelector || dlg.querySelector('[contenteditable="true"], input[type="file"], textarea')) return false;
    // (review) a composer shell whose editor has not mounted yet still carries its Post button: never the picker
    const _postWords = (typeof POST_TRANSLATIONS !== 'undefined' && Array.isArray(POST_TRANSLATIONS)) ? POST_TRANSLATIONS : [];
    if (Array.from(dlg.querySelectorAll('[role="button"][aria-label]')).some((b) => _postWords.includes(String(b.getAttribute('aria-label') || '').trim()))) return false;
    const opts = Array.from(dlg.querySelectorAll('[role="button"]')).filter((b) => {
      if (b.getAttribute('aria-label')) return false;
      if (!b.querySelector('img, svg, i')) return false;
      const lines = Array.from(b.querySelectorAll('span, div')).filter((e) => !e.children.length && (e.textContent || '').trim());
      return lines.length >= 2;
    });
    return opts.length >= 3 && opts.length <= 6;
  } catch (_) { return false; }
}

function _composerFailFactsLine() {
  try {
    const f = _composerFailFacts();
    return Object.keys(f).map((k) => k + '=' + f[k]).join(' ');
  } catch (e) { return 'facts-error'; }
}

// v2026-10-13 · post-unconfirmed on 1.2.9.87: 5 of the first 7 users (public groups), every one "dialogOpen=true
// buttonGone=false" — and Sentry keeps 300 characters, so the screen list was cut before anything Facebook said. The
// facts that tell the causes apart, FIRST and short: the Post button's own text/state, whether something sits on top
// of it, what Facebook wrote in the composer (alert/notice), how many dialogs are open. Diagnostics only.
function _postClickFacts() {
  try {
    const b = (postButtonDOM instanceof Element && document.body.contains(postButtonDOM)) ? postButtonDOM : null;
    const parts = [];
    if (b) {
      const r = b.getBoundingClientRect();
      const lbl = (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 16);
      const dis = b.disabled || b.getAttribute('aria-disabled') === 'true';
      let cover = 'no';
      try {
        const top = r.width > 0 ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
        if (!top) cover = 'offscreen';
        else if (!(top === b || b.contains(top) || top.contains(b))) cover = (top.getAttribute('aria-label') || top.getAttribute('role') || top.tagName || '?').slice(0, 20);
      } catch (_) {}
      parts.push('btn="' + lbl + '"' + (dis ? ' DISABLED' : '') + (cover !== 'no' ? ' covered-by=' + cover : '') + (r.width <= 0 ? ' hidden' : ''));
    } else parts.push('btn=gone');
    const dlg = b ? b.closest('[role="dialog"]') : null;
    const say = dlg ? Array.from(dlg.querySelectorAll('[role="alert"], [role="status"], [aria-live]'))
      .map((e) => (e.textContent || '').trim()).filter(Boolean).join(' / ').slice(0, 90) : '';
    if (say) parts.push('says="' + say + '"');
    const banner = _visibleNoticeText();
    if (banner) parts.push('notice="' + String(banner).slice(0, 70) + '"');
    parts.push('dialogs=' + Array.from(document.querySelectorAll('[role="dialog"]')).filter((d) => d.offsetParent !== null).length);
    // v2026-10-14 · was the window really hidden (covered / minimized / screen off) when Facebook did not take the Post?
    // The leading hypothesis for this class (live: a hidden window posts on a Mac; Windows refuses our "bring to front").
    try { parts.push('real_hidden=' + ((typeof _realDocHidden === 'function' && _realDocHidden()) ? 1 : 0)); } catch (_) {}
    return parts.join(' ');
  } catch (e) { return 'facts-error'; }
}

function _domFailSnapshot() {
  try {
    const banner = _visibleNoticeText();
    // v86 (Part D): current FB splits the composer into TWO visible [role=dialog]s — the
    // BODY (lexical editor + file input + ~13 buttons) and a separate HEADER ("Create
    // post", ONLY a "Close composer dialog" button). A blind `.pop()` grabs the HEADER →
    // useless snapshots (a customer's 132 post-unconfirmed all read "buttons: Close
    // composer dialog" — found LIVE in Chrome). Pick the visible dialog with the MOST
    // composer content. Snapshot STRING only — no decision reads this; the detection
    // logic uses postButtonDOM.closest('[role=dialog]'). Fallback keeps old behavior.
    const _visDlgs = Array.from(document.querySelectorAll('[role="dialog"]')).filter((d) => d.offsetParent !== null);
    const _dlgScore = (d) => (d.querySelector('[data-lexical-editor],input[type="file"]') ? 1000 : 0)
                           + d.querySelectorAll('[role="button"]').length;
    const dlg = _visDlgs.slice().sort((a, b) => _dlgScore(a) - _dlgScore(b)).pop()
              || document.querySelector('[role="dialog"]');
    if (!dlg) return ('no dialog on screen' + (banner ? ' · notice: "' + banner + '"' : '')).slice(0, 700);
    const btns = Array.from(dlg.querySelectorAll('[role="button"],button'))
      .filter((b) => b.offsetParent !== null)
      .map((b) => (b.getAttribute('aria-label') || ('[' + (b.textContent || '').trim().slice(0, 18) + ']')))
      .filter(Boolean);
    const heading = (dlg.querySelector('[role="heading"]')?.textContent || '').trim().slice(0, 40);
    return ('dialog' + (heading ? ' "' + heading + '"' : '') + ' · buttons: ' + (btns.join(' | ') || 'none')
            + (banner ? ' · notice: "' + banner + '"' : '')).slice(0, 700);
  } catch (e) { return 'snapshot-error: ' + (e && e.message ? e.message : e); }
}

// Trim an Error's stack to the first 1-2 frames (the actual throw site) so an
// exception relayed to the downloadable log pinpoints WHERE it happened
// (root JS files aren't minified → real line numbers like mgp-content.js:773).
function _errLoc(e) {
  try {
    const frames = String((e && e.stack) || '').split('\n').slice(1, 3).map((s) => s.trim()).filter(Boolean);
    return frames.length ? ' @ ' + frames.join(' ← ').slice(0, 220) : '';
  } catch (_) { return ''; }
}
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = "MediaDB";
const STORE_NAME = "media";
let receivedItems = {};

// Default selectors and settings in case remote config fails
const defaultConfig = {
  postSelectors: [
    'div[role="feed"] > div > div',
    ".x1lliihq .x1n2onr6.xh8yej3.x1ja2u2z.xod5an3",
  ],
  contentSelectors: [
    'div[data-ad-preview="message"]',
    'div[dir="auto"]',
    'div[data-visualcompletion="ignore-dynamic"]',
  ],
  composerSelectors: [
    ".x1yztbdb .xi81zsa.x1lkfr7t.xkjl1po.x1mzt3pk.xh8yej3.x13faqbe",
    '[data-composer-id="whats-on-your-mind"]',
    ".xi81zsa.x1lkfr7t.xkjl1po.x1mzt3pk.xh8yej3.x13faqbe",
  ],
  composerInputAreaSelectors: [
    '[role="dialog"] [role="presentation"] .notranslate[contenteditable="true"]',
    "div[contenteditable='true'][role='textbox']",
    ".xzsf02u.x1a2a7pz.x1n2onr6.x14wi4xw.notranslate[contenteditable='true']",
    "div[aria-label='Create a public post…'][contenteditable='true'][role='textbox']",
    ".notranslate._5rpu[contenteditable='true']",
    ".notranslate[contenteditable='true']",
    'div[role="textbox"][contenteditable="true"]',
  ],
  buttonClassName: "log-button",
  postButtonSelector: 'div[aria-label="Post"]',
};

// CONTENT SCRIPT READINESS: Respond to ping from background worker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "ping") {
    sendResponse({ pong: true });
    return;
  }
});

// Handle overlay show/hide from background script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "showOverlay") {
    let overlay = document.getElementById("__ext_overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "__ext_overlay";
      overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.35);z-index:2147483647;display:flex;align-items:center;justify-content:center;";
      const spinner = document.createElement("div");
      spinner.style.cssText = "width:48px;height:48px;border:5px solid #fff;border-top-color:transparent;border-radius:50%;animation:__ext_spin .8s linear infinite;";
      const style = document.createElement("style");
      style.textContent = "@keyframes __ext_spin{to{transform:rotate(360deg)}}";
      document.head.appendChild(style);
      overlay.appendChild(spinner);
      document.body.appendChild(overlay);
    }
    overlay.style.display = "flex";
    return;
  }
  if (msg.action === "removeOverlay") {
    const overlay = document.getElementById("__ext_overlay");
    if (overlay) overlay.remove();
    return;
  }
});

// Listen for a message to show the file picker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "show_select_files_content") {
    (async () => {
      const result = await showFilePicker(); // <-- your file picker logic
      sendResponse({ selected: result }); // <-- reply with result
    })();

    return true; // ⬅️ VERY IMPORTANT to keep the message port open
  }
});

//Test starts
async function waitForSelectorFromAI(timeoutMs = 10000) {
  let debounceTimeout;
  let selectorResolved = false;
  let foundSelector = null;

  const hostname = window.location.hostname; // full host, e.g., "www.facebook.com"
  const pathname = window.location.pathname;

  if (
    !hostname.includes("facebook.com") ||
    (!pathname.startsWith("/groups/") && document.documentElement.lang == "en")
  ) {
    return;
  }

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (selectorResolved) return;

      clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        if (selectorResolved) return;

        const feedRoot =
          document.querySelector("div[role='feed']") || document.body;
        const domSnapshot = feedRoot.innerHTML.slice(0, 20000);

        chrome.runtime.sendMessage(
          {
            action: "callAi",
            payload: { html: domSnapshot },
          },
          (response) => {
            if (response?.selector) {
              const composerEls = document.querySelectorAll(response.selector);
              logTelemetry(
                "composer_open_failed",
                { message: "ai_called", ai_response: response },
                "ERROR"
              );
              if (composerEls.length) {
                for (const el of composerEls) {
                  try {
                    el.click();
                    const rect = el.getBoundingClientRect();
                    const isVisible = rect.width > 0 && rect.height > 0;

                    if (document.activeElement === el || isVisible) {
                      selectorResolved = true;
                      foundSelector = response.selector;
                      observer.disconnect();
                      resolve(foundSelector);
                      return;
                    }
                  } catch (err) {
                    // console.warn("⚠️ Failed to click element:", el, err);
                  }
                }
              } else {
                logTelemetry(
                  "config_load_failed",
                  {
                    message: `⚠️ AI returned selector but no matching element found: ${response.selector}`,
                  },
                  "WARNING"
                );
              }
            } else {
              logTelemetry(
                "config_load_failed",
                {
                  message: `⚠️ No selector or error from AI: ${response?.error}`,
                },
                "WARNING"
              );
            }
          }
        );
      }, 500);
    });

    // Fallback timeout: stop after a certain time
    const failTimeout = setTimeout(() => {
      if (!selectorResolved) {
        clearTimeout(debounceTimeout); // BUG-26: cancel pending debounce so it can't fire after we've given up
        observer.disconnect();
        resolve(null);
      }
    }, timeoutMs);

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  });
}

//Test ends

function sleep(seconds) {
  // Delegates to sleepMs so background-tab MessageChannel optimisation applies here too.
  // Without this, sleep(0.5) in a background tab could stall for up to 60s under
  // Chrome's intensive throttling — causing the full posting flow to take 1+ minutes.
  return sleepMs(Math.round(seconds * 1000));
}

function sleepMs(ms) {
  // Plain setTimeout for both foreground and background tabs.
  // ⚠️ Two different floors, and the second one is the dangerous one:
  //   · a hidden tab clamps timers to ~1000ms — acceptable skew for our delays,
  //     which humanized pacing already absorbs;
  //   · after ~5 minutes hidden Chrome escalates to INTENSIVE throttling and
  //     allows one timer per MINUTE. That is 60×, not 1×, and it is why a Safe
  //     post can drift from 25s to minutes on a machine that is doing nothing
  //     wrong. Do not "fix" it here — the phases line and the source/arrival
  //     timestamp gap are what tell us whether it is actually happening.
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── LAYER 3 (v10): Flash-focus helpers ──────────────────────────────────
// requestFlashFocus() asks background.js to temporarily focus the posting tab,
// wait 800ms for React to process pending DOM updates, then restore the user's
// original tab. Only used as a LAST RESORT when an operation has FAILED.
async function requestFlashFocus(proactive = false, opts = {}) {
  // Safe mode: suppress ALL *proactive* flash-focus so the window never jumps to the front
  // during normal operation (matches the competitor's pure-background default).
  // EXCEPTION — opts.force is the automatic RESCUE path: when the composer didn't render or
  // the image didn't upload in the BACKGROUND, we briefly focus the window (the only
  // guaranteed way to force FB to render), complete the step, then the worker restores the
  // user's previous tab. Background-first; focus ONLY on failure → minimal disturbance,
  // and it's why the post is GUARANTEED to go through rather than silently fail.
  if (_safeMode && !opts.force) {
    cReport('flash-focus suppressed (safe mode — staying in background like the competitor)', 'info');
    return false;
  }
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "requestTabFocus", flashMode: true }, (response) => {
      if (chrome.runtime.lastError) { resolve(false); return; }
      resolve(response?.focused || false);
    });
  });
}

// ── ONE-TIME FOCUS RESCUE (Safe/DOM only) ───────────────────────────────────
// We DON'T continuously re-focus the window any more (the old every-2s keeper popped the
// window to the front whenever the user clicked away — annoying). Instead the MessageChannel
// rAF pump (mgp-alwaysactive-main.js) keeps the occluded window's DOM updating at full speed
// without any front-pop, so by default Safe posting NEVER steals focus. This is the safety
// net: if a render-dependent step STILL stalls (composer never opens, or the settle poll sees
// nothing after ~6s — e.g. a page state the pump can't keep current), we bring the window to
// the front ONCE per post, only when actually stuck (mirrors the competitor's one-shot
// focusTab-at-15s). At most ONE pop per post, vs every 2s before. The popup is a single-tab
// window so requestFlashFocus leaves it focused (restore is a no-op) → the rest of the post
// renders. _rescuedOnce starts fresh per post (each Safe post is a new tab → new content
// script instance). Pure window focus — no network, no fetch patch (100% DOM, user's choice).
let _rescuedOnce = false;
// How long a render-dependent step may stall before we spend the one allowed pop. 6s is the
// value this comment block always described; the settle phase was shipped gated on 30000ms,
// which equals its own _postCompletionMax for text/image (30000) and therefore never fired.
const _SETTLE_RESCUE_MS = 6000;
/**
 * ⚠️ ONE pop per post, shared by every rescue site.
 *
 * The plan for this round asked for another rescue site in the publish wait —
 * on the premise that it was wired only to the image wait and the settle. It is
 * not: the publish wait has had one since v10 (`_flashFocusRequested`). The
 * real reason a customer saw ZERO rescues across 54 posts is this budget: an
 * earlier site spent it and every later one is skipped in silence.
 *
 * ⛔ Not raised here. Another pop means stealing focus from the user a second
 * time mid-post, and the theory that focus is what is hurting them has not been
 * measured — the same reason the plan itself gates its Web-Lock work. Instead
 * the skip is now VISIBLE, so the next log says whether this is even happening.
 * Raise the budget when the phase line says paint is the neck, not before.
 */
async function _rescueFocusOnce(reason) {
  if (_rescuedOnce) {
    try { cLog('[focus-rescue] skipped (budget already spent this post) — asked by: ' + (reason || '?')); } catch (e) {}
    return false;
  }
  if (!_safeMode) return false;
  _rescuedOnce = true;
  cReport('focus-rescue: ' + (reason || 'a step stalled') + ' → window to front ONCE (safety net; the rAF pump usually renders without this)', 'warn');
  const focused = await requestFlashFocus(true, { force: true });
  if (focused) await sleepMs(800);
  return focused;
}

// ── FOCUS-KEEPER (Safe/DOM only) ────────────────────────────────────────────
// Restored (v6) by the user's explicit choice of "best reliability via DOM". DOM posting needs
// the composer to RENDER, and Chrome won't render a fully-occluded window (the MessageChannel
// rAF pump keeps JS/DOM current but FB gates the heavy composer + video upload on paint) — so
// when the user switches tabs, composer-open and the video-upload confirm fail. The keeper
// re-asserts the posting window to the front every ~2s for the whole post, so those render-
// dependent steps succeed even when the user clicks away. keepWindowFront is a NO-OP when the
// window is already focused, so it only visibly pops when the user actually switched away.
//
// ⛔ v2026-08-15: NOT STARTED ANY MORE — kept in the file, unstarted, so restoring it is one
// line. It was introduced to cover the settle phase, but the settle phase's own one-shot
// rescue was simply mis-gated (30000ms against a 30000ms deadline). With that threshold fixed
// (_SETTLE_RESCUE_MS) plus a matching one-shot in the image wait, the reactive layers cover
// the same failure without re-fronting the window for the whole post. _stopFocusKeeper() is
// still called in the finally — harmless, and correct if this is ever started again.
// See the block at its old call site in contentPostPost for the full reasoning.
let _focusKeeperActive = false;
async function _runFocusKeeper() {
  if (_focusKeeperActive) return;
  _focusKeeperActive = true;
  let _kept = 0;
  while (_focusKeeperActive) {
    try { chrome.runtime.sendMessage({ action: 'keepWindowFront' }).catch(() => {}); _kept++; } catch (e) {}
    for (let i = 0; i < 8 && _focusKeeperActive; i++) await sleepMs(250); // ~2s cadence, halts promptly at finally
  }
  if (_kept) cReport('focus-keeper: held window front ' + _kept + '× (stay-in-front for DOM reliability)', 'info');
}
function _stopFocusKeeper() { _focusKeeperActive = false; }

// ── KEEP-AUDIBLE (Safe/DOM video — the NO-POP alternative to the focus-keeper) ───────────────
// Chromium/Firecrawl research: a tab playing AUDIBLE audio is treated as foreground and is EXEMPT
// from background-timer throttling — even occluded/backgrounded — so FB's network-driven video
// upload + progress-bar + our MutationObserver detection all run at full speed WITHOUT bringing the
// window to front (no pop). CAVEAT: silent (gain=0) audio grants NO exemption, so we use a very low
// but NON-zero gain at a low, effectively-inaudible frequency (tune live if Chrome's speaker icon
// doesn't light up). Autoplay policy may keep the context 'suspended' (no user gesture in this tab) —
// the caller then falls back to the focus-keeper. Stopped in finally.
let _keepAudible = null;
async function _startKeepAudible() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0016;   // ≈ -56 dB: non-zero so Chrome flags the tab "audible", inaudible in practice
    osc.frequency.value = 80;   // low tone; effectively silent at this gain
    osc.type = 'sine';
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    _keepAudible = { ctx, osc, gain };
    if (ctx.state === 'suspended') {
      try { ctx.resume(); } catch (e) {}   // do NOT await — resume() can hang pending a user gesture
      await sleepMs(300);                   // give Chrome a beat to flip to 'running'
    }
    return ctx.state === 'running';
  } catch (e) { return false; }
}
function _stopKeepAudible() {
  try {
    if (!_keepAudible) return;
    try { _keepAudible.osc.stop(); } catch (e) {}
    try { _keepAudible.ctx.close(); } catch (e) {}
  } catch (e) {} finally { _keepAudible = null; }
}

// isTabActuallyFocused() queries background.js for the real active-tab state.
// With the ISOLATED world override, document.hidden is always false, so we need
// this to detect actual background state for timing-sensitive decisions.
async function isTabActuallyFocused() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "isTabFocused" }, (response) => {
      if (chrome.runtime.lastError) { resolve(false); return; }
      resolve(response?.focused || false);
    });
  });
}

// v85 (C2): a FRESH randomized approach path to a click target on every call. The old
// fixed trail ([[-36,-22],[-22,-13],[-10,-5],[0,0]]) was byte-identical on every click
// across thousands of posts → a stable motion fingerprint (arguably worse than none).
// Each call now picks a random start offset (40–120px at a random angle) and 4–8 ease-in
// points with small jitter, always landing exactly on center. Geometry ONLY — the points
// feed inert mousemove events; the actual submit stays element.click(). No isTrusted forgery.
function _randomMouseTrail() {
  const angle = Math.random() * Math.PI * 2;
  const dist = 40 + Math.random() * 80;
  const n = 4 + Math.floor(Math.random() * 5); // 4–8 points
  const sx = Math.cos(angle) * dist, sy = Math.sin(angle) * dist;
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = 1 - Math.pow(1 - t, 2);          // ease-out: steps shrink toward the target
    const jx = (Math.random() - 0.5) * 6 * (1 - t);
    const jy = (Math.random() - 0.5) * 6 * (1 - t);
    pts.push([Math.round(sx * (1 - ease) + jx), Math.round(sy * (1 - ease) + jy)]);
  }
  pts[pts.length - 1] = [0, 0];                    // always land exactly on center
  return pts;
}

// ── Trusted click (v1.19.6: simplified — no debugger) ──────────────────
// Scrolls element into view and dispatches a regular DOM click.
// Critical-path callers (Post / Photo / Video buttons) additionally invoke
// `simulateHumanizedClick()` which dispatches full pointerdown/mouseup/click
// sequences with realistic timing — matching how a real user clicks.
async function trustedClick(element) {
  if (!element) return false;
  try {
    element.scrollIntoView({ block: "center", behavior: "instant" });
    await sleepMs(200);
    // v70: emit a short mouse-move TRAIL toward the element center BEFORE the click —
    // a real cursor ARRIVES via a path, it doesn't teleport onto a button. Until now
    // the humanized pointer sequence (simulateHumanizedClick) ran ONLY as a fallback
    // on trustedClick error, so the PRIMARY click path (this one) was a bare .click()
    // with NO movement. mousemove/mouseover are INERT (only .click() submits the post),
    // so this adds human-like incidental movement with ZERO effect on click reliability.
    try {
      const _r = element.getBoundingClientRect();
      const _cx = _r.left + _r.width / 2, _cy = _r.top + _r.height / 2;
      for (const [dx, dy] of _randomMouseTrail()) { // v85 (C2): fresh randomized path, not the fixed trail
        element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: _cx + dx, clientY: _cy + dy }));
      }
      element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, clientX: _cx, clientY: _cy }));
    } catch (_) {}
    element.click();
    return true;
  } catch (e) {
    cLog('[trustedClick] error:', String(e));
    // ⛔ v2026-09-12 — DUPLICATE-POST GUARD. The fallback below is a REAL click.
    // Returning false regardless made the ONE caller that reads this value
    // (clickPostButtonWithRetry) treat it as "not clicked" and run
    // simulateHumanizedClick, which clicks AGAIN 200ms–1.4s later — while the
    // composer is still open. That is a second submit on the Post button.
    //
    // It is not theoretical: on the happy path trustedClick returns true and
    // simulateHumanizedClick never runs, so EVERY successful post ships via the
    // bare element.click() at the end of the try — the same call the catch makes
    // here. If that call can publish there, it can publish here.
    //
    // So report failure ONLY when the fallback click ALSO threw; then the caller
    // may legitimately try again. "A duplicate is worse than a gap."
    let _fallbackClicked = false;
    try { element.click(); _fallbackClicked = true; } catch (_) {}
    if (_fallbackClicked) {
      try { cReport('trustedClick: the primary path threw but the fallback click landed — not clicking a second time (duplicate guard)', 'warn'); } catch (_) {}
    }
    return _fallbackClicked;
  }
}

async function humanDelay(level, point) {
  // Natural Presence OFF (level 0) → no in-compose pause. Guard added because
  // the table below has no '0' key and would otherwise fall back to level 2
  // (Balanced). Matches maybeScrollFeed's `if (humanLevel === 0) return` and
  // the "Off = high speed" semantics now that the real level reaches the DOM path.
  if (!level) return;
  // Run delays even when the window is in the background. The MAIN-world keepalive
  // (Web Lock + rAF→MessageChannel) prevents Chrome's setTimeout throttling, so the
  // pacing stays real-time. (Previously skipped on document.hidden — that broke
  // "Safe in the background": the delays must actually run for the post to look
  // human and for the comment step to have settled timing.)
  const table = {
    1: { pre_text: [500, 1500], between_media: [800, 2000], pre_submit: [500, 1500] },
    2: { pre_text: [1000, 3000], between_media: [1500, 4000], pre_submit: [1200, 3500] },
    3: { pre_text: [2500, 5000], between_media: [3000, 7000], pre_submit: [3000, 6000] },
  };
  const [min, max] = (table[String(level)] || table[2])[point] || [1000, 2000];
  const ms = Math.round(Math.random() * (max - min) + min);
  cReport('presence: ' + point + ' delay ' + ms + 'ms (level ' + level + ')', 'info');
  await sleepMs(ms);
}

function randomInRange(min, max, fallback = 0) {
  const low = Number.isFinite(min) ? min : fallback;
  const high = Number.isFinite(max) ? max : fallback;
  if (low === high) return low;
  const base = Math.min(low, high);
  const span = Math.max(low, high) - base;
  return Math.round(base + Math.random() * span);
}

const DEFAULT_HUMANIZATION_PROFILE = {
  level: 1,
  perPostDelaySec: 3,
  clickDelayMs: [150, 450],
  scrollChance: 0.05,
  scrollDistancePx: [-120, 120],
  breakEveryPosts: 7,
  breakDurationMs: [15000, 27000],
  breakIdleMs: [2000, 4500],
  breakScrollPx: [-100, 100],
};

function cloneHumanizationProfile(profile = DEFAULT_HUMANIZATION_PROFILE) {
  const base = profile || DEFAULT_HUMANIZATION_PROFILE;
  return {
    level: Number.isFinite(base.level) ? base.level : DEFAULT_HUMANIZATION_PROFILE.level,
    perPostDelaySec: Number.isFinite(base.perPostDelaySec)
      ? base.perPostDelaySec
      : DEFAULT_HUMANIZATION_PROFILE.perPostDelaySec,
    clickDelayMs: Array.isArray(base.clickDelayMs)
      ? base.clickDelayMs.slice()
      : DEFAULT_HUMANIZATION_PROFILE.clickDelayMs.slice(),
    scrollChance: Number.isFinite(base.scrollChance)
      ? base.scrollChance
      : DEFAULT_HUMANIZATION_PROFILE.scrollChance,
    scrollDistancePx: Array.isArray(base.scrollDistancePx)
      ? base.scrollDistancePx.slice()
      : DEFAULT_HUMANIZATION_PROFILE.scrollDistancePx.slice(),
    breakEveryPosts:
      Number.isFinite(base.breakEveryPosts) && base.breakEveryPosts > 0
        ? base.breakEveryPosts
        : DEFAULT_HUMANIZATION_PROFILE.breakEveryPosts,
    breakDurationMs: Array.isArray(base.breakDurationMs)
      ? base.breakDurationMs.slice()
      : DEFAULT_HUMANIZATION_PROFILE.breakDurationMs.slice(),
    breakIdleMs: Array.isArray(base.breakIdleMs)
      ? base.breakIdleMs.slice()
      : DEFAULT_HUMANIZATION_PROFILE.breakIdleMs.slice(),
    breakScrollPx: Array.isArray(base.breakScrollPx)
      ? base.breakScrollPx.slice()
      : DEFAULT_HUMANIZATION_PROFILE.breakScrollPx.slice(),
  };
}

let currentHumanizationContext = {
  level: DEFAULT_HUMANIZATION_PROFILE.level,
  profile: cloneHumanizationProfile(DEFAULT_HUMANIZATION_PROFILE),
  postNumber: 0,
  totalPosts: 0,
};

// Safe (DOM) mode flag — set from the contentPostPost message. When true the
// posting tab must stay in the BACKGROUND like the competitor (no proactive
// flash-focus / window raise); the MAIN-world keepalive carries the tab.
let _safeMode = false;
// v2026-10-15 · the worker allows the Safe first comment (it reads the remote switch). Off unless told — an older
// worker never sends it, so a page can never comment on its own.
let _safeCommentOn = false;
// v2026-10-15 · every post's Comment button on the page the moment before we click Post: a block whose button is not in
// this set appeared after OUR post — the freshest proof there is, wherever Facebook draws it (live: 2 of 3 inside the
// feed, where "outside the feed" missed them). Null until a post is submitted from this page.
let _scPreSubmitCmtBtns = null;
// v2026-10-19 (audit F1) · what was ALREADY on the page before our Post click: the post texts (story_message nodes) and
// every post id any link names. A daily schedule posts the same text to the same group, so yesterday's post sits in
// the feed with OUR words: it must never be taken for the new one (its link would overrule a real "pending", and the
// first comment and every queued comment would land on yesterday's post).
let _preSubmitPosts = null;
function _postIdsOnPage(root) {
  const ids = new Set();
  try {
    for (const a of (root || document).querySelectorAll('a[href]')) {
      const h = a.href || '';
      let m = /\/(?:posts|permalink)\/(\d{6,})/.exec(h); if (m) ids.add(m[1]);
      m = /[?&]set=(?:gm|pcb)\.(\d{6,})/.exec(h); if (m) ids.add(m[1]);
    }
  } catch (_) {}
  return ids;
}
function _snapshotPostsBeforeSubmit() {
  try { return { msgs: new Set(document.querySelectorAll('[data-ad-rendering-role="story_message"]')), ids: _postIdsOnPage(document) }; }
  catch (_) { return null; }
}
/** True when this post block was on the page before our Post click (its text node existed then). */
function _wasOnPageBeforeSubmit(block) {
  try {
    if (!_preSubmitPosts || !block) return false;
    if (_preSubmitPosts.msgs.has(block)) return true;
    for (const m of _preSubmitPosts.msgs) if (block.contains(m)) return true;
  } catch (_) {}
  return false;
}
// Scheduled-video: the SW nulls video_id (media rides in image_ids) and instead sets
// request.post.hasVideo. Mirrored here module-wide (like _safeMode) so injectIntoComposer's
// video gates (preview-wait / 120s / publish-wait) and the focus-keeper all see "has video".
let _safeHasVideoFlag = false;
// The permalink whose card this post carries, on a SHARE run only — the signal
// that the url may leave the text once the card is confirmed. Null on an
// ordinary post and on Copy mode (which carries no link at all).
let _shareStripUrl = null;
let _safeVideoBytes = 0; // total video bytes attached this post → drives waitForVideoBySize (v12, size-based upload wait)

// v85 (C1): the SW sends {level, postNumber, totalPosts} but NO `profile` object, so
// the micro-behavior profile (scroll chance, break cadence) was the STATIC default on
// every post — the Natural-Presence slider never changed Safe scroll/break behavior.
// Derive a level-scaled profile from the slider so it actually tunes the micro-behavior.
// (Account-type pacing — Page vs personal, groups-per-run — is handled separately in the
// service worker: pickBurstSize/pickBreakMs + the new Page groups cap.)
function profileForLevel(level) {
  const base = cloneHumanizationProfile(DEFAULT_HUMANIZATION_PROFILE);
  const L = Number(level);
  if (!Number.isFinite(L) || L <= 0) { base.level = 0; base.scrollChance = 0; return base; } // Off: no extra motion
  if (L === 1) { base.level = 1; base.scrollChance = 0.15; base.breakEveryPosts = 9; return base; }   // Low
  if (L >= 3) { base.level = 3; base.scrollChance = 0.40; base.scrollDistancePx = [-400, 400];          // Full
                base.breakEveryPosts = 5; base.breakDurationMs = [18000, 32000]; return base; }
  base.level = 2; base.scrollChance = 0.30; base.scrollDistancePx = [-300, 300]; base.breakEveryPosts = 7; // Balanced
  return base;
}
function updateHumanizationContext(payload = {}) {
  // Explicit profile (future) wins; otherwise derive a level-scaled one from the slider.
  const profile = payload.profile
    ? cloneHumanizationProfile(payload.profile)
    : cloneHumanizationProfile(profileForLevel(payload.level));
  currentHumanizationContext = {
    level: Number.isFinite(payload.level) ? payload.level : profile.level,
    profile,
    postNumber: Math.max(0, Number(payload.postNumber) || 0),
    totalPosts: Math.max(0, Number(payload.totalPosts) || 0),
  };
  // Confirm the Natural Presence level actually reached the DOM path (the slider
  // value the worker sent) — one line per post in the downloadable log.
  try {
    const c = currentHumanizationContext;
    const names = { 0: 'Off', 1: 'Low', 2: 'Medium', 3: 'Full' };
    cReport('presence: Natural Presence = ' + (names[c.level] ?? c.level) +
            (c.totalPosts ? ' (post ' + (c.postNumber + 1) + '/' + c.totalPosts + ')' : ''), 'info');
  } catch (e) {}
}

// v85 (C5): a right-skewed delay within [min,max] — most clicks are quick with an
// occasional longer "thinking" pause — instead of a flat uniform box. Matches the
// "no perfectly even intervals" anti-detection point. Bounded; pure.
function _skewedDelayMs(min, max) {
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) ? max : lo;
  if (hi <= lo) return Math.round(lo);
  const skew = Math.pow(Math.random(), 1.8); // bias toward the low end, long tail toward hi
  return Math.round(lo + skew * (hi - lo));
}
async function simulateHumanizedClick(button, profile) {
  const delayBeforeClick = _skewedDelayMs(profile.clickDelayMs[0], profile.clickDelayMs[1]); // v85 (C5): skewed, not uniform
  if (delayBeforeClick > 0) {
    await sleepMs(delayBeforeClick);
  }

  if (profile.scrollChance > 0 && Math.random() < profile.scrollChance) {
    const scrollAmount = randomInRange(
      profile.scrollDistancePx[0],
      profile.scrollDistancePx[1],
      0
    );
    if (scrollAmount !== 0) {
      try {
        window.scrollBy({ top: scrollAmount, behavior: "smooth" });
      } catch (e) {}
      await sleepMs(randomInRange(300, 700, 400));
    }
  }

  const rect = button.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  // v22 (look-normal): a real cursor ARRIVES via a path — emit a short pointer TRAIL toward the
  // button center (a few mousemove at changing coords) instead of firing every event at the exact
  // same center coordinate. Geometry only, NOT random timing. Removes the "same-coordinate burst"
  // that a bot-classifier flags (no real mouse teleports onto a button).
  const _trail = _randomMouseTrail(); // v85 (C2): fresh randomized path each click (was a fixed array)
  for (const [dx, dy] of _trail) {
    try { button.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: clientX + dx, clientY: clientY + dy })); } catch (e) {}
    try { await sleepMs(6 + Math.floor(Math.random() * 22)); } catch (_) {} // v85: small inter-move pause (temporal realism)
  }
  const mouseInit = {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  };
  ["mouseenter", "mouseover", "mousedown"].forEach((eventType) => {
    button.dispatchEvent(new MouseEvent(eventType, mouseInit));
  });
  button.click();
  button.dispatchEvent(new MouseEvent("mouseup", mouseInit));
  await sleepMs(randomInRange(150, 350, 200));
}

async function applyPeriodicBreakIfNeeded(profile, postNumber) {
  if (!profile || !profile.breakEveryPosts) {
    return;
  }
  if (!postNumber || postNumber % profile.breakEveryPosts !== 0) {
    return;
  }
  const scrollOffset = randomInRange(
    profile.breakScrollPx[0],
    profile.breakScrollPx[1],
    0
  );
  if (scrollOffset !== 0) {
    try {
      window.scrollBy({ top: scrollOffset, behavior: "smooth" });
    } catch (e) {}
    await sleepMs(randomInRange(400, 900, 500));
  }
  const breakDuration = randomInRange(
    profile.breakDurationMs[0],
    profile.breakDurationMs[1],
    0
  );
  if (breakDuration > 0) {
    await sleepMs(breakDuration);
  }
  const idleDuration = randomInRange(
    profile.breakIdleMs[0],
    profile.breakIdleMs[1],
    0
  );
  if (idleDuration > 0) {
    await sleepMs(idleDuration);
  }
}

// Expand spintax patterns in the given text.
// Replaces occurrences like {opt1|opt2|opt3} with a random option.
// v2026-08-26: delegated to mgp-spintax.js, injected immediately before this
// file. The Safe path used to strip the braces off "{hello}" — text the user
// meant to keep — while the Fast path left them alone, so the same post came
// out differently depending on which engine ran it.
/**
 * v2026-08-28 — a self-contained last resort, deliberately duplicated.
 *
 * The shared module is the source of truth and this is NOT a second
 * implementation to keep in sync; it exists so that a LOAD failure degrades to
 * "expanded by a local copy" instead of "literal {a|b} braces published to
 * Facebook". That is exactly what happened when importScripts sat inside a
 * function: every fallback in this file called back into the same missing
 * global, so there was no fallback at all.
 *
 * The competitor ships a full copy of its expander in all four contexts and
 * therefore cannot fail this way — at the cost of the drift we measured and
 * removed. This keeps one canonical implementation and borrows only the safety.
 */
function _spintaxFallbackExpand(text) {
  if (!text || typeof text !== 'string') return text;
  var map = [];
  var out = String(text).replace(/<[^>]+>/g, function (m) { map.push(m); return '@@MGPHTML' + (map.length - 1) + '@@'; });
  for (var pass = 0; pass < 50; pass++) {
    var next = out.replace(/\{([^{}]+)\}/g, function (match, content) {
      if (content.indexOf('|') === -1) return match;                 // literal, not spintax
      var opts = content.split('|').map(function (o) { return o.trim(); })
                        .filter(function (o) { return o.length > 0; });
      if (opts.length < 2) return match;
      return opts[Math.floor(Math.random() * opts.length)];
    });
    if (next === out) break;
    out = next;
  }
  return out.replace(/@@MGPHTML(\d+)@@/g, function (m, i) { var t = map[Number(i)]; return t === undefined ? '' : t; });
}

function expandSpintax(text) {
  if (!text || typeof text !== 'string') return text;
  try { return self.MGPSpintax.expand(text); }
  catch (e) {
    console.warn('[Spintax] shared module unavailable — using the local fallback:', e && e.message);
    return _spintaxFallbackExpand(text);
  }
}
// ============================================================
// Pre-posting helpers: page validation, overlay dismissal,
// Discussion tab switching, and scroll nudge
// ============================================================

/**
 * Check whether the current page is actually postable.
 * Throws an object { reason } that the caller can push into postsCompleted.
 * Should run before the composer is opened.
 */
/**
 * v2026-09-24 — the page's OWN text: the main area without the posts in its feed.
 * A post in the feed that shares something since deleted reads "This content isn't
 * available" — so the whole-page check stopped Safe on ordinary, postable groups (they
 * then failed over to Fast). Measured live on a paused group: whole page = "unavailable"
 * (a feed post) + "paused"; this text = "paused" only. A group that really is gone still
 * reads "unavailable" here (its message is not inside a feed). Joined with no separator,
 * exactly like textContent, so a phrase split across elements still matches.
 */
function pageLevelText() {
  const root = document.querySelector('[role="main"]') || document.body;
  if (!root) return "";
  const parts = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === 1) {
        const role = n.getAttribute && n.getAttribute("role");
        return role === "feed" || role === "article" ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n;
  while ((n = walker.nextNode())) parts.push(n.nodeValue);
  return parts.join("");
}

async function checkPagePostable() {
  const body = pageLevelText();

  // Paused group (first: the more precise reason)
  if (body.includes("This group is paused")) {
    throw { reason: "group-paused" };
  }

  // Unavailable / deleted content
  if (
    body.includes("This content isn't available right now") ||
    body.includes("התוכן הזה אינו זמין") || // Hebrew
    body.includes("Ce contenu n'est pas disponible") || // French
    body.includes("This content isn't available")
  ) {
    throw { reason: "content-unavailable" };
  }

  // Permission / temporary restriction
  if (
    body.includes("You don't have permission") ||
    body.includes("You temporarily can't post")
  ) {
    throw { reason: "no-permission" };
  }

  // Login page check — scope to URL or a visible login form rather than body text
  // BUG-17: body.textContent contains "Log In" and "Sign Up" on fully logged-in pages
  // (footer links, ARIA labels, hidden templates). Use URL or login-form presence instead.
  const href = window.location.href;
  if (
    href.includes('/login') ||
    href.includes('/checkpoint') ||
    href.includes('/recover') ||
    document.querySelector('input[name="email"][type="email"], form[action*="login.php"]')
  ) {
    throw { reason: "login-required" };
  }
}

/**
 * Dismiss common Facebook overlays (cookie banners, notification dialogs,
 * "Continue watching" etc.) before attempting to open the composer.
 */
async function dismissCommonOverlays() {
  const dismissSelectors = [
    '[aria-label="Close"]',
    '[aria-label="Dismiss"]',
    '[aria-label="Not Now"]',
    '[data-cookiebanner] button',
    // Notification permission "Not Now" / "Allow"
    'div[role="dialog"] [aria-label*="Not Now"]',
    'div[role="dialog"] [aria-label*="Close"]',
    // "Continue Watching" overlay
    '[aria-label*="Continue Watching"]',
    '[aria-label*="Continue watching"]',
  ];

  for (const sel of dismissSelectors) {
    try {
      const btn = document.querySelector(sel);
      if (btn) {
        btn.click();
        await sleep(0.5);
      }
    } catch (e) { /* ignore — button may be gone */ }
  }
}

/**
 * If the group page is open on a tab other than Discussion, click Discussion
 * so the composer is accessible, then wait for the DOM to settle.
 */
async function ensureDiscussionTab() {
  try {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    if (!tabs.length) return; // No tab bar → nothing to do

    let discussionTab = tabs.find((t) => {
      const txt = (t.textContent || t.innerText || "").trim().toLowerCase();
      return txt === "discussion" || txt.includes("discuss");
    });

    // v77: the match above is English-only, so on any other UI language this
    // returned early and the composer was never reached if the group had opened
    // on a different tab. Structural fallback: Discussion is Facebook's FIRST
    // group tab in every language. Only used when the text match found nothing
    // AND no tab is currently selected — if a tab is already active, leave it
    // alone rather than navigating the user somewhere they did not ask for.
    if (!discussionTab && tabs.length > 1) {
      const anySelected = tabs.some((t) => t.getAttribute("aria-selected") === "true");
      if (!anySelected) {
        discussionTab = tabs[0];
        try { cReport('discussion tab picked structurally (first tab, no text match) — language-independent path', 'info'); } catch (e) {}
      }
    }

    if (!discussionTab) return; // No Discussion tab visible

    // Check if it's already active
    if (discussionTab.getAttribute("aria-selected") === "true") return;

    discussionTab.click();

    // Wait up to 3 seconds for the DOM to re-render (poll for composer)
    let waited = 0;
    while (waited < 3000) {
      await sleepMs(250);
      waited += 250;
      const composer = document.querySelector(
        "div[contenteditable='true'][role='textbox'], .notranslate[contenteditable='true']"
      );
      if (composer) break;
    }
  } catch (e) {
    console.warn("[ensureDiscussionTab] Error:", e);
  }
}

/**
 * 80% of the time, scroll the feed a bit before opening the composer
 * to simulate a human reading the page.  Only runs when humanLevel > 0.
 */
async function maybeScrollFeed() {
  const humanLevel = currentHumanizationContext.level ?? 0;
  if (humanLevel === 0) return;
  if (Math.random() > 0.8) return; // 20 % skip

  const originalY = window.scrollY;
  // v85 (C3): a human browsing a group feed scrolls in SEVERAL steps over a few seconds
  // (with reading pauses, and the odd scroll-back up to re-read) — not one jump-and-restore.
  // Do 1–3 steps scaled by Natural-Presence level, then return near the start. Inert:
  // window.scroll only — zero effect on post reliability.
  const steps = 1 + Math.floor(Math.random() * (humanLevel >= 2 ? 3 : 2)); // 1–3 (1–2 at Low)
  try {
    reportStep('Reading the feed');
    let total = 0;
    for (let i = 0; i < steps; i++) {
      const up = i > 0 && Math.random() < 0.25;             // occasional re-read (scroll up)
      const dy = (0.15 + Math.random() * 0.4) * window.innerHeight * (up ? -0.6 : 1);
      window.scrollBy({ top: dy, behavior: "smooth" });
      total += dy;
      await sleepMs(Math.floor(Math.random() * 1500) + 500); // 500–2000 ms reading pause
    }
    cReport('presence: scrolled feed ~' + Math.round(total) + 'px over ' + steps + ' step(s), reading (level ' + humanLevel + ')', 'info');
    window.scrollTo({ top: originalY, behavior: "smooth" }); // back near the start
    await sleepMs(300);
  } catch (e) { /* ignore scroll errors */ }
}

async function openComposerAndInsert(text, images = [], video_id, scheduled, background, image_ids = [], unicodeFormat = false, commentText = null) {
  const ocaiId = Date.now() + "-" + Math.floor(Math.random() * 10000);
  cLog("[ocai] openComposerAndInsert called | text:", (text||"").slice(0,80), "| images:", (images||[]).length, "| image_ids:", image_ids.length, "| video_id:", video_id);
  const hasMedia = (images && images.length > 0) || image_ids.length > 0 || !!video_id;
  if (text || hasMedia) {
    // ── Pre-flight checks (run before touching the composer) ────────────
    // 1. Dismiss overlays that might block the composer click
    try { await dismissCommonOverlays(); } catch (e) { console.warn("[ocai] dismissCommonOverlays error:", e); }

    // 2. Ensure Discussion tab is active so the composer is reachable
    try { await ensureDiscussionTab(); } catch (e) { console.warn("[ocai] ensureDiscussionTab error:", e); }

    // 2b. Record what KIND of group this is. Observation only — the post
    // proceeds exactly as before whatever this finds. A commerce ("Buy and
    // Sell") group does not accept a normal post, and until now that was
    // invisible: the failure came back as Facebook's catch-all 3809006, which
    // reads identically to an anti-spam block. Recording it separates "we tried
    // to post somewhere it is impossible to post" from "the account is blocked".
    //
    // Runs after the page has fully loaded (the worker opens a NEW window per
    // group and waits for status:'complete' before injecting this script), so
    // the embedded JSON always describes THIS group.
    let _pageFeedType = null;   // v2026-10-13 · kept for the composer step below (a buy & sell page has no post box for a profile)
    try {
      const _feedType = readGroupFeedTypeFromPage();
      _pageFeedType = _feedType;
      const _isBuySell = _feedType === 'BUY_AND_SELL';
      if (_isBuySell) {
        cReport('🏷️ buy/sell (commerce) group — Facebook does not accept an ordinary post here; posting is attempted anyway, unchanged', 'warn');
      } else if (_feedType === null) {
        cLog('[group-type] feedType not found in page scripts — recorded as unknown');
      }
      // Read back by the worker in waitForOperationDone, alongside the keys it
      // already reads there. A dedicated key on purpose: operationFailReason
      // feeds classifyDomFailover, where an unrecognised value suppresses the
      // Fast failover — riding on it would change posting behaviour.
      chrome.storage.local.set({
        _groupTypeHint: { feedType: _feedType, buySell: _isBuySell, ts: Date.now() },
      });
      logTelemetry('group_type_detected', { buy_sell: _isBuySell, known: _feedType !== null }, 'INFO');
    } catch (e) { /* detection must never affect the post */ }

    // 3. Validate the page is actually postable; fail fast with a clear reason
    try {
      await checkPagePostable();
    } catch (pageErr) {
      const reason = pageErr?.reason || "page-not-postable";
      console.warn("[ocai] Page not postable:", reason);
      chrome.storage.local.set({ operationDone: "failed", operationFailReason: reason }, () => {
        if (chrome.runtime.lastError) console.error("Storage error:", chrome.runtime.lastError);
      });
      showFallbackUI(`Cannot post: ${reason.replace(/-/g, " ")}.`);
      return false;
    }

    // 4. Scroll nudge (human simulation)
    try { await maybeScrollFeed(); } catch (e) { /* ignore */ }

    // Expand spintax only when there is text to expand
    if (text) {
      try {
        text = expandSpintax(text);
      } catch (err) {
        // if expansion fails, fall back to original text
        console.error('Spintax expansion error:', err);
      }
    }

    // SPRINT-16c: Pre-stream images BEFORE opening the composer.
    // Sprint 13 worked because images were already loaded as base64 in memory — insertImage
    // ran at ~1s after openComposer and found the Photo button.  Sprint 14+ streamed images
    // INSIDE injectIntoComposer (after composer opened), delaying insertImage by 8-9 seconds.
    // By then the Photo button had already been rendered and was no longer findable in the DOM.
    // Solution: stream blobs first, then open composer — replicating Sprint 13's timing.
    let _preloadedImageBlobs = {};
    if (image_ids.length > 0) {
      cLog(`[ocai] pre-streaming ${image_ids.length} image(s) before opening composer`);
      // A1: settle pattern. The previous version resolved with a partial
      // _result on timeout/error so the caller set _usePreloaded=true with
      // only 2/3 blobs loaded, posting without an image. Now:
      //   • onDisconnect handler catches silent SW death
      //   • any non-clean path rejects → .catch logs telemetry and returns {}
      //   • {} triggers the fetchImagesByIds fallback (itself hardened in A2)
      _preloadedImageBlobs = await new Promise((resolve, reject) => {
        const _port = chrome.runtime.connect({ name: "image-stream" });
        const _result = {};
        const _bufs = {};
        const _types = {};
        let _done = false;
        const _settle = (fn, val) => {
          if (_done) return;
          _done = true;
          clearTimeout(_to);
          try { _port.disconnect(); } catch (e) {}
          fn(val);
        };
        const _to = setTimeout(
          () => _settle(reject, new Error('pre-stream timeout 90s')),
          90000
        );
        image_ids.forEach((id) => { _bufs[id] = []; });
        _port.onDisconnect.addListener(() => {
          const got = Object.keys(_result).length;
          if (got < image_ids.length) {
            _settle(reject, new Error(`pre-stream disconnected (${got}/${image_ids.length})`));
          }
        });
        _port.onMessage.addListener((msg) => {
          const { id, chunk, type, done: itemDone, error } = msg;
          if (error) { _settle(reject, new Error(`pre-stream error: ${error}`)); return; }
          if (chunk) {
            _bufs[id].push(Uint8Array.from(chunk));
            if (!_types[id]) _types[id] = type;
            _port.postMessage({ id, received: true });
          }
          if (itemDone) {
            _result[id] = {
              blob: new Blob(_bufs[id], { type: _types[id] || type || 'image/jpeg' }),
              type: _types[id] || type,
            };
            if (Object.keys(_result).length === image_ids.length) _settle(resolve, _result);
          }
        });
        _port.postMessage({ action: "get_videos_by_ids", ids: image_ids });
      }).catch((err) => {
        logTelemetry(
          'image_prestream_failed',
          { message: err?.message || String(err), ids: image_ids },
          'ERROR'
        );
        return {};
      });
      cLog(`[ocai] pre-stream done: ${Object.keys(_preloadedImageBlobs).length}/${image_ids.length} blobs ready`);
    }

    // Open the composer and wait for the REAL post-composer dialog (editor + Post button) —
    // NOT just any editor (a bare textbox check passes on the feed COMMENT box "Comment as …"
    // that's always present, so every later step would target the comment box). 5s budget —
    // the dialog can render slowly in a background window.
    let _openerTries = 0, _openerHits = 0;
    // v2026-10-12 · composer investigation: in 8 of 41 failures the opener was clicked up to 6 times while the dialog the
    // first click opened (a notice, Facebook's listing-type picker, or a composer we did not recognise) was still on
    // screen — 4–6 dialogs stacked, 58–74 s per group, a window pop. A re-click now first closes what the last click
    // opened (Escape); if it will not close, the page attempt ends ('opener-opened-other-dialog' — nothing typed).
    const _dialogCount = () => document.querySelectorAll('[role="dialog"]').length;
    let _dialogsBefore = _dialogCount();
    let _otherDialogStuck = false;
    let _buySellPicker = false;
    let _listingPicker = false;   // v2026-10-16 · Facebook's listing-type picker seen on a page not read as buy & sell
    const _closeStrayDialog = async () => {
      if (_dialogCount() <= _dialogsBefore || findPostComposerDialog()) return true;
      try {
        const el = document.activeElement || document.body;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      } catch (_) {}
      await sleep(0.8);
      return _dialogCount() <= _dialogsBefore || !!findPostComposerDialog();
    };
    const _openAndWaitForComposer = async () => {
      // Open with up to 3 re-clicks of the "Write something" trigger — exactly the
      // competitor's main flow (content.js:1106-1123: for s<3 → click → wait 5s). When the
      // user clicks away, ONE click often doesn't open the dialog, but re-clicking (with the
      // unconditional-rAF spoof keeping FB rendering, build 1948) does — NO focus needed.
      // openComposer() is idempotent: if the dialog is already open, findPostComposerDialog()
      // catches it before we re-click → no double-open.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (findPostComposerDialog()) return true;
        if (_openerTries > 0 && !(await _closeStrayDialog())) {   // any click after the first — the focus rescue's too
          _otherDialogStuck = true;
          cReport('opener-opened-other-dialog: a dialog that is not the post composer stayed open after Escape — no re-click (dialogs ' + _dialogsBefore + '→' + _dialogCount() + ')', 'warn');
          return false;
        }
        const opened = await openComposer();
        // v2026-09-12: count what actually happened. "composer never rendered"
        // conflated two failures with different fixes — we never FOUND a trigger
        // (openComposer false) vs we found one, clicked it, and Facebook opened
        // nothing (openComposer true). Diagnosing 317 field events needed Sentry
        // breadcrumb archaeology to tell them apart; this number says it outright.
        _openerTries++; if (opened) _openerHits++;
        cLog("[ocai] openComposer attempt " + (attempt + 1) + "/3 result:", opened);
        const deadline = Date.now() + 4000; // 4s per attempt (≈ the competitor's 3×5s)
        while (Date.now() < deadline) {
          if (findPostComposerDialog()) return true;
          await sleep(0.2);
        }
        // v2026-10-13 · JAVASCRIPT-1P on 1.2.9.87 (2 of 10, 'opener 6/6 · dialog: Item for sale | Vehicle for sale | Home
        // for sale or rent | Sale event'): on a buy & sell page a profile's only opener is "Sell Something", and Facebook
        // answers with its listing picker, never a post box (checked live: the page says feedType BUY_AND_SELL). Six
        // clicks and a window pop changed nothing — one look is enough. Nothing was typed or sent.
        if (_pageFeedType === 'BUY_AND_SELL' && _dialogCount() > _dialogsBefore && !findPostComposerDialog()) {
          _buySellPicker = true;
          await _closeStrayDialog();
          return false;
        }
        // v2026-10-16 · JAVASCRIPT-1P on 1.2.9.90 (ru, 'opener 6/6 · dialog_buttons=5 · Close | Item for sale | Vehicle |
        // Home | Sale event'): the same listing picker on a page whose type was not read as buy & sell. Six clicks and a
        // window pop changed nothing. Recognised by its shape (no text box, 3–6 two-line options with an icon), it is
        // closed after the first look; the attempt ends as before (composer-open-failed → the Fast failover decides).
        if (_dialogCount() > _dialogsBefore && !findPostComposerDialog()) {
          // (review) the newest VISIBLE dialog — a hidden jewel panel mounted later must not hide the picker
          const _dlgs = Array.from(document.querySelectorAll('[role="dialog"]'));
          const _vis = _dlgs.filter((d) => d.offsetParent !== null || d.getClientRects().length);
          if (_looksLikeListingPicker((_vis.length ? _vis : _dlgs)[(_vis.length ? _vis : _dlgs).length - 1])) {
            _listingPicker = true;
            await _closeStrayDialog();
            return false;
          }
        }
        // v2026-10-12 · two looks (8 s) at a loaded, painted page that shows its posts and has NO post box are
        // enough: a third changes nothing (composer investigation: 18 of 41 failures were exactly this — a group
        // where this profile cannot post — and each cost 12–17 s).
        if (attempt >= 1 && _openerHits === 0 && document.readyState === 'complete'
            && !!document.querySelector('[role="feed"],[role="article"]') && !_realDocHidden()) break;
      }
      return false;
    };

    let composerReady = await _openAndWaitForComposer();
    if (composerReady) cReport('✅ post composer found (editor + Post button) — correct dialog, not a comment box', 'info');
    // v2026-10-11 · no post box AT ALL on a page that has finished loading and shows its feed, in a window the
    // OS is painting: a focus pop cannot create one (a group you can't post in, a Facebook page under
    // /groups/). It cost a pop and 12 more seconds per such group; it now fails over at once (same
    // not-sent reason — nothing was clicked). A hidden window or a page still loading keeps the rescue.
    const _noOpenerHere = !composerReady && _openerHits === 0 && document.readyState === 'complete'
      && !!document.querySelector('[role="feed"],[role="article"]') && !_realDocHidden();
    if (_noOpenerHere) cReport('composer-no-opener: no post box on a loaded, visible page — skipping the focus rescue', 'info');
    // v2026-10-12 · …nor on a loaded, painted page that shows no posts at all (no access): a pop changes neither.
    const _noAccessHere = !composerReady && !_noOpenerHere && _openerHits === 0 && document.readyState === 'complete'
      && !_realDocHidden() && !document.querySelector('[role="feed"],[role="article"]');
    if (!composerReady && _safeMode && !_noOpenerHere && !_noAccessHere && !_buySellPicker && !_listingPicker) {
      // SAFETY NET: the MessageChannel rAF pump should keep FB rendering the composer in the
      // background, but if it STILL didn't open, bring the window to the front ONCE and retry
      // (shared one-pop guard with the settle phase → at most one pop per post). Focus ONLY on
      // failure → minimal disturbance.
      await _rescueFocusOnce('composer did not render in background');
      composerReady = await _openAndWaitForComposer();
      if (composerReady) cReport('focus rescue worked — composer opened ✅', 'info');
    }
    // v2026-10-12 · the two "this profile cannot post here" pages get their own reason (they were all
    // composer-open-failed: the row gave the wrong advice and Sentry counted them as our defect).
    //   composer-no-opener — posts are visible, there is no post box (posting limited to admins / turned off)
    //   no-access          — no posts and no post box on a loaded, painted page (not a member yet, private, gone)
    // Both: nothing was clicked → not sent; the Fast failover still confirms (see classifyDomFailover).
    // v2026-10-13 · a buy & sell page with no post box: Facebook's own answer, not our defect (it was composer-open-failed
    // in Sentry). The worker already reads the same page type (_groupTypeHint): a profile's row says "buy & sell group",
    // with no failover; a group the person admins still goes to Fast — 'safe-no-post-box' is a not-sent reason.
    if (!composerReady && _pageFeedType === 'BUY_AND_SELL') {
      cReport('safe-no-post-box: buy & sell group — no post box here for a profile, only Facebook\'s listing picker (nothing was sent) · picker=' + (_buySellPicker ? 1 : 0) + ' · opener ' + _openerHits + '/' + _openerTries + ' · ' + _composerFailFactsLine(), 'info');
      chrome.storage.local.set({ operationDone: "failed", operationFailReason: "safe-no-post-box" }, () => {});
      return false;
    }
    if (!composerReady && _otherDialogStuck) {
      chrome.storage.local.set({ operationDone: "failed", operationFailReason: "opener-opened-other-dialog" }, () => {});
      return false;
    }
    if (!composerReady) {
      const _cantPostHere = _noOpenerHere ? 'composer-no-opener'
        : (_noAccessHere || (_openerHits === 0 && document.readyState === 'complete' && !_realDocHidden()
           && !document.querySelector('[role="feed"],[role="article"]'))) ? 'no-access' : null;
      if (_cantPostHere) {
        cReport(_cantPostHere + ': ' + (_cantPostHere === 'no-access'
          ? 'no posts and no post box on this loaded page (not a member yet, private, or gone)'
          : 'the group shows posts but has no post box for this profile (posting limited)')
          + ' · opener ' + _openerHits + '/' + _openerTries + ' · ' + _composerFailFactsLine(), 'info');
        chrome.storage.local.set({ operationDone: "failed", operationFailReason: _cantPostHere }, () => {});
        return false;
      }
    }
    if (!composerReady) {
      console.error("[ocai] ❌ Failed to open composer - marking as failed and stopping");
      showFallbackUI("Failed to open composer.");
      logTelemetry("composer_open_failed", { message: "Failed to open composer." }, "ERROR", false);
      // 🪤 The relay caps `detail` at SENTRY_DETAIL_MAX (300). The old message spent 109 of
      // those characters on a prose sentence that told a reader nothing they could act on, so
      // everything after it was cut — which is why 1,976 events carried no diagnosis. Facts
      // first, in value order; the on-screen snapshot last, because it is the one part that can
      // be long and the one a truncation hurts least.
      // ⛔ The text before the first ':' is the Sentry fingerprint — it must stay exactly
      // `composer-open-failed`.
      cReport('composer-open-failed: opener ' + _openerHits + '/' + _openerTries + (_listingPicker ? ' · listing_picker=1' : '') + ' · ' +
              _composerFailFactsLine() + ' · on-screen: ' + _domFailSnapshot(), 'error');
      chrome.storage.local.set({ operationDone: "failed", operationFailReason: "composer-open-failed" }, () => {});
      return false;
    }

    let imgs = (Array.isArray(images) ? images : [])
      .filter((element) => element && element.type === "image")
      .map((element) => element.data);
    cLog("[ocai] about to call injectIntoComposer | imgs:", imgs.length, "| image_ids:", image_ids.length, "| video_ids:", (Array.isArray(video_id)?video_id:[]).length);
    // BUG-12: video_id may be a string, an array, or an empty array — normalise to a flat array
    let done = await injectIntoComposer(text, imgs, Array.isArray(video_id) ? video_id : (video_id ? [video_id] : []), scheduled, background, image_ids, _preloadedImageBlobs, unicodeFormat, commentText);
    if (!done) {
      // Signal failure so background doesn't wait for 120s timeout
      chrome.storage.local.set({ operationDone: "failed" }, function () {});
      chrome.storage.local.set(
        {
          postingStatus: "Posting encounters an error, checking again..",
        },
        function () { }
      );
    } else {
      // BUG-02: operationDone:"successful" + _postMeta are now set inside injectIntoComposer.
      // Do NOT re-set operationDone here — it would overwrite _postMeta with no postUrl.
      logTelemetry("post_success", { message: "Post successful." }, "INFO");
      return true; // CRITICAL: Return true on success so injection completes
    }
  } else {
    // Signal failure so background doesn't hang waiting for operationDone
    cReport('no-post-content: post content not found — nothing to post', 'error');
    chrome.storage.local.set({ operationDone: "failed", operationFailReason: "no-post-content" }, function () {});
    showFallbackUI("[Error] Post content not found.");
    logTelemetry(
      "post_content_not_found",
      { message: "Post content not found. Post unsucessful." },
      "ERROR"
    );
    return false; // Fail on no content
  }
  return false; // Default fail case
}

function getModalButton() {
  // Selector for the modal button, update this if Facebook changes their classes
  const selector =
    'div[class="x1i10hfl x1ejq31n xd10rxx x1sy0etr x17r0tee x972fbf xcfux6l x1qhh985 xm0m39n x9f619 x1ypdohk xe8uvvx xdj266r x11i5rnm xat24cr x1mh8g0r x16tdsg8 x1hl2dhg xggy1nq x87ps6o x1lku1pv x1a2a7pz x6s0dn4 xmjcpbm x107yiy2 xv8uw2v x1tfwpuw x2g32xy x78zum5 x1q0g3np x1iyjqo2 x1nhvcw1 x1n2onr6 xt7dq6l x1ba4aug x1y1aw1k xn6708d xwib8y2 x1ye3gou"]';
  return document.querySelector(selector);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "contentPostPost") {
    cLog("[MSG] contentPostPost received | text:", (request?.post?.text||"").slice(0,80), "| images:", (request?.post?.images||[]).length, "| video_id:", (request?.post?.video_id||[]).length);
    // Acknowledge immediately — background.js polls chrome.storage for operationDone,
    // so it doesn't need (or use) the sendResponse value. Calling sendResponse now
    // eliminates the "message channel closed" error caused by returning true without
    // ever calling sendResponse.
    sendResponse({ ack: true });
    updateHumanizationContext(request.humanization);
    _safeMode = !!request.safeMode;
    _safeCommentOn = request.safeComment === true;
    _shareStripUrl = request.shareStripUrl || null;
    // v20: kill the "Leave site? — unsaved changes" beforeunload prompt for this post. FB installs it
    // when the composer has unsaved media+text; when our window is focused mid-post it freezes the JS
    // event loop (the 121s freeze / "window keeps popping" bug). The MAIN-world neutralizer
    // (mgp-alwaysactive-main.js) does the real work on FB's handler; this clears the isolated-world
    // handle + logs a relayed confirmation so any recurrence is visible in the downloadable log.
    try { window.onbeforeunload = null; } catch (e) {}
    cReport('beforeunload: neutralized for this post (no "Leave site?" prompt → no window-freeze)', 'info');
    reportStep('Opening Facebook composer');
    // Safe mode: ask the worker to tuck this unfocused window into the bottom-right
    // corner (like the competitor), out of the user's way. Best-effort, fail-open.
    if (_safeMode) {
      // Verify the document_start visibility spoof actually injected (the ISOLATED helper
      // sets window.__mgp_aa_iso at document_start, in this same ISOLATED world). If it's
      // missing, the background tab is throttled and the composer won't render — that's the
      // root of composer-open-failed, and it tells us the registration/timing needs fixing.
      try {
        const _spoofOn = !!window.__mgp_aa_iso;
        cReport('spoof: document_start ' + (_spoofOn ? 'ACTIVE ✅' : 'NOT injected ❌ (background render may fail)'), _spoofOn ? 'info' : 'warn');
      } catch (e) {}
      try {
        const _noFoc = false; // v30: ALWAYS front the Safe window (v10 parity). A FOCUSED window is what renders the composer; unfocused = no paint = video 121s-freeze + 16s settle. safePlaceWindow runs per-post → this also re-focuses each post (v10 background.js:2237).
        chrome.runtime.sendMessage({ action: 'safePlaceWindow', sw: screen.availWidth, sh: screen.availHeight, noFocus: _noFoc }).catch(() => {});
      } catch (e) {}
      // VIDEO POSTS — v12 NO-POP: the rupload upload is network-driven and continues in a
      // backgrounded tab, so instead of OBSERVING the DOM (which needs rendering → focus) we WAIT a
      // SIZE-BASED time (waitForVideoBySize) for the upload, then assume it finished. → NO focus-
      // keeper and NO audio (both removed): nothing re-fronts the window. The visibility spoof keeps
      // the composer interactive for attach+type+Post; if it fails to render, the one-time
      // _rescueFocusOnce (composer-open guard, below) fronts the window ONCE — never continuously.
      // (_safeHasVideoFlag also honors scheduled video, which rides in image_ids with video_id null.)
      const _kv = request?.post?.video_id;
      _safeHasVideoFlag = (Array.isArray(_kv) ? _kv.length > 0 : !!_kv) || !!request?.post?.hasVideo;
      _safeVideoBytes = 0; // reset per post; accumulated as the video file(s) attach (insertImage)
      // v2026-08-15: the every-2s _runFocusKeeper is NOT started any more. It was added
      // 2026-08-09 for a real failure (timeout-no-completion on text/image: an occluded
      // window stops Chrome painting FB's dialog-close), but it was the wrong instrument
      // for it — it re-fronted the window for the WHOLE post (~80s/group measured) to
      // protect the ~11s settle phase, and users reported the posting window constantly
      // stealing focus, which is what it does by design.
      //
      // The real defect was one threshold, not a missing keeper: the settle phase ALREADY
      // has a one-shot flash-focus (waitForPostCompletion's LAYER 3) and it was gated on
      // `elapsed > 30000` while _postCompletionMax for text/image is exactly 30000 — it
      // could not fire before its own deadline. Lowered to _SETTLE_RESCUE_MS (6s), which is
      // what this file's own _rescueFocusOnce comment always claimed ("the settle poll sees
      // nothing after ~6s"). Same for the image wait, which had no rescue at all.
      //
      // Net: reactive instead of periodic. A post that proceeds normally never pops; a step
      // that actually stalls pops ONCE (shared _rescuedOnce guard) and the window then STAYS
      // front, so the recovered state is identical to what the keeper produced. Video is
      // unaffected — it has its own _vidKeeper31 below, deliberately left alone.
      // _runFocusKeeper/_stopFocusKeeper are kept in the file (unstarted) so this is one
      // line to revert if the field data says the one-shot is not enough.
    }
    // Open a long-lived port to keep the service worker alive for the full post
    let keepAlivePort = null;
    try {
      keepAlivePort = chrome.runtime.connect({ name: "posting-keep-alive" });
    } catch (e) {}
    // Watchdog: GUARANTEE operationDone is written even if the DOM flow hangs at a step
    // (a throttled/frozen typing loop, a never-resolving await, etc.). Without this, a hang
    // surfaces only as the worker's "timeout-no-report" after the full 90–210s wait with no
    // reason. We fire ~8s before the worker's own timeout and write a precise reason, so the
    // campaign continues cleanly and the log is actionable. Cleared when the flow settles.
    const _wdSec = Math.max(30, (Number(request.timeoutSec) || 90) - 8);
    // v2026-08-14: both reads below used to be RAW `await chrome.storage.local.get`.
    // This callback is the last-resort guarantee that operationDone gets written when
    // the DOM flow hangs — so it must not be able to hang on the very same class of
    // problem. A wedged storage read is not an exception, so the try/catch around it
    // was no protection at all. Bounded here, with clearTimeout on the winning branch
    // (the leaked-timer shape already fixed in loadConfig's withTimeout).
    // On timeout we return WITHOUT writing: the v23 invariant below — never overwrite
    // a possible success with a failure — outranks precision of the reason. The worker's
    // own timeout still ends the group cleanly, just as "timeout-no-report".
    const _WD_READ_MS = 3000;
    const _wdReadDone = () => new Promise((resolve) => {
      let settled = false;
      const t = setTimeout(() => { if (!settled) { settled = true; resolve('__read_timeout__'); } }, _WD_READ_MS);
      try {
        chrome.storage.local.get('operationDone', (r) => {
          if (settled) return;
          settled = true; clearTimeout(t);
          resolve(chrome.runtime?.lastError ? '__read_timeout__' : (r && r.operationDone));
        });
      } catch (e) { if (!settled) { settled = true; clearTimeout(t); resolve('__read_timeout__'); } }
    });
    const _wdSettled = (v) => v === 'success' || v === 'successful' || v === 'failed';
    // ⛔ The ceiling. Re-arming on progress must never become "runs forever":
    // a flow that keeps reporting steps and never finishes still has to end.
    const _WD_HARD_STOP = Date.now() + 15 * 60 * 1000;
    const _wdFire = async () => {
      try {
        const operationDone = await _wdReadDone();
        if (operationDone === '__read_timeout__') {
          cReport('post-confirm-timeout: storage unreadable in ' + _WD_READ_MS + 'ms — NOT writing a failure (a landed post must never be overwritten)', 'warn');
          return;
        }
        if (_wdSettled(operationDone)) return;
        // ⛔ Confirmed publication outranks the clock. Without this, a post that
        // Facebook accepted was still reported as post-confirm-timeout whenever
        // the settle/permalink/comment tail outran the watchdog — which is
        // exactly what one customer's 9 failures looked like.
        if (_postLanded) {
          cReport('post-confirm-timeout suppressed: publication was already confirmed — '
            + 'the tail (settle/permalink/comment) is still running', 'warn');
          return;
        }
        cReport('post-confirm-timeout: DOM flow did not finish in ' + _wdSec + 's — reporting failure (campaign continues)', 'error');
        // v23 (M2): re-check immediately before writing — a real 'successful' may have landed during the
        // await/cReport above. Never overwrite a success with a failure (would mask a landed post + could
        // wrongly trigger the failover).
        const _re = await _wdReadDone();
        if (_re === '__read_timeout__' || _wdSettled(_re)) return;
        chrome.storage.local.set({ operationDone: 'failed', operationFailReason: 'post-confirm-timeout' }, () => {});
      } catch (e) { /* ignore */ }
    };
    _postLanded = false;   // fresh per post — never inherit the previous group's landing
    _postUnconfirmedSent = false;
    _unconfirmedHeld = false;
    // ⛔ …and so must the STORAGE stamp. A leftover _postConfirmedAt from group N
    // would vouch for group N+1's timeout and report a post that never landed.
    try { chrome.storage.local.remove(['_postConfirmedAt', '_postPendingAt']); } catch (e) {}
    _phaseMarks = [];      // …and so does the phase timeline
    let _watchdog = setTimeout(_wdFire, _wdSec * 1000);
    _postWatchdogRearm = () => {
      if (Date.now() >= _WD_HARD_STOP) return;   // past the ceiling — let it fire
      clearTimeout(_watchdog);
      _watchdog = setTimeout(_wdFire, _wdSec * 1000);
    };
    (async () => {
      try {
        const { post } = request;
        await sleep(2);
        await openComposerAndInsert(
          post.text,
          post.images || [],
          post.video_id,
          post?.scheduled,
          request.background,
          post.image_ids || [],
          !!request.unicodeFormat,
          post.commentText || null
        );
      } catch (error) {
        cReport('handler-exception: ' + (error?.message || String(error)) + _errLoc(error), 'error');
        chrome.storage.local.set({ operationDone: "failed", operationFailReason: "handler-exception" }, () => {
          if (chrome.runtime.lastError) {
            console.error("Storage error:", chrome.runtime.lastError);
          }
        });
        showFallbackUI("Failed to open composer and insert text.");
        logTelemetry(
          "composer_injection_failed",
          { message: "Failed to open composer and insert text." },
          "WARNING"
        );
      } finally {
        try { emitPhaseSummary(); } catch (e) {}   // one line per post, whatever the outcome
        _postWatchdogRearm = null;   // ⛔ before the clear — a late step must not re-arm a dead timer
        _postLanded = false;         // ⛔ per-post — a landed post must not vouch for the NEXT group
        _postUnconfirmedSent = false;
        _unconfirmedHeld = false;
        try { chrome.storage.local.remove(['_postConfirmedAt', '_postPendingAt']); } catch (e) {}   // same rule, storage side
        clearTimeout(_watchdog);
        try { _stopFocusKeeper(); } catch (e) {}
        try { _stopKeepAudible(); } catch (e) {}
        try { keepAlivePort?.disconnect(); } catch (e) {}
      }
    })();
    return false; // sendResponse already called synchronously above
  }
});

function getOSType() {
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();

  if (platform.includes("win")) return "Windows";
  if (platform.includes("mac")) return "macOS";
  if (platform.includes("linux")) return "Linux";
  if (/android/.test(userAgent)) return "Android";
  if (/iphone|ipad|ipod/.test(userAgent)) return "iOS";

  return "unknown";
}

function getBrowserName() {
  const userAgent = navigator.userAgent;

  if (
    userAgent.includes("Chrome") &&
    !userAgent.includes("Edg") &&
    !userAgent.includes("OPR")
  )
    return "Chrome";
  if (userAgent.includes("Firefox")) return "Firefox";
  if (userAgent.includes("Safari") && !userAgent.includes("Chrome"))
    return "Safari";
  if (userAgent.includes("Edg")) return "Edge";
  if (userAgent.includes("OPR") || userAgent.includes("Opera")) return "Opera";

  return "unknown";
}

// The ~25 call sites of this function already sit at exactly the failure points
// worth knowing about — composer failed to open, image never attached, the Post
// click was never confirmed — but the body was `return;`, so every one of them
// was dead. They now relay a breadcrumb to the service worker, which owns the
// only Sentry transport (this file has no bundler and cannot import an SDK).
//
// What crosses the wire is deliberately narrow: the developer-written event
// name, the severity, and any NUMERIC/boolean fields (elapsed ms, scores,
// counts). Every string value in `data` is dropped here at the source — some
// call sites pass a free-text `message`, and the privacy commitment is that the
// text a customer writes and the groups they pick never leave the device.
// (The service worker scrubs again on the way out; this is the first gate.)
async function logTelemetry(event, data, type, _supported_group) {
  try {
    const safe = {};
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'number' || typeof v === 'boolean') safe[k] = v;
      }
    }
    safe.severity = String(type || 'INFO');
    cSentryBreadcrumb(String(event || 'dom_event'), safe);
  } catch (e) {}
}

// --------------------------------------
// 1. DYNAMIC SELECTOR MINING UTILITIES
// --------------------------------------

/**
 * Given an element and sample set, constructs the shortest unique CSS selector path.
 * @param {Element} el - The starting DOM element
 * @param {Element[]} samples - Array of sibling sample elements to match against
 * @returns {string} A minimal unique selector path string
 */
function buildUniquePath(el, samples) {
  let path = "";
  let curr = el;
  while (curr && curr.nodeType === 1) {
    const tag = curr.tagName.toLowerCase();

    // Priority: ID > role > aria-label > meaningful class > tag only
    let segment = tag;

    if (curr.id) {
      // IDs are unique, best selector candidate
      segment += `#${curr.id}`;
    } else if (curr.getAttribute("role")) {
      segment += `[role="${curr.getAttribute("role")}"]`;
    } else if (curr.getAttribute("aria-label")) {
      // Use aria-label if available
      // Escape quotes in aria-label if any
      const ariaLabel = curr.getAttribute("aria-label").replace(/"/g, '\\"');
      segment += `[aria-label="${ariaLabel}"]`;
    } else {
      // fallback to class names: pick first non-numeric, min length 3 class
      const cls = Array.from(curr.classList).find(
        (c) => c.length > 3 && !/\d+/.test(c)
      );
      if (cls) segment += `.${cls}`;
      // else leave as tag only selector segment
    }

    path = path ? `${segment} > ${path}` : segment;

    // Test if this selector matches all sample elements
    const matches = samples.filter((s) => s.matches(path));
    if (matches.length === samples.length) {
      // Found a selector that matches all samples uniquely enough
      break;
    }

    curr = curr.parentElement;
  }
  return path;
}

/**
 * Dynamically mines a selector within a given root container using a few samples.
 * @param {string} rootSel - CSS selector for the root element
 * @param {number} [sampleCount=3] - Number of child samples to use
 * @returns {Promise<string|null>} The best mined selector, or null
 */
async function mineSelector(rootSel, sampleCount = 3) {
  const root = document.querySelector(rootSel);
  if (!root) return null;
  const items = Array.from(root.children).slice(0, sampleCount);
  if (items.length < 2) return null;
  const paths = items.map((it) => buildUniquePath(it, items));
  const valid = paths.filter((p) => p);
  if (!valid.length) return null;
  return valid.sort((a, b) => a.length - b.length)[0];
}

/**
 * Attempts to determine a working selector from a list, with retry logic.
 * On success, writes to config[resultKey].
 * @param {string} arrayKey - Key in config holding candidate selectors
 * @param {string} resultKey - Key to store the chosen selector
 * @param {number} [retries=5] - Number of retry intervals
 * @param {number} [interval=1000] - Time between retries in ms
 * @returns {Promise<void>}
 */
async function determineSelector(
  arrayKey,
  resultKey,
  retries = 5,
  interval = 1000
) {
  const selectors = config[arrayKey] || [];

  // 1. Try static list up front, logging each failure
  for (let i = 0; i < selectors.length; i++) {
    const sel = selectors[i];
    if (document.querySelector(sel)) {
      config[resultKey] = sel;
      return;
    } else {
      // console.log(
      //   `[Selector][${resultKey}] ❌ Static failed (#${i + 1}): "${sel}"`
      // );
    }
  }

  // 2. Retry loop over same list, logging when one finally appears
  let attempts = 0;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      attempts++;
      for (let i = 0; i < selectors.length; i++) {
        const sel = selectors[i];
        if (document.querySelector(sel)) {
          config[resultKey] = sel;
          clearInterval(timer);
          return resolve();
        }
      }
      if (attempts >= retries) {
        // 3. Fallback after retries
        const fallback = selectors[0] || null;
        config[resultKey] = fallback;
        // logTelemetry(
        //   "selector_detection_failed",
        //   { selector_type: arrayKey, retries, fallback_selector: fallback },
        //   "ERROR"
        // );
        clearInterval(timer);
        resolve();
      }
    }, interval);
  });
}

// Fetch remote config; fallback to default
async function loadConfig() {
  const manifest = chrome.runtime.getManifest();
  const version = manifest.version;
  const baseUrl = "https://www.multiplegroupposter.com/assets/";
  const versionedFile = `domselector_${version}.config.json`;
  const defaultFile = `mgp-selectors.json`;

  const fetchConfigFromBackground = () => {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: "fetch-firebase-config" },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else if (!response) {
            reject(new Error("No config received"));
          } else {
            resolve(response);
          }
        }
      );
    });
  };

  // A5: guard sendMessage with a 15s race. If the service worker is dead or
  // reloading, the callback may never fire and init used to hang forever.
  //
  // v2026-08-10: was `Promise.race([p, new Promise(...setTimeout...)])` with
  // the timer never captured/cleared — confirmed live via Sentry: the 15s
  // timer kept running even after `p` settled fast (e.g. the already-known
  // fetchSelectorsConfigREST 403, which fails in well under a second), so
  // EVERY content-script injection fired a false "bounded-await-fallback"
  // breadcrumb ~15s later regardless of whether anything actually stalled —
  // polluting the one diagnostic signal available for genuine hangs in this
  // exact area. Mirrors the proven clear-on-settle shape already used
  // correctly by mgp-service-worker.js's own withTimeout (~line 6731) —
  // reject/resolve contract unchanged, only the leak is fixed.
  const withTimeout = (p, ms, label) => {
    let t;
    const timer = new Promise((_, rej) => {
      t = setTimeout(() => {
        // Reaching here IS the hang this race exists to break — if `p` had
        // settled, the .then below would already have cleared this timer.
        try { cSentryBreadcrumb('bounded-await-fallback', { fn: 'loadConfig.withTimeout', ms }); } catch (_) {}
        rej(new Error(`${label} timeout ${ms}ms`));
      }, ms);
    });
    return Promise.race([
      Promise.resolve(p).then(
        (v) => { clearTimeout(t); return v; },
        (e) => { clearTimeout(t); throw e; }
      ),
      timer,
    ]);
  };

  // v2026-08-10: remote config deliberately disabled for now (product
  // decision, not a bug) — confirmed live that both fallback tiers below
  // were ALREADY failing on every single load regardless: Firestore returns
  // 403 (Cloud Firestore API disabled at the multigroupposter-v2 GCP
  // project level) and the static-file fallback 404s (file not present at
  // multiplegroupposter.com/assets/mgp-selectors.json). So `config` was
  // already always ending up as defaultConfig — this doesn't change that,
  // it only stops making two guaranteed-to-fail network calls and logging
  // two guaranteed ERROR events to Sentry on every single post. To restore
  // remote config once the backend is fixed: delete this line and
  // un-comment the block below it.
  config = defaultConfig;
  /*
  try {
    config = await withTimeout(fetchConfigFromBackground(), 15000, 'loadConfig');
  } catch (e1) {
    logTelemetry(
      "config_load_failed",
      {
        version,
        message: `(FETCH) ${e1.message}. Using default configuration.`,
      },
      "ERROR"
    );

    // fallback to default file
    try {
      let res2 = await fetch(`${baseUrl}${defaultFile}`);
      if (!res2.ok) throw new Error(res2.statusText);
      config = await res2.json();
    } catch (e2) {
      logTelemetry(
        "config_load_failed_default",
        { version, message: `(FETCH) ${e2.message}. Using default config.` },
        "ERROR"
      );
      config = defaultConfig;
    }
  }
  */

  // Use first content selector
  config.contentSelector = config.contentSelectors[0];

  tagWriteSomethingComposer();
  waitForFeedAndInit();
}

// Locate and tag the "What's on your mind" composer
// Tag the "Write something..." composer box if found
function tagWriteSomethingComposer() {
  const spans = document.querySelectorAll("span");

  for (const span of spans) {
    const text = span.innerText.trim();

    // Match common Facebook composer prompts
    if (
      /What's on your mind, .+\?/i.test(text) ||
      /Write something\.\.\./i.test(text) ||
      /Write something/i.test(text) ||
      /What are you selling/i.test(text) ||
      /Write Napisz coś\.\.\./i.test(text) ||
      /Exprimez-vous\.\.\./i.test(text) ||
      /اكتب شيئًا\.\.\./i.test(text)
    ) {
      // Climb to the nearest interactive ancestor — on current Facebook the trigger
      // is a div[role="button"], not a textbox, so we check both.
      const parent =
        span.closest('[role="button"]') ||
        span.closest('[role="textbox"]') ||
        span.closest('[tabindex="0"]') ||
        span.parentElement;
      if (parent) {
        parent.setAttribute("data-composer-id", "whats-on-your-mind");
        return parent;
      }
    }
  }

  return false;
}

function findPostContent(post) {
  for (const selector of config.contentSelectors) {
    const content = post.querySelector(selector);
    if (content && content.innerText.trim() !== "") {
      return content;
    }
  }
  return null;
}

// Expand any "See more" links for long posts, with retries
function expandSeeMore(post, retries = 5, interval = 300) {
  let attempts = 0;
  const timer = setInterval(() => {
    const els = Array.from(post.querySelectorAll("div,span,a")).filter(
      (el) => el.innerText.trim() === "See more"
    );
    if (els.length) els.forEach((e) => e.click());
    if (!els.length || ++attempts >= retries) clearInterval(timer);
  }, interval);
}

function autoExpandOnLoad() {
  document
    .querySelectorAll(config.postSelector)
    .forEach((p) => expandSeeMore(p));
}

// Open the Facebook post composer by clicking the appropriate element
// ── The composer OPENER, found without reading a single word ─────────────────
//
// v2026-09-12. `composer-open-failed` was the loudest issue in the field (317
// events / 43 users, first seen 2026-08-14 and still firing). Measured on the
// real Facebook group feed in the QA browser, 2 groups × 3 viewport widths
// (300 / 500 / 1100 — the posting window is created at 300×300 and resized to
// 500×440 once the page reports complete, so both sizes are real):
//
//   • PRIORITY 1 (aria-label/aria-placeholder) matched 0 elements in ALL SIX
//     runs — on an ENGLISH page. Today's opener carries no aria-label at all.
//   • The v77 "wide button beside ≥2 small icon buttons" recipe found the right
//     element ZERO times: nothing at 1100px, and only `Anonymous post` (238px),
//     `Feeling/activity` (157px) or `Poll` (112px) below it. Its parent holds
//     exactly ONE role=button — the opener itself — so `icons.length >= 2` can
//     never be true. It is not a threshold problem; the DOM shape it describes
//     is gone. ⛔ Do NOT "fix" it by lowering the 300px gate: at 500px that
//     elects `Anonymous post`, and at 300px `Feeling/activity`.
//   • This anchor found it 6/6, at every width, and a real click opened the
//     composer (a dialog with a lexical editor AND a file input).
//
// Why the line-clamp span is the right anchor: Facebook truncates the prompt
// text with `-webkit-line-clamp`, and on the group feed exactly one such span
// resolves to a button of opener size. No text is compared, so it holds in any
// UI language — which is the whole point, since the placeholder list covers ~10
// languages and German (a paying customer's locale) is still not among them.
// The competitor uses the same anchor across 31 locales.
/**
 * 🔴 v2026-09-16 — this path was UNREACHABLE in the window it exists for.
 *
 * Measured on the real account, same page, same element, 2026-09-16:
 *     tab in BACKGROUND  →  offsetParent null,  getBoundingClientRect 0 × 0
 *     tab in FOREGROUND  →  offsetParent set,   600 × 40
 * An unpainted tab has no layout boxes at all. So `offsetParent === null` and the width/height
 * gates below could NEVER pass in a hidden window — and Safe/DOM posts from a hidden window by
 * design (that is the entire reason the rAF pump exists).
 *
 * Which means the "language-independent path" only ever worked in a foreground window, and a
 * customer whose Facebook is in a language the placeholder list does not carry — German is the
 * documented example, and the field has produced Indonesian and Greek too — had NOTHING left:
 * `composer-open-failed: opener found 0/6 attempts`, 1,976 events across 121 users.
 *
 * The filters that do the real work never needed layout. Measured across six live groups in a
 * hidden tab, `[role=button]` ancestor + not-in-article/dialog + not-anonymous + a computed-style
 * visibility check elects EXACTLY ONE element — the opener — and rejects the `display:none`
 * duplicate Facebook also renders. Geometry is kept only as a TIE-BREAK, and only when the
 * window actually has layout, so the foreground behaviour the 2026-09-12 audit measured
 * (6/6 at every width) is unchanged.
 */
function _openerHiddenByStyle(el) {
  // The only visibility test that works without paint. ⛔ Not offsetParent, not a rect.
  try {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = window.getComputedStyle(n);
      if (!cs) continue;
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
      if (n.hasAttribute && n.hasAttribute('hidden')) return true;
      if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return true;
    }
  } catch (e) { /* a realm that cannot answer is not proof of hiding */ }
  return false;
}

function _findComposerOpenerAnchor() {
  try {
    const out = [];
    for (const span of document.querySelectorAll('span[style*="-webkit-line-clamp"]')) {
      const btn = span.closest('[role="button"]');
      if (!btn || out.indexOf(btn) !== -1) continue;
      if (btn.closest('[role="article"]')) continue;        // a feed post's own controls
      if (btn.closest('[role="dialog"]')) continue;         // the opener lives on the FEED
      // 🔒 never elect the anonymous opener: it posts under a different identity,
      // and waitForPost would refuse the confirmation anyway → a wasted group.
      // Same vocabulary as ensureNotAnonymous().
      if (/anonymous|אנונימי|anónimo|anonyme/i.test(btn.textContent || '')) continue;
      if (_openerHiddenByStyle(btn)) continue;              // works with or without paint
      out.push(btn);
    }
    if (!out.length) return null;
    // ⛔ Does this DOCUMENT have layout at all? That is the whole question, and it is asked of
    // the body, not of a candidate — an element can be 0×0 for its own reasons.
    // WITH layout, every size rule below is meaningful and stays exactly as the 2026-09-12 audit
    // left it: a 112px `Poll`, a 220px-tall promo card and an off-screen element are all still
    // refused, which is what keeps a stray anchor from electing the wrong composer (see the
    // German "opened the POLL composer" incident).
    // WITHOUT layout, those same rules reject EVERYTHING — including the real opener — so the
    // structural filters above have to stand on their own.
    const box = (el) => { try { return el.getBoundingClientRect(); } catch (e) { return { width: 0, height: 0 }; } };
    const w = (el) => box(el).width;
    // 🪤 Asked of the CANDIDATES, not of document.body: a body rect is 0 in jsdom too, so a
    // document-level probe would silently take the no-layout branch in every test.
    const anySized = out.some((el) => { const r = box(el); return r.width > 0 || r.height > 0; });

    if (anySized) {
      const sized = out.filter((btn) => {
        if (btn.offsetParent === null) return false;        // off-screen, and we can tell
        const r = box(btn);
        return r.width > 150 && r.height > 20 && r.height < 100;
      });
      if (!sized.length) return null;
      // The opener is the full-width row; measured 390px at a 500px viewport against
      // 169/157/112 for the icon actions beside it.
      sized.sort((a, b) => w(b) - w(a));
      return sized[0];
    }

    // No layout: size cannot order anything. Take the one outside the feed if that is decisive,
    // else document order — measured across six live groups in a hidden tab, the structural
    // filters already leave exactly one.
    if (out.length === 1) return out[0];
    const outsideFeed = out.filter((el) => !el.closest('[role="feed"]'));
    return (outsideFeed.length === 1 ? outsideFeed[0] : out[0]);
  } catch (e) { return null; }
}

async function openComposer() {
  try {
    let activeComposer = null;

    const multiLangPlaceholders = [
      "write something",
      "what's on your mind",
      "what are you selling",
      "اكتب شيئًا",
      "بماذا تفكر",
      "ماذا تبيع",
      "escribe algo",
      "¿qué estás pensando?",
      "¿qué estás vendiendo?",
      "écrivez quelque chose",
      "à quoi pensez-vous",
      "que vendez-vous",
      "napisz coś",
      "o czym myślisz",
      "co sprzedajesz",
      "कुछ लिखें",
      "आप क्या सोच रहे हैं",
      "आप क्या बेच रहे हैं",
      "何か書く",
      "何を考えていますか",
      "何を売っていますか",
      "写点什么",
      "你在想什么",
      "你在卖什么",
      "寫點什麼",
      "你在想什麼",
      "你在賣什麼",
    ];

    // --- PRIORITY 1: aria-label / aria-placeholder (stable across DOM changes) ---
    const ariaSelectors = [
      '[aria-label*="Write something"]',
      '[aria-label*="What\'s on your mind"]',
      '[aria-label*="What are you selling"]',
      '[aria-placeholder*="Write something"]',
      '[aria-placeholder*="What\'s on your mind"]',
      '[aria-placeholder*="What are you selling"]',
      '[aria-label*="اكتب شيئًا"]',
      '[aria-label*="Escribe algo"]',
      '[aria-label*="Écrivez"]',
    ];
    for (const sel of ariaSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el) { activeComposer = el; break; }
      } catch (e) { /* invalid selector — skip */ }
    }

    // --- PRIORITY 2: visually-tagged element (set by tagWriteSomethingComposer) ---
    if (!activeComposer) {
      activeComposer = document.querySelector('[data-composer-id="whats-on-your-mind"]');
    }

    // --- PRIORITY 3: text content in spans — climb to clickable ancestor ---
    if (!activeComposer) {
      const spans = document.querySelectorAll("span");
      for (const span of spans) {
        const text = (span.textContent || "").toLowerCase().trim();
        // Guard: short text only — avoids matching large feed containers
        if (text.length > 200) continue;
        if (multiLangPlaceholders.some((kw) => text.includes(kw.toLowerCase()))) {
          // Climb to the nearest element with interactive role so the click registers
          activeComposer =
            span.closest('[role="button"]') ||
            span.closest('[role="textbox"]') ||
            span.closest('[tabindex="0"]') ||
            span.parentElement;
          break;
        }
      }
    }

    // --- PRIORITY 4: aria-label / title on input-like elements ---
    if (!activeComposer) {
      const inputLike = Array.from(
        document.querySelectorAll(
          'textarea, input[placeholder], input[aria-label], input[title], [contenteditable="true"], [role="textbox"]'
        )
      );
      activeComposer = inputLike.find((el) => {
        const attrs = [
          el.getAttribute && el.getAttribute("placeholder"),
          el.getAttribute && el.getAttribute("aria-label"),
          el.getAttribute && el.getAttribute("title"),
          el.textContent,
        ]
          .filter(Boolean)
          .map((s) => String(s).toLowerCase());
        return attrs.some((a) =>
          multiLangPlaceholders.some((kw) => a.includes(kw.toLowerCase()))
        );
      });
    }

    // --- PRIORITY 4b: STRUCTURAL, language-independent (see _findComposerOpenerAnchor) ---
    // Placed BELOW every text strategy so a locale that works today is untouched,
    // and ABOVE the config selectors because those are Facebook class hashes: the
    // third one matches a `role=null` inner DIV (measured 366×23), not the button,
    // and rotates whenever Facebook rebuilds its CSS.
    if (!activeComposer) {
      const _anchored = _findComposerOpenerAnchor();
      if (_anchored) {
        activeComposer = _anchored;
        cReport('composer opener found structurally (truncated-prompt anchor) — ' +
                'no text matched, language-independent path', 'info');
      }
    }

    // --- PRIORITY 5: static CSS selectors from config ---
    if (!activeComposer && Array.isArray(config.composerSelectors)) {
      for (const selector of config.composerSelectors) {
        try {
          const btn = document.querySelector(selector);
          if (btn) {
            activeComposer = btn;
            break;
          }
        } catch (e) { /* invalid selector — skip */ }
      }
    }

    // v77: last-resort STRUCTURAL locator, tried only after every text and
    // config strategy above has already failed — so it can add a post that
    // would otherwise not happen, and can never pre-empt a working path.
    //
    // The recipe comes from a live DOM audit of the composer: the opener is the
    // WIDE button whose parent also holds several small icon buttons (Live
    // video / Photo/video / Reel). No text is involved, so it holds in any UI
    // language. The audit also showed why position must not be used — the same
    // button sat at top:150px and top:330px across two page loads because a
    // banner shifted the layout.
    //
    // The sibling-triad idea is already proven in this file: _cmtOpenComposer
    // finds the Comment button the same way.
    if (!activeComposer) {
      try {
        const wide = Array.from(document.querySelectorAll('[role="button"]')).find((btn) => {
          if (btn.offsetParent === null) return false;
          const r = btn.getBoundingClientRect();
          if (r.width < 300 || r.height < 20) return false;          // the opener is a full-width row
          if (btn.closest('[role="article"]')) return false;          // never a feed post's own controls
          const parent = btn.parentElement;
          if (!parent) return false;
          const icons = Array.from(parent.querySelectorAll('[role="button"]')).filter((b) => {
            if (b === btn) return false;
            const br = b.getBoundingClientRect();
            return br.width > 10 && br.width < 200;                   // the small icon actions beside it
          });
          return icons.length >= 2;
        });
        if (wide) {
          activeComposer = wide;
          cReport('composer opener found structurally (wide button beside ' +
                  'icon actions) — no text matched, language-independent path', 'info');
        }
      } catch (e) { /* structural probe must never break the open path */ }
    }

    // --- BUG-23: Scope "join" check to button elements only with exact phrase ---
    // Old code scanned all spans/anchors/divs for any "join" substring which matched
    // member counts, post text, etc. on any valid group page.
    if (!activeComposer) {
      const joinGroupPhrases = [
        "join group", "join the group", "join this group",
        "unirse al grupo", "únete al grupo", "rejoindre le groupe",
        "gruppe beitreten", "partecipa al gruppo", "加入群组", "加入群組",
      ];

      // Only scan button-role elements; match EXACT text (not substring)
      const buttonCandidates = Array.from(
        document.querySelectorAll('div[role="button"], button')
      );
      const foundJoin = buttonCandidates.find((el) => {
        const text = (el.textContent || "").toLowerCase().trim();
        return joinGroupPhrases.some((phrase) => text === phrase);
      });

      if (foundJoin) {
        // Found a Join Group CTA — treat as "no composer available"
        logTelemetry(
          "unsupported_grup",
          {
            message:
              "The user may not have sufficient permission to post in the grup.",
          },
          "ERROR",
          false
        );
        return false;
      }
    }

    // --- Handle case if still not found after all checks ---
    if (!activeComposer) {
      // ── LAYER 3 (v10): Flash-focus retry ──
      // All 5 strategies failed — the tab is likely in the background and Facebook
      // hasn't rendered the composer opener. Request a brief tab focus, wait for
      // React to render, then retry the two most reliable strategies.
      cLog('[openComposer] all strategies failed — attempting flash-focus retry');
      const focused = await requestFlashFocus(true);
      if (focused) {
        await sleepMs(800);
        // Retry PRIORITY 1: aria-label selectors
        for (const sel of ariaSelectors) {
          try {
            const el = document.querySelector(sel);
            if (el) { activeComposer = el; break; }
          } catch (e) { /* skip */ }
        }
        // Retry PRIORITY 2: tagged element
        if (!activeComposer) {
          activeComposer = document.querySelector('[data-composer-id="whats-on-your-mind"]');
        }
        // Retry PRIORITY 3: text content in spans
        if (!activeComposer) {
          const spans = document.querySelectorAll("span");
          for (const span of spans) {
            const text = (span.textContent || "").toLowerCase().trim();
            if (text.length > 200) continue;
            if (multiLangPlaceholders.some((kw) => text.includes(kw.toLowerCase()))) {
              activeComposer =
                span.closest('[role="button"]') ||
                span.closest('[role="textbox"]') ||
                span.closest('[tabindex="0"]') ||
                span.parentElement;
              break;
            }
          }
        }
        if (activeComposer) {
          cLog('[openComposer] flash-focus retry SUCCEEDED');
        }
      }
    }

    if (!activeComposer) {
      logTelemetry(
        "post_composer_not_found",
        {
          message: `[DOM ERROR] Used ${Array.isArray(config.composerSelectors)
            ? config.composerSelectors.join(", ")
            : "composerSelectors missing"
            }`,
        },
        "ERROR"
      );
      return false;
    }

    // --- Click the composer button/element ---
    // Scroll element into view so click is not intercepted by sticky headers
    // LAYER 7 (v10): Use trusted click for composer opener
    try {
      await trustedClick(activeComposer);
    } catch (err) {
      // Sometimes clickable element is nested or not the actual clickable layer
      const clickable =
        activeComposer.querySelector &&
        activeComposer.querySelector('[role="button"], button, a');
      if (clickable) {
        await trustedClick(clickable);
      } else {
        console.warn("Could not click composer element directly:", err);
        return false;
      }
    }
    return true;
  } catch (err) {
    logTelemetry("open_composer_exception", { error: String(err) }, "ERROR");
    return false;
  }
}

/**
 * Convert markdown text to proper HTML for Facebook editor.
 * Supports bold, italic, underline, headings, lists, and line breaks.
 */
function convertMarkdownToHTML(markdown) {
  if (!markdown || typeof markdown !== 'string') return '';

  let html = markdown;

  // Convert headings first (must be at start of line)
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Convert bold (**text** or __text__)
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // Convert italic (*text* or _text_) - be careful not to match ** or __
  html = html.replace(/(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/(?<!_)_(?!_)([^_]+)(?<!_)_(?!_)/g, '<em>$1</em>');

  // Convert underline (~~text~~)
  html = html.replace(/~~([^~]+)~~/g, '<u>$1</u>');

  // Convert unordered lists
  html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => {
    return '<ul>' + match + '</ul>';
  });

  // Convert ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  // Wrap consecutive <li> that aren't already in <ul>
  html = html.replace(/(<li>.*<\/li>(?:\n<li>.*<\/li>)*)/g, (match) => {
    if (!match.includes('<ul>') && !match.includes('<ol>')) {
      return '<ol>' + match + '</ol>';
    }
    return match;
  });

  // Convert line breaks
  html = html.replace(/\n\n+/g, '<br><br>');
  html = html.replace(/\n/g, '<br>');

  return html;
}

/**
 * Convert inline markdown (**bold**, *italic*) to DOM nodes,
 * using <strong> for bold and <em> for italic.
 */
function parseMarkdownToNodes(text) {
  const fragment = document.createDocumentFragment();
  let pos = 0;
  // Capture **bold** in group 2, *italic* in group 3
  const regex = /(\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Add any text before this match
    const beforeText = text.substring(pos, match.index);
    if (beforeText) {
      fragment.appendChild(document.createTextNode(beforeText));
    }

    if (match[2]) {
      // **bold** → <strong>
      const strong = document.createElement("strong");
      strong.textContent = match[2];
      fragment.appendChild(strong);
    } else if (match[3]) {
      // *italic* → <em>
      const em = document.createElement("em");
      em.textContent = match[3];
      fragment.appendChild(em);
    }

    pos = regex.lastIndex;
  }

  // Add any trailing text
  const afterText = text.substring(pos);
  if (afterText) {
    fragment.appendChild(document.createTextNode(afterText));
  }

  return fragment;
}

// Attempt to click the Post button, retrying a few times before showing fallback

// Helper function to convert HTML to plain text, preserving line breaks

function smartFind(selectorHint) {
  const hint = selectorHint.toLowerCase();

  // Gather candidate elements: contenteditable textboxes and textareas/inputs
  const candidates = Array.from(
    document.querySelectorAll(
      "div[contenteditable='true'][role='textbox'], textarea, input"
    )
  ).filter((el) => el.offsetParent !== null); // only visible ones

  let best = { el: null, score: 0 };

  for (const el of candidates) {
    const score = computeElementScore(el, hint);
    if (score > best.score) {
      best = { el, score };
    }
  }

  // Only return if it looks good enough (e.g. score > 0.6)
  if (best.score >= 0.6) {
    return best.el;
  }
  return null;
}

/**
 * 2. Scoring heuristic: looks at innerText, aria-label, placeholder, name, title.
 */
function computeElementScore(el, hint) {
  const text = (el.innerText || "").toLowerCase();
  const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
  const placeholder = (el.getAttribute("placeholder") || "").toLowerCase();
  const name = (el.getAttribute("name") || "").toLowerCase();
  const title = (el.getAttribute("title") || "").toLowerCase();

  let score = 0;
  if (text.includes(hint)) score += 1;
  if (ariaLabel.includes(hint)) score += 1;
  if (placeholder.includes(hint)) score += 1;
  if (name.includes(hint)) score += 0.5;
  if (title.includes(hint)) score += 0.5;

  // Normalize by max possible (3.0)
  return Math.min(score / 3, 1);
}

// v2026-09-30 · A WhatsApp link written WITHOUT https:// ("wa.me/972…") is not a link to
// Facebook: its own composer skipped "wa.me/972500000000" and previewed the https:// link
// after it (captured live twice). With the scheme it is a link. Only WhatsApp's hosts
// (+ wa.link), only where the address starts a word, never twice.
// ⚠️ mgp-engine-core.js carries the same function for Fast — keep the two identical.
const _MGP_BARE_WA_RE = /(^|[\s(>"'“«:;,‎‏‪-‮])((?:wa\.me|wa\.link|(?:api|chat|web)\.whatsapp\.com)\/[^\s<>"']*)/gi;
function addSchemeToBareWhatsAppLinks(text) {
  if (text == null) return text;
  return String(text).replace(_MGP_BARE_WA_RE, (m, pre, link) => pre + 'https://' + link);
}

function htmlToPlainTextWithLineBreaks(html) {
  if (typeof html !== "string") return "";

  // Step 1: Replace <br> with \n and </p> with \n\n directly in the HTML string
  // (same approach as the competitor — simpler and more reliable than placeholder logic).
  // </p>\n\n gives Facebook-style paragraph spacing (blank line between paragraphs).
  //
  // v2026-08-12: </div> maps to a SINGLE \n, not \n\n — matching what the sibling
  // htmlToUnicodeFormattedText already does (its 'div' branch returns result + '\n').
  // RichTextEditor's contenteditable wraps EVERY line the user types in its own
  // <div> (Chrome's default Enter behavior), so treating each </div> as a full
  // paragraph gap turned every single line break into a blank line — every plain
  // (non-Unicode-formatted) post with a tight, line-per-line layout (e.g. a list-
  // style ad) rendered double-spaced on Facebook, while the Unicode-formatted path
  // (and Fast/API posts, which never run this file) stayed tight. Reported live via
  // side-by-side Fast-vs-Safe screenshots of the identical post text.
  // A REAL blank line the user typed (Enter twice) is still spaced correctly: Chrome
  // stores it as an EMPTY <div><br></div>, which contributes its own \n (from the
  // <br>) PLUS this </div>'s \n — three \n in a row between the two real paragraphs
  // — collapsed to exactly \n\n by the 3+-run normalization below. Verified by hand
  // trace for both the tight-list case and the blank-line-paragraph case before
  // changing this — the fix that originally introduced \n\n here (to stop paragraphs
  // silently merging) is still honored, just via that collapse step instead of a
  // blanket \n\n on every line boundary.
  // v2026-09-29: a block that OPENS after text on the same line starts a new line.
  // Chrome's editor leaves the first line bare ("Line one<div>Line two</div>"), and
  // ending lines only at closing tags glued it to the second — a scheduled Safe post
  // (this file gets the HTML there) went out as "Line oneLine two". Measured live in
  // the test group. Same rule as the worker's htmlToText (fixed 24-Sep for Publish
  // Now). The mark is a private-use character, resolved after the text is read.
  const BLOCK_START = "";
  const prepared = html
    .replace(/<(?:div|p|h[1-6]|li|blockquote|pre|tr)\b[^>]*>/gi, (tag) => BLOCK_START + tag)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/blockquote>/gi, "\n");

  // Step 2: Strip all remaining HTML tags, then get the text content
  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = prepared;
  let text = tempDiv.textContent || tempDiv.innerText || "";
  // A block start right after text breaks the line; after a line break (or at the
  // very start) it adds nothing — so tight lines stay tight.
  text = text
    .replace(/+/g, BLOCK_START)
    .replace(/([^\n])/g, "$1\n")
    .replace(//g, "");

  // Step 3: Normalize — collapse 3+ consecutive newlines to max 2 (one blank line)
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

/**
 * Convert HTML to plain text with Unicode formatting for Facebook.
 * Maps <strong>/<b> to Unicode Mathematical Bold, <em>/<i> to Unicode Mathematical Italic,
 * <strong><em> (bold+italic) to Unicode Mathematical Bold Italic,
 * and preserves line breaks, lists, headings.
 */
function htmlToUnicodeFormattedText(html) {
  if (typeof html !== "string") return "";

  // Unicode Mathematical character maps
  // Bold: 𝐀-𝐙 (U+1D400), 𝐚-𝐳 (U+1D41A), 𝟎-𝟗 (U+1D7CE)
  // Italic: 𝐴-𝑍 (U+1D434), 𝑎-𝑧 (U+1D44E)  (exception: h → ℎ U+210E)
  // Bold Italic: 𝑨-𝒁 (U+1D468), 𝒂-𝒛 (U+1D482)
  function toUnicodeBold(ch) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D400 + (code - 65)); // A-Z
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D41A + (code - 97)); // a-z
    if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7CE + (code - 48)); // 0-9
    return ch;
  }

  function toUnicodeItalic(ch) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D434 + (code - 65)); // A-Z
    if (code >= 97 && code <= 122) {
      if (ch === 'h') return '\u210E'; // special case
      return String.fromCodePoint(0x1D44E + (code - 97)); // a-z
    }
    return ch;
  }

  function toUnicodeBoldItalic(ch) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D468 + (code - 65)); // A-Z
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D482 + (code - 97)); // a-z
    if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7CE + (code - 48)); // 0-9 (same as bold)
    return ch;
  }

  function applyUnicodeFormat(text, format) {
    if (format !== 'bold' && format !== 'italic' && format !== 'bold-italic') {
      return text;
    }
    // Transform plain letters/digits to the chosen Unicode math style.
    const transformChars = (s) => {
      let out = '';
      for (const ch of s) {
        if (format === 'bold-italic') out += toUnicodeBoldItalic(ch);
        else if (format === 'bold') out += toUnicodeBold(ch);
        else out += toUnicodeItalic(ch); // format === 'italic'
      }
      return out;
    };
    // URL-PROTECTION: never convert a URL inside <b>/<i> to Unicode glyphs.
    // Facebook only detects a link when its characters are real ASCII — a
    // Mathematical-Bold "𝗵𝘁𝘁𝗽𝘀://…" is NOT recognised → no hyperlink, no link
    // preview, broken link for readers (common when a user bolds the CTA line
    // that contains the link). Split on URL spans, format only the non-URL
    // text, and keep each URL verbatim so FB still linkifies it (and the
    // URL-isolation step below can still move it to its own line for preview).
    // v2026-09-29: a link WITHOUT https:// is a link too. A customer's bold CTA line
    // "WhatsApp: wa.me/972…" went out as "𝐰𝐚.𝐦𝐞/𝟗𝟕𝟐…" and was not clickable — the
    // old pattern knew only https:// and www. Protected now: host.tld/<path>
    // (wa.me/…, chat.whatsapp.com/…, bit.ly/…) and a bare host on a common TLD.
    // A TLD is letters only, so "e.g.", "3.5" and "Mr.Smith" stay formatted.
    const PROTECT_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}\/[^\s<>"']*|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|il|me|io|ly|link|app|info|biz|shop|store|online|site)\b)/gi;
    let result = '';
    let lastIndex = 0;
    let m;
    while ((m = PROTECT_RE.exec(text)) !== null) {
      result += transformChars(text.slice(lastIndex, m.index)); // text before the URL → formatted
      result += m[0];                                           // the URL → raw ASCII (untouched)
      lastIndex = m.index + m[0].length;
    }
    result += transformChars(text.slice(lastIndex));            // trailing text → formatted
    return result;
  }

  const tempDiv = document.createElement("div");
  const cleaned = html.replace(/<br\s*\/?>/gi, "||BR||");
  tempDiv.innerHTML = cleaned;

  let listCounter = 0;

  // v2026-09-29: a block that opens after text on the same line starts a new line —
  // "Line one<div>Line two</div>" (Chrome's editor leaves line 1 bare) used to come out
  // "Line oneLine two" on every scheduled Safe post. Measured live in the test group.
  const BLOCK_TAG = /^(p|div|li|ul|ol|h[1-6]|blockquote|pre|tr|table)$/i;
  function joinChild(acc, child, out) {
    if (out && acc && !acc.endsWith('\n') && !out.startsWith('\n') &&
        child.nodeType === Node.ELEMENT_NODE && BLOCK_TAG.test(child.tagName)) {
      return acc + '\n' + out;
    }
    return acc + out;
  }

  function processNode(node, parentFormats) {
    if (node.nodeType === Node.TEXT_NODE) {
      let text = node.textContent || '';
      text = text.replace(/\|\|BR\|\|/g, '\n');

      if (!parentFormats || parentFormats.length === 0) return text;

      const isBold = parentFormats.includes('bold');
      const isItalic = parentFormats.includes('italic');

      if (isBold && isItalic) return applyUnicodeFormat(text, 'bold-italic');
      if (isBold) return applyUnicodeFormat(text, 'bold');
      if (isItalic) return applyUnicodeFormat(text, 'italic');
      return text;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    let formats = [...(parentFormats || [])];

    // Detect formatting tags
    if (['strong', 'b'].includes(tag) && !formats.includes('bold')) {
      formats.push('bold');
    }
    if (['em', 'i'].includes(tag) && !formats.includes('italic')) {
      formats.push('italic');
    }
    // <u> text renders as-is (Facebook doesn't support underline; keep plain)

    // Process children
    let result = '';
    for (const child of node.childNodes) {
      result = joinChild(result, child, processNode(child, formats));
    }

    // Block-level formatting
    if (['h1', 'h2', 'h3'].includes(tag)) {
      // Headings → bold Unicode
      result = applyUnicodeFormat(result.replace(/[\n]+$/, ''), 'bold');
      return '\n' + result + '\n\n';
    }

    if (tag === 'li') {
      const parentTag = node.parentElement?.tagName?.toLowerCase();
      if (parentTag === 'ol') {
        listCounter++;
        return listCounter + '. ' + result.trim() + '\n';
      }
      return '• ' + result.trim() + '\n';
    }

    if (tag === 'ol') {
      listCounter = 0;
      return '\n' + result + '\n';
    }

    if (tag === 'ul') {
      return '\n' + result + '\n';
    }

    if (['p', 'div'].includes(tag)) {
      return result + '\n';
    }

    return result;
  }

  let output = '';
  for (const child of tempDiv.childNodes) {
    output = joinChild(output, child, processNode(child, []));
  }

  // Normalize newlines
  output = output.replace(/\n{3,}/g, '\n\n').trim();

  // v2026-10-14 · a url only needs to be SEPARATED from its neighbours (so Facebook links it), not put on a line of its own:
  // that changed the customer's layout ("Link: url" → "Link:" / url) and, with one paragraph more, Facebook folded every
  // Safe link post in the group feed after its first line — the link hidden under "See more" (review 2, live in R1/R2).
  output = output.replace(
    /\bhttps?:\/\/[^\s<>"']+/gi,
    (url, off, str) => {
      const before = off > 0 ? str[off - 1] : '';
      const after = str[off + url.length] || '';
      return (before && !/\s/.test(before) ? ' ' : '') + url + (after && !/\s/.test(after) ? ' ' : '');
    }
  );
  output = output.replace(/\n{3,}/g, '\n\n').trim();

  return output;
}

function dataURItoBlob(dataURI) {
  const byteString = atob(dataURI.split(",")[1]);
  const mimeString = dataURI.split(",")[0].split(":")[1].split(";")[0];

  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);

  for (let i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i);
  }

  return new Blob([ab], { type: mimeString });
}

/**
 * In content.js
 *
 * Fetch multiple videos from the background's IndexedDB.
 * Expects your background.js to handle { action: "get_video", id }
 * and respond with { success: true, blob } or { success: false }.
 */
function fetchVideosByIds(ids) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "video-stream" });
    const videos = {};
    const buffers = {};
    const types = {};
    let _fvDone = false;

    // BUG-FIX: Add 90-second timeout. Without this, if the background service worker
    // dies or never sends the 'done' signal, this Promise never resolves and the entire
    // injectIntoComposer function hangs indefinitely — operationDone is never written.
    const _fvTimeout = setTimeout(() => {
      if (_fvDone) return;
      _fvDone = true;
      try { port.disconnect(); } catch(e) {}
      reject(new Error('fetchVideosByIds timeout after 90s'));
    }, 90000);

    const _fvResolve = (val) => {
      if (_fvDone) return;
      _fvDone = true;
      clearTimeout(_fvTimeout);
      resolve(val);
    };
    const _fvReject = (err) => {
      if (_fvDone) return;
      _fvDone = true;
      clearTimeout(_fvTimeout);
      reject(err);
    };

    // initialize buffers
    ids.forEach((id) => {
      buffers[id] = [];
    });

    port.onMessage.addListener((msg) => {
      const { id, chunk, type, done, error } = msg;

      if (error) {
        _fvReject(new Error(error));
        port.disconnect();
        return;
      }

      if (chunk) {
        // accumulate
        buffers[id].push(Uint8Array.from(chunk));
        if (!types[id]) types[id] = type; // store MIME type
        // ack to background so it sends next slice
        port.postMessage({ id, received: true });
      }

      if (done) {
        // create Blob using the stored type
        const blobType = types[id] || type || "video/mp4";
        const blob = new Blob(buffers[id], { type: blobType });
        videos[id] = { blob, type: blobType };

        // check if all videos are received
        if (Object.keys(videos).length === ids.length) {
          port.disconnect();
          _fvResolve(videos);
        }
      }
    });

    // kick off video streaming
    port.postMessage({ action: "get_videos_by_ids", ids });
  });
}

/**
 * Map MIME types to file extensions
 * @param {string} mimeType - The MIME type (e.g., "image/jpeg", "image/png")
 * @returns {string} - The file extension (e.g., ".jpg", ".png")
 */
function getFileExtensionFromMime(mimeType) {
  const mimeToExt = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/x-icon': '.ico',
    'image/heif': '.heif',
    'image/heic': '.heic',
    'video/mp4': '.mp4',
    'video/mpeg': '.mpeg',
    'video/quicktime': '.mov',
    'video/x-m4v': '.m4v',
    'video/x-matroska': '.mkv',
    'video/webm': '.webm',
    'video/ogg': '.ogv',
  };
  
  // Return exact match if found
  if (mimeToExt[mimeType]) {
    return mimeToExt[mimeType];
  }
  
  // Fallback: check if it's a video or image and use a generic extension
  if (mimeType.includes('video')) {
    return '.mp4';
  }
  if (mimeType.includes('image')) {
    // Default to jpg for generic image types
    return '.jpg';
  }
  
  // Ultimate fallback
  return '.bin';
}

// findPostComposerDialog() returns the OPEN post-composer dialog — uniquely the
// [role="dialog"] that contains BOTH a contenteditable editor AND a Post/Share submit
// button. Live-verified on real FB (2026-06): a group feed renders a COMMENT editor
// ("Comment as …") FIRST in the DOM, so a bare document.querySelector grabbed THAT — the
// image was set on the comment composer's input, never the post → image-attach-failed
// ("composer buttons: Comment with a GIF | Comment with a sticker…"). The post composer is
// distinguished by being the dialog that ALSO has a Post/Share button (a comment box has
// neither a dialog wrapper nor a dialog-level Post button; Notifications/Messenger dialogs
// have no editor). Returns null when the post composer isn't open yet.
function findPostComposerDialog() {
  try {
    // VISIBLE dialogs only — the competitor filters on offsetParent !== null && display !==
    // 'none' (content.js:277). Notifications/Messenger jewels are frequently present-but-
    // hidden in the DOM; filtering them out avoids ever scoping to them.
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter((d) => {
      try { return d.offsetParent !== null && window.getComputedStyle(d).display !== 'none'; }
      catch (e) { return false; }
    });
    // Prefer the LAST visible dialog with an editor AND a Post/Share button. The last dialog
    // is the most-recently-opened (the composer FB just opened — competitor uses e[e.length-1]);
    // the Post button distinguishes it from a comment box or a single-post view.
    for (let i = dialogs.length - 1; i >= 0; i--) {
      const dlg = dialogs[i];
      if (!dlg.querySelector('[data-lexical-editor="true"], [role="textbox"][contenteditable="true"]')) continue;
      const hasPostBtn = Array.from(dlg.querySelectorAll('[role="button"][aria-label], button[aria-label]')).some((b) => {
        const l = (b.getAttribute('aria-label') || '').trim();
        return POST_TRANSLATIONS.some((t) => l === t || l.toLowerCase() === t.toLowerCase());
      });
      if (hasPostBtn) return dlg;
    }
    // Fallback: LAST visible dialog whose editor carries a POST placeholder (covers the brief
    // window before the Post button mounts, and non-English UIs). Skips comment editors.
    for (let i = dialogs.length - 1; i >= 0; i--) {
      const dlg = dialogs[i];
      const ed = dlg.querySelector('[data-lexical-editor="true"], [role="textbox"][contenteditable="true"]');
      if (!ed) continue;
      const ph = (ed.getAttribute('aria-placeholder') || ed.getAttribute('aria-label') || '').toLowerCase();
      if (/comment|תגוב|comentar|kommentar/.test(ph)) continue; // skip comment editors
      if (/public post|write something|on your mind|מה בא לך|כתוב משהו|share something|écrire|escribe|schreib/.test(ph)) return dlg;
    }
    // ── Tier 3 (v44): STRUCTURAL, language-INDEPENDENT ──────────────────────────
    // Tier 1/2 above depend on a finite language list (POST_TRANSLATIONS) + a
    // hardcoded placeholder regex, so a Facebook UI in an UNLISTED language
    // (e.g. Thai: the Post button aria-label is "โพสต์", the placeholder is Thai)
    // detects NOTHING even though the composer DID open → the exact
    // `composer-open-failed` bug. This tier confirms "post composer" by STRUCTURE
    // — the same language-agnostic confidence the SUBMIT path already uses
    // (Facebook-blue button) — so it works in ANY language. Safe by construction:
    // if no dialog carries a composer-only affordance it returns null, so we
    // NEVER mistake a comment box / single-post view for the composer.
    for (let i = dialogs.length - 1; i >= 0; i--) {
      const dlg = dialogs[i];
      const ed = dlg.querySelector('[data-lexical-editor="true"], [role="textbox"][contenteditable="true"]');
      if (!ed) continue;
      // Exclude comment editors structurally (a comment box lives inside a feed
      // post = [role=article]) + by a broadened multi-language placeholder check.
      if (ed.closest('[role="article"]')) continue;
      const ph3 = (ed.getAttribute('aria-placeholder') || ed.getAttribute('aria-label') || '').toLowerCase();
      if (/comment|comentar|commentaire|kommentar|commento|תגוב|ความคิดเห็น|تعليق|bình luận|коммент/i.test(ph3)) continue;
      // Composer-only affordance #1 (cheapest, always present in the post
      // composer): the image/video file input the photo button mounts.
      if (dlg.querySelector('input[type="file"][accept*="image" i], input[type="file"][accept*="video" i]')) return dlg;
      // Composer-only affordance #2: a Facebook-blue action button (the enabled
      // Post/Next button). rgb where blue dominates red+green — language-free,
      // identical to the submit path's _getPostButtonTier2 detection.
      try {
        for (const b of dlg.querySelectorAll('[role="button"], button')) {
          const m = (window.getComputedStyle(b).backgroundColor || '').match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
          if (m && (+m[3]) >= (+m[1]) + 20 && (+m[3]) >= (+m[2]) + 20) return dlg;
        }
      } catch (e3) { /* ignore */ }
    }
  } catch (e) { /* fall through */ }
  return null;
}

// getComposerScope() returns the post-composer dialog so all photo-button / post-button /
// preview / file-input queries are scoped to the REAL post composer — never a feed comment
// box or the Notifications/Messenger dialog. Returns `document` only as a last resort;
// callers that strictly need the composer should check findPostComposerDialog() directly
// and fail clean when it's null (rather than silently targeting a comment box).
/**
 * Best-scoring visible dialog: the one that actually contains composer content.
 *
 * Facebook splits the composer into TWO visible [role=dialog] elements — the body
 * (lexical editor, file input, ~13 buttons) and a bare header holding only a
 * close button. The identical scoring already existed in _domFailSnapshot, where
 * its own comment notes it is used for logging only ("no decision reads this"),
 * even though it was written precisely because a blind pick grabbed the header.
 * Same rule, now available to the code that has to choose a scope.
 */
function _bestComposerDialog() {
  try {
    const vis = Array.from(document.querySelectorAll('[role="dialog"]')).filter((d) => d.offsetParent !== null);
    if (!vis.length) return null;
    const score = (d) => (d.querySelector('[data-lexical-editor],input[type="file"]') ? 1000 : 0)
                       + d.querySelectorAll('[role="button"]').length;
    const best = vis.slice().sort((a, b) => score(a) - score(b)).pop();
    // Only worth returning if it actually looks like a composer; a header-only
    // dialog is narrower than `document` but no more correct.
    return (best && score(best) >= 1000) ? best : null;
  } catch (_) { return null; }
}

function getComposerScope() {
  // v77: the `|| document` fallback silently widens the scope to the whole page,
  // which the header comment above already flags as a risk — every subsequent
  // querySelector can then match something outside the composer. Try the
  // dialog scorer first: it is strictly narrower than `document`, and returns
  // null unless it finds real composer content, so the old fallback still
  // applies whenever it cannot improve on it.
  return findPostComposerDialog() || _bestComposerDialog() || document;
}

async function findFileInput(context = "post") {
  const exactSelector = 'input[type="file"].x1s85apg[accept="image/*,image/heif,image/heic,video/*,video/mp4,video/x-m4v,video/x-matroska,.mkv"]';

  // Strategy 0: the image input INSIDE the composer dialog — the most reliable target.
  // Avoids grabbing a stray document-level file input (e.g. a profile-photo input), which
  // would set files on the wrong element → no preview → "upload NOT confirmed".
  try {
    const _scope = getComposerScope();
    if (_scope && _scope !== document) {
      const scoped =
        _scope.querySelector('input[type="file"][accept*="image" i]') ||
        _scope.querySelector('input[type="file"]');
      if (scoped) { cLog("[findFileInput] found via composer scope (strategy0)"); return scoped; }
    }
  } catch (e) { /* fall through */ }

  const pickFromList = (inputs) => {
    const filtered = Array.from(inputs).filter(inp => {
      const closest = inp.closest('[aria-label*="messenger" i], [aria-label*="chat" i], [data-pagelet*="Chat" i]');
      return !closest;
    });
    if (filtered.length === 1) return filtered[0];
    if (filtered.length > 1) return filtered[1];
    return null;
  };

  // 1. Exact Facebook class (document-level)
  let inputs = document.querySelectorAll(exactSelector);
  cLog("[findFileInput] strategy1 exactClass count:", inputs.length);
  let found = pickFromList(inputs);
  if (found) { cLog("[findFileInput] found via exactClass"); return found; }

  // 2. Broader selector
  inputs = document.querySelectorAll('input[type="file"][accept*="image"], input[type="file"][accept*="video"]');
  cLog("[findFileInput] strategy2 broader count:", inputs.length);
  found = pickFromList(inputs);
  if (found) { cLog("[findFileInput] found via broader"); return found; }

  // 3. Any file input at all (widest net)
  inputs = document.querySelectorAll('input[type="file"]');
  cLog("[findFileInput] strategy3 any-file-input count:", inputs.length);
  found = pickFromList(inputs);
  if (found) { cLog("[findFileInput] found via any-file-input"); return found; }

  // 4. Click the upload trigger and wait.
  // v2026-08-14: was five hardcoded English selectors ("Photo/video" / *Photo*).
  // A live capture showed the real labels are "Zdjęcie/film" (pl), "Фото/видео"
  // (ru), "صورة/فيديو" (ar) — none of which those matched, which is the second
  // symptom customers reported ("I can't find the image button").
  const btn = _findPhotoButton(getComposerScope()) || _findPhotoButton(document);
  cLog("[findFileInput] strategy4 photoBtn:", !!btn, btn?.getAttribute('aria-label'));
  if (btn) {
    btn.click();
    await sleepMs(1500);
    inputs = document.querySelectorAll('input[type="file"][accept*="image"], input[type="file"]');
    cLog("[findFileInput] after btn click, inputs:", inputs.length);
    found = pickFromList(inputs);
    if (found) { cLog("[findFileInput] found after btn click"); return found; }
  }
  cLog("[findFileInput] FAILED — no file input found");
  return null;
}

async function insertImage(imageData, context = "post") {
  // BUG-IMG-FIX: Click Photo/video button to initialize the upload handler, BUT intercept
  // any click() calls on file inputs BEFORE clicking the button.
  // Root cause of OS file dialog opening: Facebook's internal React handler for the
  // Photo/video button calls input.click() when the button is clicked, which opens the
  // native OS file picker dialog. We block this by capturing all click events on
  // input[type=file] before they reach the browser's file-picker handler.

  // Declared OUTSIDE try so it's accessible in catch for guaranteed cleanup.
  const _blockFilePicker = (e) => {
    if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'file') {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  try {
    // Intercept file-input clicks to prevent OS file dialog
    document.addEventListener('click', _blockFilePicker, true);

    // Step 1: reveal the image file input. LANGUAGE-PROOF — the image input is usually
    // already present in the composer (validated live on real FB), and findFileInput
    // finds it structurally (input[type=file][accept*=image], independent of language
    // OR FB selector changes). So we click the English "Photo/video" button ONLY when
    // the input isn't already there — that click is the single language-dependent step,
    // and we skip it whenever we can.
    const _imgInputSel = 'input[type="file"][accept*="image" i]';
    // Scope strictly to the REAL post-composer dialog. If it isn't open, DON'T fall back to
    // the document (that grabs the feed comment box's photo input → image attaches to a
    // comment, never the post). Fail clean instead.
    const _composerScope = findPostComposerDialog();
    if (!_composerScope) {
      cReport('image: post composer dialog not found — refusing to attach to a comment box', 'error');
      document.removeEventListener('click', _blockFilePicker, true);
      return false;
    }
    // v75b: snapshot the composer's images BEFORE attaching, so the confirm can detect a
    // NEW image (any src) that appears after — language- AND format-independent (Layer 3).
    try { _imgsBeforeAttach = new Set(_composerScope.querySelectorAll('img')); } catch (_) { _imgsBeforeAttach = null; }
    let _photoBtn = null;
    if (_composerScope.querySelector(_imgInputSel)) {
      cReport('image: file input already present in composer — skipping Photo/video click (language-proof path)', 'info');
    } else {
      // SPRINT-15: Poll for Photo button (up to 1500ms) — dialog may have just appeared.
      // Selectors WITHOUT the [role="dialog"] prefix — queried within the composer scope.
      // v2026-08-14: the selector array here led with two English labels and
      // then two data-testid probes described in its own comment as
      // "STRUCTURAL (language-proof)". The capture showed data-testid appears
      // ZERO times anywhere on Facebook across 7 languages — that fallback
      // could never fire, so the comment was the only thing keeping anyone
      // (including me) confident there was a language-proof net here.
      // _findPhotoButton carries the captured labels plus a real structural
      // probe: a button that already contains an image file input.
      const _photoPollStart = Date.now();
      while (Date.now() - _photoPollStart < 1500) {
        _photoBtn = _findPhotoButton(_composerScope);
        if (_photoBtn) break;
        await sleepMs(150);
      }
    }
    if (_photoBtn) {
      cReport('image: clicked Photo/video button', 'info');
      // LAYER 7 (v10): Use trusted click for Photo button - critical for image/video uploads
      await trustedClick(_photoBtn);
      // LAYER 5 (v10): Increased from 1000ms to 1500ms — React needs more time
      // to register the file input handler, especially in background tabs.
      await sleepMs(1500);
    } else {
      // Debug: dump the COMPOSER's buttons (scoped) so we identify the correct Photo label.
      const _allDlgBtns = Array.from(_composerScope.querySelectorAll('[role="button"]'));
      const _btnLabels = _allDlgBtns.map(b => b.getAttribute('aria-label') || `[text:${b.textContent.trim().slice(0,20)}]`).join(' | ');
      cReport('image: Photo/video button NOT found (1.5s poll) — composer buttons: ' + _btnLabels.slice(0, 200), 'warn');
      await sleepMs(500);
    }

    // Remove interceptor BEFORE we set files — we only needed to block the button-click phase
    document.removeEventListener('click', _blockFilePicker, true);

    // Step 2: Find the file input (should now be properly activated)
    const fileInput = await findFileInput(context);
    if (!fileInput) {
      cReport('image: NO file input found in composer — cannot attach', 'warn');
      return false;
    }
    cReport('image: file input found', 'info');

    // Step 3: Set files and dispatch change event.
    // Accept: raw Blob (streamed from MediaDB), base64 string, { base64, type } object,
    // OR an ARRAY of any of those. v86b: a multi-file batch so FB attaches them in ARRAY
    // ORDER — matching the Fast path's ordered image_ids[] array. (The old one-at-a-time
    // loop let FB order multi-image posts by upload-COMPLETION: a later, smaller image
    // could finish before an earlier, larger one → reordered vs the user's arrangement.
    // FB renders a multi-file FileList in array order, exactly like an OS multi-select.)
    const _toFile = (data, k) => {
      let blob, mime;
      if (data instanceof Blob) { blob = data; mime = data.type || 'image/jpeg'; }
      else { const b64 = typeof data === "object" ? data.base64 : data; blob = dataURItoBlob(b64); mime = b64.split(",")[0].split(":")[1].split(";")[0]; }
      try { if (/video/i.test(mime)) _safeVideoBytes += (blob.size || 0); } catch (e) {} // v12: video bytes for the size-based wait
      return new File([blob], `upload_${Date.now()}_${k}${getFileExtensionFromMime(mime)}`, { type: mime });
    };
    const _files = (Array.isArray(imageData) ? imageData : [imageData]).map(_toFile);
    const dt = new DataTransfer();
    for (const f of _files) dt.items.add(f);            // preserves array (= user-arranged) order
    fileInput.files = dt.files; // v22: normal assignment only — dropped the Object.defineProperty(fileInput,'files',…) fallback (a configurable own-property override on a DOM element is a bot tell; the real composer + competitor use plain `o.files = dt.files`).
    cReport('image: files set on input (' + (fileInput.files?.length || 0) + ' file' + (fileInput.files?.length === 1 ? '' : 's') + ' · ' + Math.round(_files.reduce((s, f) => s + (f.size || 0), 0) / 1024) + 'KB)', 'info');
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    // Dispatch "input" event as well — required when Photo button was NOT clicked.
    // Without Photo button click, React's upload machinery isn't pre-initialized.
    // The "input" event is what dist-15 (last known working version) used to make
    // React process the file even without the Photo button being clicked first.
    fileInput.dispatchEvent(new Event("input",  { bubbles: true }));

    // ── LAYER 5 (v10): Extended event dispatch ──
    // React intercepts native property setters on form elements. Triggering the
    // value setter can nudge React's internal change detection to recognize the file.
    try {
      const nativeDescriptor = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      );
      if (nativeDescriptor?.set) {
        nativeDescriptor.set.call(fileInput, '');
      }
    } catch (e) { /* ignore — this is a best-effort nudge */ }
    // Also dispatch a "click" event on the input element itself — some React builds
    // only initialize the file handler after the input receives a click.
    try {
      fileInput.dispatchEvent(new MouseEvent("click", { bubbles: false }));
    } catch (e) { /* ignore */ }

    // Step 4: Wait for FB to process, then LOG whether a preview appeared. (The real
    // upload-complete check runs in waitForImageUploadComplete after the loop; this is a
    // diagnostic so a silently-failed background upload is visible in the downloadable log.
    // We still return true so the drag-drop fallback isn't triggered on a false-negative
    // preview check — that would risk a duplicate image.)
    await sleepMs(1000);
    let _previewSeen = false;
    try {
      _previewSeen = mediaAttachedInScope(_composerScope); // v75: language/render-proof
    } catch (e) { /* ignore */ }
    cReport('image: change/input dispatched — preview ' + (_previewSeen ? 'visible ✅' : 'not yet visible'), _previewSeen ? 'info' : 'warn');
    return true;
  } catch (error) {
    // Always clean up interceptor even on exception
    document.removeEventListener('click', _blockFilePicker, true);
    cLog("[insertImage] Error:", String(error));
    return false;
  }
}

// ── LAYER 5 (v10): Drag-and-drop fallback for image upload ──
// When the standard file-input approach fails (React doesn't process the change event),
// try uploading via simulated drag-and-drop on the composer dialog.
async function insertImageViaDragDrop(imageData, composerElement) {
  try {
    // v86b: accept a single blob/base64 OR an ARRAY → one multi-file drop in array order
    // (same ordered-batch contract as insertImage, so the drag-drop fallback also preserves
    // the user's arrangement).
    const _toFileDD = (data, k) => {
      let b, m;
      if (data instanceof Blob) { b = data; m = data.type || 'image/jpeg'; }
      else { const b64 = typeof data === "object" ? data.base64 : data; b = dataURItoBlob(b64); m = b.type || 'image/jpeg'; }
      return new File([b], `upload_${Date.now()}_${k}${getFileExtensionFromMime(m)}`, { type: m });
    };
    const dt = new DataTransfer();
    for (const f of (Array.isArray(imageData) ? imageData : [imageData]).map(_toFileDD)) dt.items.add(f);

    const target = composerElement || getComposerScope();
    if (!target || target === document) {
      cLog('[insertImageViaDragDrop] No target element found');
      return false;
    }

    cLog('[insertImageViaDragDrop] attempting drag-and-drop upload');
    target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
    await sleepMs(100);
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    await sleepMs(100);
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    await sleepMs(1500);
    cLog('[insertImageViaDragDrop] drop event dispatched');
    return true;
  } catch (error) {
    cLog('[insertImageViaDragDrop] Error:', String(error));
    return false;
  }
}

// ============================================================
// Helper functions for preview detection and keystroke simulation
// ============================================================

// v75: language-proof + background-proof "an image is attached to the composer"
// detector. Shared by the image-upload confirm (waitForImageUploadComplete), the
// insertImage diagnostic, and the video-preview wait.
//
// PRIMARY signal is STRUCTURAL and language-independent: a blob:/data: image whose
// INTRINSIC size (naturalWidth) is large. naturalWidth needs NO layout, so it confirms
// even in a background/occluded Safe window where getBoundingClientRect() returns 0×0 —
// that 0×0 was the exact false-negative that made non-English Safe image posts fail
// (the old size gate used rect.width>60 only). The >=250 gate filters the small (~40–168px)
// author avatar (also a blob: URL), so it can't false-positive on it.
//
// SECONDARY signal: FB's "remove attachment" control, which appears ONLY once media is
// attached, in every UI language we ship. We match REMOVE terms only (NOT a generic
// "Edit", which would also match the always-present "Edit privacy settings" button →
// false-positive on a media-less composer) + the English-specific "Edit photo"/"Edit all".
// Scoped to the composer → fail-closed preserved (no media ⇒ returns false ⇒ refuse-to-post).
// v75b: snapshot of the composer's <img> elements, captured by insertImage RIGHT
// BEFORE the file is set. Lets the confirm detect a NEW image (any src — blob, data,
// OR https) that appears after the attach: novelty excludes the pre-existing avatar,
// so detection is language- AND format-independent (Layer 1 only sees blob/data).
let _imgsBeforeAttach = null;
const MEDIA_REMOVE_LABELS = [
  'Remove',                 // en  (FB photo "Remove"; "Edit photo"/"Edit all" handled separately)
  'Usuń',                   // pl  ("Usuń załącznik do posta")
  'Eliminar', 'Quitar',     // es
  'Supprimer',              // fr
  'Remover',                // pt
  'Entfernen',              // de
  'Eltávolít',              // hu ("Eltávolítás")
  'Elimină', 'Eliminați',   // ro
  '删除',                    // zh
  'הסר', 'הסרה',            // he
];
function mediaAttachedInScope(scope, beforeSet = _imgsBeforeAttach) {
  try {
    if (!scope) return false;
    // LAYER 3 (v75b): structural, language- AND FORMAT-independent. A NEW <img> (any
    // src — blob/data/https) sized like a real photo (naturalWidth>=250) that was NOT in
    // the composer before the attach. Novelty excludes the pre-existing avatar without
    // depending on src scheme; naturalWidth needs no layout → works in a background window.
    if (beforeSet) {
      for (const im of scope.querySelectorAll('img')) {
        if (!beforeSet.has(im) && im.naturalWidth >= 250) return true;
      }
    }
    // LAYER 1 (structural, blob/data preview by size — no snapshot needed; diagnostic/video).
    const imgs = scope.querySelectorAll('img[src^="blob:"], img[src^="data:"]');
    for (const im of imgs) {
      const r = im.getBoundingClientRect();
      if (r.width > 60 || im.naturalWidth >= 250) return true;
    }
    // SECONDARY (multilingual remove control, unique to attached media) + en edit-photo.
    // v86 (Part E): current FB renders "Edit media" (was "Edit photo"/"Edit all") — found
    // LIVE in Chrome. naturalWidth>=250 above is the PRIMARY; this is the refreshed backup.
    if (scope.querySelector('[aria-label*="Edit photo" i], [aria-label*="Edit all" i], [aria-label*="Edit media" i]')) return true;
    const btns = scope.querySelectorAll('[role="button"][aria-label]');
    for (const b of btns) {
      const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
      for (const t of MEDIA_REMOVE_LABELS) {
        if (lbl.includes(t.toLowerCase())) return true;
      }
    }
  } catch (e) { /* ignore */ }
  return false;
}

/**
 * Check if a preview exists in the composer
 * Supports images and videos including vertical videos
 */
function previewPresent(container = document) {
  try {
    // v2 spec: explicit link-preview signals (the "Remove preview" close button and
    // FB's link_preview testid) are the most reliable "preview rendered" indicators.
    //
    // 🔴 1.2.9.68, MEASURED in a live group composer: BOTH of these are inert.
    // Facebook's real labels are "Remove link preview from your post" /
    // "Change Preview" / "Remove All" — "Remove preview" is a substring of none of
    // them — and data-testid does not exist on Facebook at all (see below).
    // ⛔ Do NOT "fix" this by calling _linkCardPresent here. That function
    // deliberately treats a scraped link card as present, and this function's
    // callers (the three sites around the media-attach confirmation) would then
    // read a LINK CARD as "the image attached" — a post that believes its media
    // landed when it did not. The working signals here are the media checks
    // below; this line is left exactly as it is, now documented as dead.
    //
    // ⚠️ v2026-08-14, measured: `data-testid` appears ZERO times anywhere on
    // Facebook — 21 captured pages across 7 languages, composer open and closed.
    // Every [data-testid*="…"] in this file is therefore INERT. They are left in
    // place because each is only one option in an OR chain (removing a
    // never-matching option changes nothing, and touching the hot preview path
    // for a cosmetic gain is not worth the risk), but do NOT read them as
    // coverage: the working signals here are the aria-label probe, and
    // mediaAttachedInScope, which is genuinely structural.
    // The one place where a data-testid probe was DOCUMENTED as the
    // "STRUCTURAL (language-proof)" fallback — the Photo/video selector list —
    // was replaced with _findPhotoButton, because there the false comment was
    // load-bearing: it is why nobody looked closer.
    if (container.querySelector('[aria-label*="Remove preview" i], [data-testid*="link_preview"]')) return true;
    // Look for image/video previews in the composer area
    const previews = container.querySelectorAll(
      'img[src*="data:"], video, [data-testid*="preview"], [role="img"]'
    );
    
    // Check if any previews are visible and non-empty
    for (const preview of previews) {
      const rect = preview.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        // For images, check if they have data
        if (preview.tagName === 'IMG' && preview.src) {
          return true;
        }
        // For videos, check if they have src and are ready
        if (preview.tagName === 'VIDEO' && preview.src) {
          return true;
        }
        // For other preview elements
        if (preview.tagName !== 'IMG' && preview.tagName !== 'VIDEO') {
          const style = window.getComputedStyle(preview);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            return true;
          }
        }
      }
    }
    
    // Additional check for Facebook's specific preview containers
    const fbPreviews = container.querySelectorAll(
      '.x1qx5ct2, .x1beo9mf, [aria-label*="preview"], [data-testid*="attachment"]'
    );
    
    for (const preview of fbPreviews) {
      const rect = preview.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const style = window.getComputedStyle(preview);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          return true;
        }
      }
    }
    
    return false;
  } catch (e) {
    console.warn("[previewPresent] Error checking for preview:", e);
    return false;
  }
}

/**
 * Simulate a keystroke to trigger editor updates
 * Sends space then backspace to nudge the editor without leaving visible changes
 */
function nudgeWithKeystroke(element) {
  try {
    if (!element) return;
    
    // Simulate space press
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: " ",
        code: "Space",
        keyCode: 32,
        bubbles: true,
        cancelable: true,
      })
    );
    
    element.dispatchEvent(
      new KeyboardEvent("keypress", {
        key: " ",
        code: "Space",
        keyCode: 32,
        bubbles: true,
        cancelable: true,
      })
    );
    
    element.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: " ",
        code: "Space",
        keyCode: 32,
        bubbles: true,
        cancelable: true,
      })
    );
    
    // Simulate backspace
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Backspace",
        code: "Backspace",
        keyCode: 8,
        bubbles: true,
        cancelable: true,
      })
    );
    
    element.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Backspace",
        code: "Backspace",
        keyCode: 8,
        bubbles: true,
        cancelable: true,
      })
    );
    
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  } catch (e) {
    console.warn("[nudgeWithKeystroke] Error sending keystroke:", e);
  }
}

/**
 * Add text to an element safely
 * Uses insertText command or fallback to other methods
 */
function addText(element, text) {
  try {
    if (!element || !text) return;
    
    // Try using insertText command first
    if (document.execCommand) {
      try {
        document.execCommand("insertText", false, text);
        return;
      } catch (e) {
        // Fallback if insertText fails
      }
    }
    
    // Fallback: simulate typing by setting value (input/textarea elements only).
    // BUG-16: element.textContent += removed — it bypasses Lexical's internal state
    // and corrupts the rich-text editor, leaving the post button disabled.
    if (element.value !== undefined) {
      element.value += text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
  } catch (e) {
    console.warn("[addText] Error adding text:", e);
  }
}

/**
 * Check if any video uploads are currently in progress
 * Looks for progress bars and upload indicators in the DOM
 */
function isVideoUploading() {
  try {
    // Check for progress bar with aria-label="Uploading video"
    const progressBars = document.querySelectorAll('[role="progressbar"][aria-label*="Uploading"]');
    for (const bar of progressBars) {
      const progress = parseInt(bar.getAttribute('aria-valuenow') || '0', 10);
      const rect = bar.getBoundingClientRect();
      // If visible and progress < 100, upload is in progress
      if (rect.width > 0 && rect.height > 0 && progress < 100) {
        return true;
      }
    }
    
    // Check for progress bar class patterns used by Facebook
    const fbProgressBars = document.querySelectorAll('._1_bj[role="progressbar"], .x1ebt8du[role="progressbar"]');
    for (const bar of fbProgressBars) {
      const rect = bar.getBoundingClientRect();
      const opacity = window.getComputedStyle(bar).opacity;
      // If visible (opacity > 0), upload is in progress
      if (rect.width > 0 && rect.height > 0 && parseFloat(opacity) > 0) {
        return true;
      }
    }
    
    // Check for video elements with blob URLs (still processing)
    const videoElements = document.querySelectorAll('video[src^="blob:"]');
    for (const video of videoElements) {
      const rect = video.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        // Check if there's a sibling or parent with upload indicators
        const parent = video.closest('.x6s0dn4, .x1mzt3pk, [class*="upload"]');
        if (parent) {
          const progressInParent = parent.querySelector('[role="progressbar"], [class*="progress"]');
          if (progressInParent) {
            return true;
          }
        }
      }
    }
    
    return false;
  } catch (e) {
    console.warn('[isVideoUploading] Error checking upload status:', e);
    return false;
  }
}

/**
 * Wait for all video uploads to complete
 * Monitors progress bars and upload indicators until all videos are uploaded
 * @param {number} maxWaitSeconds - Maximum time to wait in seconds (default: 300 = 5 minutes)
 * @param {number} pollIntervalMs - How often to check in milliseconds (default: 500ms)
 * @returns {Promise<boolean>} - Returns true if uploads completed, false if timed out
 */

async function waitForImageUploadComplete(maxWaitMs = 12000, imageCount = 1) {
  // SPRINT-20: Smart two-phase detection replacing fixed minWaitMs.
  //
  // Phase 1: wait up to 1000ms for React to process file events.
  //   Exit early if aria-disabled="true" detected (upload started signal).
  //   1000ms always suffices — React processes all files in one batch regardless of count.
  //   Uses strict selector only (no fallback) to avoid false positives on Cancel/Schedule buttons.
  //   Budget: min(1000, maxWaitMs-2000) so Phase 2 always has at least 2000ms.
  //
  // Phase 2: poll every 500ms until aria-disabled cleared (server confirmed upload).
  //   Uses full fallback selector to support anonymous-post groups.
  //
  // WHY NOT blob: thumbnail: profile avatar is already a blob: URL → immediate false-positive.

  const postSel = config?.postButtonSelector || 'div[aria-label="Post"]';
  const start = Date.now();
  cLog(`[waitForImageUpload] starting: imageCount=${imageCount} maxWait=${maxWaitMs}ms`);

  // Scope every query to the composer dialog (not the first [role="dialog"] = Notifications).
  const _scope = getComposerScope();

  // Strict selector — primary only, no fallback.
  // Used in Phase 1 to avoid matching Cancel/Schedule buttons that carry aria-disabled.
  // NOTE: `postSel` is English-only ('div[aria-label="Post"]'). That is harmless HERE —
  // Phase 1 is a pure early-exit optimisation; when it misses we simply wait out its
  // ~1000ms budget, which the comment above says always suffices anyway. It is NOT
  // harmless in Phase 2, which is why Phase 2 no longer uses it (see below).
  const getPostBtnStrict = () =>
    _scope.querySelector(postSel) || document.querySelector(`[role="dialog"] ${postSel}`);

  // ── v2026-08-14: language-proof "the Post button is ENABLED" signal ────────
  // WAS: `_scope.querySelector('div[aria-label="Post"]') || … || the first
  //       [role=button] that merely HAS aria-disabled`.
  // On any non-English Facebook the first two tiers miss (the button is
  // "Opublikuj" / "Publicar" / …), so the third took over — and it matches the
  // first button that *has* aria-disabled, which is Cancel/Schedule: buttons
  // that are disabled PERMANENTLY. Phase 2 then asks "is it enabled yet?" of a
  // button that can never be enabled, so the predicate could never be satisfied
  // and every image post failed with image-attach-failed.
  // NOT intermittent — deterministic: engine logs show ok=0 / 384 failures on a
  // Polish account vs 0 failures across 232 uploads on English ones, and the
  // built-in diagnostic printed `preview=true, postEnabled=false` (the image WAS
  // attached; only the button read failed). The Phase-1 comment above even warns
  // about "false positives on Cancel/Schedule buttons" — that is exactly what
  // the old fallback did.
  // NOW: resolve the primary button the same way production already does —
  // POST_TRANSLATIONS on the label/text, else "the last short-text, non-negative
  // button in the composer" (FB renders the primary action last) — but
  // DISABLED-TOLERANT, then read aria-disabled off the button we resolved.
  //
  // ⚠️ Why not just call _getPostButtonTier1/2/3: every one of them skips
  // aria-disabled="true" (tier1 :6186, tier2 :6154, tier3 :6190), because their
  // job is "give me a button to CLICK". Here we need the opposite — the button
  // WHILE it is disabled, since "disabled → enabled" IS the upload-finished
  // signal. Caught by testing against the real customer composer: mid-upload the
  // tier chain skipped the disabled "Opublikuj" and happily returned the enabled
  // toolbar button "Zdjęcie/film", which would have confirmed the upload early
  // and posted a half-uploaded image — the exact failure the predicate below
  // exists to prevent (FB drops those to text-only).
  // Implemented at module scope (_isPrimaryComposerBtnEnabled) so it is directly
  // unit-testable — see test/dom-safety/image-upload-confirm-language.test.js.
  const isPostBtnEnabled = () => _isPrimaryComposerBtnEnabled();

  // Positive "image is attached" signal, scoped to the composer. The Remove/Edit control
  // is UNIQUE to an attached photo (the author avatar has neither), so it can't false-positive
  // on the avatar's blob: URL. A large blob:/data: image is a secondary signal (the ~40px
  // avatar is filtered out by the size gate).
  // v75: language-proof + background-proof (naturalWidth structural signal + multilingual
  // remove control). Was English-only labels + a rendered-size gate that fails (0×0) in an
  // occluded background window → false-negative "image-attach-failed" on non-English FB.
  const hasAttachedPreview = () => mediaAttachedInScope(_scope);

  // ── Phase 1: react-processing wait (max 1000ms) ───────────────────────────
  const phase1End = start + Math.min(1000, Math.max(0, maxWaitMs - 2000));
  while (Date.now() < phase1End) {
    if (getPostBtnStrict()?.getAttribute('aria-disabled') === 'true') {
      cLog(`[waitForImageUpload] upload started (aria-disabled=true) at ${Date.now() - start}ms`);
      break;
    }
    await sleepMs(150);
  }
  cLog(`[waitForImageUpload] phase1 done at ${Date.now() - start}ms — entering phase2`);

  // ── Phase 2: poll for upload completion ──────────────────────────────────
  // Confirmed = the attached-photo preview is present AND the Post button is enabled
  // (not mid-CDN-upload). Preview rules out "no image"; enabled Post rules out "still
  // uploading" — so we never submit a half-uploaded image (which FB drops to text-only).
  // Phase 2 via MutationObserver (reuses _cmtWaitFor) instead of a sleepMs(500) poll — the
  // poll is THROTTLED to ~1/s in an occluded window (Chrome), delaying confirmation; a
  // MutationObserver fires on the real DOM change regardless of throttle. Same predicate:
  // attached preview present AND Post enabled (not mid-CDN-upload → never submit half-uploaded).
  const _remaining = Math.max(1000, maxWaitMs - (Date.now() - start));
  // v2026-08-15: one-shot focus rescue for the image path, mirroring the video bar's
  // _vpRescue above. Before this, the image wait had NO rescue of any kind — the only thing
  // re-fronting the window mid-upload was the every-2s focus-keeper, which is exactly the
  // behaviour users asked us to stop. Confirmation here needs the DOM to update
  // (aria-disabled clearing on the primary button); the rAF pump normally carries that in an
  // occluded window, and when it doesn't we spend the single allowed pop instead of holding
  // the window hostage for the whole upload. Only armed when there is enough time left for
  // the pop to actually help, and _rescueFocusOnce is a no-op if the budget is already spent.
  let _imgDone = false;
  const _imgRescue = (_remaining > _SETTLE_RESCUE_MS + 2000)
    ? setTimeout(() => {
        if (!_imgDone && _safeMode) {
          _rescueFocusOnce('image upload not confirmed after ' + _SETTLE_RESCUE_MS + 'ms — front once to un-throttle').catch(() => {});
        }
      }, _SETTLE_RESCUE_MS)
    : null;
  // 🔑 Heartbeat for the media phase — the longest one, and the ONLY one with no
  // progress signal of its own. The whole batch goes up in a single
  // DataTransfer, so reportStep('Uploading image') fires once and then the
  // service worker's progress budget sees a frozen step for the entire upload.
  // Counting the previews Facebook has actually rendered turns that into a real
  // per-image signal. ⛔ Reported only when the COUNT CHANGES — this predicate
  // runs every ~150ms and an unguarded reportStep would hammer storage.
  let _seenPreviews = -1;
  const _confirmed = await _cmtWaitFor(() => {
    try {
      if (imageCount > 1) {
        const _n = _scope.querySelectorAll('img[src^="blob:"]').length;
        if (_n !== _seenPreviews) {
          _seenPreviews = _n;
          reportStep('Uploading image ' + Math.min(_n, imageCount) + '/' + imageCount);
        }
      }
    } catch (e) {}
    // Identical two-part predicate to before — preview present AND the primary
    // button not mid-upload — only the button is now resolved without depending
    // on the English word "Post".
    return (hasAttachedPreview() && isPostBtnEnabled()) ? true : null;
  }, _scope, _remaining);
  _imgDone = true;
  if (_imgRescue) clearTimeout(_imgRescue);
  if (_confirmed) {
    cLog(`[waitForImageUpload] confirmed (preview + post enabled) after ${Date.now() - start}ms`);
    // v77: `imageCount` has been a parameter here all along without ever being
    // read — confirmation was "at least one preview showed up". So attaching 2
    // of 3 images looked identical to attaching all 3, and the shortfall only
    // surfaced after the post went out.
    //
    // A live DOM audit confirmed each attached image renders as an
    // img[src^="blob:"] inside the composer, which is structural and needs no
    // wording. REPORTED, not enforced: failing the post on a count mismatch
    // would risk stranding posts over a preview that simply rendered late.
    try {
      if (imageCount > 1) {
        const _seen = _scope.querySelectorAll('img[src^="blob:"]').length;
        if (_seen > 0 && _seen < imageCount) {
          cReport(`⚠️ media count short: ${_seen}/${imageCount} image previews present at confirm — posting anyway (observation only)`, 'warn');
          logTelemetry('media_count_short', { expected: imageCount, seen: _seen }, 'WARN');
        }
      }
    } catch (e) {}
    _imgsBeforeAttach = null; // v75b: done with the pre-attach snapshot (don't leak to next group)
    return true;
  }
  console.warn('[waitForImageUpload] timeout — image not confirmed');
  // preview=true + postEnabled=false is the exact signature of the bug fixed above
  // (image attached, button unreadable). Kept so a REGRESSION is recognisable in
  // the engine log without needing Sentry.
  cReport(`[waitForImageUpload] timeout after ${maxWaitMs}ms — preview=${hasAttachedPreview()}, postEnabled=${isPostBtnEnabled()}`, 'warn');
  _imgsBeforeAttach = null; // v75b: done with the pre-attach snapshot (don't leak to next group)
  return false;
}

// VIDEO attach-confirm (Safe/DOM) — runs BEFORE clicking Post. Like the competitor's ue(): wait
// ONLY for the video PREVIEW to appear (= the file was accepted into the composer). We do NOT wait
// for the upload here — comprehensive read of the competitor (content.js:1124-1199) showed FB
// uploads the 32MB to the post SERVER-SIDE *after* Post is clicked (a progress bar; see
// waitForVideoPublishComplete). Post-button-enabled is handled separately by clickPostButtonWithRetry.
async function waitForVideoPreview(maxMs = 20000) {
  _imgsBeforeAttach = null; // v75b: video never uses an image-attach snapshot (prevent cross-context leak)
  const scope = getComposerScope();
  const hasPreview = () => {
    try {
      if (scope.querySelector('video, [data-testid*="preview"]')) return true;
      if (mediaAttachedInScope(scope)) return true; // v75: language/render-proof image preview
    } catch (e) {}
    return false;
  };
  await sleepMs(1500); // let FB register the file + render the preview
  const ok = await _cmtWaitFor(() => (hasPreview() ? true : null), scope, maxMs);
  cLog(`[waitForVideoPreview] ${ok ? 'preview present (attached)' : 'timeout — no preview'}`);
  return !!ok;
}

// VIDEO publish-confirm (Safe/DOM) — runs AFTER clicking Post + the composer closed. THIS is where
// the video really uploads: Facebook shows an upload/processing PROGRESS BAR while it sends the
// file to the just-submitted post, and the post is only truly done when that bar disappears.
// Mirrors the competitor's x() detector + their ~480s wait (content.js:1186-1191). MutationObserver-
// based (occlusion-tolerant); the restored focus-keeper keeps the window in front so the bar renders.
// Returns true = bar cleared (or never appeared → small/instant video); false = timeout (still uploading).
async function waitForVideoPublishComplete(maxMs = 270000) {
  const uploadBarShowing = () => {
    try {
      const bars = document.querySelectorAll('[data-visualcompletion="loading-state"], [role="progressbar"], [role="status"] img[src*=".gif"]');
      for (const b of bars) {
        const r = b.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 3) continue;
        const st = window.getComputedStyle(b);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
        if (r.bottom < 0 || r.top > window.innerHeight) continue;
        const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
        if (lbl.includes('volume') || lbl.includes('seek')) continue; // skip video-player controls
        return true;
      }
    } catch (e) {}
    return false;
  };
  // Grace for the upload bar to APPEAR after submit; if it never does, the upload was instant/done.
  await sleepMs(2500);
  if (!uploadBarShowing()) { cLog('[waitForVideoPublish] no upload bar after submit — assuming done'); return true; }
  cReport('video: Facebook is uploading/processing the file — waiting…', 'info');
  // FALLBACK net: if the bar is STILL showing after ~30s (e.g. keep-audible didn't fully un-throttle
  // and no focus-keeper is running), pop the window to front ONCE to un-occlude and let it finish.
  let _vpDone = false;
  const _vpRescue = setTimeout(() => { if (!_vpDone && _safeMode) { _rescueFocusOnce('video upload bar still showing after 30s — front once to un-throttle').catch(() => {}); } }, 30000);
  const gone = await _cmtWaitFor(() => (!uploadBarShowing() ? true : null), document.body, maxMs);
  _vpDone = true; clearTimeout(_vpRescue);
  cLog(`[waitForVideoPublish] ${gone ? 'upload bar cleared' : 'timeout — bar still showing'}`);
  return !!gone;
}

// Is FB's video upload/processing progress bar currently visible? (size/visibility-filtered to skip
// player controls + offscreen spinners). Module-level so waitForVideoUpload can reuse it.
function _videoUploadBarShowing() {
  try {
    const bars = document.querySelectorAll('[data-visualcompletion="loading-state"], [role="progressbar"], [role="status"] img[src*=".gif"]');
    for (const b of bars) {
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 3) continue;
      const st = window.getComputedStyle(b);
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
      if (lbl.includes('volume') || lbl.includes('seek')) continue; // skip video-player controls
      return true;
    }
  } catch (e) {}
  return false;
}

// VIDEO upload wait (Safe/DOM — v12 HYBRID, per the user's idea): combine the ADAPTIVE signal (the
// upload progress bar) with a SIZE-BASED time, closing on the FIRST of the two.
//  • PRIMARY = adaptive: the moment the bar clears (= upload finished) we're done → fast uploads
//    close fast. (MutationObserver via _cmtWaitFor — fires on DOM change even in a background tab.)
//  • FALLBACK/CAP = size-based time: if the bar can't be read (deep-background, not rendering) OR it
//    never clears, the conservative size estimate closes it. → never closes before a real upload.
// No focus, no audio, no keeper in either branch. Lenient (always resolves true).
// v13: estimate the USER's upload bandwidth from Chrome's built-in Network Information API — a
// property read, ZERO network overhead (no active speed test). downlink is the DOWNLOAD estimate,
// so take a conservative fraction for upload; fail-safe to ~2 Mbps if the API is unavailable.
function _estUploadBps() {
  try {
    const c = navigator.connection || navigator.webkitConnection;
    if (c && c.downlink > 0) return Math.max(1, c.downlink * 0.5) * 1024 * 1024 / 8; // download→upload ×0.5, →bytes/s
  } catch (e) {}
  return 250 * 1024; // ~2 Mbps fail-safe
}
// v15: read the EXACT upload percentage (aria-valuenow 0→100) — language-agnostic. This is the
// precise "bytes uploaded" signal; returns -1 if no upload progressbar with a value is present.
function _getVideoUploadPercent() {
  try {
    let best = -1;
    for (const b of document.querySelectorAll('[role="progressbar"][aria-valuenow]')) {
      // v2026-10-19 (audit F6) · a feed video's bar at 100 % closed the window while OUR upload was still going
      try { if (b.closest('[role="feed"], [role="article"], [hidden]') || b.closest(_NOTICE_EXCLUDE)) continue; } catch (_) {}
      const r = b.getBoundingClientRect();
      const st = window.getComputedStyle(b);
      if (r.width <= 0 || r.height <= 0 || st.display === 'none' || st.visibility === 'hidden') continue;
      const v = parseInt(b.getAttribute('aria-valuenow') || '', 10);
      if (!isNaN(v) && v > best) best = v;
    }
    return best; // -1 = no bar; else 0..100
  } catch (e) { return -1; }
}
async function waitForVideoUpload(totalBytes) {
  // v15: we only need the BYTES to upload (% ≈ 100) — Facebook then ENCODES the video SERVER-SIDE
  // (the dialog/bar can stay up 2–4 min during that, but the tab is NOT needed for it). So we watch
  // the upload PERCENTAGE and close at ~100% — NOT wait for the bar to disappear (= processing done,
  // far too long, the 4-min bug). No focus either way. Lenient — always resolves true.
  const bytes = Math.max(0, Number(totalBytes) || 0);
  const _bps = _estUploadBps();
  const _estMbps = (_bps * 8 / (1024 * 1024)).toFixed(1);
  const sizeSec = Math.min(180, Math.max(15, Math.round(bytes / _bps) + 10)); // byte-upload estimate (cap = safety net)
  const mb = bytes ? Math.round(bytes / (1024 * 1024)) + 'MB' : 'unknown size';
  cReport('video: confirming upload finished — watching % to ~100 (no focus, no waiting on FB encoding), size cap ~' + sizeSec + 's (' + mb + ', ~' + _estMbps + 'Mbps est)', 'info');
  const _t0 = Date.now();
  const _deadline = _t0 + sizeSec * 1000;
  let _sawBar = false, _noBar = 0;
  while (Date.now() < _deadline) {
    const pct = _getVideoUploadPercent();
    const showing = pct >= 0 || _videoUploadBarShowing();
    if (showing) {
      _sawBar = true; _noBar = 0;
      if (pct >= 99) { cReport('video: upload 100% — bytes uploaded ✅ (closing; FB encodes server-side) after ~' + Math.round((Date.now() - _t0) / 1000) + 's', 'info'); return true; }
    } else {
      if (_sawBar) { cReport('video: upload bar cleared — bytes uploaded ✅ after ~' + Math.round((Date.now() - _t0) / 1000) + 's', 'info'); return true; }
      if (++_noBar >= 12) { // ~6s and an upload bar never appeared → finished during compose (fast) or not rendering (slow)
        let _fast = true;
        try { const c = navigator.connection; if (c && c.effectiveType) _fast = (c.downlink >= 5) || (c.effectiveType === '4g'); } catch (e) {}
        // v23b (B3): only trust "no bar = finished during compose" when the video is SMALL enough to
        // plausibly have uploaded in the elapsed ~6s. A throttled BACKGROUND tab never paints the bar, so
        // for a LARGE video (sizeSec > 8) a missing bar means "not painting", NOT "done" — fall through to
        // the size-based wait rather than falsely reporting success (which would post WITHOUT the video).
        if (_fast && sizeSec <= 8) { cReport('video: no upload bar after 6s + small size (~' + sizeSec + 's est) — finished during compose ✅', 'info'); return true; }
        break; // large/slow + no bar → fall through to the size-based safety wait (don't assume done)
      }
    }
    await sleepMs(500);
  }
  const _remain = Math.max(0, _deadline - Date.now());
  if (_remain > 0) await sleepMs(_remain);
  cReport('video: size-based safety wait done (~' + sizeSec + 's, ' + mb + ', ~' + _estMbps + 'Mbps est) — assuming bytes uploaded ✅', 'info');
  return true;
}

async function waitForVideoUploadsComplete(maxWaitSeconds = 300, pollIntervalMs = 500) {
  // pollIntervalMs kept for API compat — MutationObserver replaces polling so it is unused.
  // MutationObserver fires immediately on DOM changes regardless of tab visibility,
  // eliminating the 38–58s delay caused by Chrome throttling setInterval in background tabs.

  // SPRINT-19: Add minimum wait for React to process file-set events and render the upload UI.
  // Without this, evaluate() fires immediately before the progress bar appears → isVideoUploading()
  // returns false → function resolves "done" instantly, before upload even starts.
  // LAYER 2 (v10): document.hidden is always false with ISOLATED world override.
  // Use a fixed 2500ms that works for both foreground and background tabs.
  const _initWaitMs = 2500;
  cLog(`[waitForVideoUploads] init wait: ${_initWaitMs}ms`);
  await sleepMs(_initWaitMs);

  const maxWaitMs = maxWaitSeconds * 1000;

  return new Promise((resolve) => {
    let settled = false;
    let observer = null;
    let timeoutHandle = null;

    const finish = (success) => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      clearTimeout(timeoutHandle);
      resolve(success);
    };

    const evaluate = () => {
      if (settled) return;
      if (!isVideoUploading()) finish(true);
    };

    // Watch for progressbar attribute changes and any DOM mutations in the upload area
    observer = new MutationObserver(() => evaluate());
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-valuenow', 'aria-valuemax', 'class', 'style'],
    });

    timeoutHandle = setTimeout(() => {
      if (!settled) {
        console.warn(`[waitForVideoUploads] Timeout after ${maxWaitSeconds}s`);
        finish(false);
      }
    }, maxWaitMs);

    evaluate(); // check immediately — upload might already be done
  });
}



function reconstructBlobs() {
  const blobs = [];

  Object.values(receivedItems).forEach(({ key, type, chunks }) => {
    const blob = new Blob(chunks, { type });
    blobs.push({ key, blob });
  });

  return blobs;
}

function blobToBase64(blob, type) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res({ base64: reader.result, type });
    reader.onerror = (e) => rej(e);
    reader.readAsDataURL(blob);
  });
}

function fetchSnapshotViaPort(snapshotId) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "snapshotPort" });

    // BUG-15: Track whether allChunksSent was received so that the normal
    // port.disconnect() that fires right after allChunksSent doesn't reject
    // the promise while async processing (blobToBase64 / insertImage) is still in flight.
    let allChunksReceived = false;

    // Reject only if disconnected BEFORE allChunksSent (unexpected SW death, etc.)
    port.onDisconnect.addListener(() => {
      if (!allChunksReceived) {
        reject(new Error("snapshotPort disconnected unexpectedly"));
      }
    });

    // 90-second overall timeout so a stalled video upload can't hang forever.
    const timeoutId = setTimeout(() => {
      try { port.disconnect(); } catch (e) {}
      reject(new Error("fetchSnapshotViaPort timed out after 90s"));
    }, 90_000);

    port.postMessage({ action: "fetchSnapshotItems", snapshotId });

    const receivedItems = [];
    let totalExpectedItems = null;

    port.onMessage.addListener(async (msg) => {
      if (msg.action === "receiveChunk") {
        const { itemIndex, index, total, key, type, chunk } = msg;

        if (!receivedItems[itemIndex]) {
          receivedItems[itemIndex] = {
            key,
            type,
            chunks: [],
            totalChunks: total,
          };
        }

        receivedItems[itemIndex].chunks[index] = new Uint8Array(chunk);
      }

      if (msg.action === "allChunksSent") {
        // BUG-15: Set flag BEFORE any await so that the disconnect that fires
        // immediately after background sends allChunksSent doesn't reject the promise.
        allChunksReceived = true;
        totalExpectedItems = msg.itemsCount;

        const blobs = receivedItems.map((item) => ({
          blob: new Blob(item.chunks, { type: item.type }),
          key: item.key,
        }));

        try {
          // Process each blob sequentially — no sleep between items.
          for (const el of blobs) {
            const video = await blobToBase64(el.blob, el.blob.type);
            await insertImage(video, "post");
          }
          clearTimeout(timeoutId);
          try { port.disconnect(); } catch (e) {}
          resolve(true);
        } catch (err) {
          clearTimeout(timeoutId);
          try { port.disconnect(); } catch (e) {}
          reject(err);
        }
      }
    });
  });
}

// content_fixed.js
// Updated: fixes the return-type mismatch between findPublicPostComposer() and injectIntoComposer(),
// and adds defensive checks before calling DOM methods like focus().
async function findPublicPostComposer({
  timeoutMs = 5000,
  root = document.body,
} = {}) {
  const normalize = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\u2026/g, "...") // normalize ellipsis char to three dots
      .replace(/[^\S\r\n]+/g, " ") // collapse whitespace
      .trim();

  const placeholders = [
    "create a public post",
    "what's on your mind",
    "write something",
    "create post",
    "create a post",
    "public post",
    "write a post",
    "post",
    // localized examples
    "créer une publication publique",
    "crear una publicación pública",
    "erstellen sie einen öffentlichen beitrag",
    "criar uma publicação pública",
    "creare un post pubblico",
    "创建公开帖子",
    "建立公開貼文",
    "สร้างโพสต์สาธารณะ",
    "パブリック投稿を作成",
    "공개 게시물 만들기",
    "पब्लिक पोस्ट बनाएँ",
  ].map(normalize);

  const isPlaceholderMatch = (text) => {
    if (!text) return false;
    const n = normalize(text);
    // match if placeholder text contains any of our well-known phrases
    return placeholders.some((ph) => ph.length >= 2 && n.includes(ph));
  };

  // Candidate selectors (comma-separated - valid CSS)
  const editorSelectors = [
    "div[contenteditable='true'][role='textbox'][data-lexical-editor='true']",
    "div[contenteditable='true'][role='textbox'][aria-placeholder]",
    "div[contenteditable='true'][role='textbox']",
    ".notranslate[contenteditable='true']",
  ].join(", ");

  function inspectCandidate(el) {
    try {
      if (!el || el.nodeType !== 1) return null;

      // Require placeholder text to match, not just existence of aria-placeholder
      const ap =
        el.getAttribute("aria-placeholder") || el.getAttribute("aria-label");
      if (ap && isPlaceholderMatch(ap)) {
        return { editor: el, placeholderNode: el, placeholderText: ap };
      }

      // 2) visible placeholder in aria-hidden / sibling nodes
      let ancestor = el;
      for (
        let depth = 0;
        depth < 4 && ancestor;
        depth++, ancestor = ancestor.parentElement
      ) {
        const hiddenCandidates = Array.from(
          ancestor.querySelectorAll(
            '[aria-hidden="true"], [data-testid="placeholder"], .xi81zsa, .placeholder, [role="presentation"]'
          )
        );
        for (const hidden of hiddenCandidates) {
          const txt = (hidden.textContent || hidden.innerText || "").trim();
          if (isPlaceholderMatch(txt)) {
            return {
              editor: el,
              placeholderNode: hidden,
              placeholderText: txt,
            };
          }
        }
      }

      // 3) empty editor + visible sibling placeholder
      if (
        (el.textContent || "").trim() === "" ||
        el.querySelector("p:empty, p > br")
      ) {
        const parent = el.parentElement;
        if (parent) {
          const visibleHint = Array.from(parent.querySelectorAll("div, span"))
            .map((n) => (n.textContent || n.innerText || "").trim())
            .find((txt) => isPlaceholderMatch(txt));
          if (visibleHint) {
            return {
              editor: el,
              placeholderNode: parent,
              placeholderText: visibleHint,
            };
          }
        }
      }
    } catch (err) {
      console.warn("inspectCandidate error", err);
    }
    return null;
  }

  // Fast scan first (in case the element is already present)
  try {
    const candidates = Array.from(document.querySelectorAll(editorSelectors));
    for (const c of candidates) {
      const found = inspectCandidate(c);
      if (found) return found; // returns an object {editor, placeholderNode, placeholderText}
    }

    // Also scan for visible placeholder text nodes anywhere, then walk to nearby editor
    const textHints = Array.from(document.querySelectorAll("div, span")).filter(
      (n) => (n.textContent || "").length < 200
    );
    for (const node of textHints) {
      if (isPlaceholderMatch(node.textContent || node.innerText)) {
        const editable =
          node
            .closest("div")
            ?.querySelector("div[contenteditable='true'][role='textbox']") ||
          node
            .closest("article, section, div")
            ?.querySelector("div[contenteditable='true'][role='textbox']");
        if (editable) {
          const found = inspectCandidate(editable);
          if (found) return found;
        }
      }
    }
  } catch (err) {
    console.warn("initial findPublicPostComposer scan failed", err);
  }

  // If not found: observe for mutations up to timeout
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      // on timeout, resolve null (not a truthy object) so callers can check easily
      observer.disconnect();
      resolve(null);
    }, timeoutMs);

    const observer = new MutationObserver((mutations) => {
      try {
        // prefer cheap queries: look for editors quickly
        const nodes = Array.from(root.querySelectorAll(editorSelectors));
        for (const n of nodes) {
          const ok = inspectCandidate(n);
          if (ok) {
            clearTimeout(timeout);
            observer.disconnect();
            return resolve(ok);
          }
        }

        // incremental: if placeholders appear as text nodes, check near them
        const possibleHints = Array.from(
          root.querySelectorAll('[aria-hidden="true"], div, span')
        ).filter((node) => {
          const text = (node.textContent || node.innerText || "").trim();
          return isPlaceholderMatch(text);
        });
        for (const hint of possibleHints) {
          const editable =
            hint
              .closest("div")
              ?.querySelector("div[contenteditable='true'][role='textbox']") ||
            hint
              .closest("article, section, div")
              ?.querySelector("div[contenteditable='true'][role='textbox']");
          if (editable) {
            const ok = inspectCandidate(editable);
            if (ok) {
              clearTimeout(timeout);
              observer.disconnect();
              return resolve(ok);
            }
          }
        }
      } catch (err) {
        console.warn("MutationObserver callback error", err);
      }
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    // As a safety, do a tiny re-check after starting observation (catch fast renders)
    setTimeout(() => {
      const nodes = Array.from(root.querySelectorAll(editorSelectors));
      for (const n of nodes) {
        const ok = inspectCandidate(n);
        if (ok) {
          clearTimeout(timeout);
          observer.disconnect();
          return resolve(ok);
        }
      }
    }, 50);
  });
}

// ============================================================
// Character-by-character typing simulation
// ============================================================
/**
 * Type plain text into a contenteditable element one character at a time,
 * with random per-character delays and occasional longer pauses.
 * Only used when humanLevel > 0 (SMART BEHAVIOR is not Off).
 *
 * @param {Element} element   - The target contenteditable element
 * @param {string}  plainText - Plain text string to type (no HTML)
 */
async function typeTextCharByChar(element, plainText) {
  if (!plainText || !element) return;
  cReport('presence: typing ' + plainText.length + ' chars char-by-char', 'info');

  // Split text into segments: URLs are pasted as whole chunks (to avoid Lexical's
  // auto-link detector doubling characters), everything else is typed char-by-char.
  const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;
  const segments = [];
  let lastIndex = 0;
  let match;
  while ((match = URL_REGEX.exec(plainText)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: plainText.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'url', value: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < plainText.length) {
    segments.push({ type: 'text', value: plainText.slice(lastIndex) });
  }

  // Number of chars between longer pauses (random 5-15)
  let charsTillPause = Math.floor(Math.random() * 11) + 5;

  for (const segment of segments) {
    if (segment.type === 'url') {
      // Insert the entire URL at once via insertText to prevent Lexical from
      // doubling characters as its auto-link detector fires on each keystroke.
      // NOTE: Do NOT dispatch a manual InputEvent after execCommand — execCommand
      // already fires its own input event. A second one causes Lexical to process
      // the insertion twice, resulting in doubled URLs.
      try {
        document.execCommand("insertText", false, segment.value);
      } catch (e) { /* ignore */ }
      // Brief pause after URL insertion
      await sleepMs(Math.floor(Math.random() * 101) + 100); // 100-200ms
      continue;
    }

    // Regular text: type character by character
    for (let i = 0; i < segment.value.length; i++) {
      const char = segment.value[i];

      if (char === "\n") {
        // BUG-FIX: For line breaks, use Enter keyboard event ONLY (no execCommand insertText).
        // execCommand("insertText", "\n") + keydown Enter = double paragraph break in Lexical.
        // Lexical's keydown handler for Enter creates the paragraph break — execCommand is redundant.
        // v2026-10-14 · ONE "\n" is a line break (Shift+Enter), "\n\n" a new paragraph (Enter). Facebook stores a
        // paragraph as an empty line ("a\n\nb") and, in the group FEED, folds a post with a card at its first empty line —
        // every Safe link post read "first line… See more" while the same text by Fast ("a\nb") showed in full (measured
        // live 14-Oct: identical blocks in the post, "\n\n" vs "\n" in Facebook's own feed data).
        const _para = segment.value[i + 1] === "\n";
        if (_para) i++;   // the pair is ONE paragraph break
        try {
          element.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter", code: "Enter", keyCode: 13, which: 13, shiftKey: !_para,
            bubbles: true, cancelable: true, composed: true,
          }));
        } catch (e) { /* ignore */ }
        await sleepMs(60);
        try {
          element.dispatchEvent(new KeyboardEvent("keyup", {
            key: "Enter", code: "Enter", keyCode: 13, which: 13, shiftKey: !_para,
            bubbles: true, cancelable: true, composed: true,
          }));
        } catch (e) { /* ignore */ }
        await sleepMs(60);
        continue;
      }

      // Dispatch keydown
      try {
        element.dispatchEvent(new KeyboardEvent("keydown", {
          key: char,
          code: "Key" + char.toUpperCase(),
          bubbles: true,
          cancelable: true,
          composed: true,
        }));
      } catch (e) { /* ignore */ }

      try {
        document.execCommand("insertText", false, char);
      } catch (e) {
        // Silently skip the character rather than corrupting editor state.
      }

      // Dispatch keyup
      try {
        element.dispatchEvent(new KeyboardEvent("keyup", {
          key: char,
          bubbles: true,
          cancelable: true,
          composed: true,
        }));
      } catch (e) { /* ignore */ }

      // Per-character delay: 40-120 ms, non-uniform
      const baseDelay = Math.floor(Math.random() * 81) + 40;
      await sleepMs(baseDelay);

      charsTillPause--;
      if (charsTillPause <= 0) {
        // Longer pause every 5-15 chars: 300-800 ms
        const longPause = Math.floor(Math.random() * 501) + 300;
        await sleepMs(longPause);
        charsTillPause = Math.floor(Math.random() * 11) + 5;
      }
    }
  }
}

function scoreTextbox(el) {
  const ariaPh = (el.getAttribute('aria-placeholder') || '').toLowerCase();
  const text   = (el.innerText                        || '').toLowerCase();
  const label  = (el.getAttribute('aria-label')       || '').toLowerCase();

  const keywords = ["what's on your mind", 'write something', 'create a public post', 'post'];
  const hit = (str) => keywords.some((k) => str.includes(k));

  let score = 0;
  if (hit(ariaPh)) score += 2.0; // aria-placeholder is the most reliable signal
  if (hit(text))   score += 1.5; // innerText second
  if (hit(label))  score += 1.0; // aria-label third

  // v44: STRUCTURAL, language-INDEPENDENT signal. The keyword list above is
  // English-only, so a composer in another language (e.g. Thai) scores 0 and is
  // only picked by the area fail-closed fallback. A lexical editor inside a
  // [role=dialog] (and not a feed comment box, already filtered upstream by
  // [role=article]) IS the post composer regardless of UI language → score it as
  // a first-class match so detection is predictable in every locale.
  try {
    if ((el.getAttribute('data-lexical-editor') === 'true' || el.getAttribute('role') === 'textbox')
        && el.closest('[role="dialog"]') && !el.closest('[role="article"]')) {
      score += 1.0;
    }
  } catch (e) { /* ignore */ }

  return score;
}

async function waitForComposerTextbox(timeoutMs = 15000) {
  const selectors = [
    "div[data-lexical-editor='true']",
    "div.notranslate[contenteditable='true']",
    "div[role='textbox'][contenteditable='true']",
  ].join(', ');

  const deadline = Date.now() + timeoutMs;

  // Path-based safety guard (v2 spec): never look for a composer in a DM/Messenger
  // context — belt-and-suspenders beyond the per-element aria-label/pagelet checks.
  if (location.pathname.startsWith('/messages') || location.pathname.startsWith('/t/') ||
      location.hostname.includes('messenger.com')) {
    cLog('[composer] messaging context (' + location.pathname + ') — refusing to find a composer');
    return null;
  }

  while (Date.now() < deadline) {
    if (document.readyState !== 'complete') {
      await sleepMs(500);
      continue;
    }

    const candidates = Array.from(document.querySelectorAll(selectors)).filter((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 20 &&
        rect.height > 10 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    });

    if (candidates.length === 0) {
      await sleepMs(200);
      continue;
    }

    const filtered = candidates.filter((el) => {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      // Explicit exclusions: comment boxes, chat/DM inputs, search bars, Messenger sidebar,
      // DM inbox, and any pagelet identified as Chat or Inbox by Facebook's data attributes.
      if (label.includes('comment') || label.includes('chat') || label.includes('search') ||
          label.includes('message') || label.includes('messenger')) return false;
      // v77: those labels are English-only, so on another UI language none of
      // them match and a comment box could be picked as the composer. A comment
      // editor always lives inside a feed post ([role="article"]); the real
      // composer never does. Same test findPostComposerDialog's Tier 3 already
      // uses — structural, so it holds in every language.
      if (el.closest('[role="article"]')) return false;
      if (el.closest('div[aria-label*="comment" i]')) return false;
      if (el.closest('div[aria-label*="chat" i]')) return false;
      if (el.closest('div[aria-label*="message" i]')) return false;
      if (el.closest('div[role="search"]')) return false;
      // Facebook DM / Messenger sidebar pagelots
      if (el.closest('[data-pagelet*="Chat"]')) return false;
      if (el.closest('[data-pagelet*="Inbox"]')) return false;
      if (el.closest('[data-pagelet*="MercuryFixedBottomPerch"]')) return false;
      if (el.closest('[role="complementary"]')) return false; // docked chat rail (v2 spec)
      if (el.closest('[role="article"]')) return false;       // every feed post + its comment box is in an article (v2 spec)
      // Minimum width guard: filter out search bars, comment reply boxes, DM chips.
      // Use width ONLY — the composer textbox is always full-dialog-width (300px+)
      // whereas comment/search boxes are narrow. Do NOT check height: an empty
      // Lexical composer starts at ~20px tall (one line) which is under any
      // reasonable height threshold and would cause false exclusions.
      const rect = el.getBoundingClientRect();
      if (rect.width < 150) return false;
      return true;
    });

    const pool = filtered.length > 0 ? filtered : candidates;

    const scored = pool.map((el) => ({ el, score: scoreTextbox(el) }));
    scored.sort((a, b) => b.score - a.score);

    if (scored[0].score > 0.5) return scored[0].el;

    // v2 spec FAIL-CLOSED: score is weak (≤0.5). Only fall back to "largest by area"
    // if that element is NOT a forbidden context AND carries a positive composer
    // signal — otherwise refuse (return null) rather than risk typing into the wrong
    // box. A real composer scores ≥0.5 from structure, so this fallback is a rare edge.
    const _largest = pool.reduce((best, el) => {
      const rb = best.getBoundingClientRect();
      const re = el.getBoundingClientRect();
      return re.width * re.height > rb.width * rb.height ? el : best;
    });
    const _confirmed = _largest && !_isForbiddenComposerContext(_largest) &&
      (_largest.getAttribute('data-lexical-editor') === 'true' || !!_largest.closest('[role="dialog"]'));
    if (!_confirmed) {
      cLog('[composer] weak score (' + scored[0].score + ') + fallback not a confirmed composer — refusing (fail-closed)');
      return null;
    }
    return _largest;
  }

  return null;
}

// v2 spec: ONE fail-closed guard — is this element inside a context where we must
// NEVER type/submit (a comment box, a DM/Messenger thread, a feed article, a search
// box, or any messaging page)? Used by composer detection AND as a final pre-submit
// guard so a post can never go out from the wrong place.
// v2026-10-02 · the editor Facebook shows NOW. A reference that is still in the page is returned as is; a detached
// one (Facebook re-mounts the editor, e.g. when a background is picked) is replaced by the editor of the open
// post composer — the dialog the post is being written in. Nothing else is ever substituted.
function liveComposerEditor(prev) {
  if (prev && prev.isConnected) return prev;
  const dlg = Array.from(document.querySelectorAll('[role="dialog"]'))
    .find((d) => d.offsetParent !== null && d.querySelector('[contenteditable="true"]'));
  const live = dlg && (dlg.querySelector('[data-lexical-editor="true"]') || dlg.querySelector('[contenteditable="true"]'));
  return live || prev;
}

function _isForbiddenComposerContext(el) {
  try {
    if (!el || !(el instanceof Element)) return true;
    if (location.pathname.startsWith('/messages') || location.pathname.startsWith('/t/') ||
        location.hostname.includes('messenger.com')) return true;
    if (el.closest('[role="article"]')) return true;                       // comment boxes live in articles
    if (el.closest('div[aria-label*="comment" i]')) return true;
    if (el.closest('div[aria-label*="chat" i], div[aria-label*="message" i], div[aria-label*="messenger" i]')) return true;
    if (el.closest('[data-pagelet*="Chat"], [data-pagelet*="Inbox"], [data-pagelet*="MercuryFixedBottomPerch"]')) return true;
    if (el.closest('[role="complementary"]')) return true;                 // docked chat rail
    if (el.closest('div[role="search"]')) return true;
    const label = (el.getAttribute('aria-label') || el.getAttribute('aria-placeholder') || '').toLowerCase();
    if (/\b(comment|message|chat|reply|search)\b/.test(label)) return true;

    // v2026-08-14: STRUCTURAL backstop. Every check above this line is either
    // an English word or a container that a live capture showed is simply not
    // on the page: across en/pl/ru/ar/vi/pt/zh, `[role=complementary]` appears
    // in NONE, and `[role=article]` / `[data-pagelet]` are absent in en, pl and
    // vi. The English label test is the only one that ever fired — "comment"
    // occurs 5× in English and 0× in all six other languages. So on a
    // non-English Facebook a comment box passed every gate.
    //
    // What separates them is structural, not verbal: captured in 4 languages,
    // the post composer's editor is ALWAYS inside a [role=dialog] (and within
    // it a [role=presentation] — the shape composerInputAreaSelectors already
    // leads with), while the feed's comment box is inline and inside none.
    //
    // Scoped deliberately: this only rejects when a composer dialog is actually
    // open, so it can never misfire on a page with no dialog at all. Nothing is
    // newly ALLOWED here — this only adds a rejection, keeping the fail-closed
    // direction of the whole function.
    const _openComposerDialog = Array.from(document.querySelectorAll('[role="dialog"]'))
      .find((d) => d.offsetParent !== null &&
                   d.querySelector('[contenteditable="true"], [data-lexical-editor], input[type="file"]'));
    if (_openComposerDialog && !el.closest('[role="dialog"]')) return true;

    return false;
  } catch (e) { return true; }   // fail-CLOSED: any error → treat as forbidden, never type/submit on uncertainty
}

// B (never anonymous): the user never wants an anonymous post. If the create-post
// dialog has an "anonymous" toggle that is ON, turn it OFF before submit. Only
// touches a switch positively identified as the anonymous one — never flips an
// unrelated switch.
async function ensureNotAnonymous() {
  try {
    // v2026-10-19 (audit F9) · the first [role=dialog] in the page is usually Facebook's hidden Notifications panel
    let dialog = null;
    try { dialog = (typeof findPostComposerDialog === 'function' && findPostComposerDialog()) || null; } catch (_) { dialog = null; }
    if (!dialog) dialog = Array.from(document.querySelectorAll('div[role="dialog"]')).find((d) => !d.closest('[hidden]') && !d.querySelector('a[href*="/notifications"], [role="grid"]')) || null;
    if (!dialog) return;
    const switches = dialog.querySelectorAll('input[role="switch"], [role="switch"]');
    for (const sw of switches) {
      const ctx = sw.closest('[role="group"], label') || sw.parentElement || dialog;
      const txt = ((sw.getAttribute('aria-label') || '') + ' ' + ((ctx && ctx.textContent) || '')).toLowerCase();
      if (!/anonymous|אנונימי|anónimo|anonyme/.test(txt)) continue; // only the anonymous toggle
      const isOn = sw.getAttribute('aria-checked') === 'true' || sw.checked === true;
      if (isOn) {
        cLog('[ensureNotAnonymous] anonymous toggle is ON — turning it OFF');
        try { sw.click(); } catch (e) {}
        await sleepMs(400);
      } else {
        cLog('[ensureNotAnonymous] anonymous toggle already OFF');
      }
    }
  } catch (e) { cLog('[ensureNotAnonymous] error:', e && e.message ? e.message : e); }
}

function isValidTextbox(el) {
  if (!(el instanceof Element)) return false;
  if (el.offsetParent === null) return false;
  // Exclude comment boxes, chat/DM inputs, Messenger pagelots
  if (el.closest('div[aria-label*="comment" i], div[aria-label*="Comment"]')) return false;
  if (el.closest('[role="article"]')) return false; // feed post / comment box (v2 spec)
  if (el.closest('div[aria-label*="chat" i], div[aria-label*="message" i]')) return false;
  if (el.closest('[data-pagelet*="Chat"], [data-pagelet*="Inbox"]')) return false;
  const rect = el.getBoundingClientRect();
  // Width-only check — an empty Lexical composer is ~20px tall so height filtering
  // would exclude the valid textbox. Width is the reliable distinguisher.
  return rect.width >= 150 && rect.height > 0;
}

// v2 spec: scrape the real post permalink from the success toast (FB shows a
// "View post" / permalink link in the [role="alert"] snackbar after publishing).
// Scoped to the alert/toast ONLY so we don't match other posts' links in the feed.
// Returns the clean post URL or null (caller falls back to the group URL).
// A resolved href that is a real group post/permalink: /posts/<id>, /permalink/<id>,
// or /groups/<gid>/posts|permalink/<id>. The numeric id is in the PATH, so split('?')[0]
// yields the clean canonical URL.
function _isPostPermalinkHref(href) {
  return /\/(posts|permalink)\/\d+/.test(href || '');
}
// Locate the freshly-published article: prefer the one whose text matches what we posted
// (robust against pinned/announcement posts at the top), else the top feed article.
// ── v1.2.9.67 · matching OUR post, or admitting we cannot ────────────────────
//
// 🔴 This used to end with `post = arts[0] || document.querySelector('div[role="article"]')`
// — "if the text did not match, take the first post in the feed". Two shipping
// bugs came out of that one line:
//
//   1. A PENDING post is not in the feed at all, so the snippet could never
//      match and a STRANGER'S permalink came back. The settle loop's exit
//      condition is `detectPendingApproval() || getExactPostPermalink(...)`, so
//      that stranger's link satisfied it on the FIRST poll — the pending notice
//      never got its 12 seconds, and the post was recorded as a plain success.
//      This is the customer's "it doesn't always notice a pending post", and the
//      randomness is whether the snippet happened to match.
//   2. A group feed is RANKED, not chronological, so `arts[0]` can be a pinned
//      or announcement post even when our post really did land — the user's
//      history then links to somebody else's post.
//
// An image-only post made it certain: empty text ⇒ no snippet ⇒ straight to
// `arts[0]`, every time.
//
// So: match, or return null. Null is already the caller's supported answer —
// "falls back to the group url (fine for a pending post)".
function _normForMatch(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]+>/g, ' ')
    // 🪤 Entities, because the snippet comes from the post HTML and the feed gives
    // us rendered text: "&amp;" would never match "&", which is one more way the
    // old code silently fell through to arts[0].
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// v2026-10-13 · Facebook's group feed no longer wraps a post in role="article" — only its COMMENTS are articles
// now (measured live in R1: the chain from a post's text up to the feed has no article). 0 of 39 Safe posts got
// their own link, so every "View" opened the group. A post is one CHILD of the feed; the old articles stay as a
// fallback (nested ones lose to the unit that contains them — the outermost rule below).
function _feedPostUnits() {
  const units = [];
  try { for (const f of document.querySelectorAll('div[role="feed"]')) for (const c of f.children) units.push(c); } catch (_) {}
  const arts = Array.from(document.querySelectorAll('div[role="feed"] div[role="article"]'));
  return units.concat(arts.filter((a) => !units.includes(a)));
}

/** The feed post that is OUR post, or null when that cannot be established. */
function _findFreshPostArticle(postedText) {
  const arts = _feedPostUnits();   // may be empty — the fresh post can sit outside any feed (below)
  const snip = _normForMatch(postedText).slice(0, 40);
  // Under ~8 characters a snippet stops identifying anything — "thanks" matches
  // half a buy/sell group. No identification is better than the wrong post.
  if (snip.length < 8) return null;
  let hits = arts.filter((a) => _normForMatch(a.textContent).includes(snip) && !_wasOnPageBeforeSubmit(a));
  if (!hits.length) {
    // v2026-10-13 · measured live IN the Safe window: right after Post, Facebook draws the new post ABOVE the feed —
    // outside div[role=feed] (the page held 2 post texts, only the older one inside the feed). Find our text anywhere
    // in the page's main column, then climb to the block that holds it and no other post. Never past main/feed, never
    // into the side column (its "recent media" photos name OTHER posts).
    const msgs = Array.from(document.querySelectorAll('[data-ad-rendering-role="story_message"]'))
      .filter((m) => _normForMatch(m.textContent).includes(snip) && !m.closest('[role="complementary"], [role="navigation"], [role="dialog"]')
        && !(_preSubmitPosts && _preSubmitPosts.msgs.has(m)));
    if (msgs.length !== 1) return null;
    const STOP = '[role="main"], [role="feed"], [role="complementary"], [role="navigation"], [role="banner"]';
    let u = msgs[0];
    while (u.parentElement && u.parentElement !== document.body && !u.parentElement.matches(STOP)
      && u.parentElement.querySelectorAll('[data-ad-rendering-role="story_message"]').length === 1) u = u.parentElement;
    return u;
  }
  if (hits.length > 1) {
    // A shared post renders as an article inside an article, and an ancestor's
    // textContent includes its descendants' — so one real match can present as
    // two nested ones. Keep the OUTERMOST: the timestamp anchor that carries the
    // permalink lives in the post's own header, while a nested article's anchor
    // points at the post being quoted. (Written the other way round first, and a
    // mutation caught it: the inner one is somebody else's link.)
    hits = hits.filter((h) => !hits.some((o) => o !== h && o.contains(h)));
  }
  return hits.length === 1 ? hits[0] : null;
}

function scrapePermalinkFromToast() {
  try {
    // Broadened: any toast/snackbar/alert/aria-live surface, scan every anchor inside it.
    const surfaces = document.querySelectorAll('[role="alert"], [data-testid="snackbar"], [data-testid*="toast"], [aria-live="polite"], [aria-live="assertive"]');
    for (const s of surfaces) {
      // 🔴 Messenger lives in an aria-live region. A chat notification carrying a
      // link to somebody's post would be read as OUR post's permalink — and
      // because the settle loop exits as soon as a permalink appears, that also
      // robs a pending post of its detection window. Same exclusion the notice
      // and pending scanners already use.
      try { if (s.closest(_NOTICE_EXCLUDE)) continue; } catch (_) {}
      for (const a of s.querySelectorAll('a[href]')) {
        if (_isPostPermalinkHref(a.href)) return a.href.split('?')[0];
      }
    }
  } catch (e) { /* fall back to group URL */ }
  return null;
}

// Best-effort EXACT post permalink after a successful Safe/DOM post — 100% DOM, no network:
//   1. the success toast's "View post" link (fastest), else
//   2. the freshly-posted article in the feed — BROADENED to scan ALL anchors in the post,
//      because the timestamp/permalink link is often an `a[role="link"]`, not a plain
//      `a[href*="/posts/"]` (that narrow selector is why the link wasn't found in 2/3/7).
// Returns null if none found → caller falls back to the group url (fine for a pending post).
function getExactPostPermalink(postedText) {
  try {
    const fromToast = scrapePermalinkFromToast();
    if (fromToast) return fromToast;
  } catch (e) {}
  try {
    const post = _findFreshPostArticle(postedText);
    if (post) {
      // ⛔ never a link INSIDE the post's text — a post that quotes another post's url would take its identity
      const _inText = (a) => { try { return !!a.closest('[data-ad-rendering-role="story_message"], [data-ad-preview="message"]'); } catch (_) { return false; } };
      const _old = (href) => { try { const m = /\/(?:posts|permalink)\/(\d{6,})/.exec(href || ''); return !!(m && _preSubmitPosts && _preSubmitPosts.ids.has(m[1])); } catch (_) { return false; } };
      for (const a of post.querySelectorAll('a[href]')) {
        if (_isPostPermalinkHref(a.href) && !_inText(a) && !_old(a.href)) return a.href.split('?')[0];
      }
      // v2026-10-13 · a photo post names itself in its photo links: set=gm.<post id> (one photo) / set=pcb.<post id>
      // (several) — measured live, the same id Facebook's own answer gives. No hover, no wait.
      const gid = (String(location.pathname || '').match(/\/groups\/([^/?#]+)/) || [])[1];
      if (gid) {
        for (const a of post.querySelectorAll('a[href*="set=gm."], a[href*="set=pcb."]')) {
          if (_inText(a)) continue;
          const m = /[?&]set=(?:gm|pcb)\.(\d{6,})/.exec(a.href || '');
          if (m && !(_preSubmitPosts && _preSubmitPosts.ids.has(m[1]))) return 'https://www.facebook.com/groups/' + gid + '/posts/' + m[1] + '/';
        }
      }
    }
  } catch (e) {}
  return null;
}

// Hover-reveal fallback (async): on Comet the post's timestamp <a> sometimes carries
// href="#" until hovered — which is why the permalink wasn't found even when the feed
// HAD rendered (posts 2/3/7). Dispatch pointer/mouse-over on the post's header anchors so
// FB populates the real href, then re-read. DOM-only — no click, no navigation.
async function _hoverRevealPermalink(postedText) {
  try {
    const post = _findFreshPostArticle(postedText);
    if (!post) return null;
    const cands = Array.from(post.querySelectorAll('a[role="link"], a[href]')).slice(0, 14);
    for (const a of cands) {
      try {
        a.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
        a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        a.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      } catch (e) {}
    }
    // v2026-10-13 · measured live: synthetic hover events no longer fill the lazy timestamp href ("?__cft__…"); a
    // real FOCUS does (Facebook fills it for keyboard users too). Focus only — no click, no navigation.
    const lazy = cands.filter((a) => { const h = a.getAttribute('href') || ''; return h === '#' || h.charAt(0) === '?'; }).slice(0, 4);
    for (const a of lazy) { try { a.focus({ preventScroll: true }); } catch (e) {} }
    await sleepMs(450);
    const found = getExactPostPermalink(postedText);
    for (const a of lazy) { try { a.blur(); } catch (e) {} }
    return found;
  } catch (e) { return null; }
}

// ── v1.2.9.66 · the pending vocabulary, compiled once ────────────────────────
// Module-scoped because detectPendingApproval now tests TWO texts (the alert
// surfaces, then the page body) and two copies of a phrase list is how they
// drift apart.
// 🪤 The recurring trap here is the SUBSTRING one: the short form is never a
// substring of the admin form — Facebook's real string on a customer's group
// page carried the extra word in the middle, and nothing here matched it. Every
// language below has that same shape, so each variant is listed, not assumed.
const _PENDING_PHRASES = [
  // English — 'waiting for admin approval' is NOT covered by 'waiting for approval'
  'pending approval','pending admin approval','pending admin review','pending moderator approval',
  'pending post','pending posts','pending review','post is pending','your post is pending',
  'will be reviewed','to be reviewed','awaiting approval','awaiting admin approval',
  'waiting for approval','waiting for admin approval','waiting for an admin',
  'needs admin approval','needs approval','needs to be approved','must be approved',
  'requires approval','requires admin approval','sent for approval','submitted for review',
  // v2026-10-19 · Facebook's own toast on a post that waits: "Thanks for your post. It's been submitted to group admins for
  // approval" — none of the phrases above matched it (measured live), so a real pending post waited the whole settle.
  'submitted to group admins','submitted to the group admins','submitted to the admins','submitted to admins',
  'in review','being reviewed by','after it is approved','after it\u2019s approved','once approved',
  // Hebrew — plural is what Facebook uses for a queue, and it was missing
  '\u05de\u05de\u05ea\u05d9\u05df \u05dc\u05d0\u05d9\u05e9\u05d5\u05e8','\u05de\u05de\u05ea\u05d9\u05e0\u05d4 \u05dc\u05d0\u05d9\u05e9\u05d5\u05e8','\u05de\u05de\u05ea\u05d9\u05e0\u05d9\u05dd \u05dc\u05d0\u05d9\u05e9\u05d5\u05e8','\u05de\u05de\u05ea\u05d9\u05e0\u05d5\u05ea \u05dc\u05d0\u05d9\u05e9\u05d5\u05e8',
  '\u05d1\u05d4\u05de\u05ea\u05e0\u05d4 \u05dc\u05d0\u05d9\u05e9\u05d5\u05e8','\u05d9\u05d9\u05e9\u05dc\u05d7 \u05dc\u05d0\u05d9\u05e9\u05d5\u05e8','\u05e0\u05e9\u05dc\u05d7 \u05dc\u05d0\u05d9\u05e9\u05d5\u05e8','\u05dc\u05d0\u05d7\u05e8 \u05d0\u05d9\u05e9\u05d5\u05e8','\u05de\u05d7\u05db\u05d4 \u05dc\u05d0\u05d9\u05e9\u05d5\u05e8',
  '\u05de\u05de\u05ea\u05d9\u05df \u05dc\u05d1\u05d3\u05d9\u05e7\u05d4','\u05d8\u05e8\u05dd \u05d0\u05d5\u05e9\u05e8','\u05d9\u05d0\u05d5\u05e9\u05e8 \u05e2\u05dc \u05d9\u05d3\u05d9',
  // Arabic — in the construct state the article on \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 disappears, so
  // '\u0628\u0627\u0646\u062a\u0638\u0627\u0631 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629' does not match '\u0628\u0627\u0646\u062a\u0638\u0627\u0631 \u0645\u0648\u0627\u0641\u0642\u0629 \u0627\u0644\u0645\u0634\u0631\u0641'. Both forms listed.
  '\u0641\u064a \u0627\u0646\u062a\u0638\u0627\u0631 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629','\u0628\u0627\u0646\u062a\u0638\u0627\u0631 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629','\u0641\u064a \u0627\u0646\u062a\u0638\u0627\u0631 \u0645\u0648\u0627\u0641\u0642\u0629','\u0628\u0627\u0646\u062a\u0638\u0627\u0631 \u0645\u0648\u0627\u0641\u0642\u0629',
  '\u0645\u0648\u0627\u0641\u0642\u0629 \u0627\u0644\u0645\u0634\u0631\u0641','\u0642\u064a\u062f \u0627\u0644\u0645\u0631\u0627\u062c\u0639\u0629','\u0642\u064a\u062f \u0627\u0644\u0627\u0646\u062a\u0638\u0627\u0631','\u0628\u062d\u0627\u062c\u0629 \u0625\u0644\u0649 \u0645\u0648\u0627\u0641\u0642\u0629','\u064a\u062e\u0636\u0639 \u0644\u0644\u0645\u0631\u0627\u062c\u0639\u0629',
  // French / Spanish / Portuguese / Italian / Dutch / German / Polish / Turkish
  'en attente d.approbation','sera examin','pendiente de aprobaci','en revisi','aguardando aprova',
  'pendente de aprova','ser\u00e1 analisad','em an\u00e1lise','in attesa di approvazione','wacht op goedkeuring',
  'wartet auf genehmigung','ausstehende genehmigung','wird \u00fcberpr\u00fcft','zur \u00fcberpr\u00fcfung','oczekuj',
  'do zatwierdzenia','onay bekl',
  // SEA: Thai / Vietnamese / Indonesian / Malay / Filipino
  '\u0e23\u0e2d\u0e01\u0e32\u0e23\u0e2d\u0e19\u0e38\u0e21\u0e31\u0e15\u0e34','\u0e23\u0e2d\u0e2d\u0e19\u0e38\u0e21\u0e31\u0e15\u0e34','\u0e23\u0e2d\u0e01\u0e32\u0e23\u0e15\u0e23\u0e27\u0e08\u0e2a\u0e2d\u0e1a','ch\u1edd ph\u00ea duy\u1ec7t','ch\u1edd duy\u1ec7t','menunggu persetujuan',
  'menunggu kelulusan','naghihintay','pag-apruba',
  // Russian / Korean / Japanese / Chinese / Hindi
  '\u043e\u0436\u0438\u0434\u0430\u0435\u0442 \u043e\u0434\u043e\u0431\u0440\u0435\u043d\u0438\u044f','\u043d\u0430 \u0440\u0430\u0441\u0441\u043c\u043e\u0442\u0440\u0435\u043d\u0438\u0438','\u043e\u0436\u0438\u0434\u0430\u044e\u0449\u0438','\uc2b9\uc778 \ub300\uae30','\uac80\ud1a0 \uc911','\u627f\u8a8d\u5f85\u3061','\u627f\u8a8d\u3092\u5f85',
  '\u7b49\u5f85\u6279\u51c6','\u5f85\u5ba1\u6838','\u6b63\u5728\u5ba1\u6838','\u7b49\u5f85\u6838\u51c6','\u0905\u0928\u0941\u092e\u094b\u0926\u0928 \u0915\u0940 \u092a\u094d\u0930\u0924\u0940\u0915\u094d\u0937\u093e',
];
const _RE_PENDING = new RegExp(_PENDING_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

// Detect a post that is PENDING ADMIN APPROVAL (groups that review posts before
// publishing). Facebook shows a toast/dialog like "pending approval" / "will be
// reviewed by an admin" instead of "posted/live". Mirrors the GraphQL path's
// `if_viewer_can_learn_more_about_pending_post` signal so Safe records 'pending'
// instead of a false 'successful'. Multilingual.
function detectPendingApproval() {
  // v2026-10-19 · optional (ownHtml, wantSource). A customer's posts were ALL read as "pending" while every one was
  // live: her offer said "once approved…", and the page-text fallback below read that phrase in HER OWN fresh post at
  // the top of the feed (reproduced live in an admin group). Now a phrase that comes from the text we just posted
  // never counts, and the composer's leftover text box is not read. With wantSource the answer is 'surface' (a
  // toast/dialog/alert said it) or 'page' (only the page text did), so the caller can let our post's own permalink
  // outrank the weaker page evidence. (The signature stays () — tests lift this function by that exact text.)
  const _ownHtml = arguments[0];
  const _wantSource = arguments[1] === true;
  // (out) gets WHICH phrase decided, and a phrase skipped because it was our own words — phrases from the fixed list
  // above, never the page's or the post's text (for the diagnosis: "pending from the page text, 'once approved'")
  const _out = (arguments[2] && typeof arguments[2] === 'object') ? arguments[2] : null;
  try {
    // ⛔ v1.2.9.65: the same chat exclusion the notice reader needed. This scan
    // includes [aria-live], which is where Facebook renders incoming Messenger
    // text — so a chat message containing "pending approval" used to decide a
    // real post's outcome. Found by the unit test written for the fallback below.
    const surfaces = Array.from(document.querySelectorAll(
      '[role="alert"], [data-testid="snackbar"], [data-testid="toast"], [aria-live="polite"], [aria-live="assertive"], div[role="dialog"]'
    )).filter((e) => {
      try {
        if (e.closest(_NOTICE_EXCLUDE)) return false;
        // v2026-10-19 · measured LIVE (an admin's Safe post read as pending at the first look): Facebook keeps its
        // Notifications and Messenger panels in the page as [role=dialog] even while closed (inside a [hidden] wrapper),
        // and an admin's notifications say "<group> … needs approval: <someone's post>". A hidden surface is never read,
        // and those two panels are never read even when open — by structure (a /notifications link, a chat grid), so
        // every language is covered.
        if (e.closest('[hidden]')) return false;
        if (e.matches('[role="dialog"]') && e.querySelector('a[href*="/notifications"], [role="grid"]')) return false;
        // (audit F2) the composer (a dialog that holds an editor) lingers after Post with OUR words and a link card's
        // title — it is not Facebook's notice
        if (e.matches('[role="dialog"]') && e.querySelector('[contenteditable="true"]')) return false;
        return true;
      } catch (_) { return true; }
    });
    // v2026-10-19 · the composer can linger a few seconds after Post with the typed text still in its box
    const _EDITABLE = '[contenteditable="true"], [role="textbox"], textarea';
    const _textOf = (el) => { try { const c = el.cloneNode(true); c.querySelectorAll(_EDITABLE).forEach((n) => n.remove()); return c.textContent || ''; } catch (_) { return el.textContent || ''; } };
    // v1.2.9.66: normalise before matching. The phrases contain literal single
    // spaces, so "Pending admin\napproval" or an &nbsp; between the words defeated
    // them; and Facebook injects RTL/LTR marks (U+200E/200F, U+061C) into Hebrew
    // and Arabic strings, which sit INSIDE the phrase and break a plain includes().
    const _norm = (v) => String(v || '')
      .replace(/[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, '')
      .normalize('NFC')
      .replace(/\s+/g, ' ')
      .toLowerCase();
    let txt = _norm(surfaces.map(_textOf).join(' '));
    // v2026-10-19 · our own post's words: a match whose few words before it ALSO appear in the text we posted came
    // from our post (wherever Facebook drew it, even cut by "See more"), not from Facebook's notice.
    // (audit F2) compared as a SKELETON — letters and digits only, NFKC: Safe types bold as Unicode glyphs and Facebook
    // draws an emoji as an image, so "offer 🔥 once 𝗮𝗽𝗽𝗿𝗼𝘃𝗲𝗱" on the page is not a substring of the HTML we typed
    const _skel = (v) => String(v || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const _ownNorm = _ownHtml ? _norm(String(_ownHtml)
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")) : '';
    const _ownSkel = _skel(_ownNorm);
    const _counts = (t) => {
      if (!t) return false;
      if (!_ownNorm) { const m0 = _RE_PENDING.exec(t); if (m0 && _out) _out.phrase = m0[0].slice(0, 40); return !!m0; }
      const re = new RegExp(_RE_PENDING.source, 'gi');
      let m;
      while ((m = re.exec(t))) {
        const from = Math.max(0, m.index - 24);
        let ctx = t.slice(from, m.index + m[0].length);
        if (from > 0) ctx = ctx.replace(/^\S*\s/, '');   // start at a whole word
        // …or the few words AFTER it (a phrase at the very start of our post has Facebook's own labels before it)
        const to = Math.min(t.length, m.index + m[0].length + 24);
        let after = t.slice(m.index, to);
        if (to < t.length) after = after.replace(/\s\S*$/, '');   // end at a whole word
        const ours = (c) => { const v = _skel(c); return v.length > _skel(m[0]).length && _ownSkel.includes(v); };
        if (!ours(ctx) && !ours(after)) { if (_out) _out.phrase = m[0].slice(0, 40); return true; }
        if (_out && !_out.ownSkipped) _out.ownSkipped = m[0].slice(0, 40);
        if (re.lastIndex === m.index) re.lastIndex++;
      }
      return false;
    };
    // ── 🔴 v1.2.9.65 · measured on a live post ────────────────────────────────
    // A real post into a moderated group came back "✅ posted · ⏳ 0 pending"
    // while Facebook's own page said "Pending admin approval · 1 post". Every
    // selector above matched ZERO characters on that page: FB showed no toast and
    // no dialog ("post-confirmed: button-gone, dialog-closed, no toast"), and put
    // the notice in a bare <span> inside anonymous divs — nothing structural to
    // hook. So when the structural scan comes up empty, fall back to the page
    // text and look for the SAME narrow phrase list.
    // ⛔ Fallback only. A page-wide read is the shape of the bug that leaked a
    // customer's Messenger chat into our logs, so: the chat surfaces are excluded,
    // nothing is logged or transmitted, and the phrases are specific enough
    // ("pending admin approval", "ממתין לאישור") that ordinary prose cannot trip
    // them — unlike the single words that made the toast scanner dangerous.
    // 🔴 v1.2.9.66: this used to be gated on `!txt` — i.e. the page text was only
    // consulted when EVERY selector above matched zero characters anywhere on the
    // page. One unrelated `[role="alert"]`, one open dialog, one screen-reader
    // live region with any content at all made `txt` truthy and disabled the
    // fallback permanently for that post. The notice this exists to catch lives
    // in a bare <span> in the page body, so the two conditions are in direct
    // conflict. Now: match the surfaces first, and if they do not say "pending",
    // read the page too. ⛔ The chat exclusion and the length cap stay.
    if (_counts(txt)) return _wantSource ? 'surface' : true;
    try {
      const _main = document.querySelector('[role="main"]') || document.body;
      const _clone = _main.cloneNode(true);
      _clone.querySelectorAll(_NOTICE_EXCLUDE).forEach((n) => n.remove());
      _clone.querySelectorAll(_EDITABLE).forEach((n) => n.remove());
      // v2026-10-19 · measured LIVE: every post in the group — ours just published, and every other member's — sits inside
      // [role="feed"], while Facebook's real "Your post is pending · Your post is awaiting…" notice sits OUTSIDE it (and
      // outside any [role="article"]). So the posts are never read: no one's words can make a live post "pending".
      _clone.querySelectorAll('[role="feed"], [role="article"]').forEach((n) => n.remove());
      // …nor anything hidden, nor the Notifications / Messenger panels (when the page has no [role=main], the body is read)
      _clone.querySelectorAll('[hidden]').forEach((n) => n.remove());
      // (audit F4) an ADMIN sees shortcuts like "Pending posts · 3" / "Review" in the group page — links to admin pages.
      // Their label (and a short wrapper around it) is admin chrome, never a notice about our post.
      _clone.querySelectorAll('a[href*="/pending_posts"], a[href*="/admin_activities"], a[href*="/member_requests"], a[href*="/spam"], a[href*="/admin_assist"], a[href*="/moderation"]').forEach((a) => {
        try { const p = a.parentElement; if (p && (p.textContent || '').length <= 80) p.remove(); else a.remove(); } catch (_) {}
      });
      _clone.querySelectorAll('[role="dialog"]').forEach((n) => { try { if (n.querySelector('a[href*="/notifications"], [role="grid"]')) n.remove(); } catch (_) {} });
      // 8000, not 4000: a group feed's header + composer alone can exceed 4k
      // before the notice is reached.
      txt = _norm((_clone.innerText || _clone.textContent || '')).slice(0, 8000);
    } catch (_) {}
    if (!txt) return false;
    // v50: the SURFACE scan above is structural (role=alert/dialog/toast — language-
    // proof); only this text match is language-specific. Expanded to cover the same
    // SEA + major locales as POST_TRANSLATIONS so pending-approval is detected on a
    // Thai/Vietnamese/Indonesian/Polish/etc. Facebook (was: en/he/fr/es only → a
    // pending post on an unlisted-language FB was mis-recorded as 'successful').
    return _counts(txt) ? (_wantSource ? 'page' : true) : false;
  } catch (e) { return false; }
}

// v2 spec: read the existing `_stopRequested` storage flag (set by the worker's
// stopPosting handler, cleared at next campaign start) so a DOM post can abort
// mid-flow when the user hits Stop — instead of only stopping between posts.
async function isDomStopRequested() {
  try {
    // v70 (B): bound the read — a wedged storage callback must NOT hang the
    // pre-submit stop check. Falls open to {} → false (no spurious stop), the
    // same fail-open the catch below already provides.
    const res = await Promise.race([
      chrome.storage.local.get('_stopRequested'),
      new Promise((r) => setTimeout(() => r({}), 1500)),
    ]);
    const stopped = !!(res && res._stopRequested);
    // v70 (L2): when the flag IS set, say so — this single line would have
    // revealed the v69 stale-flag bug instantly (a "stop set" on post 1 of a
    // fresh scheduled campaign = a stale flag, not a real user stop).
    if (stopped) { try { cReport('[stop] _stopRequested is SET → aborting before submit', 'info'); } catch (_) {} }
    return stopped;
  } catch (e) { return false; }
}

// ── DOM-only RESILIENT first-comment poster (v11.x) ─────────────────────────
// Every target (composer / box / submit button / open-comment action) is located
// by SEVERAL independent SCORED signals + active BEHAVIORAL PROBING, so a single
// Facebook rename/restructure can't take it down. Decisive families are behavior
// (probe-insert · aria-disabled flip · click-result) and structure — both
// language-free; labels & icons are tiebreakers only. Verification at EVERY stage
// → NEVER reports unverified success. DOM only (GraphQL is the separate primary
// engine). Best-effort: a comment failure NEVER fails the main post.
// ToS reminder: own account, low volume, varied text, human-in-the-loop, stop on checkpoint.
// Thresholds set by the LEVEL-2 rule (hardening addendum): THRESHOLD ≤ MAX − (the
// heaviest signal FAMILY's total). By construction, even if one whole family
// vanishes, the surviving score still clears the threshold → the element is still
// found. (composer MAX105 heaviest50 → ≤55; box MAX130 heaviestB50 → ≤80; submit
// MAX100 heaviestD45 → ≤55; open MAX95 heaviestD50 → ≤45.) Residual: only TWO
// families breaking in one release can dip a target — caught as an honest failure,
// never a silent wrong success.
const _CMT_THRESHOLD = { composer: 45, box: 50, submit: 50, open: 40 };
// Family F (localized labels) — tiebreakers only; empty until captured live (a
// future remote-config can push these without a redeploy).
const _CMT_LABELS = { box: [], submit: [], open: [] };

function _cmtVisible(el) {
  try { return !!el && el.offsetParent !== null && el.getBoundingClientRect().width > 0; } catch (e) { return false; }
}
function _cmtMatchLabel(el, kind) {
  const tbl = _CMT_LABELS[kind] || []; if (!tbl.length) return false;
  const s = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('aria-placeholder') || '')).toLowerCase();
  return tbl.some((p) => s.includes(p));
}
// MutationObserver-based wait (scoped; never blind setTimeout). Resolves testFn()'s
// truthy value, or null on timeout. Re-queries on every mutation — never caches.
function _cmtWaitFor(testFn, scope, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { obs.disconnect(); } catch (e) {} clearTimeout(t); resolve(v); };
    const tick = () => { let r = null; try { r = testFn(); } catch (e) {} if (r) finish(r); };
    const obs = new MutationObserver(tick);
    try { obs.observe(scope || document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-disabled', 'class', 'style'] }); } catch (e) {}
    const t = setTimeout(() => finish(null), timeoutMs);
    tick();
  });
}
// Behavioral probe (family D): the REAL editable is the one where a 1-char
// beforeinput actually changes textContent. Fully reversible.
function _cmtProbeInsertable(el) {
  if (!el || el.getAttribute('contenteditable') !== 'true') return false;
  let changed = false;
  try {
    const before = (el.textContent || '');
    try { el.focus(); } catch (e) {}
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '​', bubbles: true, cancelable: true, composed: true }));
    changed = (el.textContent || '') !== before;
    if (changed) {
      try { const sel = window.getSelection(); const r = document.createRange(); r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r); } catch (e) {}
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true, composed: true }));
    }
  } catch (e) {}
  return changed;
}
// Family E (icon): the send / paper-plane glyph. Until we capture the exact
// viewBox/path signature live, accept any SMALL inline svg as a weak icon signal —
// it carries only 13/100 points, so a wrong icon match can't decide the button.
function _cmtSendGlyph(el) {
  try {
    const svg = el.querySelector('svg'); if (!svg) return false;
    const r = svg.getBoundingClientRect();
    return r.width > 0 && r.width <= 40 && r.height <= 40; // icon-sized, not media art
  } catch (e) { return false; }
}
// Family D (generalized): watch which buttons' ATTRIBUTES mutate while the box fills
// (empty→filled). Mechanism-agnostic — catches today's aria-disabled flip AND a
// future class/disabled/tabindex enable. Start before insert; stop after.
function _cmtWatchButtonMutations(scope) {
  const mutated = new Set();
  let obs = null;
  try {
    obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type !== 'attributes' || !m.target || m.target.nodeType !== 1) continue;
        const btn = m.target.closest && m.target.closest('[role="button"], button');
        if (btn) mutated.add(btn);
      }
    });
    obs.observe(scope || document.body, { attributes: true, subtree: true, attributeFilter: ['aria-disabled', 'class', 'disabled', 'tabindex', 'aria-hidden', 'style'] });
  } catch (e) {}
  return { mutated, stop: () => { try { if (obs) obs.disconnect(); } catch (e) {} } };
}
// Signal registry (A role · B attrs · C structure · D behavior · E icon · F label · G geometry).
const _CMT_SIGNALS = {
  composer: [
    { id: 'form-presentation+lexical', weight: 50, test: (el) => !!(el.matches && el.matches('form[role="presentation"]') && el.querySelector('[data-lexical-editor]')) },
    { id: 'has-editable-textbox', weight: 25, test: (el) => !!el.querySelector('[contenteditable="true"][role="textbox"]') },
    { id: 'form-of-lexical', weight: 20, test: (el) => el.tagName === 'FORM' && !!el.querySelector('[data-lexical-editor]') },
    { id: 'in-article', weight: 10, test: (el, ctx) => !!(ctx && ctx.post && ctx.post.contains(el)) },
  ],
  box: [
    { id: 'probe-insert', weight: 45, test: (el, ctx) => !!(ctx && ctx._probeOk && ctx._probeOk.has(el)) },
    { id: 'data-lexical-editor', weight: 25, test: (el) => el.getAttribute('data-lexical-editor') === 'true' },
    { id: 'role-textbox', weight: 15, test: (el) => el.getAttribute('role') === 'textbox' },
    { id: 'contenteditable', weight: 15, test: (el) => el.getAttribute('contenteditable') === 'true' },
    { id: 'data-interactable-input', weight: 10, test: (el) => (el.getAttribute('data-interactable') || '').includes('input') },
    { id: 'in-composer', weight: 10, test: (el, ctx) => !!(ctx && ctx.composer && ctx.composer.contains(el)) },
    { id: 'visible', weight: 5, test: (el) => _cmtVisible(el) },
    { id: 'label-hint', weight: 5, test: (el) => _cmtMatchLabel(el, 'box') },
  ],
  // Rebuilt per the hardening addendum (Level-2 single-family safe). The OLD table
  // leaned 70/110 on ONE attribute (aria-disabled flip 50 + has-attr 20) — same
  // family, dies together. NEW decisive signal is GENERAL behavior: the button whose
  // ATTRIBUTES mutate when the box fills — mechanism-agnostic, survives FB swapping
  // aria-disabled for a class/disabled/tabindex enable. No two families share an
  // attribute. MAX=100, heaviest family D=45 → threshold 50; any one family can die
  // and the rest still ≥50 (D→55 · C→73 · E→87 · B→92 · F→93).
  submit: [
    { id: 'attrs-mutate-on-fill', weight: 45, test: (el, ctx) => !!(ctx && ctx._mutated && ctx._mutated.has(el)) },
    { id: 'in-composer-form', weight: 15, test: (el, ctx) => !!(ctx && ctx.composer && ctx.composer.contains(el)) },
    { id: 'send-glyph-svg', weight: 13, test: (el) => _cmtSendGlyph(el) },
    { id: 'trailing-button', weight: 12, test: (el, ctx) => !!(ctx && ctx._lastButton === el) },
    { id: 'disabled-type-attr', weight: 8, test: (el) => el.hasAttribute('aria-disabled') || el.hasAttribute('disabled') },
    { id: 'label-hint', weight: 7, test: (el) => _cmtMatchLabel(el, 'submit') },
  ],
  open: [
    { id: 'reveals-composer', weight: 50, test: (el, ctx) => !!(ctx && ctx._reveals && ctx._reveals.has(el)) },
    { id: 'middle-of-3', weight: 25, test: (el, ctx) => !!(ctx && ctx._middleAction === el) },
    { id: 'has-svg', weight: 10, test: (el) => !!el.querySelector('svg') },
    { id: 'label-hint', weight: 10, test: (el) => _cmtMatchLabel(el, 'open') },
    { id: 'pen-aria-pressed', weight: -20, test: (el) => el.hasAttribute('aria-pressed') },
    { id: 'pen-opens-dialog', weight: -20, test: (el, ctx) => !!(ctx && ctx._opensDialog && ctx._opensDialog.has(el)) },
  ],
};
// Scoring resolver: best candidate ONLY if it clears the threshold (else null = broken).
function _cmtResolveByScore(target, candidates, ctx) {
  const signals = _CMT_SIGNALS[target] || []; const thr = _CMT_THRESHOLD[target] || 9999;
  let best = null;
  for (const el of candidates) {
    if (!el) continue;
    let total = 0; const hit = [];
    for (const s of signals) { let ok = false; try { ok = s.test(el, ctx); } catch (e) {} if (ok) { total += s.weight; hit.push(s.id); } }
    if (!best || total > best.total) best = { el, total, hit };
  }
  const pass = !!(best && best.total >= thr);
  try {
    if (best) {
      cLog('[cmt] ' + target + ' score=' + best.total + '/' + thr + ' [' + best.hit.join(',') + ']' + (pass ? '' : ' BELOW'));
      if (pass && (best.total - thr) <= 10) cLog('[cmt] WARN ' + target + ' margin collapsed — a Facebook change may be eroding signals');
      if (!pass) { try { logTelemetry('cmt_locate_weak', { target, score: best.total, thr, hit: best.hit }, 'WARN'); } catch (e) {} }
    } else { cLog('[cmt] ' + target + ' no candidates'); }
  } catch (e) {}
  return pass ? best.el : null;
}
function _cmtClickSeq(el) {
  const o = { bubbles: true, cancelable: true, composed: true, view: window };
  try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (e) {}
  try { el.dispatchEvent(new MouseEvent('mousedown', o)); } catch (e) {}
  try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (e) {}
  try { el.dispatchEvent(new MouseEvent('mouseup', o)); } catch (e) {}
  try { el.click(); } catch (e) {}
}
/**
 * 🔴 Is the scraped link card in the composer?
 *
 * The shipped test was `[aria-label*="Remove preview" i]`. Measured live in a
 * real group composer, Facebook's labels are:
 *
 *     "Remove link preview from your post"   "Change Preview"   "Remove All"
 *
 * `"Remove preview"` is a substring of NONE of them — the extra word "link" sits
 * in the middle. **Exactly the trap that hid pending-approval** ("pending
 * approval" is not a substring of "Pending admin approval"). So the 12-second
 * link-preview wait timed out on EVERY link post and the log said "not shown
 * (posting without a card)" while the card was on screen.
 *
 * 🔑 The second arm is language-independent: a scraped card's thumbnail is served
 * from Facebook's content CDN. This runs only on a post with no media of its own,
 * so a `scontent` image inside the composer and outside the text box can only be
 * the card.
 */
function _linkCardPresent(scope) {
  try {
    if (!scope) return false;
    if (scope.querySelector('[aria-label*="preview" i], [data-testid*="link_preview"]')) return true;
    var box = scope.querySelector('[role="textbox"]');
    var imgs = scope.querySelectorAll('img[src*="scontent"]');
    for (var i = 0; i < imgs.length; i++) {
      if (!box || !box.contains(imgs[i])) return true;
    }
  } catch (_) {}
  return false;
}

/**
 * Remove the permalink the CARD already carries from the composer text.
 * ⚠️ Mirror of `stripCardUrlFromText` in mgp-engine-core.js — the two files never
 * share code (both ship verbatim, no bundler). A test pins them to one table of
 * cases so they cannot drift.
 */
function _stripCardUrlFromComposerText(text, cardUrl) {
  if (!cardUrl) return String(text == null ? '' : text);
  var bare = String(cardUrl).replace(/\/+$/, '');
  if (!bare) return String(text == null ? '' : text);
  var esc = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var out;
  try {
    out = String(text == null ? '' : text).replace(new RegExp(esc + '\\/?(?![\\w\\-/?#=&%])', 'g'), '');
  } catch (_) {
    return String(text == null ? '' : text);
  }
  return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

function _cmtClear(box) {
  try {
    box.focus();
    const sel = window.getSelection(); const r = document.createRange(); r.selectNodeContents(box); sel.removeAllRanges(); sel.addRange(r);
    box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true, composed: true }));
  } catch (e) {}
}
// Insertion ladder — each method verified by a textContent change; independent
// browser pathways so they fail independently.
async function _cmtInsertVerified(box, text) {
  const had = (box.textContent || '');
  const probe = text.slice(0, Math.min(8, text.length));
  const ok = () => { const t = (box.textContent || ''); return (probe && t.includes(probe)) || t.length > had.length; };
  try { box.focus(); box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true, composed: true })); await sleepMs(150); if (ok()) return true; } catch (e) {}
  try { box.focus(); document.execCommand('insertText', false, text); await sleepMs(150); if (ok()) return true; } catch (e) {}
  try { box.focus(); const dt = new DataTransfer(); dt.setData('text/plain', text); box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true })); await sleepMs(200); if (ok()) return true; } catch (e) {}
  try { box.focus(); for (const ch of text) { box.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, composed: true })); box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true, composed: true })); await sleepMs(8 + Math.floor(Math.random() * 30)); } if (ok()) return true; } catch (e) {}
  return ok();
}
// Open-comment action (feed mode) — find the action that REVEALS a composer when
// clicked; disambiguate by RESULT (composer = Comment · dialog = Share · aria-pressed = Like).
async function _cmtOpenComposer(post) {
  const composerNow = () => Array.from(post.querySelectorAll('form[role="presentation"]')).find((f) => f.querySelector('[data-lexical-editor]') && _cmtVisible(f));
  if (composerNow()) return composerNow();
  const actions = Array.from(post.querySelectorAll('[role="button"]')).filter(_cmtVisible);
  const ctx = { post, _reveals: new Set(), _opensDialog: new Set(), _middleAction: null };
  for (const a of actions) {
    const sibs = a.parentElement ? Array.from(a.parentElement.children).filter((c) => c.getAttribute && c.getAttribute('role') === 'button') : [];
    if (sibs.length === 3 && sibs[1] === a) { ctx._middleAction = a; break; }
  }
  const ranked = actions
    .map((el) => ({ el, s: (el === ctx._middleAction ? 25 : 0) + (el.querySelector('svg') ? 10 : 0) - (el.hasAttribute('aria-pressed') ? 20 : 0) }))
    .sort((a, b) => b.s - a.s).slice(0, 5).map((x) => x.el);
  for (const cand of ranked) {
    if (cand.hasAttribute('aria-pressed')) continue;        // that's Like
    const dialogsBefore = document.querySelectorAll('[role="dialog"]').length;
    _cmtClickSeq(cand);
    const appeared = await _cmtWaitFor(() => composerNow() || (document.querySelectorAll('[role="dialog"]').length > dialogsBefore ? 'dialog' : null), post, 3500);
    if (appeared && appeared !== 'dialog') return appeared;  // it was Comment
    if (appeared === 'dialog') {                             // it was Share — reverse + try next
      try { const c = document.querySelector('[role="dialog"] [aria-label*="close" i], [role="dialog"] [aria-label*="סגור" i]'); if (c) _cmtClickSeq(c); else document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e) {}
      await sleepMs(400);
    }
  }
  return composerNow() || null;
}
// ── v2026-10-15 · Safe first comment, by the page (safeFirstCommentDom) ──────────────────────────────────────────
// Liran: "take DOM, base it on everything around it, give it a score, with protections so a change in Facebook's page
// cannot affect us". Measured live in R1 the same day: the fresh post's block carries language-free markers
// (data-ad-rendering-role story_message · profile_name · comment_button), its author link names the actor
// (/groups/<g>/user/<id>/), a post with no comments shows its own comment box, and one with comments opens in a
// dialog when Comment is pressed. Typing is execCommand('insertText'); a line break is beforeinput insertLineBreak
// (a "\n" inside insertText is silently dropped); Enter submits; the comment appears in ~1 s as a NEW
// [role="article"] carrying our text. The comment's own author link is the profile's vanity URL, so the receipt is
// "our exact text, new, in our post, right after our one submit" — not an id.
// The rules:
//   1. nothing is typed unless OUR post (author + one post + our id, or our text in the fresh post) and ITS box (every
//      box signal) are proven;
//   2. ONE submit per post — no second key, no other button: a slow Facebook is never a reason to press again;
//   3. a receipt or 'unconfirmed' (never resent); a block notice = 'refused';
//   4. a doubt before the submit types nothing (or clears what it typed) and says `handoff`: the worker may give the
//      comment to the comment queue, so a change in Facebook's page costs the customer nothing;
//   5. the post is already decided — this only adds, inside a hard time budget.
const SAFE_CMT = { OPEN_WAIT_MS: 5000, RECEIPT_MS: 10000, TOTAL_MS: 25000 };
const _SC_STORY = '[data-ad-rendering-role="story_message"]';
const _SC_CMT_BTN = '[data-ad-rendering-role="comment_button"]';
const _SC_BOX = '[contenteditable="true"][role="textbox"]';
const _SC_OUTSIDE = '[role="complementary"], [role="navigation"], [role="banner"]';

function _scNorm(s) { return String(s == null ? '' : s).replace(/[\u200B\u3164]/g, '').replace(/\s+/g, ' ').trim(); }
/** Letters and digits only (bold Unicode folded): Facebook draws an emoji as an <img>, so a rendered comment's text
 *  never holds it — measured live on the first Safe comment (SC1, 15-Oct): the comment was up, the receipt missed it. */
function _scSkeleton(s) { try { return String(s == null ? '' : s).normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase(); } catch (_) { return ''; } }
/** The identity the page acts as: the Page (i_user) when switched, else the person (c_user). */
function _scActorId() {
  try {
    const c = String(document.cookie || '');
    return (c.match(/(?:^|;\s*)i_user=(\d+)/) || [])[1] || (c.match(/(?:^|;\s*)c_user=(\d+)/) || [])[1] || null;
  } catch (_) { return null; }
}
function _scPostIdOf(permalink) { const m = String(permalink || '').match(/\/(?:posts|permalink)\/(\d{6,})/); return m ? m[1] : null; }
function _scHasLayout(el) { try { return !!el && el.getClientRects().length > 0; } catch (_) { return false; } }
/** From an anchor inside a post up to the block that is that post: one comment button and at most one story text. */
function _scPostBlockOf(el, stopAt) {
  const STOP = '[role="main"], [role="feed"], [role="dialog"], ' + _SC_OUTSIDE;
  let u = el;
  while (u.parentElement && u.parentElement !== document.body && u.parentElement !== stopAt && !u.parentElement.matches(STOP)
    && u.parentElement.querySelectorAll(_SC_CMT_BTN).length <= 1 && u.parentElement.querySelectorAll(_SC_STORY).length <= 1) u = u.parentElement;
  return u;
}
/**
 * Score one candidate block against what we know about the post we just published. Pure over the DOM.
 * Proven = our author AND one post AND (our post id, OR our text in the FRESH post — the one Facebook draws above the
 * feed right after Post, measured 13-Oct). Live 15-Oct: 2 of 11 Safe windows did not capture the post's link (one
 * minimized), so the id was missing and text + author alone was refused; an older post of ours with the same text
 * sits INSIDE the feed, which is what `fresh` rules out.
 */
function _scScorePost(block, snip, pid, actor) {
  const sig = { text: 0, id: 0, author: 0, one: 0, fresh: 0 };
  try {
    const msg = block.querySelector(_SC_STORY);
    // letters and digits: Safe types bold as Unicode glyphs and an emoji is drawn as an image (review 15-Oct)
    if (snip && msg && _scSkeleton(msg.textContent).includes(snip)) sig.text = 30;
    if (pid) {
      const inText = (a) => !!a.closest(_SC_STORY);
      const links = Array.from(block.querySelectorAll('a[href*="/posts/' + pid + '"], a[href*="/permalink/' + pid + '"], a[href*="set=gm.' + pid + '"], a[href*="set=pcb.' + pid + '"]'));
      if (links.some((a) => !inText(a))) sig.id = 30;
    }
    if (actor && Array.from(block.querySelectorAll('a[href*="/user/' + actor + '/"]')).some((a) => !a.closest(_SC_STORY) && !a.closest('[role="article"]'))) sig.author = 30;
    if (block.querySelectorAll(_SC_CMT_BTN).length === 1 && block.querySelectorAll(_SC_STORY).length <= 1) sig.one = 10;
    if (_wasOnPageBeforeSubmit(block)) sig.fresh = 0;   // (audit F1/F10) it was there before our Post click
    else if (!block.closest('[role="feed"]') && !block.querySelector('[role="feed"]')) sig.fresh = 20;
    // …or its Comment button was not on the page before our Post click: it appeared after it (wherever it is drawn)
    else if (_scPreSubmitCmtBtns) { const b = block.querySelector(_SC_CMT_BTN); if (b && !_scPreSubmitCmtBtns.has(b)) sig.fresh = 20; }
  } catch (_) {}
  const score = sig.text + sig.id + sig.author + sig.one + sig.fresh;
  const ok = sig.author > 0 && sig.one > 0 && (sig.id > 0 || (sig.text > 0 && sig.fresh > 0));
  return { score, sig, ok };
}
/** Our post inside `root` (the page, or a dialog): exactly one block passes, or null. */
function _scFindOurPost(root, snip, pid, actor) {
  const anchors = [];
  try {
    if (snip) for (const m of root.querySelectorAll(_SC_STORY)) if (_scSkeleton(m.textContent).includes(snip)) anchors.push(m);
    if (pid) for (const a of root.querySelectorAll('a[href*="/posts/' + pid + '"], a[href*="/permalink/' + pid + '"], a[href*="set=gm.' + pid + '"], a[href*="set=pcb.' + pid + '"]')) if (!a.closest(_SC_STORY)) anchors.push(a);
  } catch (_) {}
  const blocks = [];
  for (const a of anchors) {
    if (a.closest(_SC_OUTSIDE)) continue;
    const b = _scPostBlockOf(a, root === document ? null : root);
    if (!blocks.includes(b)) blocks.push(b);
  }
  const scored = blocks.map((b) => ({ b, ...(_scScorePost(b, snip, pid, actor)) }));
  const passing = scored.filter((x) => x.ok);
  const best = scored.sort((x, y) => y.score - x.score)[0] || null;
  return { post: passing.length === 1 ? passing[0].b : null, best, candidates: blocks.length, passing: passing.length };
}
/** The one empty comment box of that post (or dialog): every signal must hold. */
function _scFindBox(scope) {
  const boxes = Array.from(scope.querySelectorAll(_SC_BOX)).filter((b) => !b.closest('[role="article"]') && _scHasLayout(b));
  const full = boxes.filter((b) => b.getAttribute('data-lexical-editor') === 'true' && !!b.closest('form') && _scNorm(b.innerText || b.textContent) === '');
  return { box: (boxes.length === 1 && full.length === 1) ? full[0] : null, seen: boxes.length };
}
function _scSelectAll(box) {
  try { const sel = window.getSelection(); const r = document.createRange(); r.selectNodeContents(box); sel.removeAllRanges(); sel.addRange(r); } catch (_) {}
}
function _scClear(box) {
  try { box.focus(); _scSelectAll(box); box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true, composed: true })); } catch (_) {}
}
/** Type the comment exactly (lines joined by Facebook's own line break) and prove the box holds exactly it. */
async function _scTypeExact(box, text) {
  try { box.focus(); } catch (_) {}
  await sleepMs(300);
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) { try { box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true, composed: true })); } catch (_) {} await sleepMs(120); }
    if (lines[i]) { try { document.execCommand('insertText', false, lines[i]); } catch (_) {} await sleepMs(120); }
  }
  await sleepMs(250);
  const got = box.innerText || box.textContent;
  if (_scNorm(got) === _scNorm(text)) return true;
  // the editor may draw an emoji as an image too — then every letter and digit must still be exactly ours
  const sk = _scSkeleton(text);
  return sk.length >= 3 && _scSkeleton(got) === sk;
}

/**
 * Pure: the scope to receive in — every comment article present before the submit is old.
 * The receipt: a NEW article in `scope` whose text holds the start of ours.
 */
function _scReceipt(scope, before, text) {
  const want = _scSkeleton(text).slice(0, 40);
  for (const a of scope.querySelectorAll('[role="article"]')) {
    if (before.has(a)) continue;
    // an emoji-only comment has no letters to match: a NEW comment in our fresh post, right after our one submit
    if (!want) return a;
    let seen = a.textContent || '';
    try { for (const img of a.querySelectorAll('img[alt]')) seen += ' ' + img.getAttribute('alt'); } catch (_) {}
    if (_scSkeleton(seen).includes(want)) return a;
  }
  return null;
}

async function safeFirstCommentDom(commentText, postedText, capturedPermalink) {
  const t0 = Date.now();
  const text = String(commentText == null ? '' : commentText);
  let flags = {};
  const out = (o) => ({ commented: false, submitted: false, ms: Date.now() - t0, ...flags, ...o });
  if (!_scNorm(text)) return out({ reason: 'no-comment' });
  const actor = _scActorId();
  const pid = _scPostIdOf(capturedPermalink);
  // the post's first letters and digits (bold folded, entities decoded, emoji out); under 8 they identify nothing
  const snipSk = _scSkeleton(_normForMatch(postedText)).slice(0, 32);
  const snip = snipSk.length >= 8 ? snipSk : '';
  flags = { hadId: !!pid, hadText: !!snip };
  cReport('comment: attempting (' + _scNorm(text).length + ' chars, Safe page' + (pid ? ', post id known' : '') + ')', 'info');
  let typed = null;   // the box we typed into, while nothing is submitted
  let sent = false;   // the one submit happened — from here on nothing may type, clear or hand off
  try {
    if (!actor) return out({ reason: 'no-identity', step: 'post', handoff: true });
    await sleepMs(1500);   // the fresh post settles above the feed
    // 1 · our post, proven
    let found = _scFindOurPost(document, snip, pid, actor);
    if (!found.post) { await sleepMs(1500); found = _scFindOurPost(document, snip, pid, actor); }
    const postScore = found.best ? found.best.score : 0;
    if (!found.post) {
      cReport('comment: not typed — the post could not be proven ours (score ' + postScore + ' ' + JSON.stringify(found.best ? found.best.sig : {}) + ', ' + found.candidates + ' candidate(s), ' + found.passing + ' passing)', 'warn');
      return out({ reason: 'post-unproven', step: 'post', postScore, handoff: true });
    }
    let scope = found.post;
    // 2 · its box: open below the post, or (a post with comments) in the dialog its Comment button opens
    let b = _scFindBox(scope);
    let viaDialog = false;
    if (!b.box) {
      const cb = scope.querySelector(_SC_CMT_BTN);
      const btn = cb && (cb.closest('[role="button"]') || cb.querySelector('[role="button"]'));
      if (!btn || !scope.contains(btn)) return out({ reason: 'no-box', step: 'box', postScore, handoff: true });
      const dlgBefore = new Set(document.querySelectorAll('[role="dialog"]'));
      try { btn.click(); } catch (_) {}
      const opened = await _cmtWaitFor(() => {
        const inPost = _scFindBox(scope); if (inPost.box) return { scope, box: inPost.box };
        for (const d of document.querySelectorAll('[role="dialog"]')) {
          if (dlgBefore.has(d)) continue;
          const f = _scFindOurPost(d, snip, pid, actor);
          if (!f.post) continue;
          const bx = _scFindBox(d);
          if (bx.box) return { scope: d, box: bx.box, dialog: true };
        }
        return null;
      }, document.body, SAFE_CMT.OPEN_WAIT_MS);
      if (!opened) return out({ reason: 'no-box', step: 'box', postScore, handoff: true });
      scope = opened.scope; b = { box: opened.box }; viaDialog = !!opened.dialog;
    }
    const box = b.box;
    if (await isDomStopRequested()) return out({ reason: 'stopped', step: 'box', postScore });
    if (Date.now() - t0 > SAFE_CMT.TOTAL_MS - SAFE_CMT.RECEIPT_MS) return out({ reason: 'out-of-time', step: 'box', postScore, handoff: true });
    // 3 · type exactly; anything else is cleared and nothing is sent
    typed = box;
    if (!(await _scTypeExact(box, text))) {
      _scClear(box); typed = null;
      return out({ reason: 'insert-failed', step: 'type', postScore, viaDialog, handoff: true });
    }
    if (await isDomStopRequested()) { _scClear(box); typed = null; return out({ reason: 'stopped', step: 'type', postScore }); }
    // 4 · ONE submit
    const before = new Set(scope.querySelectorAll('[role="article"]'));
    typed = null; sent = true;
    try { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true })); } catch (_) {}
    // 5 · the receipt
    let receipt = null, refused = false, emptied = false;
    const end = Date.now() + SAFE_CMT.RECEIPT_MS;
    while (Date.now() < end) {
      await sleepMs(300);
      receipt = _scReceipt(scope, before, text);
      if (receipt) break;
      emptied = _scNorm(box.innerText || box.textContent) === '';
      try { if (_isBlockNotice(_visibleNoticeText())) { refused = true; break; } } catch (_) {}
    }
    if (viaDialog) { try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (_) {} }
    if (receipt) { cReport('comment: ✅ posted + seen under the post (Safe page' + (viaDialog ? ', post view' : '') + ')', 'info'); return out({ commented: true, submitted: true, reason: 'sent', step: 'done', postScore, viaDialog }); }
    if (refused) { cReport('comment: Facebook refused it (block notice)', 'warn'); return out({ submitted: true, reason: 'refused', step: 'receipt', postScore, viaDialog }); }
    cReport('comment: sent once, not seen within ' + Math.round(SAFE_CMT.RECEIPT_MS / 1000) + ' s' + (emptied ? ' (the box emptied)' : '') + ' — not sent again', 'warn');
    return out({ submitted: true, reason: 'unconfirmed', step: 'receipt', postScore, viaDialog, emptied });
  } catch (e) {
    if (typed) { _scClear(typed); return out({ reason: 'error', step: 'type', handoff: true, error: String(e && e.message || e).slice(0, 80) }); }
    return out({ reason: sent ? 'unconfirmed' : 'error', submitted: sent, step: 'error', error: String(e && e.message || e).slice(0, 80) });
  }
}

/** v2026-10-14 · Pure: `html` without the worker's link mark (" \u3164" now, U+200B before) after a link, and whether it
 *  had one. The page types the post without it so Facebook forms the card, then adds the mark (injectIntoComposer). */
function _stripLinkMark(html) {
  if (typeof html !== 'string') return { html, had: false };
  const re = /(https?:\/\/[^\s<>"'\u200B\u3164]+)(?: \u3164|\u200B)/gi;
  if (!re.test(html)) return { html, had: false };
  return { html: html.replace(/(https?:\/\/[^\s<>"'\u200B\u3164]+)(?: \u3164|\u200B)/gi, '$1'), had: true };
}

async function injectIntoComposer(
  html,
  images = [],
  video_ids = [],
  scheduled = false,
  background = null,
  image_ids = [],
  preloadedBlobs = {},
  unicodeFormat = false,
  commentText = null
) {
  // BUG-13/BUG-06: Allow image-only or video-only posts that have no text.
  // Only bail when there is truly nothing to post (no text AND no media).
  if ((!html || !html.trim()) && images.length === 0 && video_ids.length === 0 && image_ids.length === 0) return false;

  // v2026-10-14 · the worker glues an invisible mark to a link that ends the post (keepTrailingLinkVisible — always on) so
  // Facebook does not hide that link behind its card. Typed WITH the mark, Facebook's composer never formed the card
  // (live 14-Oct, ikea.com: "link-preview: not shown"). So the post is typed without it, the card forms, and the mark is
  // added at the end afterwards — a formed card survives later edits (verified live for the share-url strip below).
  let _linkMarkPending = false;
  try { const _lm = _stripLinkMark(html); html = _lm.html; _linkMarkPending = _lm.had; } catch (_) {}

  _setOwnPostText(html);
  const injectId = Date.now() + "-" + Math.floor(Math.random() * 10000);
  cLog("[inject] entry | html:", (html||"").slice(0,80), "| images:", images?.length, "| image_ids:", image_ids?.length, "| video_ids:", video_ids?.length);
  await sleep(0.5);

  let TimeTaken = 0;
  let inputElement = null; // should be a DOM Element when we're done
  let inputTypeDetected = "unknown";

  // ----- STEP 0a: PREFER the editor inside the REAL post-composer dialog -----
  // The heuristic smartFind (below) and several fallbacks can grab the feed COMMENT box
  // ("Comment as …") which is first in the DOM — text would then be typed into a comment,
  // not the post. findPostComposerDialog() = the dialog with an editor AND a Post button.
  try {
    const _postDlg = findPostComposerDialog();
    const _dlgEd = _postDlg && _postDlg.querySelector('[data-lexical-editor="true"], [role="textbox"][contenteditable="true"]');
    if (_dlgEd) { inputElement = _dlgEd; inputTypeDetected = 'post_dialog_editor'; }
  } catch (e) { /* fall through to smartFind */ }

  // ----- STEP 0b: AI-ASSISTED HEURISTIC LOOKUP (awaited) — only if 0a didn't resolve -----
  try {
    let smart = inputElement ? null : await smartFind?.("post"); // await smartFind if it exists
    if (smart) {
      // smartFind may return {editor: Element, ...} or the Element itself
      if (smart.editor instanceof Element) {
        inputElement = smart.editor;
        inputTypeDetected = "smart_find_object";
      } else if (smart instanceof Element) {
        inputElement = smart;
        inputTypeDetected = "smart_find_element";
      }
    }
  } catch (err) {
    // ignore smartFind errors and proceed to fallback selectors (keep 0a's result if any)
  }
  // CRITICAL: Lexical's selection state ($getSelection) initializes asynchronously via its
  // rAF reconciler; a paste before it commits is silently dropped. Focus + wait gives it
  // time — covers BOTH the dialog-editor (0a) and smartFind (0b) paths. Background tabs
  // throttle rAF, so 1500ms is the safe floor.
  if (inputElement) {
    try { inputElement.focus(); } catch (e) {}
    await sleepMs(1500);
  }
  cLog("[inject] step0:", !!inputElement, inputTypeDetected);

  // ----- STEP 1: MEDIA SECTION (BUG-11: always run regardless of inputElement; BUG-10: skip direct images loop when scheduled) -----
  if ((images && images.length > 0) || image_ids.length > 0 || (video_ids && video_ids.length > 0)) {
    const _humanLevel = currentHumanizationContext.level ?? 1;

    if (scheduled) {
      // BUG-10: For scheduled posts, fetchSnapshotViaPort handles ALL media from IndexedDB.
      // Do NOT also loop images directly — that causes every image to be uploaded twice.
      // Issue-2 FIX: pass the first ID (single snapshotId string), not the full array.
      await fetchSnapshotViaPort?.(video_ids[0]).catch(() => { });
    } else {
      // Regular posts: upload images via MediaDB streaming (image-stream port).
      // SPRINT-14: images[] no longer carries base64 — popup now sends image_ids[] instead.
      // fetchVideosByIds reuses the existing video-stream port infrastructure (same background
      // handler accepts both "video-stream" and "image-stream" port names).
      // This supports arbitrary image sizes (10-15MB+) without sendMessage size limits.
      // image_ids is passed as a parameter to injectIntoComposer — NOT from post object.
      if (image_ids.length > 0) {
        // Use pre-streamed blobs if available (passed from openComposerAndInsert).
        // This avoids streaming AFTER the composer opens, which delayed insertImage by 8-9s
        // and caused the Photo button to be missed. Pre-streaming replicates Sprint 13 timing.
        const _usePreloaded = preloadedBlobs && Object.keys(preloadedBlobs).length > 0;
        cLog(`[inject] ${_usePreloaded ? `using ${Object.keys(preloadedBlobs).length} pre-streamed blobs` : `fetching ${image_ids.length} image(s) via image-stream port`}`);
        // A2: settle pattern + onDisconnect guard + telemetry. Behavioural
        // output unchanged (still returns {} on failure so existing downstream
        // "not found — skipping" branch kicks in) but silent SW death / port
        // disconnection is now visible in telemetry instead of being lost.
        const imageMap = _usePreloaded ? preloadedBlobs : await (function fetchImagesByIds(ids) {
          return new Promise((resolve, reject) => {
            const port = chrome.runtime.connect({ name: "image-stream" });
            const result = {};
            const buffers = {};
            const types = {};
            let done = false;
            const settle = (fn, val) => {
              if (done) return;
              done = true;
              clearTimeout(timeout);
              try { port.disconnect(); } catch (e) {}
              fn(val);
            };
            const timeout = setTimeout(
              () => settle(reject, new Error('fetchImagesByIds timeout after 90s')),
              90000
            );
            ids.forEach((id) => { buffers[id] = []; });
            port.onDisconnect.addListener(() => {
              const got = Object.keys(result).length;
              if (got < ids.length) {
                settle(reject, new Error(`fetchImagesByIds disconnected (${got}/${ids.length})`));
              }
            });
            port.onMessage.addListener((msg) => {
              const { id, chunk, type, done: itemDone, error } = msg;
              if (error) { settle(reject, new Error(`fetchImagesByIds error: ${error}`)); return; }
              if (chunk) {
                buffers[id].push(Uint8Array.from(chunk));
                if (!types[id]) types[id] = type;
                port.postMessage({ id, received: true });
              }
              if (itemDone) {
                const blobType = types[id] || type || 'image/jpeg';
                result[id] = { blob: new Blob(buffers[id], { type: blobType }), type: blobType };
                if (Object.keys(result).length === ids.length) settle(resolve, result);
              }
            });
            port.postMessage({ action: "get_videos_by_ids", ids });
          });
        })(image_ids).catch((err) => {
          logTelemetry(
            'images_fetch_failed',
            { message: err?.message || String(err), ids: image_ids },
            'ERROR'
          );
          return {};
        });

        // Pre-upload focus: ONLY in non-Safe mode. In Safe mode the user chose pure
        // background "like the competitor" — no front-pop — so we rely on the
        // document_start visibility spoof (registered for the campaign) to make FB's
        // React process the file-input change event while the window stays in the
        // background. (The old code flash-focused here, popping the window forward.)
        if (!_safeMode && image_ids.length > 0) {
          const _preFocused = await isTabActuallyFocused();
          if (!_preFocused) {
            cReport('image: focusing the window briefly so FB processes the upload…', 'info');
            await requestFlashFocus(false);
            await sleepMs(700);
          }
        }
        reportStep('Uploading image');

        // Diagnostic manifest: batch size, how many ids resolved to a blob, and
        // the exact upload ORDER (image_ids[]). Lets a log reader confirm the
        // user's arranged order reached the engine and spot a silent mismatch.
        cReport('[inject] image batch: ' + image_ids.length + ' image' + (image_ids.length === 1 ? '' : 's')
          + ', imageMap has ' + Object.keys(imageMap || {}).length + ' entries'
          + ', order=[' + image_ids.map(x => String(x).slice(0, 10)).join(', ') + ']', 'info');

        // v86b: attach ALL images in ONE ordered DataTransfer (image_ids[] order) so FB
        // keeps the user's arrangement — matching the Fast path's ordered array. The OLD
        // one-at-a-time loop let FB order a multi-image post by upload-COMPLETION (a later,
        // smaller image could land before an earlier, larger one → reordered vs the drag
        // arrangement). A SINGLE set+change for the whole batch. 🛡️ We do NOT re-insert per
        // image (re-inserting on top of an already-set batch would ADD duplicate
        // attachments) — the existing waitForImageUploadComplete + focus-rescue below
        // confirm/recover the whole batch, unchanged.
        const _orderedBlobs = [];
        for (let i = 0; i < image_ids.length; i++) {
          const _e = imageMap[image_ids[i]];
          if (_e && _e.blob && _e.blob.size > 0) _orderedBlobs.push(_e.blob);
          else cReport(`image-attach: id '${String(image_ids[i]).slice(0,12)}' (${i+1}/${image_ids.length}) missing/empty blob — skipping`, 'warn');
        }
        if (_orderedBlobs.length > 0) {
          const _batchArg = _orderedBlobs.length === 1 ? _orderedBlobs[0] : _orderedBlobs;
          let uploadOk = false;
          cLog(`[inject] attaching ${_orderedBlobs.length} image(s) as ONE ordered batch (order = image_ids[])`);
          try { uploadOk = await insertImage(_batchArg, "post"); } catch (e) { console.warn("insertImage(batch) threw", e); }
          // file-input set failed entirely → drag-and-drop the SAME ordered batch (one drop,
          // order preserved, no per-input re-insert → no duplicate).
          if (!uploadOk) {
            cLog('[inject] batch file-input attach failed — trying drag-and-drop fallback (ordered batch)');
            try { uploadOk = await insertImageViaDragDrop(_batchArg); } catch (e) {}
          }
          if (!uploadOk) cLog('[inject] batch attach not confirmed yet — waitForImageUploadComplete + rescue will follow');
          await humanDelay(_humanLevel, "between_media");
        }
        cLog('[inject] waiting for image AJAX upload to complete...');
        // SPRINT-20: foreground 10000ms (was 5000 — increased so Phase 2 has plenty of budget after 1000ms Phase 1).
        // Background: 12000ms unchanged.
        // LAYER 2 (v10): Use real focus state for timing
        const _imgFocused = await isTabActuallyFocused();
        const _imgUploadMaxWait = _imgFocused ? 10000 : 12000;
        let imgOk = await waitForImageUploadComplete(_imgUploadMaxWait, image_ids.length);
        // AUTOMATIC FOCUS-RESCUE for the image: in a background tab FB's React may not process
        // the file-input change event, so the upload never confirms. Briefly focus, then
        // RE-CONFIRM — the file is already set on the input, so once the tab is visible React
        // processes it and the preview appears (no re-inject needed → no duplicate). Only if
        // there's STILL no preview do we re-inject ONCE (fileInput.files = dt.files REPLACES,
        // so even then it's a single attachment). This is the image half of the guarantee.
        if (!imgOk && _safeMode && image_ids.length > 0) {
          // v58: MULTI-ROUND on-stall focus-rescue for image BATCHES. In a
          // backgrounded scheduled window Chrome throttles paint, so FB's React
          // never finishes processing the file-input change events for a 6-image
          // batch → the upload never confirms (this is exactly the customer's
          // image-attach-failed). The old rescue flashed focus ONCE (~800ms) — too
          // little for a batch. Now we bring the window forward for a few BOUNDED
          // rounds, scaled by batch size, and just RE-CONFIRM each round: the files
          // are already set on the input, so a foreground window lets FB process the
          // whole batch. NO re-insert in the loop → never a duplicate image. This is
          // pop-only-on-stall (v27), NOT a persistent keeper (the front-pop users
          // disliked) — a quick/foreground post confirms on round 1 and never pops.
          const _rescueRounds = Math.min(4, 2 + image_ids.length);            // 6 imgs → 4 rounds
          const _rescueWaitMs = Math.min(3000, 1000 + image_ids.length * 300); // scale with batch
          for (let _rr = 0; _rr < _rescueRounds && !imgOk; _rr++) {
            cReport('image not confirmed in background — focus rescue (round ' + (_rr + 1) + '/' + _rescueRounds + ', ' + image_ids.length + ' file' + (image_ids.length === 1 ? '' : 's') + ')', 'warn');
            // v2026-08-15: front the window through the SHARED one-pop budget instead of
            // calling requestFlashFocus({force}) every round. Measured in the SW handler:
            // requestTabFocus does chrome.windows.update({focused:true}) (+ state:'normal' if minimized, 16-Oct) and only ever
            // restores the TAB — window focus is never given back, and this window is
            // single-tab so the tab restore is a no-op too. So every round was a fresh,
            // visible yank of the whole window; with the old 2s keeper also running, this
            // was the second source of the "it never stops coming to the front" report,
            // and the one that made IMAGE posts worse than text.
            //
            // Because the window STAYS front after the first pop, rounds 2+ never needed to
            // re-front: they only need to give FB time and re-confirm, which is unchanged.
            // The rounds, their scaling and the waits are all exactly as before, so the
            // foreground time a batch gets is the same — only the repeated yank is gone.
            // _rescueFocusOnce is a no-op once the budget is spent (e.g. the 6s rescue
            // inside waitForImageUploadComplete already fired), which is correct: the
            // window is already front, so re-asserting it would be a pure disturbance.
            await _rescueFocusOnce('image batch not confirmed in background (' + image_ids.length + ' file' + (image_ids.length === 1 ? '' : 's') + ')');
            await sleepMs(_rescueWaitMs);
            imgOk = await waitForImageUploadComplete(1500, image_ids.length);
          }
          if (!imgOk) {
            // Last resort (unchanged): re-inject the FIRST image once — kept narrow
            // on purpose (insertImage replaces the input each call) to avoid adding a
            // duplicate attachment when some of the batch already landed.
            const _rid = image_ids[0];
            const _re = imageMap[_rid];
            if (_re && _re.blob) {
              try { await insertImage(_re.blob, "post"); } catch (e) {}
              await sleepMs(500);
              imgOk = await waitForImageUploadComplete(_imgUploadMaxWait, image_ids.length);
            }
          }
          if (imgOk) cReport('focus rescue worked — image attached ✅', 'info');
        }
        cReport('image: upload ' + (imgOk ? 'complete ✅ (' + image_ids.length + ' file' + (image_ids.length === 1 ? '' : 's') + ')' : 'NOT confirmed ❌') , imgOk ? 'info' : 'warn');
        // Require the image: the user chose "I want the image" (no text-only fallback).
        // If the attachment isn't confirmed, REFUSE to publish — fail this group cleanly so
        // the campaign continues and the group can be retried (mirrors the Fast engine's
        // "Refusing to post text-only" guard). Prevents a silent imageless post.
        if (image_ids.length > 0 && !imgOk) {
          cReport('image-attach-failed: image not confirmed — refusing to post without it (campaign continues)', 'error');
          await new Promise((resolve) => chrome.storage.local.set(
            { operationDone: 'failed', operationFailReason: 'image-attach-failed' }, resolve));
          return false;
        }
      }
      // ...then upload videos
      for (let i = 0; i < (video_ids || []).length; i++) {
        await sleep(1.5);
        cLog(`[inject] video ${i+1}/${video_ids.length}: fetching blob for id:`, (video_ids[i]||'').slice(0,60));
        const videoMap = await fetchVideosByIds?.([video_ids[i]]).catch(
          () => ({})
        );
        const videoList = Object.values(videoMap || {});
        cLog(`[inject] video ${i+1}: videoList.length=`, videoList.length);
        for (const el of videoList) {
          // Skip if this file is an image type and we already uploaded images in this post.
          // This prevents the duplicate-image bug when the same file lands in both arrays.
          if (el.type && el.type.startsWith('image/') && images && images.length > 0) {
            cLog(`[inject] video ${i+1}: skipping image-type in video_ids (already uploaded via images[])`);
            continue;
          }
          // SPRINT-14: pass Blob directly — skip the 200MB blobToBase64 call for large videos
          cLog(`[inject] video ${i+1}: inserting blob directly, type:`, el?.type, 'size:', el?.blob?.size);
          const vResult = await insertImage(el.blob, "post").catch(() => false);
          cLog(`[inject] video ${i+1}: insertImage result:`, vResult);
          if (vResult) await sleep(2);
        }
      }
    }
  }

  // After media upload Facebook's Lexical re-renders the composer — give it a moment to settle.
  if ((image_ids.length > 0) || (video_ids && video_ids.length > 0)) {
    await sleep(0.6);
  }

  // BUG-TEXTONLY-FIX: ALWAYS discard the smartFind reference, not just after media upload.
  // smartFind runs right after openComposer() before Facebook's Lexical editor is fully mounted.
  // It grabs the first visible contenteditable that scores well — often the mini-composer trigger
  // or a pre-Lexical placeholder, NOT the actual dialog editor. For image posts this was
  // accidentally fixed because media upload triggers React re-render; but for TEXT-ONLY posts
  // the stale/wrong reference persisted, causing ALL 4 paste strategies to silently fail.
  // waitForComposerTextbox (step2) is the reliable finder — it polls, filters, scores, and
  // waits up to 12s for the real Lexical editor to appear inside the dialog.
  if (inputTypeDetected === 'smart_find_element' || inputTypeDetected === 'smart_find_object') {
    cLog('[inject] discarding smartFind reference — re-querying via waitForComposerTextbox');
    inputElement = null;
    inputTypeDetected = 'unknown';
  }

  // ----- SEARCH STRATEGIES (kept but safer) -----
  // 1. notranslate specific — ALWAYS prefer notranslate when found (matches competitor priority)
  // BUG-FIX: previous code set inputTypeDetected="notranslate_5rpu" even when inputElement
  // was a Lexical editor found by step0 — causing strategy1 to paste wrong HTML format to Lexical.
  {
    const _ntEl = document.querySelector(".notranslate._5rpu[contenteditable='true']");
    if (_ntEl) {
      inputElement = _ntEl;
      inputTypeDetected = "notranslate_5rpu";
    }
  }
  cLog("[inject] step1 notranslate:", inputTypeDetected === "notranslate_5rpu");

  // 2. waitForComposerTextbox — scored, comment-filtered search (primary strategy)
  if (!inputElement) {
    cLog("[inject] step2 waitForComposerTextbox starting (12s timeout)...");
    const found = await waitForComposerTextbox(12000);
    cLog("[inject] step2 waitForComposerTextbox result:", !!found, found ? `w=${Math.round(found.getBoundingClientRect().width)} h=${Math.round(found.getBoundingClientRect().height)} connected=${found.isConnected}` : "null");
    if (found instanceof Element) {
      inputElement = found;
      inputTypeDetected = "wait_for_composer";
    }
  }

  // 3. specific lexical editor composers (uses findPublicPostComposer) — fallback
  if (!inputElement) {
    const composer = await findPublicPostComposer();
    // composer is either null or {editor, placeholderNode, placeholderText}
    if (composer && composer.editor instanceof Element) {
      inputElement = composer.editor;
      inputTypeDetected = "lexical_main_specific_class";
    }
  }

  // 4. general lexical editors prioritized by label and size
  if (!inputElement) {
    const mainPostInputs = Array.from(
      document.querySelectorAll(
        "div[contenteditable='true'][role='textbox'][data-lexical-editor='true'], div[contenteditable='true'][role='textbox']"
      )
    ).filter((el, idx, arr) => arr.indexOf(el) === idx); // remove duplicates (safety)
    let candidateInputs = mainPostInputs.filter(
      (el) =>
        !el.closest('div[aria-label*="comment"], div[aria-label*="Comment"]')
    );
    candidateInputs.sort((a, b) => scoreTextbox(b) - scoreTextbox(a));
    if (candidateInputs.length) {
      inputElement = candidateInputs[0];
      inputTypeDetected = "lexical_prioritized";
    }
  }

  // 5. fallback selectors (safer, fewer fragile classes)
  if (!inputElement) {
    inputElement =
      document.querySelector(
        "div[aria-label='Create a public post…'][contenteditable='true'][role='textbox'], div[aria-label*='Create a public post'][contenteditable='true'], div[data-lexical-editor='true'][contenteditable='true']"
      ) ||
      document.querySelector("div[contenteditable='true'][role='textbox']");
    if (inputElement) {
      inputTypeDetected =
        inputElement.getAttribute("data-lexical-editor") === "true"
          ? "lexical_fallback"
          : "standard_fallback";
    }
  }

  // 6. last-resort: first valid candidate
  if (!inputElement) {
    const selectors = [
      "div[contenteditable='true'][role='textbox'][data-lexical-editor='true'][aria-placeholder]",
      "div[contenteditable='true'][role='textbox'][data-lexical-editor='true']",
      "div[contenteditable='true'][role='textbox']",
    ];
    const candidates = selectors.flatMap((sel) =>
      Array.from(document.querySelectorAll(sel))
    );
    for (let i = 0; i < candidates.length; i++) {
      if (isValidTextbox(candidates[i])) {
        inputElement = candidates[i];
        inputTypeDetected =
          inputElement.getAttribute("data-lexical-editor") === "true"
            ? "lexical_largest"
            : "standard_largest";
        break;
      }
    }
  }

  if (!inputElement || !(inputElement instanceof Element)) return false;
  console.log("[inject] inputElement found, type:", inputElement.getAttribute("data-lexical-editor") === "true" ? "lexical" : "standard", "| connected:", inputElement.isConnected, "| width:", inputElement.getBoundingClientRect().width);

  // ----- PASTE / INSERT -----
  try {
    // Defensive focus: focus might throw if element is detached — guard it
    try {
      inputElement.focus();
    } catch (focusErr) {
      // try to set tabindex and focus again as last resort
      try {
        if (!inputElement.hasAttribute("tabindex"))
          inputElement.setAttribute("tabindex", "-1");
        inputElement.focus();
      } catch (e) {
        console.warn("focus failed on inputElement", e);
      }
    }

    try {
      inputElement.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "nearest",
      });
    } catch (e) {
      // ignore scrolling errors
    }

    await sleep(0.25);

    if (document.activeElement !== inputElement) {
      try {
        inputElement.focus();
        await sleep(0.15);
      } catch (e) {
        // if focus still fails, continue — some editors accept innerHTML changes
      }
    }
    if (document.activeElement !== inputElement) {
      // continue anyway, some editors don't set document.activeElement correctly
      // but we still need to ensure we can paste; so we won't return false yet
    }

    // NOTE: Do NOT dispatch a stray 'input' event here — competitor does not do this,
    // and firing input before paste can confuse Lexical's internal editor state.

    // Content is already HTML with proper tags (strong, em, u, etc.)
    // Clean up: remove anchor wrappers, decode &nbsp; to regular spaces
    // (Facebook's Lexical corrupts raw &nbsp; entities into garbled text)
    const sanitizedHtml = addSchemeToBareWhatsAppLinks(html)
      .replace(/<a[^>]*>(.*?)<\/a>/gi, "$1")
      .replace(/&nbsp;/gi, " ")
      .replace(/&#160;/g, " ")
      // Also normalize the RAW U+00A0 character (not just the &nbsp; entity) —
      // some editor paths emit the bare char, which no other decoder catches.
      .replace(/ /g, " ");

    // FIX: Previously used htmlToUnicodeFormattedText which converts <strong>/<h1> to
    // Unicode bold characters (𝗵𝗲𝗹𝗹𝗼) — causing posts to appear bold on Facebook.
    // Now use htmlToPlainTextWithLineBreaks which strips formatting and preserves line breaks
    // as real \n characters, fixing both the bold bug and the missing line breaks bug.
    // Item B (Safe mode): when unicodeFormat is on, render <b>/<i> as Unicode
    // math bold/italic (𝗯𝗼𝗹𝗱) instead of stripping them — so formatting shows
    // even on Lexical (they are plain characters that paste fine as text/plain).
    const expectedPlainText = (
      (unicodeFormat ? htmlToUnicodeFormattedText?.(sanitizedHtml) : htmlToPlainTextWithLineBreaks?.(sanitizedHtml)) || ""
    ).trim();
    await humanDelay(currentHumanizationContext.level ?? 1, "pre_text");

    // ── BACKGROUND STYLE — apply BEFORE typing (not after) ──────────────────
    // BUG-FIX: Previously applied background AFTER text injection. With typeTextCharByChar,
    // typing 100 chars takes ~8 seconds. Facebook hides the background button while text is
    // being typed if it grows beyond the threshold. Applying BEFORE typing (on empty composer)
    // ensures the background button is always visible and accessible.
    {
      const _bgPlainLen = (html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().length;
      const _bgHasMedia = (images && images.length > 0) || (video_ids && video_ids.length > 0) || (image_ids && image_ids.length > 0) || _safeHasVideoFlag;
      if (background && _bgPlainLen <= 130 && !_bgHasMedia) {
        const bgApplied = await applyBackgroundStyle(background);
        // v2026-10-02: picking a background re-mounts Facebook's editor (the text moves onto the coloured card),
        // so the reference taken above is DETACHED from here on. Found live in the QA Chrome: the post was typed
        // and verified, then the final wrong-target guard saw a detached editor "outside any dialog" and aborted.
        if (bgApplied) {
          await sleep(0.3);
          inputElement = liveComposerEditor(inputElement);
        }
        if (!bgApplied) {
          console.warn('[inject] Background style failed — aborting post');
          cReport('background-apply-failed: could not apply the background-color tile — aborting (color posts require the BG applied). Why: ' + (_bgFailWhy || '?') + '. On-screen: ' + _domFailSnapshot(), 'error');
          await new Promise(resolve => chrome.storage.local.set({ operationDone: 'failed', operationFailReason: 'background-apply-failed' }, resolve));
          return false;
        }
        await sleep(1);
      } else if (background && (_bgPlainLen > 130 || _bgHasMedia)) {
        console.debug('[bg] Skipping background: text too long or has media', { _bgPlainLen, _bgHasMedia });
      }
    }

    // ── SMART BEHAVIOR: character-by-character typing (humanLevel > 0) ──────
    // Only use the typed path when text is plain (no HTML tags) so that rich
    // formatting (bold, italic, etc.) still goes through the clipboard paste.
    // BUG-FIX: Check against sanitizedHtml (entity-decoded), not raw html.
    const isPlainText = sanitizedHtml && !/<[a-z][\s\S]*>/i.test(sanitizedHtml);
    const humanLevel = currentHumanizationContext.level ?? 0;
    let pasteSucceeded = false;
    cLog("[inject] text path | isPlainText:", isPlainText, "| humanLevel:", humanLevel, "| plainText:", expectedPlainText.slice(0,60));
    reportStep('Typing the post text');

    if (humanLevel > 0 && isPlainText && expectedPlainText.length <= 800 && !_safeMode) {
      // Plain text + short → char-by-char (NON-SAFE only). In SAFE mode we NEVER do this:
      // the moment the user clicks away, each keystroke's setTimeout is throttled, so 250
      // chars blow past the post-confirm timeout (verified live, build 1857). The competitor
      // never types char-by-char — it bulk-pastes. So Safe always falls through to the paste
      // path below = instant insert, immune to focus loss.
      try {
        await typeTextCharByChar(inputElement, expectedPlainText);
        pasteSucceeded = true;
      } catch (typingErr) {
        console.warn("[inject] typeTextCharByChar failed, falling back to paste:", typingErr);
        pasteSucceeded = false;
      }
    } else if (humanLevel > 0 && isPlainText) {
      cReport('presence: bulk paste (' + (_safeMode ? 'Safe — instant insert like the competitor' : 'text >800 chars') + ')', 'info');
    }

    // ── CLIPBOARD PASTE path — mirrors competitor's ensureComposerContentInserted() ──
    // Competitor strategy: paste → dispatchEditorInput → check → insertHTML → insertText → DOM
    // Critical: dispatchEditorInput() (input event) MUST fire after paste to trigger Lexical's update cycle.
    // ClipboardEvent must NOT have composed:true or view:window — competitor omits these.
    if (!pasteSucceeded) {

    // Helper: fire input event to trigger Lexical's internal update cycle (competitor's dispatchEditorInput)
    const dispatchEditorInput = () => {
      try { inputElement.dispatchEvent(new Event("input", { bubbles: true, composed: true })); } catch (e) {}
    };

    // Helper: check if expected text actually landed in the editor (competitor's composerContainsExpectedContent)
    // BUG-FIX: inputElement can be DETACHED after Lexical re-renders (replaces child nodes on paste).
    // A detached node always has empty textContent — this caused strategy1 to look like it failed
    // when it actually worked, then strategy3 fired too, causing duplicate text.
    // Fix: always re-query the LIVE Lexical root (never replaced, only its children change).
    const composerHasText = () => {
      const liveEl =
        (inputElement.isConnected ? inputElement : null) ||
        document.querySelector('[data-lexical-editor="true"]') ||
        document.querySelector('.notranslate._5rpu[contenteditable]');
      const actual = (liveEl?.textContent || '').trim().toLowerCase();
      if (!actual) return false;
      const expected = expectedPlainText.trim().toLowerCase();
      if (!expected) return true;
      if (actual.includes(expected)) return true;
      // Fuzzy: ≥60% of words (3+ chars) found
      const tokens = expected.split(/\s+/).filter(w => w.length >= 3);
      if (tokens.length === 0) return actual.length > 0;
      const matched = tokens.filter(t => actual.includes(t)).length;
      return matched >= Math.max(1, Math.ceil(tokens.length * 0.6));
    };

    // NOTE: requestTabFocus removed intentionally — focusing the posting tab
    // would steal the user's window focus on every post. The content script
    // does not check focus; we rely on Lexical accepting paste events as long
    // as we focus the input and wait for $getSelection() to settle (below).
    cLog('[inject] tab state: visibilityState:', document.visibilityState, 'hasFocus:', document.hasFocus());

    // ── Focus + 500ms wait (competitor's proven approach) ────────────────────────────────────
    // ROOT CAUSE FIX: Lexical silently ignores paste events when $getSelection() is null.
    // $getSelection() is set by Lexical's onDocumentSelectionChange handler, which runs
    // ASYNCHRONOUSLY after focus (via editor.update() microtask + reconciler commit).
    // Competitor research confirmed: they use focus() + 500ms sleep, nothing else.
    // Using createRange()/addRange() to force selection placement CONFUSES Lexical —
    // the container-level cursor position is not a valid Lexical insert point, causing
    // $getSelection() to remain null and the paste to be silently rejected.
    // 500ms gives React/Lexical enough time to commit the selection state internally.
    try { inputElement.focus(); } catch(e) {}
    await sleepMs(500);
    cLog("[inject] about to run strategy1 | connected:", inputElement.isConnected, "| hasFocus:", document.activeElement === inputElement);

    // ── Pre-compute paste HTML once — reused by strategy1 and the paste-retry ──────────────
    const _isNotranslate = inputTypeDetected === 'notranslate_5rpu';
    let _pasteHtml, _pastePlain;
    {
      // Shared HTML escaper (for Lexical path only)
      const _escHtml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

      if (_isNotranslate) {
        // ── NOTRANSLATE PATH: pass raw HTML, like the competitor does ──
        // The notranslate editor handles HTML from clipboard correctly (bold, italic, etc. preserved).
        // Previous bug where tags appeared literally was caused by execCommand("insertHTML"),
        // not by ClipboardEvent paste. Paste with text/html works correctly here.
        // This preserves ChatGPT formatting (bold, italic, line breaks) in the final post.
        const _ntHtml = sanitizedHtml
          .replace(/<p><br\s*\/?><\/p>/gi, '<p>\u200B</p>') // empty paragraphs → zero-width space (competitor fix)
          .replace(/<p><\/p>/gi, '<p>\u200B</p>');           // same for pure empty <p>
        _pasteHtml = _ntHtml;
        // For text/plain: strip HTML to plain text
        try {
          const _div = document.createElement('div');
          _div.innerHTML = _ntHtml;
          _pastePlain = _div.innerText || expectedPlainText;
        } catch(e) { _pastePlain = expectedPlainText; }
        cLog('[inject] notranslate paste: using raw HTML for formatting preservation');
      } else {
        // ── LEXICAL PATH: multiple <p> elements for proper paragraph spacing ──
        // ROOT CAUSE FIX: single <p> with <br><br><br> only creates LineBreakNodes
        // inside ONE ParagraphNode. Facebook's published post collapses these into
        // no visible spacing. Multiple <p> elements create separate ParagraphNodes
        // which Facebook renders with proper blank-line spacing between paragraphs.
        const _pClass = 'xdj266r x11i5rnm xat24cr x1mh8g0r x16tdsg8 xdpxx8g';
        const _plainForLines = (unicodeFormat ? htmlToUnicodeFormattedText?.(sanitizedHtml) : htmlToPlainTextWithLineBreaks?.(sanitizedHtml)) || expectedPlainText;

        // Split on \n but KEEP empty lines (they represent blank lines between paragraphs).
        // PRESERVE each content line's real spaces (leading indentation, alignment) —
        // only fully-blank lines (empty or whitespace-only) act as paragraph separators.
        // (Previously `.map(l => l.trim())` stripped intentional leading/trailing spaces.)
        const _rawLines = _plainForLines.split('\n').map(l => l.split(String.fromCharCode(160)).join(' '));

        // Strip leading/trailing BLANK lines (whitespace-only counts as blank)
        while (_rawLines.length > 0 && !_rawLines[0].trim()) _rawLines.shift();
        while (_rawLines.length > 0 && !_rawLines[_rawLines.length - 1].trim()) _rawLines.pop();

        // Collapse 3+ consecutive blank lines → max 1 blank line
        const _normalizedLines = [];
        let _emptyRun = 0;
        for (const _ln of _rawLines) {
          if (!_ln.trim()) {
            _emptyRun++;
            if (_emptyRun <= 1) _normalizedLines.push('');
          } else {
            _emptyRun = 0;
            _normalizedLines.push(_ln);
          }
        }

        if (_normalizedLines.length > 0) {
          // Group consecutive NON-EMPTY lines into ONE <p>, joined by <br> soft
          // breaks — so a single line break stays tight (soft break inside one
          // paragraph), and only a BLANK line starts a new <p> (paragraph gap).
          // Previously EACH line was its own <p> → every single line break
          // rendered as a paragraph gap → double-spaced posts (customer complaint).
          const _paras = [];
          let _cur = [];
          for (const l of _normalizedLines) {
            if (l === '') { if (_cur.length) { _paras.push(_cur); _cur = []; } }
            else _cur.push(l);
          }
          if (_cur.length) _paras.push(_cur);
          const _pParts = _paras.map(lines =>
            `<p class="${_pClass}" dir="ltr">` +
            lines.map(l => `<span data-lexical-text="true">${_escHtml(l)}</span>`).join('<br>') +
            `</p>`
          );
          _pasteHtml = `<meta charset='utf-8'>` +
            (_pParts.join('') || `<p class="${_pClass}" dir="ltr"><br></p>`);
          _pastePlain = _normalizedLines.join('\n');
        } else {
          // Fallback: wrap plain text in a minimal paragraph
          _pasteHtml = `<meta charset='utf-8'><p dir="ltr"><span data-lexical-text="true">${_escHtml(expectedPlainText)}</span></p>`;
          _pastePlain = expectedPlainText;
        }
      }
    } // end pre-compute block

    // Helper: re-query inputElement if it has become disconnected.
    // Must be called before every paste attempt — React may have replaced the node at any time.
    const _refreshInputElement = () => {
      if (inputElement && inputElement.isConnected) return; // still good
      const fresh =
        document.querySelector('[data-lexical-editor="true"][contenteditable="true"]') ||
        document.querySelector(".notranslate._5rpu[contenteditable='true']") ||
        document.querySelector("div[contenteditable='true'][role='textbox']");
      if (fresh) {
        cLog('[inject] _refreshInputElement: replaced stale ref with live element', fresh.tagName, fresh.className?.slice(0,40));
        inputElement = fresh;
      }
    };

    // Helper: dispatch a fresh ClipboardEvent paste with the pre-computed HTML/plain
    const _doPaste = () => {
      // Create a fresh ClipboardEvent each call (events cannot be re-dispatched).
      const _ev = new ClipboardEvent("paste", {
        bubbles: true, cancelable: true, clipboardData: new DataTransfer(),
      });
      if (_isNotranslate) {
        // Notranslate path: keep text/html for bold/italic/formatting preservation
        _ev.clipboardData.setData("text/html", _pasteHtml || '');
        _ev.clipboardData.setData("text/plain", _pastePlain || '');
      } else {
        // v2026-10-14 · text/html (the grouped _pasteHtml built above: lines of one paragraph joined by <br>, a blank line
        // = a new <p>) + text/plain. With text/plain ONLY, Facebook's editor made EVERY line its own paragraph, stored them
        // as empty lines ("a\n\nb") and folded every Safe link post in the group feed after its first line ("See more") —
        // measured live 14-Oct: editor-shape paragraphs=2 line-breaks=0 for "line\nLink: url"; the same text by Fast is
        // stored "a\nb" and shows in full. (The older note — html "merges paragraphs" — predates the grouped _pasteHtml.)
        _ev.clipboardData.setData("text/html", _pasteHtml || '');
        _ev.clipboardData.setData("text/plain", _pastePlain || '');
      }
      inputElement.dispatchEvent(_ev);
    };

    // Helper: wait for the paste to appear in the editor (MutationObserver + 4000ms fallback)
    // Increased from 1500ms → 4000ms: Lexical's async reconciler takes longer in background
    // tabs where Chrome throttles timers/microtasks. A false negative here causes strategy3
    // to append duplicate text on top of already-pasted content.
    const _waitPasteResult = () => new Promise((resolve) => {
      const liveEl = (inputElement.isConnected ? inputElement : null)
        || document.querySelector('[data-lexical-editor="true"]')
        || document.querySelector('.notranslate._5rpu[contenteditable]');
      if (!liveEl) return resolve(false);
      if (composerHasText()) return resolve(true);
      let _d = false;
      const _fin = (r) => { if (_d) return; _d = true; mo.disconnect(); clearTimeout(_t); resolve(r); };
      const mo = new MutationObserver(() => { if (composerHasText()) _fin(true); });
      mo.observe(liveEl, { childList: true, subtree: true, characterData: true });
      const _t = setTimeout(() => _fin(composerHasText()), 4000);
    });

    try {
      cLog("[inject] s1 pasteHtml:", _pasteHtml ? _pasteHtml.slice(0, 150) : 'null');
      _refreshInputElement(); // ensure we paste on the live element, not a stale one
      try { inputElement.focus(); } catch(e) {}
      await sleepMs(300); // let focus settle on the fresh element
      _doPaste();
      dispatchEditorInput();
      pasteSucceeded = await _waitPasteResult();
      cLog("[inject] strategy1 paste:", pasteSucceeded, "| editorType:", inputTypeDetected, "| text:", (inputElement.isConnected ? inputElement.textContent : '[detached — checking live]').slice(0,80));
    } catch (e) {
      console.warn("[inject] strategy1 paste threw:", e);
    }

    // Grace period: if Lexical is still committing the selection state async,
    // the paste might land just after our 1500ms timeout. Check once more before retrying.
    if (!pasteSucceeded) {
      await sleepMs(400);
      if (composerHasText()) { pasteSucceeded = true; cLog("[inject] s1 late-success"); }
    }

    // Strategy 2: PASTE RETRY — same ClipboardEvent approach with an extra focus+wait.
    // Replaces insertHTML (which never works on Lexical). This covers the case where
    // strategy1 failed due to Lexical's async selection commit not being ready in 500ms.
    if (!pasteSucceeded) {
      try {
        cLog("[inject] strategy2 paste-retry: re-focusing and re-pasting");
        _refreshInputElement(); // re-check — element may have been replaced since strategy1
        try { inputElement.focus(); } catch(e) {}
        await sleepMs(600);
        _doPaste();
        dispatchEditorInput();
        pasteSucceeded = await _waitPasteResult();
        cLog("[inject] strategy2 paste-retry:", pasteSucceeded);
      } catch (e) { console.warn("[inject] strategy2 threw:", e); }
    }

    // Strategy 3: paragraph-by-paragraph insertText + Enter key (fallback when paste fails).
    // Uses same line structure as strategy1/2 — preserving blank lines as double-Enter.
    // Each Enter creates a new ParagraphNode in Lexical → proper paragraph spacing.
    if (!pasteSucceeded) {
      try {
        cLog("[inject] strategy3 line-by-line insertText+Enter");
        _refreshInputElement(); // always operate on live element
        try { inputElement.focus(); } catch(e) {}
        await sleepMs(200);
        // Use same normalized lines as paste (preserving blank lines between paragraphs)
        const _plain3 = htmlToPlainTextWithLineBreaks?.(sanitizedHtml) || expectedPlainText;
        const _raw3 = _plain3.split('\n').map(l => l.trim());
        while (_raw3.length > 0 && !_raw3[0]) _raw3.shift();
        while (_raw3.length > 0 && !_raw3[_raw3.length - 1]) _raw3.pop();
        // Collapse 3+ empty lines to max 1
        const _lines3 = [];
        let _er3 = 0;
        for (const _l of _raw3) { if (!_l) { _er3++; if (_er3 <= 1) _lines3.push(''); } else { _er3 = 0; _lines3.push(_l); } }

        const _dispatchEnter = async () => {
          inputElement.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            bubbles: true, cancelable: true
          }));
          await sleepMs(60);
        };

        for (let _li = 0; _li < _lines3.length; _li++) {
          if (_lines3[_li]) {
            document.execCommand("insertText", false, _lines3[_li]);
          }
          // After each line (except last): Enter for next paragraph
          // Empty line → double Enter (blank paragraph then new paragraph)
          if (_li < _lines3.length - 1) {
            await _dispatchEnter();
            if (!_lines3[_li + 1]) {
              // Next line is empty (blank paragraph) — we'll handle it in next iteration
              // Just the single Enter here is enough; the empty line iter will add another
            }
          }
        }
        await sleepMs(200);
        dispatchEditorInput();
        pasteSucceeded = composerHasText();
        cLog("[inject] strategy3 line-by-line:", pasteSucceeded);
      } catch (e) { console.warn("[inject] strategy3 threw:", e); }
    }

    // Strategy 4: legacy DOM fallback — non-Lexical editors only
    if (!pasteSucceeded) {
      try {
        inputElement.focus();
        const isLexical = inputElement.getAttribute('data-lexical-editor') === 'true';
        if (!isLexical && typeof inputElement.innerHTML === 'string' && sanitizedHtml) {
          inputElement.innerHTML = sanitizedHtml;
        } else if (typeof inputElement.value === 'string') {
          inputElement.value = expectedPlainText;
        } else if (!isLexical) {
          inputElement.textContent = expectedPlainText;
        }
        await sleepMs(220);
        dispatchEditorInput();
        pasteSucceeded = composerHasText();
        cLog("[inject] strategy4 DOM fallback:", pasteSucceeded);
      } catch (e) { console.warn("[inject] strategy4 threw:", e); }
    }

    cLog("[inject] FINAL pasteSucceeded:", pasteSucceeded, "| text:", (inputElement.textContent||'').slice(0,80));

    // ABORT GUARD: If the user provided text AND paste failed → abort entirely.
    // Do NOT submit an empty/text-less post — this damages the user's reputation.
    // Exception: if the user intentionally sent NO text (image-only post), proceed.
    const _textWasRequired = !!(expectedPlainText && expectedPlainText.trim());
    const _hasMediaAttached = (images && images.length > 0) || (video_ids && video_ids.length > 0) || (image_ids && image_ids.length > 0) || _safeHasVideoFlag;
    if (!pasteSucceeded && _textWasRequired) {
      cReport("text-insert-failed: text required but all paste strategies failed — refusing to submit a text-less post " + (_hasMediaAttached ? "(had media too)" : "(no media)"), 'error');
      try { await new Promise((resolve) => chrome.storage.local.set({ operationDone: "failed", operationFailReason: "text-insert-failed" }, resolve)); } catch(e) {}
      return false;
    }
    if (!pasteSucceeded && !_textWasRequired && _hasMediaAttached) {
      cLog("[inject] no text provided — proceeding as image-only post");
    }

      // Only run the link-preview watcher when the paste actually landed clean text
      // that contains a URL. Skipping it on failure avoids an unnecessary 8-10 s delay.
      if (pasteSucceeded && /https?:\/\//i.test(html || '')) {
      // timing constants (client requested behavior)
      const TOTAL_CAP_MS = 10000; // total cap (≈10s)
      const PRIMARY_TIMER_MS = 8000; // short timer (≈8s) used as safety net
      const NUDGE_WAIT_MS = 2000; // wait after nudge (≈2s)

      // Scope preview detection to the composer area only — avoids false positives
      // from [role="img"] on profile pictures, icons, etc. elsewhere on the page.
      const composerContainer = inputElement.closest('[role="dialog"]')
        || inputElement.closest('form')
        || document.body;

      // helper: watch for preview using MutationObserver + quick poll (observer is primary)
      const watchForPreview = (timeoutMs) =>
        new Promise((resolve) => {
          if (previewPresent(composerContainer)) {
            resolve(true);
            return;
          }

          let finished = false;
          // primary: MutationObserver
          const mo = new MutationObserver(() => {
            try {
              if (previewPresent(composerContainer)) {
                if (!finished) {
                  finished = true;
                  mo.disconnect();
                  clearInterval(pollInterval);
                  clearTimeout(timer);
                  resolve(true);
                }
              }
            } catch (e) {
              // ignore and let timeout handle it
            }
          });

          // observe broad changes; this should be non-invasive to existing observers
          try {
            mo.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: true,
            });
          } catch (e) {
            // if observing body fails for some reason, fallback to polling only
          }

          // secondary: short polling (safe fallback, non-invasive)
          const pollInterval = setInterval(() => {
            try {
              if (previewPresent(composerContainer)) {
                if (!finished) {
                  finished = true;
                  mo.disconnect();
                  clearInterval(pollInterval);
                  clearTimeout(timer);
                  resolve(true);
                }
              }
            } catch (e) {
              // ignore
            }
          }, 150);

          // overall timeout for this watcher
          const timer = setTimeout(() => {
            if (!finished) {
              finished = true;
              try {
                mo.disconnect();
              } catch (e) { }
              clearInterval(pollInterval);
              resolve(false);
            }
          }, timeoutMs);
        });

      // Start the primary watcher immediately (it represents the MutationObserver path)
      const primaryWatcher = watchForPreview(TOTAL_CAP_MS);

      // Start a short safety timer (client asked that timer be a safety net, not primary)
      const primaryTimer = new Promise((resolve) =>
        setTimeout(() => resolve(false), PRIMARY_TIMER_MS)
      );

      // Race: if preview detected before primary timer ends -> proceed immediately.
      const previewBeforeTimer = await Promise.race([
        primaryWatcher,
        primaryTimer,
      ]);

      if (previewBeforeTimer) {
        // preview appeared before the 8s safety timer — proceed.
        // primaryWatcher has already resolved true and cleaned up its observer.
      } else {
        // safety timer expired with no preview signal -> perform fallback nudge,
        // but keep the primary watcher running for a short extra window.
        try {
          // nudge with keystroke (space -> backspace) using existing helper
          nudgeWithKeystroke(inputElement);
        } catch (e) {
          // ignore nudge errors — we'll still wait for the observer
        }

        // Wait up to NUDGE_WAIT_MS for preview to appear after nudge.
        // Note: primaryWatcher was started with TOTAL_CAP_MS, so it is still watching.
        // We'll also create a short watcher promise that times out after NUDGE_WAIT_MS.
        const postNudge = await Promise.race([
          primaryWatcher, // may still resolve true if preview appears
          new Promise((resolve) =>
            setTimeout(() => {
              resolve(false);
            }, NUDGE_WAIT_MS)
          ),
        ]);

        if (postNudge) {
          // preview appeared during the nudge window — proceed.
        } else {
          // final fallback: nothing detected within ~10s total (8s timer + 2s nudge window).
          // We intentionally do not mutate innerHTML or force insertion. Keep older logic intact.
          // Optionally, we can attempt the text-insert fallback (non-HTML) once more as a last resort
          // without touching innerHTML — keep this minimal and non-invasive.
          try {
            // Try the safe insertText fallback (will trigger beforeinput/input handlers where supported)
            addText(inputElement, " ");
            // remove the inserted space immediately via nudge to avoid leaving extra character
            nudgeWithKeystroke(inputElement);
          } catch (e) {
            // swallow any errors — we won't alter HTML or throw.
          }
        }
      }
      } // end: only wait for link preview when text contains a URL
    } // closes outer if (!pasteSucceeded) / clipboard paste block

    // Let the editor process the paste
    // 🔑 The window between "Typing the post text" and "Publishing the post" is
    // 570 lines long and used to emit NOTHING. That silence is what killed
    // one customer: the budget cannot tell a slow flow from a
    // wedged one when neither says anything for two minutes. Each mark below
    // both re-arms the budget AND names the segment in the phases line.
    // ⛔ Marks go at REAL boundaries only. A heartbeat on every sleepMs would
    // re-arm the watchdog from inside a poll that is waiting for something that
    // will never arrive — the wedge case the watchdog exists for.
    reportStep('Verifying the post content');
    await sleep(pasteSucceeded ? 1.2 : 0.5);
    try {
      inputElement.dispatchEvent(
        new Event("input", { bubbles: true, composed: true })
      );
    } catch (e) { }

    // Background style is now applied BEFORE text insertion (moved above) —
    // see "BACKGROUND STYLE" block above typeTextCharByChar call.


    // CRITICAL: Wait for all media uploads (video AND image) to complete before clicking post.
    // BUG-H5 FIX: Previously timed out after 5 minutes but CONTINUED anyway —
    // resulting in a post with missing video. Now we abort on timeout.
    // BUG-IMG-FIX: Extended to also cover image-only posts. For images, isVideoUploading()
    // returns false immediately (no progress bar), but the settle time + Post button
    // aria-disabled check in clickPostButtonWithRetry handles any remaining upload state.
    // v2026-10-12: photos staged from the media library arrive as image_ids (Publish now always does). Counting
    // only `images` made a photo post wait 12 s for a link card Facebook never shows beside photos (LIVE: LT4).
    const _hasImages = (images && images.length > 0) || (image_ids && image_ids.length > 0);
    const _hasVideos = (video_ids && video_ids.length > 0) || _safeHasVideoFlag;
    if (_hasVideos) {
      // BEFORE Post: confirm only that the video PREVIEW appeared (= FB accepted the file into the
      // composer). The actual 32MB upload happens AFTER Post — Facebook uploads it server-side to
      // the submitted post (a progress bar), which waitForVideoPublishComplete waits for below.
      // This matches the competitor's proven flow (ue() = preview before Post; x() = bar after Post).
      reportStep('Attaching the video');   // up to 20s + a 15s rescue retry, silent until now
      cReport('video: confirming the file attached (preview)…', 'info');
      let attached = await waitForVideoPreview(20000);
      if (!attached && _safeMode) {
        await _rescueFocusOnce('video preview not rendered in background');
        attached = await waitForVideoPreview(15000);
      }
      if (!attached) {
        // The video never attached — refuse a silent video-less post (mirrors the image guard).
        cReport('video-attach-failed: the video never attached (no preview) — refusing to post without it (campaign continues)', 'error');
        await new Promise((resolve) => chrome.storage.local.set({ operationDone: "failed", operationFailReason: "video-attach-failed" }, resolve));
        return false;
      }
      cReport('video: preview confirmed ✅ (attached) — the upload finishes after Post', 'info');
      await sleep(1);
    } else if (_hasImages) {
      // Image-only: each image was already confirmed via waitForImageUploadComplete above; just settle.
      await sleep(3);
    }

    // LINK PREVIEW (text+link posts, no media): when the text has a URL and there's no image/
    // video, FB auto-generates an Open-Graph preview card a beat after the URL lands in the
    // composer. Wait (MutationObserver via _cmtWaitFor — not throttled in a background window)
    // for the card before clicking Post, so the published post includes the rich preview.
    // Non-fatal: if no card appears (no OG data / FB didn't generate one), post anyway.
    if (!_hasImages && !_hasVideos && /https?:\/\//i.test(html || '')) {
      reportStep('Waiting for the link preview');   // 12s cap, silent until now
      const _lpScope = getComposerScope();
      const _linkReady = await _cmtWaitFor(
        () => (_linkCardPresent(_lpScope) ? true : null),
        _lpScope, 12000
      );
      cReport('link-preview: ' + (_linkReady ? 'rendered ✅' : 'not shown (posting without a card)'), 'info');

      // v2026-10-14 · now the mark (see the top of this function): caret at the very end, one invisible character.
      if (_linkMarkPending && inputElement) {
        _linkMarkPending = false;
        try {
          inputElement.focus();
          const _sel = window.getSelection(); const _rng = document.createRange();
          _rng.selectNodeContents(inputElement); _rng.collapse(false); _sel.removeAllRanges(); _sel.addRange(_rng);
          document.execCommand('insertText', false, ' \u3164');
          await sleep(1);
          const _cardKept = _linkReady ? _linkCardPresent(_lpScope) : null;
          cReport('link-mark: added after the card — ' + (_linkReady ? (_cardKept ? 'card kept ✅' : 'card LOST') : 'no card') + ' · the link stays visible in the text', _linkReady && !_cardKept ? 'warn' : 'info');
        } catch (e) { cReport('link-mark: could not be added (' + ((e && e.message) || e) + ') — Facebook may hide the link behind its card', 'warn'); }
      }

      // ── C-Safe · the permalink belongs to the CARD, not to the text ───────
      //
      // A native Facebook share shows the card and whatever the sharer wrote.
      // Ours showed the raw permalink above it, because on this path the url in
      // the text IS what makes the card. Once the card exists it is an
      // attachment in its own right, so the url has done its job.
      //
      // 🔑 Verified live in a real group composer before a line of this was
      // written (the plan refused to allow it otherwise): url alone → card
      // scraped, Post enabled → clear the box → **card survives, Post still
      // enabled** → type the caption → card still there, Post still enabled,
      // stable over seconds. Measured, not assumed.
      //
      // ⛔ Gated on `_linkReady`: no confirmed card, no strip. A post with
      // neither a card nor a link is the one outcome worse than a visible url,
      // and every failure below restores the original body rather than risk it.
      if (_linkReady && _shareStripUrl && inputElement) {
        const _bodyWas = String(inputElement.textContent || '');
        const _rest = _stripCardUrlFromComposerText(_bodyWas, _shareStripUrl);
        if (_rest !== _bodyWas.trim()) {
          reportStep('Removing the link from the post text');
          _cmtClear(inputElement);
          await sleep(1);
          let _restored = false;
          let _ok = _rest ? await _cmtInsertVerified(inputElement, _rest) : true;
          if (!_ok) {
            await _cmtInsertVerified(inputElement, _bodyWas);
            _restored = true;
            cReport('share-url-strip: the caption would not go back in — kept the original text (the url stays visible)', 'warn');
          } else if (!_linkCardPresent(_lpScope)) {
            _cmtClear(inputElement);
            await sleep(1);
            await _cmtInsertVerified(inputElement, _bodyWas);
            _restored = true;
            cReport('share-url-strip: the card did not survive the edit — restored the url', 'warn');
          }
          if (!_restored) {
            cReport('share-url-strip: the permalink is in the card now, not in the text ✅' +
                    (_rest ? ' (caption kept)' : ' (no caption — the card is the post)'), 'info');
          }
        }
      }
    }

    // Natural pre-submit delay — simulates human reviewing the post before submitting.
    // With plain setTimeout, these fire at real wall-clock time (Web Lock prevents 60s throttling).
    // Background (hidden): 8–12s. humanDelay is skipped in background so this is the only wait.
    // Foreground (visible): 2–4s. humanDelay(pre_submit) adds another 0.5–1.5s on top.
    // Total background target: ~25–30s. Total foreground target: ~21–25s.
    {
      // LAYER 2 (v10): document.hidden is always false with ISOLATED world override.
      // Use isTabActuallyFocused() for real state: longer delay when truly in background
      // to give Facebook time to process, shorter in foreground.
      reportStep('Preparing to publish');   // the humanized pre-submit wait — ours, not Facebook's
      // v2026-10-14 · the editor's shape right before Post: Facebook stores a paragraph as an empty line ("\n\n") and folds
      // a link post at its first empty line in the feed — this says whether the post went in as lines or paragraphs.
      try {
        const _ed = (inputElement && inputElement.isConnected ? inputElement : null) || document.querySelector('[role="dialog"] [data-lexical-editor="true"]');
        if (_ed) cReport('editor-shape: paragraphs=' + _ed.querySelectorAll('p').length + ' line-breaks=' + _ed.querySelectorAll('br').length + ' empty-paragraphs=' + Array.from(_ed.querySelectorAll('p')).filter((p) => !(p.textContent || '').replace(/[\u200B\u3164\s]/g, '')).length, 'info');
      } catch (_) {}
      const _actuallyFocused = await isTabActuallyFocused();
      const _preSubmitMs = _actuallyFocused
        ? Math.round(1500 + Math.random() * 1500)   // 1.5–3s foreground
        : Math.round(3000 + Math.random() * 3000);  // 3–6s background
      cLog(`[inject] pre-submit natural delay: ${_preSubmitMs}ms (focused=${_actuallyFocused})`);
      await sleepMs(_preSubmitMs);
    }
    // v2 spec: STOP check immediately before publishing — a user "Stop" must never
    // result in a post going out. Reads the existing `_stopRequested` storage flag.
    if (await isDomStopRequested()) {
      cReport('stopped: user requested STOP before submit — aborted without posting (not a bug)', 'info');
      // v2026-10-12 · its own name: nothing was submitted, so a restart may send this group (live QA: the generic
      // 'stopped' kept its same-post mark and the restart skipped a group that never got the post).
      await new Promise((resolve) => chrome.storage.local.set({ operationDone: "failed", operationFailReason: "stopped-before-submit" }, resolve));
      return false;
    }
    // v2 spec FINAL wrong-target guard: never publish from a comment/DM/article/
    // messaging context — fail-closed even if detection slipped earlier.
    if (_isForbiddenComposerContext(liveComposerEditor(inputElement))) {
      cReport('wrong-target: SECURITY abort — the composer resolved to a forbidden context (DM/comment/article), not a group post box. Not publishing.', 'error');
      await new Promise((resolve) => chrome.storage.local.set({ operationDone: "failed", operationFailReason: "wrong-target" }, resolve));
      return false;
    }
    // B: never post anonymously — force the anonymous toggle OFF before submit.
    try { await ensureNotAnonymous(); } catch (_) {}
    await humanDelay(currentHumanizationContext.level ?? 1, "pre_submit");
    // v31: VIDEO focus-keeper — bring the Safe window to the FRONT and HOLD it there through the
    // publish + upload (~60-120s). Video needs SUSTAINED paint to confirm; an unfocused window stops
    // painting → the publish never confirms (the 121s-freeze the user hit). Text/image are quick so
    // v30's create-focused already covers them — this arms ONLY for video. Pure window focus (no
    // network/audio): the SW 'stay' mode keeps the window front WITHOUT restoring the user's tab.
    const _isVideoPost31 = (video_ids && video_ids.length > 0) || _safeHasVideoFlag;
    let _vidKeeper31 = null;
    const _pingFront31 = () => { try { chrome.runtime.sendMessage({ action: 'requestTabFocus', stay: true }, () => { void chrome.runtime.lastError; }); } catch (e) {} };
    const _stopVidKeeper31 = () => { if (_vidKeeper31) { clearInterval(_vidKeeper31); _vidKeeper31 = null; try { cReport('video focus-keeper OFF — upload/publish done', 'info'); } catch (e) {} } };
    if (_isVideoPost31 && _safeMode) {
      _pingFront31();                                  // front it NOW for the Post click + first paint
      _vidKeeper31 = setInterval(_pingFront31, 4000);  // hold the front every 4s through upload+publish
      try { cReport('video focus-keeper ON — holding the window in FRONT through upload+publish (so FB renders & the post confirms)', 'info'); } catch (e) {}
    }
    reportStep('Publishing the post');
    try { _scPreSubmitCmtBtns = new Set(document.querySelectorAll('[data-ad-rendering-role="comment_button"]')); } catch (_) { _scPreSubmitCmtBtns = null; }
    _preSubmitPosts = _snapshotPostsBeforeSubmit();
    // v2026-10-19 · page text that already said "pending" BEFORE Post (an admin's chrome, a rule) can never decide
    // early below — only a notice that appears after our click can. Unreadable = assume it was there (no early path).
    const _pagePendingBeforeClick = _pendingBeforeClick(html);
    cLog('[inject] clickPostButton: calling clickPostButtonWithRetry');
    const clickedPost = await clickPostButtonWithRetry?.();
    cLog('[inject] clickPostButton: result:', clickedPost);
    if (!clickedPost) {
      cLog("[inject] Post button click FAILED");
      await new Promise((resolve) => {
        chrome.storage.local.set({ operationDone: "failed" }, resolve);
      });
      return false;
    }

    // Wait for Facebook's UI to start processing the click before we poll.
    // The dialog close animation takes 300-500ms; the button DOM node stays alive
    // for another 200-400ms after that. Using 2000ms (same as competitor) gives
    // the full cycle time to complete before we check whether the button is gone.
    // 900ms was too short — first poll would see button still present → false fail.
    await sleepMs(2000);

    cLog('[inject] waitForPostCompletion: starting');
    // SPRINT-19: video posts need up to 120s — Facebook encodes the video server-side after upload.
    // Image posts keep 30s which is plenty.
    // v19: RESTORE the generous video wait. v15 cut this to 15s on the theory that the dialog stays
    // open during server-side encoding — but in practice FB closes the dialog (and renders the
    // permalink) when it ACCEPTS the post (~when the upload finishes), often 1–2 min in. The 15s
    // timeout gave up before that → the post was real but we reported failure. waitForPostCompletion
    // polls every 500ms and RETURNS EARLY the instant it confirms, so a generous cap costs nothing
    // when the post is quick, and is patient when the upload is slow.
    const _postCompletionMax = (video_ids.length > 0 || _safeHasVideoFlag) ? 120000 : 30000;
    _mgpPostBlockedNotice = false;
    let postCompleted = await waitForPostCompletion?.(500, video_ids, clickedPost, _postCompletionMax); // v2026-10-11: let — see the settle loop
    cLog('[inject] waitForPostCompletion: result:', postCompleted);
    if (!postCompleted && _mgpPostBlockedNotice) {
      // v2026-10-12 · Facebook answered with its block notice — reported 'post-blocked' already; no more waiting
      await new Promise((resolve) => { chrome.storage.local.set({ operationDone: "failed", operationFailReason: "post-blocked" }, resolve); });
      chrome.runtime.sendMessage({ action: 'closeMyTab' }).catch(() => { try { window.close(); } catch (e) {} });
      return false;
    }
    if (!postCompleted) {
      if ((video_ids && video_ids.length > 0) || _safeHasVideoFlag) {
        // v12 lenient (video): the Post WAS clicked; the dialog-close confirm can lag in a
        // backgrounded tab. Don't fail — fall through to the size-based upload wait below.
        cLog("[inject] waitForPostCompletion unconfirmed for video — continuing to size-based wait (lenient)");
      } else {
        // v23 (B2): a throttled BACKGROUND tab can miss the dialog-close confirm within 30s even though
        // the Post button was clicked and the post will land. Don't hard-fail yet — give ONE more lenient
        // settle poll (~15s) to catch a late landing. Only declare failure if STILL unconfirmed.
        cLog("[inject] waitForPostCompletion timed out — extra lenient settle before failing (B2)");
        const _late = await waitForPostCompletion?.(700, video_ids, clickedPost, 15000);
        if (!_late) {
          // v2026-10-13 · engine log only; the worker reports the post once, after looking for it in the group
          cReport('timeout-no-completion: text/image post not confirmed after 30s + 15s settle — reporting failure (campaign continues)', 'warn');
          _holdUnconfirmedReport('timeout-no-completion: text/image post not confirmed after 30s + 15s settle');
          await new Promise((resolve) => {
            chrome.storage.local.set({ operationDone: "failed", operationFailReason: "timeout-no-completion" }, resolve); // v23 (M7): concrete reason, not generic dom-failed
          });
          chrome.runtime.sendMessage({ action: 'closeMyTab' }).catch(() => {
            try { window.close(); } catch(e) {}
          });
          return false;
        }
        cLog("[inject] late confirm — post landed during the B2 settle; continuing to verify/capture");
      }
    }
    // VIDEO publish wait (AFTER Post): the composer closed = FB accepted the submission, but for a
    // video Facebook now uploads the 32MB to the post (a progress bar). Wait for it to clear — THIS
    // is where the upload actually completes (mirrors the competitor's x()+~480s, content.js:1186).
    // Without it we'd report success while the video is still uploading → it never lands.
    // (|| _safeHasVideoFlag: scheduled video rides in image_ids, so video_ids is empty here.)
    if (((video_ids && video_ids.length > 0) || _safeHasVideoFlag) && !postCompleted) {
      // v19: only run the size-based wait as a FALLBACK — when waitForPostCompletion did NOT confirm.
      // If the post WAS confirmed (dialog closed = FB accepted = bytes received), skip this entirely
      // and go straight to the settle/permalink capture (no redundant double-wait → faster).
      // v12 HYBRID: close on the FIRST of (a) the progress bar clearing = upload finished (adaptive —
      // fast), or (b) a conservative SIZE-BASED time cap/fallback (safe when the bar can't be read in
      // the background). No focus/audio/keeper either way. Lenient.
      await waitForVideoUpload(_safeVideoBytes);
      // Still honor a HARD FB rejection alert if one happens to be visible (never fail on timeout).
      let _failAlert = null;
      try {
        _failAlert = _findPublishFailureAlert();
      } catch (e) {}
      if (_failAlert) {
        cReport('video-publish-failed: FB reported "' + (_failAlert.textContent || '').trim().slice(0, 60) + '" — campaign continues', 'error');
        await new Promise((resolve) => { chrome.storage.local.set({ operationDone: "failed", operationFailReason: "video-publish-failed" }, resolve); });
        chrome.runtime.sendMessage({ action: 'closeMyTab' }).catch(() => { try { window.close(); } catch (e) {} });
        return false;
      }
      cReport('video: publish assumed complete ✅ (size-based wait)', 'info');
    }
    _stopVidKeeper31?.();  // v31: upload/publish done → release the video focus-keeper (the post has landed; the settle below can read the permalink while the window is still front)
    // ── SETTLE PHASE (Safe/DOM only — 100% DOM, NO network) ───────────────────
    // The post SUCCEEDED, but the success toast / pending notice / freshly-posted article
    // (carrying the permalink) render a beat LATER. The MessageChannel rAF pump keeps the
    // occluded window's DOM updating at full speed WITHOUT any front-pop, so we just POLL the
    // DOM up to ~12s: pending (detectPendingApproval) wins → else the exact permalink
    // (getExactPostPermalink) → after ~5s, ONE hover-reveal pass (Comet's lazy timestamp href)
    // → after ~6s with still nothing, the one-time focus-rescue safety net (at most one pop per
    // post, only if the pump didn't keep this page state current). No network read.
    let _capturedPermalink = null;
    let _pendingApproval = false;
    let _pagePendingSeen = false;
    let _pendingWhy = null;     // v2026-10-19 · { source: 'surface'|'page', phrase } — sent with the result (no text)
    let _pendingOwnSkipped = null;
    try {
      const _settleStart = Date.now();
      // v19: VIDEO gets a GENEROUS ~90s settle = the verification window. FB renders the fresh post's
      // permalink (or pending notice) ~1–2 min AFTER publish (observed live: a successful video's
      // permalink appeared ~2 min in). The v16 15s window gave up too early → real posts reported as
      // video-verify-failed. The loop RETURNS EARLY the instant the permalink/pending appears, so a
      // quick post isn't slowed. We still REQUIRE the signal before success (no false positives).
      const _isVid = (video_ids && video_ids.length > 0) || _safeHasVideoFlag;
      // v2026-10-13 · Liran (live): "the posting window got stuck for no reason". A CONFIRMED video post (the composer
      // closed = Facebook accepted it; v20 counts that as success) sat ~90 s more, only hunting its permalink, with
      // nothing on screen saying why. Confirmed → the same 12 s as a photo, longer ONLY while Facebook's own upload bar
      // is still filling (bytes still going — closing then would cut the video). Unconfirmed → the 90 s verification stays.
      const _SETTLE_BASE_MS = 12000, _SETTLE_VIDEO_MS = 90000;
      // A big video keeps the window at least as long as its bytes need at this connection (GPP waits up to 480 s
      // while any loader shows) — even if Facebook closed its composer early. A small one: the 12 s.
      let _vidFloorMs = _SETTLE_BASE_MS;
      try { if (_isVid) _vidFloorMs = Math.min(_SETTLE_VIDEO_MS, Math.max(_SETTLE_BASE_MS, Math.round((Number(_safeVideoBytes) || 0) / _estUploadBps() * 1000))); } catch (_) {}
      let _settleDeadline = _settleStart + (_isVid && !postCompleted ? _SETTLE_VIDEO_MS : _vidFloorMs);
      const _vidBytesGoing = () => { try { const p = _getVideoUploadPercent(); return p >= 0 && p < 99; } catch (_) { return false; } };
      let _uploadNoted = false;
      reportStep('Finishing the post');   // the screen says what this wait is (it used to show "Publishing" all along)
      let _polls = 0, _hoverTries = 0;
      const _HOVER_AT_MS = [1500, 5000, 9000];   // v2026-10-13 · was once, at 5 s
      let _pageRun = 0, _pageRunSince = 0;      // v2026-10-19 · consecutive polls with NEW page pending text
      // v2026-10-11 · a LATE close counts. postCompleted was decided once, after the 120 s cap, and this
      // 90 s settle never looked again — a video whose composer closed in here (Facebook accepted it)
      // still ended as video-verify-failed: 325 group posts, 16 users in 9 days. Button gone AND its
      // dialog gone = the strongest close there is (a re-rendered button leaves its dialog in place).
      const _lateClosed = () => {
        try {
          if (!clickedPost || !(postButtonDOM instanceof Element) || document.body.contains(postButtonDOM)) return false;
          const _dlg = postButtonDOM.closest('[role="dialog"]');
          return !_dlg || !document.body.contains(_dlg);
        } catch (_) { return false; }
      };
      while (Date.now() < _settleDeadline) {
        _polls++;
        if (!postCompleted && _lateClosed()) {
          postCompleted = true;
          _postLanded = true;
          try { chrome.storage.local.set({ _postConfirmedAt: Date.now() }); } catch (e) {}
          cReport('post-confirmed-late: the composer closed during the settle (FB accepted it) — elapsed=' + (Date.now() - _settleStart) + 'ms', 'info');
          _settleDeadline = Math.min(_settleDeadline, Date.now() + _vidFloorMs);   // accepted → only the link (and a big video's bytes) left
        }
        if (_isVid && postCompleted && _vidBytesGoing()) {
          if (!_uploadNoted) { _uploadNoted = true; reportStep('Uploading the video to Facebook'); cReport('video: accepted, Facebook still uploading (' + _getVideoUploadPercent() + '%) — the window stays until the bar is full', 'info'); }
          _settleDeadline = Math.min(_settleStart + _SETTLE_VIDEO_MS, Math.max(_settleDeadline, Date.now() + 3000));
        }
        // v2026-10-19 · only Facebook's own toast/dialog decides at once. Page text alone is weaker evidence: it waits
        // for the end of the settle, and our post's own permalink (= it is live) outranks it.
        const _pdOut = {};
        const _pd = detectPendingApproval(html, true, _pdOut);
        if (_pdOut.ownSkipped && !_pendingOwnSkipped) _pendingOwnSkipped = _pdOut.ownSkipped;
        if (_pd && (!_pendingWhy || _pd === 'surface')) _pendingWhy = { source: _pd, phrase: _pdOut.phrase || null };
        if (_pd === 'page') _pagePendingSeen = true;
        // v2026-10-19 · Liran: a real pending post waited the full 12 s. Facebook's toast right after Post already said so;
        // and a "pending" notice that was NOT on the page before our click, seen steadily (3 polls, 1.5 s), is Facebook's
        // answer to this post. Our post's link still wins whenever it shows first.
        if (_pd === 'page') { if (!_pageRunSince) _pageRunSince = Date.now(); _pageRun++; } else { _pageRun = 0; _pageRunSince = 0; }
        const _early = _earlyPendingDecision({ pd: _pd, toastPending: _confirmToastPending, beforeClick: _pagePendingBeforeClick,
          run: _pageRun, since: _pageRunSince, now: Date.now(), hovered: _hoverTries, hasLink: () => !!getExactPostPermalink(html) });
        if (_early) {
          _pendingApproval = true;
          _pendingWhy = { source: _early, phrase: _early === 'page_new' ? (_pdOut.phrase || null) : null };
          try { chrome.storage.local.set({ _postPendingAt: Date.now() }); } catch (e) {}
          cReport(_early === 'toast' ? "settle: pending from Facebook's toast after Post" : 'settle: pending from a new notice on the page (not there before Post)', 'info');
          break;
        }
        if (_pd === 'surface') {
          _pendingApproval = true;
          // v1.2.9.66: publish it immediately, like _postConfirmedAt. `pending`
          // otherwise travels ONLY inside _postMeta, which is written together
          // with operationDone:'successful' — so every path that ends any other
          // way (the worker's timeout, the confirmed-but-late overrule) reported
          // the post as a plain success and dropped the queue state on the floor.
          try { chrome.storage.local.set({ _postPendingAt: Date.now() }); } catch (e) {}
          break;
        }
        const _pl = getExactPostPermalink(html);
        if (_pl) { _capturedPermalink = _pl; break; }
        // Lazy-href rescue: reveal the post's timestamp link (focus) at 1.5 s, 5 s and 9 s without a permalink.
        if (_hoverTries < _HOVER_AT_MS.length && (Date.now() - _settleStart) > _HOVER_AT_MS[_hoverTries]) {
          _hoverTries++;
          const _ph = await _hoverRevealPermalink(html);
          if (_ph) { _capturedPermalink = _ph; break; }
        }
        // v27: SMART safety net. The window pops to front ONCE only when the post is genuinely STUCK —
        // i.e. !postCompleted (the composer never closed). RESEARCH-BACKED: a CONFIRMED post (composer
        // closed = FB accepted) never needs the pop — the permalink is optional metadata (we fall back to
        // the group url). So a confirmed text/image/video post NEVER pops. Only a stalled post (occluded
        // window → Chrome suspended paint → the ONLY in-page un-stick is to un-occlude via a front-pop)
        // gets one nudge. Video waits longer (18s) before deciding "stuck" — it legitimately needs upload
        // time; text/image use 6s. (occlusion is a browser law: covered windows can't paint — proven.)
        const _rescueAfter = _isVid ? 18000 : 6000;
        if (!_rescuedOnce && !postCompleted && (Date.now() - _settleStart) > _rescueAfter) {
          await _rescueFocusOnce(_isVid ? 'video not confirmed after 18s — one paint-nudge (un-occlude)' : 'no permalink/pending after 6s (post unconfirmed)');
        }
        // MutationObserver-bounded wait (NOT a blind sleepMs, which Chrome throttles to ~1/s in
        // an occluded window): resolves the instant the pending notice OR the permalink renders,
        // else after ~600ms — so we catch the signal as soon as the DOM updates.
        await _cmtWaitFor(() => (detectPendingApproval(html, true) === 'surface' || getExactPostPermalink(html)) ? true : null, document.body, 600);
      }
      // Final reads (catch a signal that appeared on the very last tick). Our post's permalink first: a post whose own
      // link shows is live, whatever else the page says.
      if (!_pendingApproval && !_capturedPermalink) _capturedPermalink = getExactPostPermalink(html);
      if (!_pendingApproval && !_capturedPermalink) {
        const _finOut = {};
        const _fin = detectPendingApproval(html, true, _finOut);
        if (_finOut.ownSkipped && !_pendingOwnSkipped) _pendingOwnSkipped = _finOut.ownSkipped;
        if (_fin && !_pendingWhy) _pendingWhy = { source: _fin, phrase: _finOut.phrase || null };
        if (_fin || _pagePendingSeen) {
          _pendingApproval = true;
          try { chrome.storage.local.set({ _postPendingAt: Date.now() }); } catch (e) {}
          cReport('settle: pending from the ' + (_fin === 'surface' ? "notice" : "page text") + ' (no permalink of our post showed)', 'info');
        }
      }
      // v52: REMOVED the v51 "structural pending fallback" (no-permalink + a visible
      // surface → pending). It mislabeled SUCCESSFUL posts as pending: a FB success
      // toast is also a "surface", and Safe commonly succeeds without an exact
      // permalink ("using group url"). Pending is detected by the multilingual text
      // (detectPendingApproval) / the Fast API field — there is no reliable STRUCTURAL
      // way to tell pending from success-without-permalink, so we default to success.
      cReport('settle: ' + _polls + ' polls → ' + (_pendingApproval ? 'PENDING' : (_capturedPermalink ? 'permalink ' + _capturedPermalink : 'no exact permalink (using group url)')), 'info');
    } catch (_settleErr) {
      cReport('settle: error (continuing) — ' + (_settleErr && _settleErr.message ? _settleErr.message : String(_settleErr)), 'warn');
    }
    if (_pendingApproval) cReport('post-pending-approval: submitted but awaiting admin approval', 'info');

    // ── v16: VIDEO VERIFICATION — never report a false success ───────────────────────────────────
    // A real video post yields a real permalink (/posts/…) OR a pending-approval notice. If, after the
    // 15s settle, NEITHER rendered, the post did NOT land — typically because the posting window was
    // COVERED (Chrome stops painting a covered window → the upload/post can't complete). Report FAILED
    // so the user sees the truth (the campaign continues to the next group). Text/image are unaffected.
    {
      // v20: SUCCESS if ANY of: a real permalink, a pending-approval notice, OR the composer editor
      // closed (postCompleted = FB accepted — the competitor's success criterion, works even before the
      // virtualized permalink renders). If NONE → the video did NOT land → FAILED (Safe mode then fails
      // this over to Fast/GraphQL in the SW). Text/image unaffected.
      const _isVideoPost = (video_ids && video_ids.length > 0) || _safeHasVideoFlag;
      if (_isVideoPost && !_pendingApproval && !_capturedPermalink && !postCompleted) {
        // v2026-10-13 · engine log only; the worker reports the post once, after looking for it in the group.
        // (No failover follows: 'video-verify-failed' is not a not-sent reason — Post was clicked.)
        cReport('video-verify-failed: composer did not close, no permalink, not pending — Facebook did not confirm the video. Campaign continues.', 'warn');
        _holdUnconfirmedReport('video-verify-failed: composer did not close, no permalink, not pending');
        await new Promise((resolve) => { chrome.storage.local.set({ operationDone: "failed", operationFailReason: "video-verify-failed" }, resolve); });
        chrome.runtime.sendMessage({ action: 'closeMyTab' }).catch(() => { try { window.close(); } catch (e) {} });
        return false;
      }
      if (_isVideoPost && postCompleted && !_capturedPermalink && !_pendingApproval) {
        cReport('video: composer closed = FB accepted the post ✅ (competitor criterion — permalink renders later)', 'info');
      }
    }

    // v86 (Part B2): the text/image "using group url" weak-success (no permalink, no
    // pending → defaults to SUCCESS above) — but if FB ALSO shows a BLOCK banner here, the
    // post was blocked, not posted. Symmetric to Part B (the linger path). Match the NARROW
    // _FB_BLOCK_RE only → report FAILED. dup-safe: 'post-blocked' is NOT in the failover
    // allowlist (sw _notSent) → maybe-landed → NO re-post; never a success/pending phrase.
    // Rarer than the linger case (reached when the composer closed = usually accepted).
    if (!_capturedPermalink && !_pendingApproval) {
      const _settleNotice = _visibleNoticeText();
      // v77: _isBlockNotice widens the English regex with non-English phrasing
      // taken verbatim from customer logs. Only exact known block strings decide
      // here — the structural heuristic reports but never fails a post.
      if (_isBlockNotice(_settleNotice)) {
        // v2026-09-12: 'warn' never reached Sentry (only 'error' is relayed), yet
        // this line DECIDES a failure. Distinct label per site — the relay
        // fingerprints on the text before the first colon, so a shared
        // "post-blocked:" prefix would collapse the settle path and the linger
        // path into one issue. The customer-visible log is unchanged: the relay
        // maps 'error' back to 'warn' for engineLog.
        cReport('post-blocked-settle: settle found a block banner with no permalink/pending — "' + _settleNotice.slice(0, 80) + '" (reporting failed → Safe maybe-landed, no re-post)', 'error');
        await new Promise((resolve) => { chrome.storage.local.set({ operationDone: "failed", operationFailReason: "post-blocked" }, resolve); });
        chrome.runtime.sendMessage({ action: 'closeMyTab' }).catch(() => { try { window.close(); } catch (e) {} });
        return false;
      }
    }

    // FIRST COMMENT is now a FAST-only feature (the popup UI hides it in Safe + omits
    // commentText): a DOM comment needs the feed fully rendered, which isn't reliable in a
    // background window, so we don't attempt it in Safe at all — keeps Safe simple + fast and
    // avoids the one render-dependent step we can't guarantee. (Fast posts the comment via
    // GraphQL CommentCreateMutation, which is reliable.) The `_safeMode` guard also future-
    // proofs any non-safe DOM path. A pending post isn't in the feed yet → skip cleanly too.
    // v2026-10-15 · Safe has its first comment back (Liran), by the page itself: safeFirstCommentDom — scored, one
    // submit, a receipt, and nothing typed unless the post and the box are proven ours. Since 13-Oct the fresh post is
    // found in the Safe window (above the feed) on every post, which is what the old "not reliable" note was about.
    let _commentResult = { commented: false, reason: 'not-attempted' };
    if (!commentText || !String(commentText).trim()) {
      _commentResult = { commented: false, reason: 'no-comment' };
    } else if (_pendingApproval) {
      cReport('comment: skipped — post pending admin approval (cannot comment yet)', 'info');
      _commentResult = { commented: false, reason: 'pending' };
    } else if (_safeMode && !_safeCommentOn) {
      // the remote switch is off: nothing typed here — the worker gives the comment to the comment queue
      _commentResult = { commented: false, submitted: false, reason: 'fast-only', handoff: true };
    } else {
      reportStep('Adding first comment');
      try { _commentResult = (await safeFirstCommentDom(commentText, html, _capturedPermalink)) || _commentResult; } catch (_) {}
    }

    // v2026-08-09: write operationDone:'successful' BEFORE the humanization
    // break, not after. content.js's own watchdog (fires at timeoutSec-8s)
    // only checks this storage key — it has no idea the break below exists.
    // With the break running first, a slow one could outlast the watchdog's
    // remaining budget and get an ALREADY-SUCCESSFUL post mislabeled
    // 'post-confirm-timeout'. This exact bug was found + fixed the same way
    // in the sister codebase (Documents/.../Lead Radar Copy) — confirmed live
    // via Sentry+Amplitude there before porting here. The tab still lingers
    // for its human-like pause below before actually closing (unchanged
    // behavior); it just no longer holds the success signal hostage.
    // BUG-02 (pre-existing): Include postUrl + groupName so background can
    // attach them to postsCompleted.
    await new Promise((resolve) => {
      chrome.storage.local.set({
        operationDone: "successful",
        _postMeta: { postUrl: _capturedPermalink || window.location.href, groupName: document.title || '', pending: _pendingApproval, comment: _commentResult,
          // v2026-10-19 · the diagnosis of a "pending" (or a page hint our own permalink overruled) — list phrases only
          pendingCheck: (_pendingWhy || _pendingOwnSkipped) ? { result: _pendingApproval ? 'pending' : 'live', source: _pendingWhy ? _pendingWhy.source : null, phrase: _pendingWhy ? _pendingWhy.phrase : null, ownSkipped: _pendingOwnSkipped, overruledByLink: !!(_pendingWhy && !_pendingApproval && _capturedPermalink) } : null },
      }, resolve);
    });
    cLog('[inject] operationDone: successful — running post-success pacing before tab close');

    try {
      await applyPeriodicBreakIfNeeded(
        currentHumanizationContext.profile,
        currentHumanizationContext.postNumber
      );
    } catch (breakError) {
      console.warn("[humanization] Break routine failed:", breakError);
    }

    cLog('[inject] requesting tab close');
    // Ask background to close this tab. If background is stopped/busy, fall back to window.close().
    chrome.runtime.sendMessage({ action: 'closeMyTab' }).catch(() => {
      try { window.close(); } catch(e) {}
    });

    return true;
  } catch (error) {
    console.error("injectIntoComposer failed:", error);
    cReport('inject-exception: ' + (error?.message || String(error)) + _errLoc(error), 'error');
    // BUG-08: Signal failure so background doesn't poll for 120 s with no answer
    await new Promise((resolve) => { chrome.storage.local.set({ operationDone: "failed", operationFailReason: "inject-exception" }, resolve); });
    return false;
  }
}

async function waitForPostCompletion(interval = 500, snapShotId, clickedPost, maxWaitMs = 30000) {
  // interval kept for API compat — MutationObserver replaces polling so it is unused.
  // MutationObserver fires immediately on any DOM change regardless of tab visibility,
  // eliminating the 38–58s delay caused by Chrome throttling setTimeout in background tabs.
  return new Promise((resolve) => {
    const start = Date.now();
    // BUG-FIX: Detect if composer dialog is gone — needed to distinguish a
    // successful post submission from the dialog closing due to an error.
    const composerDialog = postButtonDOM?.closest?.('[role="dialog"]') || null;
    // Snapshot every dialog that exists RIGHT NOW (before clicking Post).
    // Only dialogs that appear AFTER this snapshot can be confirmation dialogs.
    // Pre-existing dialogs (e.g. Facebook notification panel with an "All" button) are excluded.
    const _dialogsAtStart = new Set(document.querySelectorAll('[role="dialog"]'));
    // v2026-10-19 (audit F7) · an alert that was already there ("There was a problem loading comments") is not about
    // our post; only one that appeared after the click can fail it
    const _alertsAtStart = new Set(document.querySelectorAll('[role="alert"], [data-testid="snackbar"], [data-testid="toast"]'));
    let settled = false;
    let observer = null;
    let timeoutHandle = null;
    let dialogLingerHandle = null; // wakeup timer for dialog-linger path
    let _confirmClicked = false;   // one-shot guard: click confirmation button at most once

    let pollingHandle = null; // backup setTimeout poll
    let _flashFocusRequested = false; // LAYER 3 (v10): one-shot flash-focus guard

    const finish = (success) => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      clearTimeout(timeoutHandle);
      clearTimeout(dialogLingerHandle);
      clearInterval(pollingHandle);
      if (success) {
        const elapsed = Date.now() - start;
        cLog('[waitForPost] SUCCESS — post completed');
        logTelemetry('post_completed', { elapsed }, 'INFO');
        chrome.runtime.sendMessage({ action: "schedulePostDone", snapShotId }).catch(() => {});
        // The post has LANDED. Everything after this point is enrichment, and a
        // slow settle/permalink/comment must never turn a landed post into
        // 'post-confirm-timeout'. All four post-confirmed sites route through
        // finish(true), so this one line covers every one of them.
        _postLanded = true;
        // v1.2.9.59: the same fact, in STORAGE, because the service worker cannot
        // see the line above — _postLanded is a variable in this tab's memory.
        // Without it the worker's own timeout wrote 'failed' on a post Facebook
        // had accepted, then closed the window and killed this tail before it
        // could write 'successful'. ⛔ Still NOT operationDone — see RACE FIX.
        try { chrome.storage.local.set({ _postConfirmedAt: Date.now() }); } catch (e) {}
        // RACE FIX: do NOT write operationDone here. injectIntoComposer writes
        // operationDone:'successful' (with _postMeta.comment) AFTER the first-comment
        // pipeline. Writing it here let the worker close the window mid-comment —
        // that's why the log showed 'comment: attempting' with no outcome. Only resolve.
        resolve(true);
      } else {
        // v85 (B2): record the final detector state alongside the snapshot. dialogOpen +
        // buttonGone + the FB notice text (in _domFailSnapshot) together separate the three
        // root causes that otherwise log identically: FB BLOCK (dialogOpen, buttonGone,
        // notice="isn't available"/"unusual activity") vs missed-success (notice="posted")
        // vs a silent paint-stall (dialogOpen, !buttonGone, no notice).
        const _btnGone = !!(clickedPost && postButtonDOM instanceof Element && !document.body.contains(postButtonDOM));
        const _dlgOpen = !!(composerDialog && document.body.contains(composerDialog));
        // v2026-09-12: level raised from 'warn' to 'error' — DIAGNOSTIC ONLY, no
        // behaviour change. The relay in mgp-service-worker.js (content_debug_log)
        // forwards to Sentry ONLY when level === 'error', so this line — the single
        // report carrying the two fields that separate the causes of an unconfirmed
        // post (dialogOpen / buttonGone) — never left the customer's machine. What
        // did reach us, `timeout-no-completion`, is a fixed sentence with nothing to
        // diagnose: 30 events / 6 users, and no way to tell "the composer never
        // closed" from "the button node survived the re-render" from "the post
        // actually landed".
        // ⛔ The user-visible log is UNCHANGED: the same relay maps 'error' back to
        // 'warn' for engineLog, so this prints exactly as before. And the payload is
        // not a new class of data — composer-open-failed already ships the identical
        // _domFailSnapshot() text at error level.
        // v2026-09-15: ONE Sentry event per unconfirmed post. A text/image post waits twice (30 s,
        // then the lenient 15 s settle) and sent this at 'error' both times — every failure was
        // two events in Sentry plus its timeout-no-completion. The second wait of the same post
        // reports at 'warn': the engine log keeps it, Sentry gets it once.
        // v2026-10-13 · always 'warn' here (engine log); the first one of the post is held for the worker
        // (_holdUnconfirmedReport), which sends it to Sentry only if the post is not in the group either.
        _postUnconfirmedSent = true;
        const _unconfirmedMsg = 'post-unconfirmed: could not confirm publish after ' + Math.round((Date.now() - start) / 1000) + 's — dialogOpen=' + _dlgOpen + ' buttonGone=' + _btnGone + ' · ' + _postClickFacts() + ' · via=' + (_postBtnVia || '?') + (_postBtnEscapeHatch ? ' escape-hatch=yes' : '') + ' (' + (_safeHasVideoFlag ? 'video' : 'text/image') + ' · last step: ' + (_lastStepLabel || '?') + '). On-screen: ' + _domFailSnapshot();
        cReport(_unconfirmedMsg, 'warn');
        _holdUnconfirmedReport(_unconfirmedMsg);
        // Record the reason only (NOT operationDone) — injectIntoComposer writes
        // operationDone:'failed' on !postCompleted; storage.set merges so the reason survives.
        chrome.storage.local.set({ operationFailReason: "post-unconfirmed" }, () => resolve(false));
      }
    };

    const evaluate = () => {
      if (settled) return;
      const elapsed = Date.now() - start;

      // FIX G: Handle confirmation dialogs after clicking Post (e.g. "Anonymous post" confirmation).
      // KEY BUG FIX: We search ALL dialogs, not just the first one.
      // The confirmation dialog is the SECOND [role="dialog"] in the DOM — the first is the composer.
      // Also language-agnostic: instead of matching "Create anonymous post" (English only),
      // we find the primary (non-cancel) button in any non-composer dialog.
      if (!_confirmClicked && composerDialog && document.body.contains(composerDialog)) {
        const _allDlgs = document.querySelectorAll('[role="dialog"]');
        // Diagnostic: log dialog counts on first call (elapsed < 100ms)
        if (elapsed < 100) {
          cLog(`[waitForPost] dialogs in DOM: ${_allDlgs.length} | pre-existing (skip): ${_dialogsAtStart.size} | composerInDOM: true`);
        }
        for (const _dlg of _allDlgs) {
          if (_dlg === composerDialog || !document.body.contains(_dlg)) continue;
          // Skip dialogs that existed BEFORE we clicked Post — they are not confirmation dialogs.
          // (e.g. Facebook notification panel, audience filter panel with an "All" button)
          if (_dialogsAtStart.has(_dlg)) continue;
          // This dialog appeared AFTER Post was clicked.
          const _cancelRE = /^\s*(cancel|close|back|dismiss|not now|ביטול|סגור|חזור)\s*$/i;
          // B (never anonymous): if this is an anonymous-post confirmation, REFUSE to
          // confirm it — click Cancel if present, else don't click. The post must not
          // go out anonymously.
          if (/anonymous|אנונימי|anónimo|anonyme/i.test(_dlg.textContent || '')) {
            _confirmClicked = true;
            const _cancelBtn = Array.from(_dlg.querySelectorAll('[role="button"]'))
              .find(el => _cancelRE.test((el.textContent || '').trim()));
            cLog('[waitForPost] SECURITY: anonymous-post confirmation — refusing to confirm' + (_cancelBtn ? ' (clicking Cancel)' : ''));
            if (_cancelBtn) { try { _cancelBtn.click(); } catch (e) {} }
            return;
          }
          // v2026-10-12 · Safe confirmation investigation: a dialog that appeared after Post was clicked through blindly —
          // if it was Facebook's BLOCK notice, the click hid it and the post was left "unconfirmed" (the 3-in-a-row block
          // stop never saw it). An exact block phrase is never clicked: reported 'post-blocked' (maybe-landed, never
          // re-sent) so the block streak counts it.
          if (_isBlockNotice(_dlg.textContent || '')) {
            _confirmClicked = true;
            cReport('post-blocked-dialog: Facebook answered the Post with a block notice — "' + String(_dlg.textContent || '').trim().slice(0, 80) + '" (not clicked; reporting failed → maybe-landed, no re-post)', 'error');
            _mgpPostBlockedNotice = true;
            try { chrome.storage.local.set({ operationDone: 'failed', operationFailReason: 'post-blocked' }); } catch (_) {}
            finish(false);
            return;
          }
          const _confirmBtn = Array.from(_dlg.querySelectorAll('[role="button"]'))
            .find(el => {
              const text = el.textContent.trim();
              return text && !_cancelRE.test(text) && el.getAttribute('aria-disabled') !== 'true';
            });
          if (_confirmBtn) {
            _confirmClicked = true; // one-shot: never click another confirmation button this session
            cLog('[waitForPost] Confirmation dialog detected — clicking:', _confirmBtn.textContent.trim().slice(0, 50));
            _confirmBtn.click();
            return; // MutationObserver re-triggers evaluate() when dialog closes
          }
        }
      }

      // BUG-FIX: Only check for loading in a LIVE dialog (one still in the DOM).
      // A detached composerDialog element still has its internal DOM, causing false "loading" hits.
      const liveDialog = (composerDialog && document.body.contains(composerDialog))
        ? composerDialog
        : document.querySelector('[role="dialog"]');
      const isStillLoading = !!(liveDialog && liveDialog.querySelector(
        '[data-visualcompletion="loading-state"], [role="status"] img[src*=".gif"]'
      ));

      const buttonGone = clickedPost && postButtonDOM instanceof Element
        && !document.body.contains(postButtonDOM);

      // Diagnostic: log state on every evaluate() call (throttled to avoid spam)
      if (elapsed < 500 || elapsed % 2000 < 600) {
        cLog(`[waitForPost] evaluate elapsed=${elapsed}ms buttonGone=${buttonGone} loading=${isStillLoading} liveDialog=${!!liveDialog}`);
      }

      // ── LAYER 3 (v10): Flash-focus on prolonged stall ──
      // If the button is STILL present with no loading activity, the click likely didn't
      // trigger React's submission in the background tab. Bring the window front ONCE so
      // React can process the pending state update.
      //
      // v2026-08-15: this was gated on `elapsed > 30000`, but _postCompletionMax for
      // text/image is exactly 30000 — the wait had already timed out by then, so the only
      // rescue covering the settle phase was unreachable for every non-video post. That
      // dead threshold is why the every-2s focus-keeper was introduced instead. Now
      // _SETTLE_RESCUE_MS (6s), and routed through _rescueFocusOnce so it shares the
      // one-pop-per-post budget with the composer guard rather than adding a second pop.
      if (!_flashFocusRequested && elapsed > _SETTLE_RESCUE_MS && !buttonGone && !isStillLoading) {
        _flashFocusRequested = true;
        cLog('[waitForPost] stalled >' + _SETTLE_RESCUE_MS + 'ms — requesting one-shot focus rescue');
        _rescueFocusOnce('settle poll saw no dialog-close after ' + _SETTLE_RESCUE_MS + 'ms').catch(() => {});
      }

      // Case 1: button gone while loading spinner active → immediate success
      // (FB processing server-side: spinner up, button already gone)
      if (buttonGone && isStillLoading) {
        cReport('post-confirmed: button-gone-while-loading (spinner active) — elapsed=' + elapsed + 'ms', 'info'); // v86 (Part A, strong)
        cLog(`[waitForPost] SUCCESS (button gone while loading) — elapsed=${elapsed}ms`);
        logTelemetry('post_completed', { elapsed }, 'INFO');
        chrome.runtime.sendMessage({ action: "schedulePostDone", snapShotId }).catch(() => {});
        finish(true);
        return;
      }

      if (buttonGone && postButtonDOM !== null) {
        const dialogStillOpen = liveDialog && document.body.contains(liveDialog);
        // BUG-FIX: [role="alert"] also fires on SUCCESS toasts ("Your post is now live").
        // Only treat as error if toast text contains actual error keywords.
        // 🔴 v1.2.9.59: was `document.querySelector` — page-wide and unfiltered,
        // like _visibleNoticeText was. This one is worse: its match CONFIRMS a
        // post (`finish(true)` below), and the words it accepts — "posted",
        // "live", "sharing", "your post" — are ordinary English. A Messenger
        // message containing any of them would confirm a post that never
        // published. Same exclusion set, same reason.
        const _toastEl = (() => {
          try {
            for (const _n of document.querySelectorAll('[role="alert"], [data-testid="snackbar"], [data-testid="toast"]')) {
              if (_n.closest(_NOTICE_EXCLUDE)) continue;
              if (_alertsAtStart.has(_n) || _n.closest('[hidden]')) continue;
              return _n;
            }
          } catch (_) { return document.querySelector('[role="alert"], [data-testid="snackbar"], [data-testid="toast"]'); }
          return null;
        })();
        const _toastText = (_toastEl?.textContent || '').toLowerCase();
        const hasRecentError = _toastEl && (elapsed < 10000)
          && (/error|fail|couldn'?t|unable|went wrong|problem|try again/i.test(_toastText));
        cLog(`[waitForPost] button gone: dialogOpen=${!!dialogStillOpen} errorToast=${!!hasRecentError} toastText="${_toastText.slice(0,40)}"`);

        // FIX F: detect success toast immediately — no need to wait for dialog to close.
        // Facebook shows "Thanks for your post! It's been submitted..." before dialog closes.
        const hasSuccessToast = _toastEl && (elapsed < 15000)
          && (/thanks|submitted|posted|live|sharing|publishing|success|your post/i.test(_toastText));

        if (hasSuccessToast) {
          _noteConfirmToast();   // v2026-10-19 · read once, here, while the toast shows
          cReport('post-confirmed: success-toast "' + _toastText.slice(0, 60) + '" — elapsed=' + elapsed + 'ms', 'info'); // v86 (Part A)
          cLog(`[waitForPost] SUCCESS (success toast detected) toastText="${_toastText.slice(0,60)}"`);
          logTelemetry('post_completed', { elapsed, viaToast: true }, 'INFO');
          chrome.runtime.sendMessage({ action: "schedulePostDone", snapShotId }).catch(() => {});
          finish(true);
          return;
        }

        if (dialogStillOpen) {
          // Dialog still visible — Facebook is processing the post server-side.
          // After 3s of "button gone, dialog still open", treat as SUCCESS.
          // 3s is safe: errors show as toasts (caught by hasRecentError), button going away
          // is a strong submission signal. Admin-approval groups never show a toast —
          // reducing from 10s to 3s saves 7-17s per post on those groups.
          if (elapsed > 3000) {
            // v86 (Part B): the dialog can linger because FB rendered a BLOCK banner, not
            // because it is processing. hasRecentError (computed above) is unreachable here
            // (this branch returns before the 5596 check), so check it + a NARROW FB-block
            // phrase. A block → report FAILED (dup-safe: Safe → maybe-landed → no re-post).
            // Match block phrases ONLY (never success/pending). Compute the notice once.
            const _notice = _visibleNoticeText();
            // v77: this is the weak-confirmation path — "dialog lingered 3s" is
            // read as "Facebook is processing". A block banner it cannot read
            // (any non-English UI) lands here and is reported as published.
            // _isBlockNotice widens the match with phrasing taken verbatim from
            // customer logs; it decides, because an exact known block string is
            // certain. The structural heuristic deliberately does NOT decide
            // here — see _looksUnpublishedStructurally.
            if (hasRecentError || _isBlockNotice(_notice)) {
              cReport('post-blocked-linger: dialog lingered with a block banner after button-gone — "' + _notice.slice(0, 80) + '" (reporting failed → Safe maybe-landed, no re-post)', 'error');
              cLog(`[waitForPost] BLOCK banner on lingering dialog — treating as failed: "${_notice.slice(0,60)}"`);
              finish(false);
              return;
            }
            // v86 (Part A): log the WEAK success criterion + any on-screen notice to the
            // downloadable log, so a future false-positive (weak confirm + banner) is diagnosable.
            // v77: the post is still being called a success here — that is
            // unchanged on purpose. But if the composer still holds the text and
            // Facebook is showing a non-success notice, this success is doubtful.
            // Recorded, never acted on: a false block would mark good posts as
            // failed for everyone, which is worse than the bug it would fix.
            // If the data shows this lines up with real blocks, it can graduate.
            try {
              if (_looksUnpublishedStructurally()) {
                cReport('⚠️ weak-confirm doubt: composer still holds the text and a non-success notice is on screen — post reported as SUCCESS anyway (observation only)', 'warn');
                logTelemetry('weak_confirm_doubt', { elapsed }, 'WARN');
              }
            } catch (e) {}
            cReport('post-confirmed: dialog-lingered ' + elapsed + 'ms after button-gone (no toast)' + (_notice ? ' · notice: "' + _notice.slice(0, 80) + '"' : ''), 'info');
            cLog(`[waitForPost] SUCCESS (dialog lingering ${elapsed}ms after button gone — treating as submitted)`);
            logTelemetry('post_completed', { elapsed, dialogLingered: true }, 'INFO');
            try { chrome.runtime.sendMessage({ action: "schedulePostDone", snapShotId }).catch(() => {}); } catch(e) {}
            finish(true);
          } else if (!dialogLingerHandle) {
            // Schedule a guaranteed wakeup so we don't rely solely on DOM changes.
            // Without this, a DOM-quiet background tab could wait indefinitely.
            const remaining = Math.max(100, 3100 - elapsed);
            dialogLingerHandle = setTimeout(() => { dialogLingerHandle = null; evaluate(); }, remaining);
          }
          return; // keep observing — dialog may close naturally
        }

        if (hasRecentError) {
          cLog('[waitForPost] Error toast — treating as failed');
          finish(false);
          return;
        }

        // v86 (Part A): button-gone + dialog-closed + no error toast = success; capture any notice.
        const _notice4 = _visibleNoticeText();
        cReport('post-confirmed: button-gone, dialog-closed, no toast' + (_notice4 ? ' · notice: "' + _notice4.slice(0, 80) + '"' : ''), 'info');
        cLog('[waitForPost] SUCCESS — post completed');
        logTelemetry('post_completed', { elapsed }, 'INFO');
        chrome.runtime.sendMessage({ action: "schedulePostDone", snapShotId }).catch(() => {});
        finish(true);
      }
    };

    // MutationObserver fires immediately on DOM changes — not throttled in background tabs
    observer = new MutationObserver(() => evaluate());
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });

    // Backup: poll every 2s via setTimeout so we never rely solely on MutationObserver.
    // In rare cases (e.g. confirmation dialogs rendered before observer started),
    // this guarantees we detect the state change within 2 seconds.
    pollingHandle = setInterval(() => evaluate(), 2000);

    // Hard timeout fallback — in case FB never updates the DOM (extreme edge case)
    timeoutHandle = setTimeout(() => {
      if (!settled) {
        cLog('[waitForPost] TIMEOUT after', maxWaitMs, 'ms');
        logTelemetry('post_completion_timeout', { elapsed: maxWaitMs }, 'ERROR');
        finish(false);
      }
    }, maxWaitMs);

    evaluate(); // initial check — in case DOM is already in final state
  });
}

const POST_TRANSLATIONS = [
  "Post", // English
  "Publier", // French
  "पोस्ट करें", // Hindi
  "Opublikuj", // Polish
  "Publicar", // Spanish
  "Postar", // Portuguese
  "Veröffentlichen", // German
  "Надіслати", // Ukrainian
  "نشر", // Arabic
  "게시", // Korean (Post/Publish)
  "投稿", // Japanese (Post)
  "发布", // Chinese (Publish)
  "פרסום", // Hebrew
  "Yayınla", // Turkish
  "Pubblicare", // Italian
  "Plaatsen",  // Dutch
  // v44: SEA + others. The Thai account in the user's log fails Tier-1/2 here.
  // (The structural Tier-3 in findPostComposerDialog already covers ANY language;
  // these just give the fast aria-label path for the common locales.)
  "โพสต์", // Thai
  "Đăng", // Vietnamese
  "Posting", // Indonesian
  "Hantar", // Malay
  "I-post", // Filipino
  // v2026-08-14: verified against a live capture of the real composer in en/pl/
  // ru/ar. Facebook's Russian button reads "Отправить", NOT "Опубликовать" —
  // the entry we shipped never matched, so Russian silently fell through to the
  // structural tier. "Опубликовать" is kept: it is Facebook's wording elsewhere
  // and costs nothing.
  "Опубликовать", // Russian (other surfaces)
  "Отправить",    // Russian — the group composer, confirmed live
];

/* ── The composer's Photo/video toolbar button ───────────────────────────────
 *
 * ⚠️ Deliberately a translation list and NOT the weighted scorer used for the
 * submit button. The live capture settled that: in en/pl/ru/ar this button is
 * 36×36 — byte-identical in geometry to every other toolbar icon (emoji, tag
 * people, check in, background). The submit button could be scored because it
 * is 468px against a 191px runner-up; here there is no such margin, and a
 * geometry-based rule would just pick an arbitrary icon.
 *
 * It matters less than it looks: findFileInput's strategies 1-3 locate
 * input[type=file] directly and are already language-proof — the engine log
 * shows "file input already present in composer — skipping Photo/video click
 * (language-proof path)" on the healthy path. This button is the fallback for
 * when Facebook has not pre-rendered the input.
 *
 * The first four values are verbatim from the capture. The rest are the
 * substring heuristics this file already shipped, kept as a wider net.
 */
const PHOTO_BUTTON_LABELS = [
  'Photo/video',    // en — captured
  'Zdjęcie/film',   // pl — captured
  'Фото/видео',     // ru — captured
  'صورة/فيديو',      // ar — captured
];
/** Substring probes for locales we have not captured. Lower confidence than the
 *  exact list above, which is why they are tried second. */
const PHOTO_BUTTON_HINTS = [
  'photo', 'foto', 'vídeo', 'video', 'vidéo', 'zdjęcie', 'фото', 'صورة',
  'וידאו', 'image', 'ảnh', '照片', '写真', 'kép', 'imagine',
  // v2026-08-28: these three have entries in POST_TRANSLATIONS — i.e. we know we
  // have users there — but no photo hint, so they fell through to the structural
  // probe. Cheap data, and the file-input strategies above still do the heavy
  // lifting (a live log shows them succeeding without ever needing this list).
  '사진', 'รูปภาพ', 'फ़ोटो', '동영상', 'วิดีโอ', 'वीडियो',
];

/** The upload trigger inside `scope`, resolved without a hardcoded English label. */
function _findPhotoButton(scope) {
  try {
    const root = scope || document;
    const btns = Array.from(root.querySelectorAll('[role="button"], button'));
    const labelOf = (el) => (el.getAttribute('aria-label') || '').trim();
    // 1. exact, captured label
    for (const el of btns) {
      const l = labelOf(el);
      if (PHOTO_BUTTON_LABELS.some((t) => l === t || l.toLowerCase() === t.toLowerCase())) return el;
    }
    // 2. substring probe — never a negative (Close/Cancel/Back) button
    for (const el of btns) {
      const l = labelOf(el).toLowerCase();
      if (!l || NEGATIVE_POST_LABELS.test(l)) continue;
      if (PHOTO_BUTTON_HINTS.some((h) => l.includes(h))) return el;
    }
    // 3. structural: a button that already CONTAINS an image file input
    for (const el of btns) {
      if (el.querySelector('input[type="file"][accept*="image"]')) return el;
    }
    return null;
  } catch (e) { return null; }
}

// Labels that disqualify a button from being the post-submit button
// Buttons that must never be mistaken for the Post button. This matters most
// inside _getPostButtonTier3, the fallback whose own comment calls it "language
// independent" — it picks the LAST enabled short-text button in the composer and
// relies on this list to reject the wrong ones. With English-only terms that
// rejection did nothing outside English, so the language-independent fallback
// had a language-dependent safety net.
//
// The non-English terms come from this extension's own translation files
// (src/locales/*.json "cancel"/"close"), professionally translated, not guessed.
// For generic UI verbs there is normally one standard word per language, so
// Facebook's wording matches in practice — and unlike block detection, a miss
// here is harmless: it simply leaves today's behaviour unchanged.
//
// Kept to plain cancel/close verbs on purpose. Broader dismissal phrases
// ("Got it", "Rozumiem", "Am înțeles") are excluded because they CAN be the
// primary button of some other dialog, and rejecting a real primary action is
// the one direction that would break posting.
// v2026-08-14: the live capture showed how thin this was. Facebook's own
// composer offers Close AND Back in every language, and this list matched
// neither in Russian ("Закрыть"/"Назад") nor Arabic ("إغلاق"), and missed
// "Back"/"Wstecz" even in the languages it did cover — so the fallback that
// relies on it to reject the wrong button had almost nothing to reject with.
// Terms below are taken verbatim from the captured composer, not guessed.
const NEGATIVE_POST_LABELS = /close|cancel|schedule|edit privacy|dismiss|back\b|cancelar|cerrar|fechar|volver|voltar|annuler|fermer|retour|anuluj|zamknij|wstecz|mégse|bezárás|vissza|anulează|închide|înapoi|закрыть|отмена|отменить|назад|إغلاق|إلغاء|رجوع|取消|关闭|返回|返回上一页|戻る|뒤로|quay lại|hủy|đóng/i;

// ── The composer's PRIMARY button, resolved DISABLED-TOLERANTLY ─────────────
// Sibling of _getPostButtonTier1/2/3 but for a different question. Those answer
// "give me a button I can CLICK", so all three skip aria-disabled="true". The
// image-upload confirm needs the opposite: the primary button WHILE it is
// disabled, because "disabled → enabled" is precisely the upload-finished
// signal. Calling the click-oriented tiers there is a real bug — verified
// against the customer's own Polish composer, where mid-upload they skipped the
// disabled "Opublikuj" and returned the enabled toolbar button "Zdjęcie/film",
// which would confirm the upload early and publish a half-uploaded image (FB
// drops those to text-only).
function _isNegativeComposerBtn(el) {
  const t = (el.textContent || '').trim();
  const l = (el.getAttribute('aria-label') || '').trim();
  return NEGATIVE_POST_LABELS.test(t) || NEGATIVE_POST_LABELS.test(l);
}
/* ── Weighted scorer for "which button submits this composer" ────────────────
 *
 * A single signal is a single point of failure, and we have now been burned by
 * both kinds: a translation list that was simply WRONG (Facebook's Russian
 * button reads "Отправить"; we shipped "Опубликовать", so Russian never matched),
 * and a positional fallback that happily returned a toolbar icon.
 *
 * So nothing here is load-bearing alone. Six independent signals vote, and the
 * two families they come from fail for different reasons:
 *   • language signals  (the translation list) break when a locale is missing
 *   • layout signals    (width / order / position) break when Facebook restyles
 * Breaking the resolver therefore takes a translation gap AND a layout change at
 * the same time, instead of either one on its own.
 *
 * Calibrated against a live capture of the real composer in en/pl/ru/ar
 * (test/dom-safety/composer-scoring.test.js replays it). In that data the
 * submit button scores ~145 and the best non-submit ~25, so the 50-point bar is
 * nowhere near either — the margin, not the exact weights, is the point.
 *
 * DISABLED-TOLERANT on purpose: the image-upload confirm needs the button while
 * it is disabled, because disabled → enabled IS the upload-finished signal.
 * Callers that need a clickable button check aria-disabled themselves.
 */
const _COMPOSER_PRIMARY_MIN_SCORE = 50;

function _scoreComposerPrimary(scope) {
  const out = [];
  const all = Array.from(scope.querySelectorAll('div[role="button"], button'));
  const visible = all.filter((el) => el.offsetParent !== null);
  const widths = visible.map((el) => el.getBoundingClientRect().width);
  const maxW = widths.length ? Math.max(...widths) : 0;
  const secondW = widths.length > 1 ? widths.slice().sort((a, b) => b - a)[1] : 0;
  const scopeW = scope.getBoundingClientRect ? scope.getBoundingClientRect().width : 0;

  for (const el of visible) {
    // Hard disqualifier. Close/Cancel/Back in every language we have seen; a
    // wrong pick here is worse than no pick, because it publishes nothing while
    // looking like it worked.
    if (_isNegativeComposerBtn(el)) continue;

    const r = el.getBoundingClientRect();
    const label = (el.getAttribute('aria-label') || '').trim();
    const text = (el.textContent || '').trim();
    const why = [];
    let score = 0;

    // 1. LANGUAGE — an exact label/text match in the translation list.
    if (POST_TRANSLATIONS.some((t) => label === t || label.toLowerCase() === t.toLowerCase()
                                   || text === t || text.toLowerCase() === t.toLowerCase())) {
      score += 50; why.push('named');
    }
    // 2. LAYOUT — the widest control by a clear margin. In the captured composer
    //    the submit button is 468px and nothing else passes 191px in ANY locale.
    if (r.width > 0 && r.width === maxW) {
      if (secondW > 0 && r.width >= secondW * 1.8) { score += 35; why.push('dominant-width'); }
      else { score += 15; why.push('widest'); }
    }
    // 3. LAYOUT — Facebook renders the primary action last.
    if (el === visible[visible.length - 1]) { score += 20; why.push('last'); }
    // 4. LAYOUT — and at the bottom of the dialog.
    if (visible.every((o) => o === el || o.getBoundingClientRect().top <= r.top)) { score += 15; why.push('bottom'); }
    // 5. SHAPE — a real action carries a short text label; toolbar icons do not.
    if (text.length >= 2 && text.length <= 40) { score += 10; why.push('has-text'); }
    // 6. SHAPE — and spans most of the composer.
    if (scopeW > 0 && r.width >= scopeW * 0.6) { score += 15; why.push('full-width'); }

    if (score > 0) out.push({ el, score, why, width: Math.round(r.width), label: label || text });
  }
  return out.sort((a, b) => b.score - a.score);
}

function _resolvePrimaryComposerBtn() {
  try {
    const ranked = _scoreComposerPrimary(getComposerScope());
    const best = ranked[0];
    // Fail CLOSED. Refusing to guess costs one failed group; guessing wrong can
    // publish into the wrong place.
    if (!best || best.score < _COMPOSER_PRIMARY_MIN_SCORE) {
      try { cLog('[composer] no confident primary button — best=' + (best ? best.score + ' (' + best.why.join(',') + ')' : 'none')); } catch (e) {}
      return null;
    }
    return best.el;
  } catch (e) { return null; }
}
/** true only when the composer's primary button exists AND is not mid-upload. */
function _isPrimaryComposerBtnEnabled() {
  const el = _resolvePrimaryComposerBtn();
  return !!el && el.getAttribute('aria-disabled') !== 'true';
}

// ── Tier 1: aria-label match scoped to the dialog ─────────────────────────
function _getPostButtonTier1() {
  // Scope to the COMPOSER dialog (not the first [role="dialog"], often the Notifications
  // jewel) so the Post/Share button is found in the composer — not missed because the
  // search was confined to the notifications panel.
  const scope = getComposerScope();
  const candidates = scope.querySelectorAll('[role="button"][aria-label], button[aria-label]');
  for (const el of candidates) {
    if (el.getAttribute("aria-disabled") === "true") continue;
    const label = (el.getAttribute("aria-label") || "").trim();
    if (NEGATIVE_POST_LABELS.test(label)) continue;
    if (POST_TRANSLATIONS.some((t) => label === t || label.toLowerCase() === t.toLowerCase())) {
      return el;
    }
  }
  return null;
}

// ── Tier 2: scoring system with Facebook-blue color detection ─────────────
function _getPostButtonTier2() {
  // Scope to the COMPOSER dialog (not the first [role="dialog"], often the Notifications
  // jewel) so the Post/Share button is found in the composer — not missed because the
  // search was confined to the notifications panel.
  const scope = getComposerScope();
  let best = null;
  let bestScore = 0;

  const candidates = scope.querySelectorAll('div[role="button"], button');
  for (const el of candidates) {
    let score = 0;
    const text = (el.textContent || el.innerText || "").trim();
    const label = (el.getAttribute("aria-label") || "").trim();

    if (NEGATIVE_POST_LABELS.test(text) || NEGATIVE_POST_LABELS.test(label)) continue;
    if (el.getAttribute("aria-disabled") === "true") continue;

    if (POST_TRANSLATIONS.some((t) => text === t)) score += 100;
    if (POST_TRANSLATIONS.some((t) => label === t || label.toLowerCase() === t.toLowerCase())) score += 100;

    // Facebook-blue background detection (language-independent)
    try {
      const style = window.getComputedStyle(el);
      const bg = style.backgroundColor; // e.g. "rgb(8, 102, 255)"
      const m = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
      if (m) {
        const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
        // Blue channel significantly higher than red and green
        if (b >= r + 20 && b >= g + 20) score += 50;
      }
    } catch (e) { /* ignore */ }

    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return bestScore >= 50 ? best : null;
}

// v51: Tier-3 STRUCTURAL fallback — fires ONLY when Tier-1 (text) AND Tier-2
// (FB-blue color) both miss (e.g. a theme/gradient where the blue channel isn't
// detectable via backgroundColor). Facebook renders the PRIMARY action
// (Post/Share/Next) as the LAST enabled, text-bearing, non-negative [role=button]
// in the composer footer — icon-only toolbar buttons have no text, close/cancel are
// filtered by NEGATIVE_POST_LABELS. Language + color independent. If it somehow
// picks wrong, the post simply doesn't publish (the watchdog fails the group) —
// never a wrong post. Fail-safe, not fail-wrong.
function _getPostButtonTier3() {
  const scope = getComposerScope();
  const candidates = Array.from(scope.querySelectorAll('div[role="button"], button')).filter((el) => {
    if (el.getAttribute("aria-disabled") === "true") return false;
    const text = (el.textContent || el.innerText || "").trim();
    const label = (el.getAttribute("aria-label") || "").trim();
    if (NEGATIVE_POST_LABELS.test(text) || NEGATIVE_POST_LABELS.test(label)) return false;
    if (el.offsetParent === null) return false; // visible only
    // Primary action has a SHORT text label (localized "Post/Share/Next"); skip
    // icon-only toolbar buttons (no text) and long paragraphs.
    if (text.length < 2 || text.length > 40) return false;
    return true;
  });
  return candidates.length ? candidates[candidates.length - 1] : null;
}

// ── Cache helpers ──────────────────────────────────────────────────────────
async function _savePostButtonCache(selector) {
  try {
    await new Promise((resolve) => chrome.storage.local.set({ postButtonCache: selector }, resolve));
  } catch (e) { /* ignore */ }
}

async function _loadPostButtonCache() {
  try {
    const result = await new Promise((resolve) => chrome.storage.local.get(["postButtonCache"], resolve));
    return result?.postButtonCache || null;
  } catch (e) {
    return null;
  }
}

function _buildSelector(el) {
  if (!el) return null;
  // BUG-27: Skip ID-based selectors — Facebook generates dynamic React IDs that
  // change on every navigation, so a cached #dynamic-id-XXXXX never matches again.
  // if (el.id) return `#${CSS.escape(el.id)}`;
  const label = el.getAttribute('aria-label');
  if (label) return `[aria-label="${label.replace(/"/g, '\\"')}"]`;
  return null;
}
function getPostButton() {
  // Note: getPostButton is now async-aware via wrapper below.
  // This sync version is kept for any legacy callers that don't await.
  return _getPostButtonTier1() || _getPostButtonTier2() || _getPostButtonTier3() || null;
}

// Async version used by clickPostButtonWithRetry — checks cache, then tiers, then AI.
async function getPostButtonAsync() {
  _postBtnVia = null;   // v2026-09-12: whichever branch below returns, records itself
  // ── Cache check ────────────────────────────────────────────────────────
  const cached = await _loadPostButtonCache();
  if (cached) {
    try {
      // 🔴 v2026-09-16: SCOPED, like every tier below. This was `document.querySelector`, so a
      // cached `[aria-label="Post"]` could resolve to a Post-labelled button anywhere on the
      // page — and current Facebook splits the composer into TWO visible dialogs, a header and
      // a body (see _domFailSnapshot's v86 note). We clicked whatever matched first and then
      // could not confirm the post: ALL 58 post-unconfirmed events carried `via=cache`.
      // The cache is a shortcut past the tiers, so it must obey the tiers' constraints — the
      // composer scope, and actually being on screen. A miss here simply falls through to
      // Tier 1, which is where the selector came from in the first place.
      const _scope = getComposerScope();
      const el = _scope.querySelector(cached);
      // v2026-09-12: the tiers reject a negative label on BOTH the text and the
      // aria-label (see _getPostButtonTier2); this path checked textContent only.
      // The cached selector is always `[aria-label="…"]` (_buildSelector emits
      // nothing else), so aria-label is precisely the field it was blind to.
      // Safe by construction: dom-language-independence.test.js pins that
      // NEGATIVE_POST_LABELS never rejects a real Post button in any of the 22
      // supported languages, so this cannot cost us a correct cached button.
      const _lbl = el ? (el.getAttribute('aria-label') || '') : '';
      if (el && el.offsetParent !== null
          && el.getAttribute("aria-disabled") !== "true"
          && !NEGATIVE_POST_LABELS.test(el.textContent || "")
          && !NEGATIVE_POST_LABELS.test(_lbl)) {
        _postBtnVia = 'cache';
        return el;
      }
    } catch (e) { /* cached selector invalid, fall through */ }
  }

  // ── Tier 1 ─────────────────────────────────────────────────────────────
  let btn = _getPostButtonTier1();
  if (btn) {
    const sel = _buildSelector(btn);
    if (sel) _savePostButtonCache(sel);
    _postBtnVia = 'tier1';
    return btn;
  }

  // ── Tier 2 ─────────────────────────────────────────────────────────────
  btn = _getPostButtonTier2();
  if (btn) {
    const sel = _buildSelector(btn);
    if (sel) _savePostButtonCache(sel);
    _postBtnVia = 'tier2';
    return btn;
  }

  // ── Tier 3: existing legacy text scan ─────────────────────────────────
  const candidates = document.querySelectorAll('div[role="button"], button');
  for (const el of candidates) {
    const text = el.textContent.trim();
    if (POST_TRANSLATIONS.includes(text)) {
      // v2 spec: the real Post button is pure text. Reject icon-only / close
      // buttons that can carry a "Post"-matching label in some locales/emoji bars.
      if (el.querySelector('svg, img, i[data-visualcompletion="css-img"]')) continue;
      if (NEGATIVE_POST_LABELS.test(text)) continue;
      _postBtnVia = 'legacyExact';
      return el;
    }
  }

  // v51: FINAL structural fallback (language + color independent) — the last
  // enabled, text-bearing, non-negative button in the composer footer. Catches an
  // unlisted-language UI where Tier-1/legacy-Tier-3 (text) AND Tier-2 (FB-blue, if
  // the theme hides the blue channel) all miss. Fail-safe: a wrong pick just doesn't
  // publish (watchdog fails the group) — never a wrong post.
  const _structuralBtn = _getPostButtonTier3();
  if (_structuralBtn) {
    const sel = _buildSelector(_structuralBtn);
    if (sel) _savePostButtonCache(sel);
    _postBtnVia = 'tier3';
    return _structuralBtn;
  }

  return null;
}

let postButtonDOM = null;
// v2026-09-12: WHICH resolver produced postButtonDOM, and whether the escape
// hatch fired. Read by the post-unconfirmed report, which already reaches Sentry
// and already carries dialogOpen/buttonGone. 82 `timeout-no-completion` events
// (7 users, one of them 0 confirms out of 114) had no way to tell "we clicked
// the wrong element" from "we clicked a disabled one" — this is that field.
// Observation only: nothing branches on either value.
let _postBtnVia = null;
let _postBtnEscapeHatch = false;

async function clickPostButtonWithRetry(attempts = 10, delay = 500) {
  // Fresh per post — this runs once per post, and a stale value from the previous
  // group would mislabel this one's failure report.
  _postBtnVia = null;
  _postBtnEscapeHatch = false;
  const profile = currentHumanizationContext.profile || cloneHumanizationProfile(DEFAULT_HUMANIZATION_PROFILE);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let btn = await getPostButtonAsync();
    // v2026-09-12: `config?.` — config is `let config = null` at load and is only
    // assigned inside loadConfig(). The sibling read elsewhere in this file already
    // uses optional chaining; this one did not, so a loadConfig failure turned into
    // a TypeError inside injectIntoComposer's try → `inject-exception` → maybe-landed
    // → no failover → a silently lost post. One character.
    if (!btn && config?.postButtonSelector) {
      btn = document.querySelector(config.postButtonSelector);
      if (btn) _postBtnVia = 'configSelector';
    }
    if (!btn) {
      const allButtons = Array.from(document.querySelectorAll('button, div[role="button"]'));
      btn = allButtons.find((b) => {
        const text = (b.textContent || b.innerText || '').trim().toLowerCase();
        return text === 'post' || text.includes('post');
      });
      // ⛔ Left exactly as-is by Liran's decision (2026-09-12): the whole-document
      // substring scan is NOT hardened — see test/unit/share-invisible-to-engine.js
      // ("Liran decided we do NOT touch the engine's finder"). It is the shape that
      // cost a German customer every run ("anonym posten".includes("post")), so it
      // is MEASURED instead: if `textScan` shows up in the field, we revisit it with
      // a number rather than an argument.
      if (btn) _postBtnVia = 'textScan';
    }
    const ariaDisabled = btn ? btn.getAttribute("aria-disabled") : 'n/a';
    cLog(`[clickPost] attempt ${attempt}/${attempts}: found=${!!btn} disabled=${btn?.disabled} ariaDisabled=${ariaDisabled} text="${(btn?.textContent||'').trim().slice(0,30)}"`);

    // BUG-H7 FIX: Facebook's Post button uses aria-disabled="true" when not ready,
    // NOT the HTML disabled attribute. Without this check, we click a "disabled"
    // button and the retry loop burns through 10 attempts × 500ms for nothing.
    // v2 spec escape hatch: on the last 2 attempts, click even if aria-disabled is
    // still "true" — FB occasionally leaves a stale aria-disabled after the post is
    // actually ready, and the input-nudge has had several ticks to enable it.
    const _nearEnd = attempt > attempts - 2;
    if (btn && !btn.disabled && (btn.getAttribute("aria-disabled") !== "true" || _nearEnd)) {
      const _escaped = _nearEnd && btn.getAttribute("aria-disabled") === "true";
      if (_escaped) {
        _postBtnEscapeHatch = true;
        // v2026-09-12: was a bare cLog — which sets neither `relay` nor `level`,
        // so it reached NEITHER the downloadable engine log NOR Sentry. The one
        // branch that clicks a button Facebook still calls disabled was therefore
        // invisible in every customer report. Fixed label before the first colon:
        // the relay fingerprints on it, so a free-text prefix would open one
        // Sentry issue per message.
        cLog('[clickPost] escape hatch — clicking despite stale aria-disabled (attempt ' + attempt + ')');
        try { cReport('post-escape-hatch: clicked the Post button while Facebook still marked it disabled (attempt ' + attempt + '/' + attempts + ') — the click may not submit', 'error'); } catch (_) {}
      }
      postButtonDOM = btn;
      try {
        // v1.19.6: trustedClick is a thin scroll+click wrapper.
        // simulateHumanizedClick performs the realistic pointer/mouse sequence
        // that Facebook's React handlers expect.
        const trustedResult = await trustedClick(btn);
        if (!trustedResult) {
          await simulateHumanizedClick(btn, profile);
        }
        cLog('[clickPost] clicked successfully');
        // v70 (L3): record the simulated incidental movement in the downloadable
        // log — the Post click now ARRIVES via a mouse-move trail (humanized),
        // not a bare teleport-click. Answers "did we do simulated movement?" + a
        // future log shows it ran on every post.
        // v2026-09-12: this line used to claim a clean humanized click
        // UNCONDITIONALLY — including right after an escape-hatch click on a
        // button Facebook still marked disabled. The downloadable log therefore
        // affirmed a healthy submit in exactly the case most likely to have
        // submitted nothing.
        try {
          cReport(_escaped
            ? 'presence: Post clicked, but Facebook still had the button disabled — treat this submit as unconfirmed'
            : 'presence: Post clicked via humanized mouse-trail ✓', 'info');
        } catch (_) {}
        return true;
      } catch (clickError) {
        cLog('[clickPost] Humanized click failed:', String(clickError));
      }
    }

    // ── LAYER 3 (v10): Flash-focus at midpoint ──
    // If we're halfway through retries and the button is STILL not found,
    // request a brief tab focus so React can render the button.
    if (attempt === 5 && !btn) {
      cLog('[clickPost] midpoint — requesting flash-focus');
      // v2026-08-15: was requestFlashFocus(true) — proactive WITHOUT force, which
      // requestFlashFocus suppresses outright in Safe mode. So this rescue has never once
      // run on a Safe post: the only reason the button still turned up was the every-2s
      // keeper holding the window front. Removing that keeper would have left the
      // "Post button never rendered" path with NO focus recovery at all (verified: a
      // clickPostButtonWithRetry failure writes operationDone:"failed" and returns — there
      // is no outer rescue the way openComposer has one at _openAndWaitForComposer).
      // Routed through the shared budget instead: it now actually fires when needed, and
      // still costs at most one pop per post because _rescueFocusOnce latches.
      const focused = await _rescueFocusOnce('Post button not rendered after 5 attempts');
      if (focused) {
        await sleepMs(800);
        cLog('[clickPost] flash-focus applied, continuing retries');
      }
    }

    // Exponential backoff: 500ms → 750ms → 1125ms … capped at 3000ms
    // ── INPUT NUDGE (v11) ──────────────────────────────────────────────────
    // When the Post button is still grey/disabled, re-dispatch an `input` event
    // on the composer editor so React/Lexical re-evaluates and enables it. This
    // is the single most effective trick for unsticking a disabled Post button
    // (e.g. after execCommand/paste left React's content state stale).
    try {
      const _ed = document.querySelector('div[role="dialog"] [contenteditable="true"]')
                || document.querySelector('[data-lexical-editor="true"]');
      if (_ed) _ed.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    } catch (_) {}

    const backoffDelay = Math.min(delay * Math.pow(1.5, attempt - 1), 3000);
    await sleepMs(Math.round(backoffDelay));
  }

  console.error('[clickPost] Post button not found or disabled after', attempts, 'attempts');
  showFallbackUI("Post button not found. The text may have been pasted but not posted.");
  logTelemetry(
    "post_button_retry_failed",
    { attempts, message: "Post button not found after retries." },
    "ERROR"
  );
  cReport('post-button-not-found: Post button not found or stayed disabled after ' + attempts + ' attempts (text may have pasted but not posted) — on-screen: ' + _domFailSnapshot(), 'error');
  await new Promise((resolve) => {
    chrome.storage.local.set({ operationDone: "failed", operationFailReason: "post-button-not-found" }, () => {
      if (chrome.runtime.lastError) {
        console.error("Storage error:", chrome.runtime.lastError);
      }
      resolve();
    });
  });
  return false;
}

// Observe for new posts being added and inject buttons and auto-expand
function setupObserver() {
  const observer = new MutationObserver((mutationsList) => {
    for (const mutation of mutationsList) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) {
          if (node.matches && node.matches(config.postSelector)) {
            // injectLogButton(node);
            expandSeeMore(node);
          } else if (node.querySelector) {
            const posts = node.querySelectorAll(config.postSelector);
            posts.forEach((post) => {
              // injectLogButton(post);
              expandSeeMore(post);
            });
          }
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// Wait for feed element then call init()
function waitForFeedAndInit(retries = 10) {
  if (document.querySelector(config.postSelector)) {
    init();
  } else if (retries > 0) {
    setTimeout(() => waitForFeedAndInit(retries - 1), 500);
  } else {
    // logTelemetry(
    //   "feed_detection_failed",
    //   { message: "Feed element not found after retries." },
    //   "DOM_ERROR"
    // );
  }
}

// Display a fallback UI banner on critical failures
function showFallbackUI(
  message = "An unexpected error occurred. Please try reloading the page."
) {
  const banner = document.createElement("div");
  banner.textContent = message;
  Object.assign(banner.style, {
    position: "fixed",
    top: 0,
    left: 0,
    width: "100%",
    padding: "10px",
    backgroundColor: "#f44336",
    color: "white",
    textAlign: "center",
    zIndex: 99999,
  });
  document.body.appendChild(banner);
  logTelemetry("fallback_ui_displayed", { message }, "ERROR");
}

// Main entry point: inject buttons, auto-expand, and start observer
function init() {
  // injectButtonsIntoPosts();
  autoExpandOnLoad();
  setupObserver();
}

function isFacebookSite() {
  return window.location.hostname.includes("facebook.com");
}

if (isFacebookSite()) {
  // Kick off the script
  (async () => await loadConfig())();
}

// Enhanced minimalistic file picker with intuitive UI and loader
function showFilePicker() {
  // Prevent multiple overlays
  if (document.getElementById("filePickerOverlay")) return Promise.resolve(null);

  return new Promise((resolve) => {

  // Inject HTML
  const overlayHTML = `
  <div id="filePickerOverlay" style="position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 2147483647; display: flex; align-items: center; justify-content: center;">
    <div style="background: #fff; border-radius: 12px; width: 380px; max-width: 90%; padding: 24px; font-family: 'Segoe UI', sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,0.2); text-align: center;">
      <h2 style="margin: 0 0 16px; font-size: 1.3rem; color: #222; display: flex; align-items: center; justify-content: center;"><svg xmlns=\"http://www.w3.org/2000/svg\" height=\"24\" viewBox=\"0 0 24 24\" width=\"24\" style=\"margin-right:8px;fill:#007bff\"><path d=\"M5 20h14v-2H5v2zm7-18L5.33 9h3.34v4h6.66V9h3.34L12 2z\"/></svg>Select Media</h2>
      <label for="fileInput" style="display: inline-flex; align-items: center; background: #007bff; color: #fff; padding: 10px 18px; border-radius: 6px; font-size: 0.95rem; cursor: pointer; transition: background 0.2s;"><svg xmlns=\"http://www.w3.org/2000/svg\" height=\"20\" viewBox=\"0 0 24 24\" width=\"20\" style=\"margin-right:6px;fill:#fff\"><path d=\"M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z\"/></svg>Choose Files</label>
      <input id="fileInput" type="file" accept="image/*,video/*" multiple style="display: none;" />
      <div id="fileList" style="margin:16px 0; max-height:140px; overflow-y:auto; text-align:left;"></div>
      <div id="statusMessage" style="min-height:24px; font-size:0.9rem; margin-bottom:12px; color:#000;"></div>
      <div style="display:flex; justify-content: space-between;">
        <button id="closeBtn" style="flex:1; margin-right:8px; padding:10px; background:#e0e0e0; color:#000; border:none; border-radius:6px; cursor:pointer; font-size:0.95rem; display:flex; align-items:center; justify-content:center;">
          <svg xmlns=\"http://www.w3.org/2000/svg\" height=\"18\" viewBox=\"0 0 24 24\" width=\"18\" style=\"margin-right:4px;fill:#555\"><path d=\"M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z\"/></svg>
          Close
        </button>
        <button id="selectBtn" style="flex:1; margin-left:8px; padding:10px; background:#28a745; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:0.95rem; display:flex; align-items:center; justify-content:center;">
          <svg xmlns=\"http://www.w3.org/2000/svg\" height=\"18\" viewBox=\"0 0 24 24\" width=\"18\" style=\"margin-right:4px;fill:#fff\"><path d=\"M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z\"/></svg>
          Upload
        </button>
      </div>
      <div id="loader" style="display:none; margin-top:16px;"><svg xmlns="http://www.w3.org/2000/svg" style="margin:auto; background:none; display:block;" width="40px" height="40px" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid">
            <circle cx="50" cy="50" fill="none" stroke="#007bff" stroke-width="10" r="35" stroke-dasharray="164.93361431346415 56.97787143782138"><animateTransform attributeName="transform" type="rotate" repeatCount="indefinite" dur="1s" values="0 50 50;360 50 50" keyTimes="0;1"></animateTransform></circle>
        </svg></div>
    </div>
  </div>
  `;
  document.body.insertAdjacentHTML("beforeend", overlayHTML);

  // References
  const overlay = document.getElementById("filePickerOverlay");
  const input = document.getElementById("fileInput");
  const fileList = document.getElementById("fileList");
  const closeBtn = document.getElementById("closeBtn");
  const selectBtn = document.getElementById("selectBtn");
  const statusMsg = document.getElementById("statusMessage");
  const loader = document.getElementById("loader");

  let selectedFiles = [];

  function dedupeFiles(files) {
    const map = new Map();
    files.forEach((file) => map.set(file.name + file.size, file));
    return Array.from(map.values());
  }

  function renderFileList() {
    fileList.innerHTML = "";
    selectedFiles.forEach((file, idx) => {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      row.style.padding = "4px 0";
      const info = document.createElement("div");
      info.style.display = "flex";
      info.style.alignItems = "center";
      const icon = document.createElement("span");
      icon.style.marginRight = "8px";
      icon.style.fontSize = "1.2rem";
      icon.textContent = file.type.startsWith("image/") ? "🖼️" : "🎥";
      const name = document.createElement("span");
      name.textContent = file.name;
      name.style.fontSize = "0.9rem";
      name.style.color = "#000";
      info.append(icon, name);
      const remove = document.createElement("button");
      remove.innerHTML = "✖";
      remove.style.background = "none";
      remove.style.border = "none";
      remove.style.cursor = "pointer";
      remove.style.color = "#d00";
      remove.onclick = () => {
        selectedFiles.splice(idx, 1);
        renderFileList();
      };
      row.append(info, remove);
      fileList.append(row);
    });
  }

  function closePicker() {
    overlay?.remove();
    resolve(null); // user cancelled
  }
  closeBtn.addEventListener("click", closePicker);

  input.addEventListener("change", () => {
    selectedFiles = dedupeFiles(Array.from(input.files));

    // ── File size & count warnings ──────────────────────────────────────────
    const MAX_FILE_SIZE_MB = 25;
    const MAX_FILE_COUNT = 9;
    const warnings = [];

    const oversized = selectedFiles.filter(f => f.size > MAX_FILE_SIZE_MB * 1024 * 1024);
    if (oversized.length) {
      warnings.push(`${oversized.length} file(s) exceed ${MAX_FILE_SIZE_MB} MB and may cause upload issues.`);
      // Remove oversized files
      selectedFiles = selectedFiles.filter(f => f.size <= MAX_FILE_SIZE_MB * 1024 * 1024);
    }
    if (selectedFiles.length > MAX_FILE_COUNT) {
      warnings.push(`Max ${MAX_FILE_COUNT} files recommended. Uploading too many at once may cause text injection to fail.`);
    }

    if (warnings.length) {
      statusMsg.style.color = "#cc7a00";
      statusMsg.textContent = warnings.join(" ");
    } else {
      statusMsg.style.color = "#000";
      statusMsg.textContent = "";
    }

    renderFileList();
    input.value = "";
  });

  selectBtn.addEventListener("click", async () => {
    if (!selectedFiles.length) return;
    // Disable buttons and show loader
    closeBtn.disabled = true;
    selectBtn.disabled = true;
    closeBtn.style.cursor = "not-allowed";
    selectBtn.style.cursor = "not-allowed";
    loader.style.display = "block";
    statusMsg.textContent = "Uploading...";

    const uploadedIds = [];

    for (const file of selectedFiles) {
      const chunkSize = 1024 * 1024;
      const totalChunks = Math.ceil(file.size / chunkSize);
      const fileId = `${file.name}_${file.size}_${Date.now()}`;
      for (let i = 0; i < totalChunks; i++) {
        const blob = file.slice(i * chunkSize, (i + 1) * chunkSize);
        const base64 = await new Promise((res) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result.split(",")[1]);
          reader.readAsDataURL(blob);
        });
        await new Promise((res) => {
          chrome.runtime.sendMessage(
            {
              action: "fileChunk",
              fileId,
              index: i,
              totalChunks,
              name: file.name,
              type: file.type,
              size: file.size,
              data: base64,
            },
            () => res()
          );
        });
      }
      uploadedIds.push(fileId);
    }

    // Finished — notify background, update UI, resolve the Promise
    statusMsg.textContent =
      "Done! Open the extension popup to post with your media.";
    loader.style.display = "none";
    selectBtn.style.display = "none";
    closeBtn.disabled = false;
    closeBtn.style.cursor = "pointer";

    // Resolve the Promise so sendResponse is called with the uploaded file IDs
    resolve(uploadedIds);
  });

  }); // end new Promise
}

// Snapshot capture removed — extension does not send page DOM off the device.
// Stub kept so existing call sites continue to compile; no network I/O happens.
function captureAndSendSnapshot(_id, _label, _meta) {
  return;
}

// ============================================================
// Background Style Application
// ============================================================

/**
 * Apply the post's background colour in Facebook's own composer (Safe mode).
 *
 * v2026-10-02 · rebuilt on a live look at Facebook's composer (QA Chrome, every write blocked; home + group):
 *  - the opener is the "Aa" button, an <img src="/images/composer/SATP_Aa_square-2x.png"> in EVERY language
 *    ("Show background options" / "Pokaż opcje tła" / "Показать параметры фона"), so it is found by that image;
 *  - its row offers three solid colours — purple rgb(198,0,255), red rgb(226,1,59), black rgb(17,17,17) — each a
 *    button whose first child is painted with the colour; the rest are gradients and pictures, and the full
 *    picker ("Background Options") holds only illustrations;
 *  - a picked colour shows as a large card painted with it (500×347 — the text card, or the preview in the
 *    full-page composer), even on an empty composer, and the swatch gets a ring.
 * The old version matched aria-label words ("Gradient, red" for red-solid), knew 2 of the palette's 8 ids, took
 * a transparent button for a perfect black, and called a click "applied". Now the swatch is found by its painted
 * colour and true means the colour is on screen. MGP's other colours are not in Facebook's row: the worker sends
 * those by Fast (BG_DOM_PAINTABLE) and never asks for them here.
 * @param {string|object|array} background - a palette id ('black'), a BackgroundStyle ({id, value}), or a list
 */
// v2026-10-12 · why the last applyBackgroundStyle() said no — carried into the failure report so the next
// 'background-apply-failed' names its cause (no opener / no swatch for the colour / clicked but not shown).
let _bgFailWhy = '';
async function applyBackgroundStyle(background) {
  _bgFailWhy = '';
  if (!background) { _bgFailWhy = 'no-background'; return false; }
  const raw = Array.isArray(background) ? background[0] : background;
  const id = String((raw && typeof raw === 'object') ? (raw.id || '') : (raw || '')).trim();
  if (id === 'back' || id === 'white') return true;               // "no background" — nothing to do

  const SOLIDS = {                                                // = mgp-service-worker.js BG_DOM_PAINTABLE
    'black': [17, 17, 17], 'red-solid': [226, 1, 59],
    'purple-solid': [198, 0, 255], 'purple-bright': [198, 0, 255], 'purple-light': [198, 0, 255],
  };
  const hexRgb = (h) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  // a colour Facebook may add to its row later is found by the palette's own value
  const target = SOLIDS[id] || (raw && typeof raw === 'object' ? hexRgb(raw.value) : null);
  if (!target) { _bgFailWhy = 'unknown-colour:' + id; console.warn('[bg] unknown background:', id); return false; }

  // the OPAQUE colour an element is painted with — null for transparent, gradients and pictures
  const paint = (el) => {
    try {
      const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/.exec(getComputedStyle(el).backgroundColor);
      if (!m || (m[4] !== undefined && +m[4] < 0.95)) return null;
      return [+m[1], +m[2], +m[3]];
    } catch (_) { return null; }
  };
  const near = (a, b, tol) => !!a && Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= tol;
  const box = (el) => el.getBoundingClientRect();
  const visible = (el) => { const r = box(el); return r.width > 0 && r.height > 0; };
  const composer = () => [...document.querySelectorAll('div[role="dialog"]')].find((d) => d.querySelector('[contenteditable="true"]')) || document;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (el) => {
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.click();
      return true;
    } catch (e) { console.warn('[bg] click failed:', e && e.message); return false; }
  };
  const findSwatch = (root) => {
    for (const b of root.querySelectorAll('[role="button"], button')) {
      if (b.getAttribute('aria-disabled') === 'true' || !visible(b)) continue;
      const r = box(b);
      if (r.width < 18 || r.width > 64 || r.height < 18 || r.height > 64) continue;
      if (near(paint(b), target, 9) || (b.firstElementChild && near(paint(b.firstElementChild), target, 9))) return b;
    }
    return null;
  };
  const findOpener = (root) => {
    const img = root.querySelector('img[src*="SATP_Aa_square"]');
    const byImg = img && img.closest('[role="button"], button');
    if (byImg && visible(byImg)) return byImg;
    // fallback: its label in the languages seen so far (any case)
    return [...root.querySelectorAll('[role="button"][aria-label], button[aria-label]')].find((b) => visible(b)
      && /background options|opcje tła|параметры фона|خيارات الخلفية|opciones de fondo|arrière-plan|opções de fundo|opțiuni de fundal|háttér|背景|רקע/i.test(b.getAttribute('aria-label') || '')) || null;
  };
  // the big elements painted with the colour — the card that shows a background is on
  const cards = (root) => {
    const out = new Set();
    for (const el of root.querySelectorAll('div, span')) {
      const r = box(el);
      if (r.width >= 150 && r.height >= 80 && near(paint(el), target, 6)) out.add(el);
    }
    return out;
  };

  const before = cards(composer());
  let sw = findSwatch(composer());
  if (!sw) {
    const opener = findOpener(composer());
    if (!opener) { _bgFailWhy = 'no-opener'; console.warn('[bg] no background button in the composer'); return false; }
    click(opener);
    for (let t = 0; t < 25 && !sw; t++) { await wait(120); sw = findSwatch(composer()); }
  }
  if (!sw) { _bgFailWhy = 'no-swatch:' + id; console.warn("[bg] Facebook's composer has no swatch for", id); return false; }
  click(sw);
  for (let t = 0; t < 15; t++) {
    await wait(120);
    for (const el of cards(composer())) {
      if (!before.has(el)) { console.debug('[bg] applied', id); return true; }
    }
  }
  _bgFailWhy = 'not-shown:' + id;
  console.warn('[bg] clicked the', id, 'swatch but the colour did not show');
  return false;
}

// Marker
window.__myExtensionContentLoaded = true;
