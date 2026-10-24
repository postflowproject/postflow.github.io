// mgp-share-content.js — "Share to groups" button injected into Facebook posts.
//
// Registered DYNAMICALLY (chrome.scripting.registerContentScripts) when the user
// turns the feature on, in the same pattern as registerSafeSpoof
// (mgp-service-worker.js:4268). manifest.json keeps content_scripts: [].
//
// ── The one rule this file exists to obey ────────────────────────────────────
// MGP's own Safe engine hunts for Facebook's "Post" button, and its last resort
// (mgp-content.js:6620) scans the WHOLE document for any element whose text
// contains "post". A visible button of ours sitting in Facebook's action bar is
// exactly the shape that fallback grabs — and the pick is then cached
// (mgp-content.js:6525), so it would not self-heal.
//
// We do not touch that finder. Instead the button is unreachable to it:
//   D1  the control lives inside a shadow root — querySelector/querySelectorAll
//       do not cross a shadow boundary, and all six of MGP's entry points
//       (:6376 :6466 :6508 :6583 :6617 :6620) are querySelector calls.
//   D2  the light-DOM host is a <span> with NO role and is NOT a <button> tag —
//       mgp-content.js:4529 filters siblings by role === 'button' (a fourth
//       sibling there would break First Comment), and tiers 2/3 match `button`
//       by TAG. A <span> satisfies both.
//   D3  no computed backgroundColor of ours ever satisfies b >= r+20 && b >= g+20
//       (mgp-content.js:6486 awards +50 for that alone, and the bar is >= 50).
//   S6  we do not inject at all while a campaign is running.
// Each is sufficient on its own. Removing any one of them must fail a test.

'use strict';

(function mgpShareContent() {
  if (window.__mgpShareBooted) return;
  window.__mgpShareBooted = true;

  var DEBUG = false;
  function LOG() { if (DEBUG) try { console.log.apply(console, ['[mgp-share]'].concat([].slice.call(arguments))); } catch (_) {} }

  // ── S1 ───────────────────────────────────────────────────────────────────
  // Exact host match. "notfacebook.com" and "facebook.com.evil.tld" must fail.
  function isFacebookHost(hostname) {
    return /(^|\.)facebook\.com$/i.test(String(hostname || ''));
  }

  // ⛔ There is deliberately NO surface gate here.
  //
  // A previous version restricted the button to /groups/* and it vanished from
  // the home feed, which is where the owner looked for it. That restriction was
  // built on two mistakes: a sample of ONE feed post that happened to be a
  // Story, and a measurement of the STATIC dom — the feed's timestamp anchors
  // are href="?__cft__…" until hovered, which is precisely what the hover rung
  // of the resolver exists for. "No permalink" was read off a page before the
  // resolver had run.
  //
  // The competitor injects on every surface with an action bar: its manifest is
  // matches:["<all_urls>"] and its be() only NAMES the surface for its log
  // (group-post / group-feed / permalink / home-feed / watch / photo) — it never
  // blocks. We match that reach without matching its permission cost: the
  // registration uses https://*.facebook.com/* which is already in
  // host_permissions, so no new install warning.
  //
  // Posts that genuinely have no permalink (Stories, Reels) are handled where
  // they actually are: the resolver fails and the user is told.

  var SCAN_BUDGET = 40;        // injections per pass
  var DEBOUNCE_MS = 350;
  var STARVE_MS = 1200;        // ceiling: a pass runs even if mutations never stop

  // ── The label test ───────────────────────────────────────────────────────
  // Negatives are tested FIRST. "Boost post" must never read as a share button,
  // and the German incident (mgp-german-safe-post-button-bug) came from exactly
  // this shape: "anonym posten".includes("post") === true.
  //
  // Substring matching, not word boundaries: \w in JS is ASCII-only and behaves
  // wrongly next to ę/ą/ș, so \b would break Polish and Romanian.
  var SHARE_NEGATIVE = [
    'boost', 'promote', 'bewerben', 'promocionar', 'promouvoir', 'promuovi',
    'kiemel', 'promosikan', 'promuj', 'impulsionar', 'i-boost', 'quảng cáo',
    'promovează', 'öne çıkar', 'tanıtımını yap', 'продвигать', 'продвижение',
    'ترويج', 'קידום', 'promoten', '宣伝', '홍보', 'โปรโมท', '推广', 'बूस्ट'
  ];
  // 🔴 MEASURED 2026-08-29 on a live group page: Facebook's OWN share control,
  // the one carrying data-ad-rendering-role="share_button", is labelled
  //     "Send this to friends or post it on your profile."
  // The competitor's list treats "send this to friends" as a DIFFERENT control
  // and rejects it. Porting that list verbatim would have made layer 2 refuse
  // the real Share button on this build — the exact shape of the German
  // incident, imported from someone else's code.
  //
  // So these phrases are NOT rejects. They are recognised as share-ish, because
  // on Facebook that is what they are. A genuinely separate Messenger control
  // is excluded structurally instead: it is not marked share_button and it is
  // not the rightmost cell in the action bar.
  var SHARE_SEND_IS_SHARE = [
    'send this to friends', 'post it on your profile',
    'an freunde senden', 'enviar esto a amigos', 'envoyer à des amis',
    'invia agli amici', 'wyślij znajomym', 'enviar para amigos',
    'trimite prietenilor', 'küldd el ismerősöknek', 'kirim ini ke teman',
    'ipadala sa mga kaibigan', 'gửi cho bạn bè', 'arkadaşlara gönder',
    'отправить друзьям', 'שלח לחברים', '发送给朋友'
  ];
  // "partilhar" is deliberate: it is a substring of pt-BR "compartilhar", so one
  // entry covers both Portuguese variants.
  var SHARE_POSITIVE = [
    'share', 'teilen', 'compartir', 'partager', 'condividi', 'udostępnij',
    'partilhar', 'distribuie', 'megosztás', 'delen', 'bagikan', 'ibahagi',
    'chia sẻ', 'paylaş', 'поделиться', 'поділитися', 'مشاركة', 'שתף',
    'शेयर', 'แชร์', '공유', 'シェア', '分享'
  ];

  /** A label we must never act on, whatever else is true about the element.
   *  The sidewalk (layers 3-4) reads no text by design, but if the element it
   *  lands on DOES carry a label and that label is an ad control, taking it
   *  anyway would repeat the German failure through a structural door. */
  function isNegativeLabel(label) {
    var t = String(label || '').toLowerCase().trim();
    if (!t) return false;                      // no label is not a negative
    for (var i = 0; i < SHARE_NEGATIVE.length; i++) if (t.indexOf(SHARE_NEGATIVE[i]) !== -1) return true;
    return false;
  }

  function looksLikeShareLabel(label) {
    var t = String(label || '').toLowerCase().trim();
    if (!t) return false;
    for (var i = 0; i < SHARE_NEGATIVE.length; i++) if (t.indexOf(SHARE_NEGATIVE[i]) !== -1) return false;
    for (var j = 0; j < SHARE_SEND_IS_SHARE.length; j++) if (t.indexOf(SHARE_SEND_IS_SHARE[j]) !== -1) return true;
    for (var k = 0; k < SHARE_POSITIVE.length; k++) if (t.indexOf(SHARE_POSITIVE[k]) !== -1) return true;
    return false;
  }

  // ── Story id ─────────────────────────────────────────────────────────────
  // Measured live 2026-08-29: ComposerLinkAttachmentPreviewQuery resolves an
  // internal permalink to {"share_type":37,"share_params":[<storyId>]}, returns
  // null for a story id that does not exist, and IGNORES the group slug. So the
  // numeric id is the whole payload — a perfectly-formed URL is not required.
  var STORY_ID_RE = /^(?:\d{6,}|pfbid[A-Za-z0-9]{4,})$/;

  function storyIdFromHref(href) {
    var s = String(href || '');
    if (!s) return null;
    var m;
    if ((m = s.match(/\/(?:groups\/[^/?#]+\/)?(?:posts|permalink)\/([^/?#]+)/))) { if (STORY_ID_RE.test(m[1])) return m[1]; }
    if ((m = s.match(/[?&]story_fbid=([^&#]+)/)))                                { if (STORY_ID_RE.test(m[1])) return m[1]; }
    if ((m = s.match(/[?&]multi_permalinks=([^&#,]+)/)))                          { if (STORY_ID_RE.test(m[1])) return m[1]; }
    // `set=gm.<id>` is the GROUP-MEDIA set id, which for a group photo post IS
    // the story id — verified against a live permalink.
    if ((m = s.match(/[?&]set=gm\.(\d{6,})/)))                                    { return m[1]; }

    // ⛔ NO rung for /videos/<id>, ?v=<id> or /reel/<id>.
    //
    // Measured 2026-08-29: those carry a VIDEO id, not a story id, and the two
    // are different numbers. Building /groups/<g>/posts/<videoId>/ from one
    // produces a permalink Facebook resolves to null — proven by probing a
    // fabricated story id, which returns null while a real one returns
    // {"share_type":37,...}. The old rungs therefore turned "no permalink" into
    // "a confidently wrong permalink", and the share went out as a dead link.
    //
    // A video post inside a group still has a real /posts/<storyId>/ permalink;
    // the rungs above find it. And a bare /watch/?v= or /reel/ URL is not
    // shareable as a post at all — Facebook scrapes those as share_type 100
    // with empty images and video arrays, i.e. an empty card.
    return null;
  }

  /**
   * 🔴 `/groups/<x>` does not always name a group. Facebook's own routes live in
   * the same namespace, and the groups feed IS `/groups/feed/` — so on that
   * surface this returned the literal string "feed" and the permalink came out as
   *     https://www.facebook.com/groups/feed/posts/4489998361249542/
   * which is not a post anywhere. Measured live on 1.2.9.67, on the very first
   * post of the feed. The reserved words are checked here, centrally, because
   * every caller (anchors, `location`, the comment-view url) has the same
   * exposure.
   */
  var GROUP_ROUTE_WORDS = {
    feed: 1, discover: 1, joins: 1, create: 1, search: 1, browse: 1,
    invites: 1, notifications: 1, your_groups: 1, category: 1, member_requests: 1
  };

  function groupIdFromHref(href) {
    var m = String(href || '').match(/\/groups\/([^/?#]+)/);
    if (!m) return null;
    return GROUP_ROUTE_WORDS[m[1].toLowerCase()] ? null : m[1];
  }

  // A canonical, clickable permalink. The slug is cosmetic for the share card
  // (FB ignores it) but it is what a human clicking the link will follow.
  function buildPermalink(groupId, storyId, ownerId) {
    if (!storyId) return null;
    if (groupId) return 'https://www.facebook.com/groups/' + groupId + '/posts/' + storyId + '/';
    // v2026-10-11: a Page's / profile's post found through its video (resolveVideoStory) carries its owner.
    if (ownerId) return 'https://www.facebook.com/' + ownerId + '/posts/' + storyId + '/';
    return 'https://www.facebook.com/' + storyId;
  }

  // ── v2026-10-11 · a Reel / a Page's or profile's video ──────────────────────────────────────────
  // Every link on such a card names the VIDEO id (see storyIdFromHref) — 83% of the "no link" share
  // clicks. ✅ Measured LIVE 11-Oct (Liran's account, Facebook's own preview query, nothing posted):
  // /reel/<v>, /watch/?v=<v> and /<owner>/videos/<v> ALL preview as share_type 22 with share_params =
  // [the POST's id] — e.g. reel 4227535864205727 → 1676933331145347, and that post's own permalink
  // previews identically. So the video's link IS a native share of its post; no page read is needed
  // (the 29-Aug "empty card" verdict came from made-up ids).
  function videoIdOfCard(card) {
    try {
      var as = card.querySelectorAll('a[href]');
      for (var i = 0; i < as.length; i++) {
        var h = as[i].getAttribute('href') || as[i].href || '';
        var m = h.match(/\/reel\/(\d{6,})/) || h.match(/\/videos\/(?:[^/?#]+\/)?(\d{6,})/) || h.match(/\/watch\/?\?(?:[^#]*&)?v=(\d{6,})/);
        if (m) return m[1];
      }
      var el = card.querySelector('[data-video-id]');
      var v = el && el.getAttribute('data-video-id');
      if (v && /^\d{6,}$/.test(v)) return v;
    } catch (_) {}
    return null;
  }
  async function resolveVideoStory(card) {
    var vid = videoIdOfCard(card);
    if (!vid) return null;
    return { storyId: vid, groupId: null, permalink: 'https://www.facebook.com/watch/?v=' + vid, viaVideo: true };
  }

  // ── Anchor layers ────────────────────────────────────────────────────────
  // First win takes it. Layers 3 and 4 read NO text at all — they are the
  // language-independence floor. That is the layer the composer entry point was
  // missing when a German customer's every run opened the wrong control
  // (mgp-german-composer-opened-poll), so it ships on day one, not as a follow-up.

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** Up to 4 levels up, find the row of action cells; return the first
   *  role=button inside the LAST cell — "the rightmost control in the bar",
   *  with no text and no class name involved. */
  function sidewalkToRightmost(el) {
    var node = el;
    for (var up = 0; up < 4 && node && node.parentElement; up++) {
      node = node.parentElement;
      var cells = [];
      for (var i = 0; i < node.children.length; i++) {
        var c = node.children[i];
        if (c.querySelector && (c.getAttribute('role') === 'button' || c.querySelector('[role="button"]'))) cells.push(c);
      }
      if (cells.length >= 2) {
        // Right to left: the rightmost cell is normally Share, but on a Page a
        // "Boost post" control can sit further right. An unlabelled candidate is
        // accepted (that is the whole point of this layer); a candidate whose
        // label is an ad control is skipped, never taken.
        for (var n = cells.length - 1; n >= 1; n--) {
          var cell = cells[n];
          var cand = cell.getAttribute('role') === 'button' ? cell : cell.querySelector('[role="button"]');
          if (!cand) continue;
          if (isNegativeLabel(cand.getAttribute('aria-label'))) continue;
          return cand;
        }
      }
    }
    return null;
  }

  /**
   * Is this control actually in a POST's action bar?
   *
   * 🔴 MEASURED 2026-08-29: a live group page carries a header control labelled
   * "Share group" — it shares the GROUP, not a post. Layer 2 accepted it,
   * because "share group" contains "share", and resolveCard then climbed past
   * it into a nearby post. The result was a second button attached to a control
   * that shares something else entirely.
   *
   * The fix has to be structural, not another word on a list: a post's share
   * control always sits beside that post's Like/Comment controls. A group
   * header button does not.
   */
  function isInPostActionBar(control) {
    return !!findActionBar(control);
  }

  /**
   * The action-bar ROW itself — the element the button must be appended to.
   *
   * 🔴 MEASURED 2026-08-29: control.parentElement is NOT the bar. It is a single
   * cell, `display:flex; flex-direction:column; width:44px`, holding just that
   * one control. Appending a 147px-wide button there pushed it out of its box
   * and it rendered on top of the comments. The bar is one level further up:
   * `display:flex; flex-direction:row`, four children, full post width.
   */
  function findActionBar(control) {
    var node = control;
    for (var up = 0; up < 4 && node && node.parentElement; up++) {
      node = node.parentElement;
      if (!node.querySelector) continue;
      // An action bar holds the controls and nothing else. The moment the node
      // also holds the author name or the post body we have climbed past the bar
      // into the post — and anything found from there is a different post's
      // control, not a mate of this one. Without this the walk reaches a common
      // ancestor of the group header and the feed, and the header's own
      // "Share group" button passes.
      if (node.querySelector('[data-ad-rendering-role="profile_name"],' +
                             '[data-ad-comet-preview="message"],[data-ad-preview="message"]')) return null;

      var mates = node.querySelectorAll(
        '[data-ad-rendering-role="comment_button"],[data-ad-rendering-role="like_button"]');
      for (var i = 0; i < mates.length; i++) {
        if (!control.contains(mates[i]) && mates[i] !== control) return node;
      }
      // Marker-less surfaces: an aria-pressed sibling is the Like control.
      var pressed = node.querySelectorAll('div[role="button"][aria-pressed]');
      for (var j = 0; j < pressed.length; j++) {
        if (pressed[j] !== control && !control.contains(pressed[j])) return node;
      }
    }
    return null;
  }

  /**
   * Every share control on the page, in layer order.
   *
   * 🔴 This enumerates CONTROLS across the whole document and then walks UP to
   * the post. The obvious inversion — enumerate posts, look down for the button —
   * finds nothing on real Facebook, because the only post-shaped element you can
   * select from the top is `[role="article"]` and that is a COMMENT (measured:
   * 8 on the page, 0 containing a share button). An earlier version did exactly
   * that and scored 0/8 on a live group.
   */
  function collectShareControls(root) {
    var out = [], seen = [], i, el;

    function push(node) {
      if (!node || !isVisible(node)) return;
      if (seen.indexOf(node) !== -1) return;
      if (!isInPostActionBar(node)) return;   // "Share group" lives in the header
      seen.push(node);
      out.push(node);
    }

    // 1 — Facebook's own semantic marker. Authoritative: if FB says this element
    // is the share button, no label test gets to overrule it.
    var marked = root.querySelectorAll('[data-ad-rendering-role="share_button"]');
    for (i = 0; i < marked.length; i++) push(marked[i].closest('div[role="button"]') || marked[i]);

    // 2 — label match (the only text-reading layer).
    var labelled = root.querySelectorAll('div[role="button"][aria-label]');
    for (i = 0; i < labelled.length; i++) {
      if (looksLikeShareLabel(labelled[i].getAttribute('aria-label'))) push(labelled[i]);
    }

    // 3 — a sibling marker, then walk sideways. Reads no text.
    var sibs = root.querySelectorAll(
      '[data-ad-rendering-role="comment_button"],[data-ad-rendering-role="like_button"]');
    for (i = 0; i < sibs.length; i++) push(sidewalkToRightmost(sibs[i].closest('div[role="button"]') || sibs[i]));

    // 4 — the Like button is the only aria-pressed control in the bar. No text.
    var pressed = root.querySelectorAll('div[role="button"][aria-pressed]');
    for (i = 0; i < pressed.length; i++) {
      if (!pressed[i].querySelector('svg, i[data-visualcompletion="css-img"]')) continue;
      el = sidewalkToRightmost(pressed[i]);
      if (el !== pressed[i]) push(el);
    }
    return out;
  }

  /** Scoped single lookup — kept for the click path, which already has a card. */
  function findShareControl(scope) {
    var found = collectShareControls(scope);
    return found.length ? found[0] : null;
  }

  /**
   * The post container that owns this control.
   *
   * 🔴 MEASURED 2026-08-29 on a live group page: `[role="article"]` on Facebook
   * is a COMMENT, not a post. Eight of them on the page, every aria-label of the
   * form "Comment by <name>", and ZERO containing a share button, a profile_name
   * or a message block. An earlier version of this function started with
   * `closest('[role="article"]')` and would therefore have resolved a comment as
   * the post — and the scan loop, which enumerated articles and looked *down*
   * for the button, found nothing at all on a real page.
   *
   * The real root is found by climbing until an ancestor holds BOTH a
   * profile_name and a comment_button. Measured: 9 levels up, and the node that
   * satisfies it contains exactly one share_button and one profile_name — it is
   * tight around a single post, not a container of several.
   */
  function resolveCard(control) {
    var node = control;
    for (var up = 0; up < 20 && node && node.parentElement; up++) {
      node = node.parentElement;
      if (!node.querySelector) continue;
      if (node.querySelector('[data-ad-rendering-role="profile_name"]') &&
          node.querySelector('[data-ad-rendering-role="comment_button"]')) return node;
    }
    // Fallback for surfaces without the rendering-role markers: an ancestor that
    // carries a message block AND is not a comment.
    node = control;
    for (var u2 = 0; u2 < 20 && node && node.parentElement; u2++) {
      node = node.parentElement;
      if (!node.querySelector) continue;
      if (node.getAttribute('role') === 'article') continue;   // that is a comment
      if (node.querySelector('[data-ad-comet-preview="message"],[data-ad-preview="message"]')) return node;
    }
    return null;
  }

  // ── Suppression gates ────────────────────────────────────────────────────
  // S4 — never inside Facebook's own Share dialog or inside a composer. A
  // permalink modal is a real post and DOES get a button, so the test is not
  // "is there a dialog" but "is this dialog a composer/share sheet".
  function isSuppressedContext(control) {
    var dlg = control.closest && control.closest('div[role="dialog"]');
    if (!dlg) return false;
    var label = String(dlg.getAttribute('aria-label') || '');
    if (looksLikeShareLabel(label)) return true;
    if (dlg.querySelector('[contenteditable="true"]') &&
        !dlg.querySelector('[data-ad-rendering-role="profile_name"],[data-ad-rendering-role="story_message"],[role="article"]')) {
      return true;
    }
    return false;
  }

  // S5 — a shared story renders a post inside a post. Only the outer one gets a
  // button, otherwise sharing a reshare would target the quoted story.
  //
  // ⚠️ NOT `closest('[role="article"]')`: measured, that selector matches a
  // COMMENT on Facebook, so the old test was both wrong and meaningless.
  // A nested card is one whose ancestors already satisfy the post predicate.
  function isNestedCard(card) {
    // ⚠️ The obvious version — "does an ancestor also satisfy the post
    // predicate" — is true for EVERY card, because a parent contains whatever
    // its child contains. It would reject everything.
    //
    // resolveCard already climbs to the TIGHTEST ancestor holding both markers,
    // and a quoted story carries no comment_button of its own, so the tightest
    // root is always the outer post. What is left to catch is climbing too high:
    // a container wrapping several posts.
    if (!card.querySelectorAll) return false;
    return card.querySelectorAll('[data-ad-rendering-role="share_button"]').length > 1;
  }

  // ── The control ──────────────────────────────────────────────────────────
  // D1: everything visible lives inside a shadow root.
  // D2: the light-DOM host is a <span> with NO role and is not a <button>.
  // D3: every background we ever set carries alpha < 1, so getComputedStyle
  //     reports "rgba(…)" — and mgp-content.js:6482 matches /rgb\(…\)/, which
  //     does not match "rgba(". The +50 blue bonus can never be awarded to us
  //     even if the shadow boundary and the tag choice both failed.
  var HOST_ATTR = 'data-mgp-share';
  var DONE_FLAG = 'mgpShareDone';
  // The wrapper cell our button sits in when it joins Facebook's own row. It has
  // no role, so neither our discovery nor the engine's post-button finder can
  // take it for a control; removeAllButtons and selfHeal remove it by this.
  var CELL_ATTR = 'data-mgp-share-cell';

  var THEME = {
    light: { fg: '#3F44EE', border: 'rgba(63,68,238,.30)', hover: 'rgba(0,0,0,.05)',  active: 'rgba(0,0,0,.09)'  },
    dark:  { fg: '#8E93FF', border: 'rgba(142,147,255,.34)', hover: 'rgba(255,255,255,.10)', active: 'rgba(255,255,255,.16)' },
  };

  /** Read Facebook's own rendered label colour rather than sniffing class names
   *  or a body attribute — those are the things that rot. FB's action-bar label
   *  is dark on light and light on dark. */
  function detectDark(referenceEl) {
    try {
      var c = window.getComputedStyle(referenceEl).color;
      var m = c && c.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
      if (m) {
        var lum = 0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3];
        return lum > 140;
      }
    } catch (_) {}
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (_) {}
    return false;
  }

  // Our actual brand mark, inlined verbatim from public/assets/mgp-icon.svg —
  // the rounded tile plus the 2x2 white grid that means "multi group".
  //
  // Inlined rather than referenced: the PNGs and the SVG are NOT in
  // web_accessible_resources, so a facebook.com page cannot load them, and
  // adding a WAR entry for a 429-byte file would widen the extension's exposed
  // surface for nothing. A string costs no request, no manifest change, and no
  // onload race.
  //
  // The brand indigo is written here as #3F44EE — the value of `--primary` in
  // src/index.css and the one this button already uses for its text. The source
  // SVG file says #5B5BF6; the repo carries three near-identical indigos and the
  // CSS token is the one that governs the product's UI.
  var ICON_SVG =
    '<svg viewBox="0 0 128 128" width="15" height="15" aria-hidden="true" class="mark">' +
    '<rect width="128" height="128" rx="28" fill="currentColor"/>' +
    '<rect x="24" y="24" width="34" height="34" rx="9" fill="#ffffff"/>' +
    '<rect x="70" y="24" width="34" height="34" rx="9" fill="#ffffff"/>' +
    '<rect x="24" y="70" width="34" height="34" rx="9" fill="#ffffff"/>' +
    '<rect x="70" y="70" width="34" height="34" rx="9" fill="#ffffff"/></svg>';

  /**
   * The button's label, in the language the USER picked in the extension.
   *
   * 🔴 chrome.i18n.getMessage() follows the BROWSER's UI locale, which the user
   * cannot change from inside the extension — a user running MGP in Hebrew on an
   * English Chrome got an English button. The real choice lives in
   * localStorage['mgp_lang'] at the EXTENSION origin, which a content script on
   * facebook.com cannot read (different storage partition), so src/i18n.ts now
   * mirrors it into chrome.storage.local as `mgpLang` and this reads that.
   *
   * The strings are inlined rather than fetched: src/locales/*.json are bundled
   * into the popup's JS, not shipped as files, and each is ~65 KB — far too much
   * to pull into a content script for one label.
   *
   * ⚠️ The two locale systems do not use the same codes. src/locales is
   * pt / zh; _locales is pt_BR / zh_CN; and _locales/he has no counterpart in
   * src/locales at all. Hence an explicit table, never a passthrough.
   */
  var SHARE_LABELS = {
    en: 'Share to groups',
    es: 'Compartir en grupos',
    fr: 'Partager dans des groupes',
    hu: 'Megosztás csoportokba',
    pl: 'Udostępnij do grup',
    pt: 'Partilhar em grupos',
    ro: 'Distribuie în grupuri',
    zh: '分享到群组',
    he: 'שיתוף לקבוצות',
  };
  // v2026-09-15: said when no permalink could be found — the click used to end in silence.
  var SHARE_NO_LINK = {
    en: "Couldn't find this post's link, so it can't be shared from here.",
    es: 'No se encontró el enlace de esta publicación, así que no se puede compartir desde aquí.',
    fr: "Impossible de trouver le lien de cette publication : elle ne peut pas être partagée d'ici.",
    hu: 'Nem található a bejegyzés linkje, ezért innen nem osztható meg.',
    pl: 'Nie znaleziono linku do tego posta, więc nie można go stąd udostępnić.',
    pt: 'Não foi possível encontrar o link desta publicação, por isso não pode ser partilhada daqui.',
    ro: 'Nu am găsit linkul acestei postări, așa că nu poate fi distribuită de aici.',
    zh: '找不到这篇帖子的链接，因此无法从这里分享。',
    he: 'לא נמצא הקישור של הפוסט הזה, ולכן אי אפשר לשתף אותו מכאן.',
  };
  var SHARE_ARIA = {
    en: 'Share this post to your Facebook groups with Multi Group Poster',
    es: 'Comparte esta publicación en tus grupos de Facebook con Multi Group Poster',
    fr: 'Partagez cette publication dans vos groupes Facebook avec Multi Group Poster',
    hu: 'Oszd meg ezt a bejegyzést a Facebook-csoportjaidban a Multi Group Poster segítségével',
    pl: 'Udostępnij ten post w swoich grupach na Facebooku za pomocą Multi Group Poster',
    pt: 'Partilha esta publicação nos teus grupos do Facebook com o Multi Group Poster',
    ro: 'Distribuie această postare în grupurile tale de Facebook cu Multi Group Poster',
    zh: '使用 Multi Group Poster 将这条帖子分享到你的 Facebook 群组',
    he: 'שתף את הפוסט הזה לקבוצות הפייסבוק שלך עם Multi Group Poster',
  };

  var userLang = null;   // filled on boot, refreshed by the onChanged listener

  function normalizeLang(code) {
    var c = String(code || '').toLowerCase().replace('_', '-');
    if (SHARE_LABELS[c]) return c;
    var base = c.split('-')[0];               // pt-BR → pt, zh-CN → zh
    return SHARE_LABELS[base] ? base : null;
  }

  function i18n(key, fallback) {
    var lang = userLang;
    if (lang) {
      if (key === 'shareBtnLabel' && SHARE_LABELS[lang]) return SHARE_LABELS[lang];
      if (key === 'shareBtnAria'  && SHARE_ARIA[lang])   return SHARE_ARIA[lang];
      if (key === 'shareNoLink'   && SHARE_NO_LINK[lang]) return SHARE_NO_LINK[lang];
    }
    // No mirrored choice yet (a user who never opened the popup on this profile)
    // — the browser locale is a better guess than English.
    try { var v = chrome.i18n.getMessage(key); if (v) return v; } catch (_) {}
    return fallback;
  }

  function buildButton(referenceEl) {
    var host = document.createElement('span');          // D2: span, no role
    host.setAttribute(HOST_ATTR, '1');
    host.style.cssText = 'display:inline-flex;align-items:center;align-self:center;max-width:100%;min-width:0;';

    var dark = detectDark(referenceEl);
    var t = dark ? THEME.dark : THEME.light;
    var refRect = referenceEl.getBoundingClientRect ? referenceEl.getBoundingClientRect() : { height: 32 };
    var h = Math.max(28, Math.min(40, Math.round(refRect.height) || 32));

    var root = host.attachShadow({ mode: 'open' });     // D1
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      // 🔴 v1.2.9.66: `all:initial` resets `direction` to ltr, which pinned the
      // whole shadow tree LTR on a Hebrew/Arabic Facebook — the icon stayed left
      // of the label, and it silently defeated the `margin-inline-start` below
      // (a logical property resolves against the element's OWN direction).
      ':host{direction:inherit}' +
      // 🔑 min-width:0 is what stops selfHeal from ever firing: without it the button
      // reports its full intrinsic width, overflows a crowded action row, measures
      // under 24px and gets re-parented OUT of the bar — onto the comment composer.
      '.b{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 10px;min-width:0;' +
      'min-height:' + h + 'px;margin:0;margin-inline-start:6px;box-sizing:border-box;' +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
      'font-size:13px;font-weight:600;line-height:1;white-space:nowrap;cursor:pointer;user-select:none;' +
      'border-radius:8px;text-decoration:none;' +
      'color:' + t.fg + ';border:1px solid ' + t.border + ';background:transparent;' +
      'transition:background .16s ease,border-color .16s ease}' +
      '.b:hover{background:' + t.hover + '}' +
      '.b:active{background:' + t.active + '}' +
      '.b[aria-disabled="true"]{opacity:.6;pointer-events:none}' +
      '.t{overflow:hidden;text-overflow:ellipsis}' +
      '.mark{flex:0 0 auto;display:block}' +
      '</style>' +
      '<a class="b" role="button" tabindex="0">' + ICON_SVG +
      '<span class="t"></span></a>';

    var a = root.querySelector('.b');
    a.querySelector('.t').textContent = i18n('shareBtnLabel', 'Share to groups');
    var aria = i18n('shareBtnAria', 'Share this post to your Facebook groups with Multi Group Poster');
    a.setAttribute('aria-label', aria);
    a.setAttribute('title', aria);
    return { host: host, anchor: a };
  }

  // ── Bookkeeping ──────────────────────────────────────────────────────────
  var seenControls = new WeakSet();
  var hostToControl = new WeakMap();   // our host  → Facebook's control
  var controlToCard = new WeakMap();   // FB control → the post card
  var injectedHosts = new Set();

  function alreadyInjectedNear(control) {
    // Stale-stamp recovery. React re-renders replace the subtree while keeping
    // the dataset flag; without this the button disappears on the first virtual
    // re-render and never comes back.
    if (control.dataset && control.dataset[DONE_FLAG] === '1') {
      var p = control.parentElement;
      if (p && p.querySelector('[' + HOST_ATTR + ']')) return true;
      if (p && p.parentElement && p.parentElement.querySelector('[' + HOST_ATTR + ']')) return true;
      delete control.dataset[DONE_FLAG];
    }
    return false;
  }

  // ── S6 — never while a campaign is running ───────────────────────────────
  // This is the gate that makes the collision impossible rather than merely
  // unlikely: the engine's post-button finder only ever runs during a campaign,
  // and during a campaign there is no button of ours anywhere to find.
  //
  // It is deliberately NOT a tab-identity check. The obvious design — ask the
  // service worker "am I the automation tab?" — loses every time: state.activeTabId
  // is assigned only after `await createTab(...)` resolves on status==='complete',
  // and a document_idle content script has already run by then.
  var campaignRunning = false;

  /** Pull the mirrored language choice, then repaint any button already on screen. */
  function readUserLang() {
    try {
      chrome.storage.local.get(['mgpLang'], function (d) {
        var next = normalizeLang(d && d.mgpLang);
        if (next === userLang) return;
        userLang = next;
        relabelButtons();
      });
    } catch (_) {}
  }

  /** Repaint in place — the user changed language with the sheet's tab still open. */
  function relabelButtons() {
    var hosts = document.querySelectorAll('[' + HOST_ATTR + ']');
    for (var i = 0; i < hosts.length; i++) {
      var root = hosts[i].shadowRoot;
      if (!root) continue;
      var a = root.querySelector('.b');
      var t = root.querySelector('.t');
      if (t) t.textContent = i18n('shareBtnLabel', 'Share to groups');
      if (a) {
        var aria = i18n('shareBtnAria', 'Share this post to your Facebook groups with Multi Group Poster');
        a.setAttribute('aria-label', aria);
        a.setAttribute('title', aria);
      }
    }
  }

  function readCampaignState() {
    try {
      chrome.storage.local.get(['isPostingInProgress'], function (d) {
        // 'paused' counts as a live campaign: its groups are still spoken for,
        // and starting a share on top of it would be refused by the worker anyway.
        var now = d && (d.isPostingInProgress === 'started' || d.isPostingInProgress === 'paused');
        if (now === campaignRunning) return;
        campaignRunning = now;
        if (now) removeAllButtons(); else schedulePass('campaign-ended');
      });
    } catch (_) {}
  }

  function removeAllButtons() {
    var hosts = document.querySelectorAll('[' + HOST_ATTR + ']');
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i];
      var ctl = hostToControl.get(h);
      if (h.parentElement) h.parentElement.removeChild(h);
      injectedHosts.delete(h);
      if (ctl && ctl.dataset) delete ctl.dataset[DONE_FLAG];
    }
    // …and the cells they sat in, or an empty cell is left in Facebook's row.
    var wraps = document.querySelectorAll('[' + CELL_ATTR + ']');
    for (var w = 0; w < wraps.length; w++) if (wraps[w].parentElement) wraps[w].parentElement.removeChild(wraps[w]);
    var stamped = document.querySelectorAll('[data-' + 'mgp-share-done]');
    for (var j = 0; j < stamped.length; j++) stamped[j].removeAttribute('data-mgp-share-done');
  }

  // ── Injection ────────────────────────────────────────────────────────────
  /** role=button elements a node IS, or holds as direct children — GPP's X().
   *  Our own button lives inside a shadow root, so it is never among them. */
  function directButtons(el) {
    if (!el || el.nodeType !== 1) return [];
    if (el.getAttribute('role') === 'button') return [el];
    var out = [], kids = el.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].getAttribute && kids[i].getAttribute('role') === 'button') out.push(kids[i]);
    }
    return out;
  }

  /** The children of a row that are button cells — GPP's Q(). */
  function buttonCellsOf(row) {
    var out = [], kids = (row && row.children) || [];
    for (var i = 0; i < kids.length; i++) if (directButtons(kids[i]).length) out.push(kids[i]);
    return out;
  }

  /**
   * 🔑 Join Facebook's own row as one more cell — the competitor's placement.
   *
   * Read from GPP 2.10.4's content.js (`J()`): the button is wrapped in a new
   * cell that WEARS THE NEIGHBOURING CELL'S CLASSES and is inserted right after
   * the Share cell, inside the row. It therefore inherits whatever layout that
   * row has — grid, flex, justified — on any post type, in either direction.
   * Its label is the same as ours and it ships no Hebrew or Arabic at all: the
   * placement is the whole difference.
   *
   * 🔴 Ours appended the button to the END of the first ancestor holding a
   * Like/Comment mate. On a Q&A-style group post ("View more answers") that is
   * not a row: the button broke onto a new line and was painted over "View more
   * answers". Liran photographed it on a Hebrew post whose UI was English — it
   * was never about direction.
   *
   * ⛔ GPP's own FALLBACK is not copied: when the parent is not a row of cells it
   * drops the button inside the control's own cell, which on the groups feed we
   * measured (2026-08-29) as a 44px column the button overflows onto the
   * comments. Our fallback stays the action-bar append in injectFor.
   */
  function placeAsCell(control, host) {
    var cell = control && control.parentElement;
    var row = cell && cell.parentElement;
    if (!cell || !row) return null;
    if (!directButtons(cell).length) return null;        // the cell holds the control
    if (buttonCellsOf(row).length < 2) return null;      // …in a row of at least two cells
    var wrap = document.createElement('div');
    wrap.setAttribute(CELL_ATTR, '1');
    try { wrap.className = cell.className || ''; } catch (_) {}
    // flex:0 0 auto — the classes bring Facebook's padding and alignment; this
    // stops the new cell taking an equal share of the row from Like/Comment/Share.
    wrap.style.cssText = 'display:flex;flex-direction:row;align-items:center;' +
                         'justify-content:center;flex:0 0 auto;min-width:0;';
    wrap.appendChild(host);
    row.insertBefore(wrap, cell.nextSibling);
    return wrap;
  }

  function injectFor(control, card) {
    if (campaignRunning) return false;
    if (alreadyInjectedNear(control)) return false;
    if (isSuppressedContext(control)) return false;

    if (card === undefined) card = resolveCard(control);
    if (!card || isNestedCard(card)) return false;
    // One button per post, checked where it is DEFINITIVE — the post itself (the
    // competitor's own guard). `alreadyInjectedNear` looks one and two levels up
    // from the control; the fallback below can put the button higher than that,
    // and then every pass added another one.
    if (card.querySelector('[' + HOST_ATTR + ']')) return false;

    var built = buildButton(control);
    // First choice: one more cell of Facebook's own row (see placeAsCell).
    var parent = placeAsCell(control, built.host);
    if (!parent) {
      // Not a row of cells. The BAR, not control.parentElement — that is a 44px
      // column cell and the button overflows it onto the comments below.
      // Measured, then fixed.
      parent = findActionBar(control) || control.parentElement;
      if (!parent) return false;
      // Appended to the row, never inside Facebook's own button, so we never
      // alter that element's subtree.
      parent.appendChild(built.host);
    }
    control.dataset[DONE_FLAG] = '1';
    seenControls.add(control);
    hostToControl.set(built.host, control);
    controlToCard.set(control, card);
    injectedHosts.add(built.host);

    built.anchor.addEventListener('click', function (ev) { onShareClick(ev, control, built); }, true);
    built.anchor.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') onShareClick(ev, control, built);
    }, true);

    selfHeal(built.host, parent);
    return true;
  }

  /** A collapsed control means our host landed in a flex cell that squeezes it.
   *  Re-parent one level up, and if it is still collapsed, remove it — a broken
   *  button is worse than none. */
  function selfHeal(host, parent) {
    requestAnimationFrame(function () {
      var r = host.getBoundingClientRect();
      if (r.width >= 24 && r.height >= 12) return;
      // 🔴 v1.2.9.66: this used to re-parent one level UP — out of the action bar
      // and into the footer wrapper that also owns the "Comment as …" composer.
      // That is exactly the broken placement a customer photographed on a Hebrew
      // page. Shrink to the icon INSIDE the row instead; the row is where the
      // button belongs, and an icon-only button is a normal Facebook affordance.
      try {
        var lbl = host.shadowRoot && host.shadowRoot.querySelector('.t');
        if (lbl && lbl.textContent) { lbl.textContent = ''; lbl.style.display = 'none'; }
      } catch (_) {}
      requestAnimationFrame(function () {
        var r2 = host.getBoundingClientRect();
        if (r2.width >= 24 && r2.height >= 12) return;
        // Still squeezed even as an icon → remove. A broken button is worse than
        // none, and it must never land on the composer to prove it.
        var wrap = (host.parentElement && host.parentElement.getAttribute &&
                    host.parentElement.getAttribute(CELL_ATTR) === '1') ? host.parentElement : null;
        if (host.parentElement) host.parentElement.removeChild(host);
        if (wrap && wrap.parentElement) wrap.parentElement.removeChild(wrap);   // no empty cell left
        injectedHosts.delete(host);
        var ctl = hostToControl.get(host);
        if (ctl && ctl.dataset) delete ctl.dataset[DONE_FLAG];
      });
    });
  }

  // ── Discovery ────────────────────────────────────────────────────────────
  // One debounce for every signal. No setInterval anywhere: on Facebook a timer
  // that keeps firing is a battery and CPU cost the user pays all day.
  var passTimer = null, starveTimer = null;

  function schedulePass() {
    if (passTimer) clearTimeout(passTimer);
    passTimer = setTimeout(runPass, DEBOUNCE_MS);
    if (!starveTimer) starveTimer = setTimeout(runPass, STARVE_MS);
  }

  function runPass() {
    if (passTimer) { clearTimeout(passTimer); passTimer = null; }
    if (starveTimer) { clearTimeout(starveTimer); starveTimer = null; }
    if (campaignRunning) return;                 // S6
    if (document.hidden) return;                 // S2
    if (!isFacebookHost(location.hostname)) return;   // S1

    var budget = SCAN_BUDGET;
    var injected = 0;
    var controls = collectShareControls(document);
    var cardsDone = [];
    for (var i = 0; i < controls.length && budget > 0; i++) {
      var control = controls[i];
      var card = resolveCard(control);
      // One button per post: Facebook renders the same story more than once on
      // some surfaces, and two controls can resolve to the same root.
      if (card && cardsDone.indexOf(card) !== -1) continue;
      if (card) cardsDone.push(card);
      if (injectFor(control, card)) { budget--; injected++; }
    }
    // Once a day, and only when the button actually rendered — an empty pass on a
    // page with no posts says nothing worth a network call.
    if (injected > 0) noteSurfaceDaily(injected);
  }

  // ── Click → permalink ────────────────────────────────────────────────────
  // One share at a time, for the whole page.
  var busy = false;
  var LADDER_CEILING_MS = 5000;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** Comet does not route a bare element.click(); the full pointer sequence does.
   *  We never forge isTrusted — that ceiling is respected here as everywhere
   *  else in this codebase (mgp-v85-humansim-block). */
  function humanClick(el) {
    var seq = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (var i = 0; i < seq.length; i++) {
      var type = seq[i];
      var Ctor = type.indexOf('pointer') === 0 && window.PointerEvent ? window.PointerEvent : window.MouseEvent;
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window }));
    }
  }

  function hoverPulse(el, out) {
    var seq = out ? ['pointerout', 'mouseout', 'mouseleave']
                  : ['pointerover', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'];
    for (var i = 0; i < seq.length; i++) {
      var Ctor = seq[i].indexOf('pointer') === 0 && window.PointerEvent ? window.PointerEvent : window.MouseEvent;
      try { el.dispatchEvent(new Ctor(seq[i], { bubbles: true, cancelable: true, composed: true, view: window })); } catch (_) {}
    }
  }

  /**
   * 🔴 The group id and the story id do not always come from the same anchor.
   *
   * Measured live on the groups feed (1.2.9.67): a real post produced
   * `https://www.facebook.com/4489793107936734` — no `/groups/<id>/posts/` at
   * all, because the anchor that carried the story id carried no group. That url
   * is what the link card is scraped from, so it decides whether the share gets a
   * card at all.
   *
   * ⛔ It does NOT scan the card for "some group id": a post can link to OTHER
   * groups, and building a permalink from one of those points at a post that does
   * not exist there — a 404 is worse than a group-less url, which Facebook can
   * still resolve. Only two sources are trusted: an anchor that carries THIS
   * story id, and the group page we are standing on.
   */
  function groupIdForStory(card, storyId) {
    var msg = null;
    try { msg = card.querySelector('[data-ad-comet-preview="message"],[data-ad-preview="message"]'); } catch (_) {}
    var header = null;
    try {
      var as = card.querySelectorAll('a[href]');
      for (var i = 0; i < as.length; i++) {
        var h = as[i].getAttribute('href') || as[i].href || '';
        var g = groupIdFromHref(h);
        if (!g) continue;
        // 1st choice: an anchor that carries THIS story — unambiguous.
        if (storyId && h.indexOf(storyId) >= 0) return g;
        // 2nd choice: the group named in the post's own HEADER. On the groups feed
        // every card shows "<GroupName> · Join", and that is the group the post is
        // in. Measured live: without this rung real posts came out as
        // facebook.com/<storyId>, and it is that url the link card is scraped
        // from — no group, no card, and the raw url stays in the post.
        // ⛔ Never from the body: those links are the AUTHOR's.
        var inBody = false;
        try { inBody = !!(msg && msg.contains(as[i])); } catch (_) {}
        if (!inBody && !header) header = g;
      }
    } catch (_) {}
    return header || groupIdFromHref(location.href);
  }

  /**
   * Any story id reachable from the anchors currently inside this card.
   *
   * 🔴 Anchors in the MESSAGE BODY are the author's own links and rank LAST. A
   * post that says "check out this other post" used to hand us that post's id —
   * so we would have shared, and Copy-mode reposted, a completely different post
   * from the one the user clicked. The permalink belongs to the header's
   * timestamp anchor, which is outside the body.
   */
  function scanCardForStoryId(card) {
    var msg = null;
    try { msg = card.querySelector('[data-ad-comet-preview="message"],[data-ad-preview="message"]'); } catch (_) {}
    var as = card.querySelectorAll('a[href]');
    var fromBody = null;
    for (var i = 0; i < as.length; i++) {
      var href = as[i].getAttribute('href') || as[i].href || '';
      var id = storyIdFromHref(href);
      if (!id) continue;
      var hit = { storyId: id, groupId: groupIdFromHref(href) || groupIdForStory(card, id) };
      var inBody = false;
      try { inBody = !!(msg && msg.contains(as[i])); } catch (_) {}
      if (inBody) { if (!fromBody) fromBody = hit; continue; }
      return hit;
    }
    return fromBody;      // no header anchor at all — better than nothing
  }

  /** Rung 1 — a collapsed "See more" hides the timestamp anchor on some layouts.
   *
   * 🔴 This ALWAYS paid its full 1200ms. The exit condition was "no `role=button`
   * is left in the message body" — but Facebook does not remove the control, it
   * relabels it *See less*, which is the same `role=button`. So the loop never
   * broke early, on every single share click, before the sheet could open.
   *
   * The old condition is KEPT as one arm of the OR: on layouts where the control
   * really does vanish it is the correct signal, and it has been shipping. The
   * two new arms observe the element we actually clicked — replaced, or
   * relabelled — either of which means the body is expanded. */
  async function expandSeeMore(card, deadline) {
    var msg = card.querySelector('[data-ad-comet-preview="message"],[data-ad-preview="message"]');
    if (!msg) return 'none';
    var more = pickExpander(msg);
    if (!more) return 'none';
    var label0 = (more.textContent || '');
    var len0 = (msg.textContent || '').length;
    humanClick(more);
    for (var i = 0; i < 8; i++) {
      await sleep(150);
      if (!msg.querySelector('[role="button"]')) return 'expanded';   // control gone entirely
      // 🔑 The body GREW. This is the only signal that cannot lie, and it is the
      // one that was missing: measured live, a real post reported 'expanded' with
      // "… See more" still in its text, because the node we clicked had merely
      // been re-rendered. A virtualized feed replaces nodes constantly, so
      // `more.isConnected` says nothing about whether anything expanded — that
      // arm is gone.
      if ((msg.textContent || '').length > len0 + 8) return 'expanded';
      // Re-query: the control we clicked may be a different node by now.
      var now = pickExpander(msg);
      if (now && (now.textContent || '') !== label0) return 'expanded';  // "See more" → "See less"
      if (deadline && Date.now() > deadline) return 'failed';
    }
    return 'failed';
  }

  /** 🪤 Which control to click. The body's first `role=button` is usually
   *  *See more*, and that is what this has always clicked — but a *translation*
   *  control is also a `role=button`, and clicking it REWRITES the text we are
   *  about to capture, so Copy mode would post a translation of the post instead
   *  of the post. Only that one shape is excluded; everything else keeps the
   *  existing first-button behaviour, so there is nothing new to get wrong. */
  function pickExpander(msg) {
    var bs = msg.querySelectorAll('[role="button"]');
    for (var i = 0; i < bs.length; i++) {
      var t = (bs[i].textContent || '').toLowerCase();
      if (t.indexOf('translat') >= 0 || t.indexOf('תרגום') >= 0 || t.indexOf('ترجم') >= 0 ||
          t.indexOf('übersetz') >= 0 || t.indexOf('traduc') >= 0 || t.indexOf('traduz') >= 0) continue;
      return bs[i];
    }
    return null;
  }

  /** Rung 3 — the timestamp permalink is href="#" until the anchor is hovered. */
  async function hoverHydrate(card, deadline) {
    var as = card.querySelectorAll('a[href]');
    var targets = [];
    for (var i = 0; i < as.length && targets.length < 6; i++) {
      var h = as[i].getAttribute('href') || '';
      if (h.charAt(0) === '?' || h.charAt(0) === '#' || h === '') targets.push(as[i]);
    }
    if (!targets.length) return null;
    for (var t = 0; t < targets.length; t++) hoverPulse(targets[t], false);
    try {
      for (var p = 0; p < 6; p++) {
        await sleep(100);
        var hit = scanCardForStoryId(card);
        if (hit) return hit;
        if (deadline && Date.now() > deadline) return null;
      }
    } finally {
      for (var u = 0; u < targets.length; u++) hoverPulse(targets[u], true);
    }
    return null;
  }

  /** Rung 4 — opening the comment view puts the canonical permalink in the URL.
   *  Everything it opens, it closes. */
  async function commentClickReveal(card, control, deadline) {
    var before = document.querySelectorAll('div[role="dialog"]').length;
    var urlBefore = location.href;
    var cmt = card.querySelector('[data-ad-rendering-role="comment_button"]');
    if (!cmt) return null;
    var target = cmt.closest('div[role="button"]') || cmt;
    humanClick(target);
    try {
      for (var i = 0; i < 16; i++) {
        await sleep(150);
        var id = storyIdFromHref(location.href);
        if (id) return { storyId: id, groupId: groupIdFromHref(location.href) };
        var dlgs = document.querySelectorAll('div[role="dialog"]');
        if (dlgs.length > before) {
          var hit = scanCardForStoryId(dlgs[dlgs.length - 1]);
          if (hit) return hit;
        }
        // Give up INSIDE the loop so the `finally` below still runs — and runs
        // now, while nothing of ours is on screen yet. See the note on the
        // caller: this cleanup used to happen after the sheet had opened.
        if (deadline && Date.now() > deadline) break;
      }
      return null;
    } finally {
      // Close whatever we opened. Never leave the user's page changed.
      for (var c = 0; c < 8; c++) {
        if (document.querySelectorAll('div[role="dialog"]').length <= before) break;
        var _esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
        _esc._mgpSelf = true;            // ours — must not close our own sheet
        document.dispatchEvent(_esc);
        await sleep(100);
      }
      if (location.href !== urlBefore) { try { history.back(); } catch (_) {} }
    }
  }

  async function resolveStory(card, control, deadline) {
    // "See more" is expanded by the CALLER before this runs — it is needed for
    // the post's TEXT, not just for the permalink, so it cannot live here as a
    // rung. See the note in onShareClick.
    var hit = scanCardForStoryId(card);
    if (hit) return hit;
    hit = await hoverHydrate(card, deadline);
    if (hit) return hit;
    // v2026-10-11: a video card has no post link anywhere — opening its comments shows video links too
    // (the slowest rung, most of the 3.9 s a failed click cost). Ask its video's page instead.
    if (videoIdOfCard(card)) return await resolveVideoStory(card);
    if (deadline && Date.now() > deadline) return null;
    return await commentClickReveal(card, control, deadline);
  }

  /**
   * 🔴 The expander control lives INSIDE the message body, so its label was
   * captured as part of the post. Measured live on two real posts:
   *
   *     "Promote your business \nDrop your business in the comments! \n See less"
   *     "Resellers plz join for regular updates \nBest price … See more"
   *
   * Copy mode would repost somebody's words with Facebook's UI text welded onto
   * the end. Both shapes appear: on its own line, and inline after an ellipsis.
   *
   * 🪤 Only the text of a REAL `[role="button"]` inside the message is removed,
   * only where it sits at the end of a line or at the very end, and only if it is
   * short enough to be a control rather than content.
   * ⚠️ v2026-09-15: this layout read (innerText) is now only the FALLBACK — the
   * structural walk in messageTextFromDom below skips controls by construction.
   */
  /** True when `lbl` appears ONLY inside controls — i.e. the author did not type
   *  those words themselves, so every occurrence of them is Facebook's UI. */
  function labelOnlyInControls(msgEl, lbl) {
    try {
      var w = document.createTreeWalker(msgEl, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = w.nextNode())) {
        if (n.parentElement && n.parentElement.closest('[role="button"]')) continue;
        if (String(n.nodeValue || '').indexOf(lbl) >= 0) return false;
      }
      return true;
    } catch (_) { return false; }      // unsure ⇒ use the conservative path
  }

  /**
   * 🔴 v2026-09-15 — the text is read from the DOM's STRUCTURE, never from layout.
   *
   * A customer's shared post went out with every line welded to the next
   * ("…в Канада.Представяме Ви…", "ХАРАКТЕРИСТИКИ✓ 3.0…"). `innerText` knows about
   * lines only while the element is being RENDERED; on a node Facebook has
   * re-rendered away or hidden it silently returns textContent, and Facebook puts
   * every line in its own <div> — so no newline is left to return. Measured on
   * the live feed: a detached copy of a real post read "…vibe coded?Been something…".
   *
   * Even rendered, innerText was wrong twice more, both measured against the same
   * posts' raw text in the page's own JSON:
   *   · a blank line is a paragraph <div> with a top MARGIN, which innerText does
   *     not count — "WEB DEVELOPERS \n\nI understand…" came back with one "\n";
   *   · emoji are <img alt="😅"> from emoji.php — innerText drops them.
   *
   * So: walk it the way the competitor does (a block ends a line, <br> is a
   * line, a control is not text), plus the two things his walk loses too — emoji
   * drawn as images, and the real address behind a link Facebook shortened
   * with "...".
   */
  var MSG_BLOCK_TAGS = { DIV: 1, P: 1, LI: 1, UL: 1, OL: 1, BLOCKQUOTE: 1, PRE: 1, SECTION: 1,
    ARTICLE: 1, HEADER: 1, FOOTER: 1, TABLE: 1, TR: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1 };
  var MSG_SKIP_TAGS = { SCRIPT: 1, STYLE: 1, SVG: 1, NOSCRIPT: 1, TEMPLATE: 1 };

  /** An emoji Facebook drew as a picture reads as its character. A photo's alt is
   *  a sentence ("May be an image of…"), so without emoji.php in the address an
   *  alt counts only when it carries no letter or digit. */
  function emojiImageText(img) {
    var alt = String(img.getAttribute('alt') || '');
    if (!alt || alt.length > 16) return '';
    if (String(img.getAttribute('src') || '').indexOf('/emoji.php/') !== -1) return alt;
    return /[\p{L}\p{N}]/u.test(alt) ? '' : alt;
  }

  /** Where a link really goes: Facebook's l.php redirect unwrapped, and its own
   *  click tracking (`fbclid`, `__cft__[0]`, `__tn__`…) removed. Only http(s). */
  function linkDestination(href) {
    try {
      var u = new URL(String(href || ''), 'https://www.facebook.com/');
      if (/^(l|lm)\.facebook\.com$/i.test(u.hostname) && u.pathname === '/l.php') {
        var inner = u.searchParams.get('u');
        if (!inner) return null;
        u = new URL(inner);
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      var drop = [];
      u.searchParams.forEach(function (_v, k) { if (k === 'fbclid' || /^__/.test(k)) drop.push(k); });
      for (var i = 0; i < drop.length; i++) u.searchParams.delete(drop[i]);
      return u.href;
    } catch (_) { return null; }
  }

  /** What a link contributes to the text. Facebook shows a long address cut down
   *  to "https://www.mobile.bg/obiava-2178…-bmw-x5..." — copying that reposts a
   *  dead link. Only an address that was visibly cut, and whose real destination
   *  begins with what was shown, is replaced; a name, a #hashtag or a whole
   *  address stays exactly as the author wrote it. */
  function linkText(a) {
    var shown = String(a.textContent || '');
    var t = shown.trim();
    if (!/^(https?:\/\/|www\.)/i.test(t) || !/(\.\.\.|\u2026)$/.test(t)) return null;
    var dest = linkDestination(a.getAttribute('href'));
    if (!dest) return null;
    var bare = function (s) { return s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase(); };
    var stem = bare(t.replace(/(\.\.\.|\u2026)$/, ''));
    return stem && bare(dest).indexOf(stem) === 0 ? shown.replace(t, dest) : null;
  }

  /** What the page itself does not draw — a hidden alternate text, a hidden duplicate.
   *  The attribute and an inline display:none hold on a detached node too; the computed
   *  style is consulted only while the node is still on the page. */
  function notDrawn(node) {
    if (node.hasAttribute('hidden')) return true;
    if (node.style && node.style.display === 'none') return true;
    if (!node.isConnected) return false;
    try {
      var cs = getComputedStyle(node);
      return cs.display === 'none' || cs.visibility === 'hidden';
    } catch (_) { return false; }
  }

  /** A block element that draws no box of its own (display:contents) starts no line. */
  function drawsNoBox(node) {
    if (!node.isConnected) return false;
    try { return getComputedStyle(node).display === 'contents'; } catch (_) { return false; }
  }

  function messageTextFromDom(root) {
    var s = '';
    function walk(node) {
      if (node.nodeType === 3) { s += node.nodeValue || ''; return; }
      if (node.nodeType !== 1) return;
      var tag = String(node.tagName || '').toUpperCase();
      if (tag === 'BR') { s += '\n'; return; }
      if (MSG_SKIP_TAGS[tag]) return;
      if (node !== root && notDrawn(node)) return;
      if (node.getAttribute('role') === 'button') {
        // See more / See less / a translation toggle — Facebook's words, not the
        // author's. A truncated body puts its own "…" right before the control.
        s = s.replace(/\s*\u2026\s*$/, '');
        return;
      }
      if (tag === 'IMG') { s += emojiImageText(node); return; }
      // A link keeps its words (a name, a #hashtag); only a visibly cut ADDRESS is replaced.
      // ⚠️ Unlike the competitor's walk, an <a> without href is NOT skipped: nothing measured
      // puts one in a post body, and skipping would silently drop words the old read kept.
      if (tag === 'A' && node.getAttribute('href')) {
        var lt = linkText(node);
        if (lt != null) { s += lt; return; }
      }
      var block = MSG_BLOCK_TAGS[tag] === 1 && !drawsNoBox(node);
      if (block && s && s.charAt(s.length - 1) !== '\n') s += '\n';
      var before = s.length;
      for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
      if (block && s.length > before) s += '\n';
    }
    walk(root);
    // A line holding nothing but formatting whitespace is an empty line.
    return s.replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function captureMessageText(msgEl) {
    if (!msgEl) return '';
    var walked = '';
    try { walked = messageTextFromDom(msgEl); } catch (_) { walked = ''; }
    if (walked) return walked;
    // Nothing structural to read (every word inside a control?) — fall back to
    // the layout read and its label strip below, which is what shipped before.
    var raw = String(msgEl.innerText || msgEl.textContent || '');
    try {
      var btns = msgEl.querySelectorAll('[role="button"]');
      for (var i = 0; i < btns.length; i++) {
        var lbl = String(btns[i].innerText || btns[i].textContent || '').trim();
        if (!lbl || lbl.length > 40) continue;      // long ⇒ it is content, not a control
        var esc = lbl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (labelOnlyInControls(msgEl, lbl)) {
          // The author never typed these words, so every occurrence is Facebook's.
          // Position-independent, which matters: innerText puts the control on its
          // own line on one layout and inline after an ellipsis on another.
          raw = raw.replace(new RegExp('[\\s\u2026.]*' + esc, 'g'), '');
        } else {
          // The body contains the same words. Remove only where a control can be:
          // on a line of its own, or trailing the text it truncated.
          raw = raw.split('\n').filter(function (line) { return line.trim() !== lbl; }).join('\n');
          raw = raw.replace(new RegExp('[\\s\u2026.]*' + esc + '\\s*$'), '');
        }
      }
    } catch (_) { /* a weird label is not worth losing the text over */ }
    return raw.trim();
  }

  /**
   * v2026-09-29 · The author's own comment under the post — where "Link in the comments"
   * puts the link. A customer shared her own post and her affiliate link lived in her
   * comment: Copy never carried it, so the groups got the post without the thing it
   * pointed to. The sheet offers it as the first comment (and fills it in Copy mode).
   *
   * Language-independent. A comment is a [role=article] WITH a label whose author link
   * carries `comment_id=` — on a permalink page the post itself is an UNLABELLED article
   * that contains the comments. The author is matched by the name Facebook shows, the
   * same string on the post and on its comments. Best effort: a comment that is not
   * loaded is simply not offered.
   */
  /** The profile a link points to, as a comparable key: "/lilia.effect00", or
   *  "/profile.php?id=…" — tracking and comment parameters dropped. '' when unusable. */
  function profileKey(href) {
    try {
      var u = new URL(String(href || ''), 'https://www.facebook.com/');
      if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return '';
      var path = u.pathname.replace(/\/+$/, '').toLowerCase();
      if (!path) return '';
      if (path === '/profile.php') return u.searchParams.get('id') ? path + '?id=' + u.searchParams.get('id') : '';
      return path;
    } catch (_) { return ''; }
  }

  /** The author's name as Facebook writes it: the profile LINK's text. The whole
   *  element also holds the verified badge's title ("Lilia Effect Verified account",
   *  measured live), which is Facebook's words in the viewer's language. */
  function authorLinkOf(authorEl) {
    if (!authorEl) return null;
    if (authorEl.matches && authorEl.matches('a[href]')) return authorEl;   // the h3/h4/strong fallback IS the link
    return authorEl.querySelector ? authorEl.querySelector('a[href]') : null;
  }
  function authorNameOf(authorEl) {
    if (!authorEl) return '';
    var a = authorLinkOf(authorEl);
    var t = String((a && a.textContent) || '').trim();
    return t || String(authorEl.textContent || '').trim();
  }

  function captureAuthorComment(card, authorEl) {
    var name = authorNameOf(authorEl);
    var link = authorLinkOf(authorEl);
    var key = link ? profileKey(link.getAttribute('href')) : '';
    if (!card || !name || !card.querySelectorAll) return '';
    var arts = card.querySelectorAll('div[role="article"][aria-label]');
    for (var i = 0; i < arts.length; i++) {
      var art = arts[i];
      var who = '', whoKey = '';
      var links = art.querySelectorAll('a[href*="comment_id="]');
      for (var k = 0; k < links.length; k++) {
        who = String(links[k].textContent || '').trim();
        if (who) { whoKey = profileKey(links[k].getAttribute('href')); break; }
      }
      // The same name, or the same profile — the name alone misses a renamed Page,
      // the profile alone misses a group post (its author link is /groups/…/user/…).
      if (!who || !(who === name || (key && whoKey === key))) continue;
      // The comment's own words — never a link card's title, never a reply's words.
      var bodies = art.querySelectorAll('div[dir="auto"]');
      for (var b = 0; b < bodies.length; b++) {
        if (bodies[b].closest('a')) continue;
        if (bodies[b].closest('div[role="article"]') !== art) continue;
        var text = captureMessageText(bodies[b]);
        if (text) return text.slice(0, 1000);
      }
    }
    return '';
  }

  /**
   * The POST's own photos. v2026-10-13 · Sentry JAVASCRIPT-3R "share copy lost photos" (1 wanted, 0 copied, no
   * reason): every <img> in the card was taken, so a COMMENT's picture counted as the post's — a stranger's photo
   * could be copied into the user's post, and a GIF from another site (Giphy/Tenor) inside a comment was then refused
   * by the copy without a word. A comment is a role="article" inside the card (resolveCard's own measured rule);
   * only Facebook's image hosts can be copied (the worker refuses any other), so only they are the post's photos.
   */
  function postImagesOf(card) {
    var images = [];
    var imgs = card.querySelectorAll('img');
    for (var i = 0; i < imgs.length && images.length < 10; i++) {
      var img = imgs[i];
      var art = img.closest ? img.closest('div[role="article"]') : null;
      if (art && art !== card && card.contains(art)) continue;   // a comment's photo, GIF or sticker
      var r = img.getBoundingClientRect();
      var src = img.currentSrc || img.src || '';
      if (r.width < 90 || r.height < 90) continue;
      if (!/^https:\/\//i.test(src)) continue;
      // Facebook's own chrome: sprites, emoji and profile thumbs are not content.
      if (src.indexOf('/rsrc.php/') !== -1) continue;
      if (src.indexOf('/images/emoji.php') !== -1) continue;
      if (src.indexOf('/t39.30808-1/') !== -1) continue;
      try { if (!/(^|\.)(fbcdn\.net|facebook\.com)$/i.test(new URL(src).hostname)) continue; } catch (_) { continue; }
      if (images.indexOf(src) === -1) images.push(src);
    }
    return images;
  }

  /** What the sheet shows the user before they send. Everything here is written
   *  by an arbitrary Facebook author — the service worker sanitises it before it
   *  is stored, and React renders it as text children. */
  function buildPostObject(card, permalink, storyId, groupId, expandVerdict) {
    var authorEl = card.querySelector('[data-ad-rendering-role="profile_name"]') ||
                   card.querySelector('h3 a, h4 a, strong a');
    var msgEl = card.querySelector('[data-ad-comet-preview="message"],[data-ad-preview="message"]');

    var images = postImagesOf(card);

    return {
      permalink: permalink,
      storyId: storyId,
      groupId: groupId || '',
      // The link's text: the element also holds the verified badge's title (measured live).
      author: authorNameOf(authorEl),
      text: captureMessageText(msgEl),
      // v2026-09-29 · the author's own comment (usually the link) — '' when none is loaded.
      authorComment: captureAuthorComment(card, authorEl),
      images: images,
      // v2026-10-11: + a Reel / video link on the card (the player may not be mounted yet) — otherwise
      // Copy mode copied the poster frame as a silent still photo.
      hasVideo: !!(card.querySelector('video') || card.querySelector('[data-video-id]') || videoIdOfCard(card)),
      // A body still holding a "See more" control means we are sending a partial
      // copy. Share mode does not care (Facebook attaches the original), Copy mode
      // very much does, so the sheet has to be told.
      // 🔴 This used to be "a role=button is still in the message body" — which is
      // TRUE on every post we successfully expanded, because Facebook relabels
      // *See more* to *See less* rather than removing it. So Copy mode showed
      // "The text was cut off by See more" on complete text, every time, telling
      // the user to go and do what we had just done for them.
      //
      // expandSeeMore already knows the answer: it watched the control it clicked
      // and saw it vanish, be replaced, or be relabelled. Its verdict is the
      // signal; the DOM test stays only as the fallback for a caller that has no
      // verdict to give.
      truncated: expandVerdict
        ? expandVerdict === 'failed'
        : !!(msgEl && msgEl.querySelector('[role="button"]')),
    };
  }

  function sendToWorker(message) {
    return new Promise(function (resolve) {
      var settled = false;
      var t = setTimeout(function () { if (!settled) { settled = true; resolve(null); } }, 6000);
      try {
        chrome.runtime.sendMessage(message, function (resp) {
          if (settled) return;
          settled = true; clearTimeout(t);
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(resp || null);
        });
      } catch (_) { if (!settled) { settled = true; clearTimeout(t); resolve(null); } }
    });
  }

  // ── telemetry ─────────────────────────────────────────────────────────────
  // This file had NONE. Every give-up below died in LOG(), which is DEBUG-gated
  // and console-only, so "I clicked and nothing happened" left no trace at all.
  //
  // Both helpers go through the service worker: a content script cannot attach
  // identity, and it must not import Amplitude or Sentry. `telemetry_relay`
  // already exists for the Sentry side (level 'error' is escalated into a real
  // issue there); `mgpTrack` is the Amplitude side, name-checked at the worker.
  function report(category, message, level, data) {
    try {
      chrome.runtime.sendMessage({
        action: 'telemetry_relay', kind: 'breadcrumb',
        category: category, message: message, level: level || 'warning', data: data || {},
      }, function () { void chrome.runtime.lastError; });
    } catch (_) {}
  }

  function track(event, props) {
    try {
      chrome.runtime.sendMessage({ action: 'mgpTrack', event: event, props: props || {} },
        function () { void chrome.runtime.lastError; });
    } catch (_) {}
  }

  /** v2026-09-15: which KIND of page a failure happened on. `surfaceLabel` files 89% of the
   *  failed clicks under 'other'; this splits that by the address's shape only — never an
   *  id, a name or the address itself. (A separate field: dashboards read `surface`.) */
  function pathKind() {
    try {
      var p = location.pathname;
      if (/^\/groups\//.test(p)) return 'group';
      if (p === '/' || p === '') return 'home';
      if (/^\/(photo|photos)(\/|\.php|$)/.test(p) || /\/photos\//.test(p)) return 'photo';
      if (/^\/(watch|reel|reels)(\/|$)/.test(p) || /\/videos\//.test(p)) return 'video';
      if (/^\/marketplace(\/|$)/.test(p)) return 'marketplace';
      if (/^\/search(\/|$)/.test(p)) return 'search';
      if (/^\/stories(\/|$)/.test(p)) return 'story';
      if (/^\/events(\/|$)/.test(p)) return 'event';
      if (/^\/permalink\.php/.test(p) || /^\/story\.php/.test(p) || /\/posts\//.test(p)) return 'post_page';
      if (/^\/(notifications|bookmarks|friends|messages|saved|memories|gaming|pages|settings|business|ads)(\/|$)/.test(p)) return 'fb_route';
      if (/^\/profile\.php/.test(p) || /^\/people\//.test(p) || /^\/[^/]+\/?$/.test(p)) return 'profile_or_page';
      return 'other';
    } catch (_) { return 'other'; }
  }

  function noLinkNotice() {
    if (document.getElementById('mgp-share-nolink')) return;
    var n = el('div', 'mgp-share-nolink',
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;' +
      'background:#0F172A;color:#fff;padding:11px 16px;border-radius:10px;max-width:min(520px,calc(100vw - 32px));' +
      'font:13px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 24px rgba(15,23,42,.35);');
    n.textContent = i18n('shareNoLink', SHARE_NO_LINK.en);
    document.body.appendChild(n);
    setTimeout(function () { if (n.parentElement) n.parentElement.removeChild(n); }, 6000);
  }

  /** Which Facebook surface this is — a label, never the url itself. */
  function surfaceLabel() {
    try {
      var p = location.pathname;
      if (/^\/groups\/[^/]+\/posts\//.test(p)) return 'permalink';
      if (/^\/groups\/feed/.test(p)) return 'groups_feed';
      if (/^\/groups\//.test(p)) return 'group';
      if (p === '/' || /^\/\?/.test(p)) return 'home';
      return 'other';
    } catch (_) { return 'other'; }
  }

  /**
   * ⚠️ The one high-volume signal, capped to ONCE PER DAY per user.
   * The button renders on every post on every Facebook page — an impression event
   * would be thousands of POSTs a day per user, and there is no batching anywhere
   * in this extension. One row a day is enough to read "shown → clicked" against
   * share_button_clicked, and cheap enough to be worth having.
   */
  function noteSurfaceDaily(injected) {
    try {
      var today = new Date().toISOString().slice(0, 10);
      chrome.storage.local.get(['mgpShareSurfaceDay'], function (d) {
        if (chrome.runtime.lastError) return;
        if (d && d.mgpShareSurfaceDay === today) return;
        chrome.storage.local.set({ mgpShareSurfaceDay: today }, function () { void chrome.runtime.lastError; });
        track('share_surface_daily', { buttons: Number(injected) || 0, surface: surfaceLabel() });
      });
    } catch (_) {}
  }

  /**
   * 🔴 After the extension is updated or reloaded, Chrome ORPHANS the content
   * scripts on pages that were already open. `chrome.runtime.id` goes undefined,
   * and — the part that is invisible until it bites — an iframe we inject points
   * at an extension origin that no longer exists, so Chrome tears it down within
   * a frame or two. On screen that is a sheet that "opens and closes by itself",
   * with nothing in the console the user would think to look at.
   *
   * There is no recovering in place: the fix is a page reload, so say so.
   */
  function extensionAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  function reloadNotice() {
    if (document.getElementById('mgp-share-stale')) return;
    var n = el('div', 'mgp-share-stale',
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;' +
      'background:#0F172A;color:#fff;padding:11px 16px;border-radius:10px;' +
      'font:13px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 24px rgba(15,23,42,.35);');
    n.textContent = i18n('shareStaleReload', 'Multi Group Poster was updated — reload this page to share.');
    document.body.appendChild(n);
    setTimeout(function () { if (n.parentElement) n.parentElement.removeChild(n); }, 6000);
  }

  async function onShareClick(ev, control, built) {
    ev.preventDefault(); ev.stopPropagation();
    if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
    if (busy) return;
    // Checked BEFORE any work: staging would throw "Extension context
    // invalidated" and the catch below would swallow it into a silent no-op.
    if (!extensionAlive()) {
      reloadNotice();
      // Nothing to relay THROUGH — the runtime is gone. Recorded only so the
      // reader knows this branch is deliberately silent, not forgotten.
      return;
    }
    busy = true;
    built.anchor.setAttribute('aria-disabled', 'true');

    // 🔴 The whole "sometimes it takes ages to open" report is THIS: every rung
    // below is silent, so the user clicked and nothing at all happened for up to
    // five seconds. The spinner already existed — it just lived inside
    // openSheet(), i.e. AFTER all of this. Put it on screen first, at click
    // time; openSheet() then reuses the shell it finds instead of building one.
    var _t0 = Date.now(), _tExpand = 0, _tResolve = 0, _tStage = 0;
    var _gen = openShell();

    try {
      var card = controlToCard.get(control);
      if (!card || !card.isConnected) card = resolveCard(control);
      if (!card) return;

      // 🔴 2026-08-29: expand "See more" FIRST, unconditionally.
      //
      // This used to be a rung inside resolveStory, tried only when the earlier
      // rungs failed to find a permalink. On a group page the permalink is right
      // there in the anchors, so the first rung always won and the expansion
      // NEVER ran — buildPostObject below then captured the TRUNCATED body, and
      // Copy mode posted half a sentence.
      //
      // Two different needs were conflated: the permalink only needs expansion
      // when it is missing, but the CONTENT always needs it. The sheet shows the
      // text before the user has even chosen a mode, so it must be complete by
      // the time we get there.
      // ⛔ The ceiling is a DEADLINE the rungs read, not a `Promise.race`.
      //
      // The race never cancelled its loser. When the ceiling won,
      // `commentClickReveal` kept polling in the background and then ran its own
      // cleanup — dispatching Escape and `history.back()` — while the sheet was
      // opening on top of it. Its Escape reaches our own capture-phase keydown
      // handler, so the sheet closed itself. Now every rung gives up inside its
      // polling loop and finishes its cleanup before returning, so there is no
      // abandoned work left to interfere and nothing to cancel.
      var _deadline = _t0 + LADDER_CEILING_MS;
      var _expand = await expandSeeMore(card, _deadline);
      _tExpand = Date.now() - _t0;

      var hit = await resolveStory(card, control, _deadline);
      _tResolve = Date.now() - _t0;
      if (_gen !== shellGen) { LOG('cancelled by user'); return; }
      if (!hit || !hit.storyId) {
        LOG('no permalink');
        report('share-click', 'no permalink resolved', 'error', { surface: surfaceLabel(), path_kind: pathKind() });
        track('share_button_clicked', {
          outcome: 'no_permalink', surface: surfaceLabel(), path_kind: pathKind(),
          has_video: !!videoIdOfCard(card), // v2026-10-11 · how many of these are videos (none was measured)
          ms_expand: _tExpand, ms_resolve: _tResolve, ms_total: Date.now() - _t0
        });
        // v2026-09-15: say so — the spinner vanishing was the only answer, and people clicked again.
        noLinkNotice();
        return;
      }

      var permalink = hit.permalink || buildPermalink(hit.groupId, hit.storyId, hit.ownerId);
      var post = buildPostObject(card, permalink, hit.storyId, hit.groupId, _expand);
      var resp = await sendToWorker({ action: 'mgpStageShare', post: post });
      if (!resp || !resp.ok) {
        var _r = (resp && resp.reason) ? String(resp.reason) : 'no_response';
        LOG('stage failed', _r);
        report('share-click', 'staging refused', 'error', { reason: _r, surface: surfaceLabel() });
        track('share_button_clicked', {
          outcome: 'stage_failed', reason: _r, surface: surfaceLabel(),
          ms_expand: _tExpand, ms_resolve: _tResolve, ms_total: Date.now() - _t0
        });
        return;
      }
      _tStage = Date.now() - _t0;
      if (_gen !== shellGen) { LOG('cancelled by user'); return; }
      openSheet(resp.token);
      // 🔑 Four stamps, because there was NO timing anywhere on this path and the
      // report was "sometimes slow, randomly" — which is unactionable until the
      // segments are separated. ms_expand is rung 1, ms_resolve the whole ladder,
      // ms_stage the worker round-trip, ms_total what the user felt.
      track('share_button_clicked', {
        outcome: 'sheet_opened', surface: surfaceLabel(),
        ms_expand: _tExpand, ms_resolve: _tResolve, ms_stage: _tStage, ms_total: Date.now() - _t0
      });
    } catch (e) {
      LOG('share click failed', e && e.message);
      // `detail` is the ONLY key the Sentry scrubber lets carry prose (≤300);
      // any other name and this becomes '<dropped>' silently.
      report('share-click', 'threw', 'error',
        { detail: String((e && e.message) || 'unknown').slice(0, 200), surface: surfaceLabel() });
      track('share_button_clicked', {
        outcome: 'threw', surface: surfaceLabel(),
        ms_expand: _tExpand, ms_resolve: _tResolve, ms_total: Date.now() - _t0
      });
    } finally {
      built.anchor.removeAttribute('aria-disabled');
      busy = false;
      // Every early exit above lands here, including `if (!card) return` — so the
      // spinner can never be left on screen with nothing behind it.
      if (!frameUp) closeShell(_gen);
    }
  }

  // ── The sheet ────────────────────────────────────────────────────────────
  // An iframe of our own extension page. The scraped post does NOT travel here —
  // only the one-time token does; the sheet redeems it from the service worker.
  var FRAME_ID = 'mgp-share-frame', BACK_ID = 'mgp-share-backdrop', SHIM_ID = 'mgp-share-shim';
  var sheetOpen = false, onSheetMessage = null, onSheetKeydown = null, shimTimer = null, staleTimer = null;
  // The shell (backdrop + spinner) now goes up on CLICK, before the permalink
  // exists; the frame joins it when there is a token. `shellGen` identifies one
  // click's shell so a resolve that finishes after the user has closed it — or
  // after they clicked a different post — cannot open a sheet they no longer
  // want. `frameUp` is what tells the finally-block whether to take it down.
  var shellUp = false, frameUp = false, shellGen = 0;

  function el(tag, id, css) {
    var n = document.createElement(tag);
    n.id = id;
    n.style.cssText = css;
    return n;
  }

  function closeSheet() {
    sheetOpen = false;
    shellUp = false;
    frameUp = false;
    shellGen++;                       // invalidate any resolve still in flight
    if (shimTimer) { clearTimeout(shimTimer); shimTimer = null; }
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
    ['mgp-share-frame', 'mgp-share-backdrop', 'mgp-share-shim'].forEach(function (id) {
      var n = document.getElementById(id);
      if (n && n.parentElement) n.parentElement.removeChild(n);
    });
    if (onSheetMessage) { window.removeEventListener('message', onSheetMessage); onSheetMessage = null; }
    if (onSheetKeydown) { document.removeEventListener('keydown', onSheetKeydown, true); onSheetKeydown = null; }
  }

  /** Geometry is shared: the spinner must be exactly where the sheet will be,
   *  or the sheet appears to jump when it arrives. Each piece is built on
   *  demand — the shell needs two of the three, the frame arrives later. */
  function sheetParts(want) {
    // Measured against the competitor: its iframe is min(780, innerWidth-32) —
    // a flat 780px on any window wider than 812 — and it then applies zoom:78%
    // internally, landing at ~733 effective px. It needs that zoom because its
    // sheet lives inside a narrow side panel; ours does not, so 780 real pixels
    // is both simpler and roomier than what it ships.
    //
    // 480 (the popup's width token) was the wrong reference: this is a modal on
    // a desktop page, not the toolbar popup, and at 480 everything stacked into
    // one long scroll.
    var W = Math.min(780, Math.max(340, window.innerWidth - 32));
    var h = Math.min(880, Math.max(420, window.innerHeight - 48));
    var isFrame = want === 'frame';
    var back = isFrame ? null : el('div', BACK_ID,
      'position:fixed;inset:0;background:rgba(15,23,42,.45);backdrop-filter:blur(8px);' +
      'z-index:2147483644;opacity:0;transition:opacity .18s ease;');
    var box = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
              'width:' + W + 'px;height:' + h + 'px;' +
              'max-width:calc(100vw - 24px);max-height:calc(100vh - 32px);' +
              'border:none;border-radius:16px;';
    var frame = !isFrame ? null : el('iframe', FRAME_ID, box +
      'z-index:2147483645;color-scheme:light;background:#F8FAFC;opacity:0;' +
      'box-shadow:0 24px 64px rgba(15,23,42,.28),0 2px 8px rgba(15,23,42,.12);' +
      'transition:opacity .18s ease,transform .18s cubic-bezier(.16,1,.3,1);');
    var shim = isFrame ? null : el('div', SHIM_ID, box +
      'z-index:2147483646;background:#fff;display:flex;align-items:center;justify-content:center;' +
      'box-shadow:0 24px 64px rgba(15,23,42,.28);');
    if (shim) shim.innerHTML =
      '<div style="display:flex;flex-direction:column;align-items:center;gap:12px">' +
      '<div style="width:22px;height:22px;border:2px solid #E2E8F0;border-top-color:#3F44EE;' +
      'border-radius:50%;animation:mgpspin .8s linear infinite"></div>' +
      '<div style="font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:#475569">' +
      i18n('shareSheetLoading', 'Getting this post ready…') + '</div></div>' +
      '<style>@keyframes mgpspin{to{transform:rotate(360deg)}}</style>';
    if (frame) frame.setAttribute('title', i18n('shareBtnLabel', 'Share to groups'));
    return want === 'frame' ? { frame: frame } : { back: back, shim: shim };
  }

  /**
   * 🔴 The backdrop + spinner, on screen at CLICK time.
   *
   * Everything in this file that finds the permalink is silent and can take up
   * to five seconds, and until now the spinner was built inside openSheet() —
   * i.e. after all of it. The user clicked and the page did nothing. This is the
   * whole of the "it takes ages, randomly" report: the randomness is which rung
   * of the ladder the post needs.
   *
   * Returns the generation for this click. The caller compares it before opening
   * the sheet, so a resolve that lands after the user closed the spinner (or
   * clicked a different post) is discarded instead of opening a sheet over a
   * page they have moved on from.
   */
  function openShell() {
    if (!extensionAlive()) { reloadNotice(); return ++shellGen; }
    closeSheet();                     // never stack two shells (also bumps the gen)
    var parts = sheetParts('shell');
    document.body.appendChild(parts.back);
    document.body.appendChild(parts.shim);
    requestAnimationFrame(function () { parts.back.style.opacity = '1'; });
    shellUp = true;

    // ⛔ The `_mgpSelf` check is load-bearing. `commentClickReveal` closes the
    // comment view it opened by DISPATCHING Escape on `document` — and this
    // listener is on `document` in the capture phase, so our own synthetic key
    // would close the spinner we just put up, mid-resolve.
    //
    // 🪤 `isTrusted` would say the same thing and say it for every synthetic
    // event, but it is not forgeable, so with that guard the branch that DOES
    // close the sheet could never be exercised by a test — the half that matters
    // to the user. An explicit marker is checkable in both directions.
    onSheetKeydown = function (ev) { if (ev.key === 'Escape' && !ev._mgpSelf) closeSheet(); };
    document.addEventListener('keydown', onSheetKeydown, true);
    parts.back.addEventListener('click', closeSheet);
    return shellGen;
  }

  /** Take the shell back down, but only if it is still the one this click put up. */
  function closeShell(gen) {
    if (shellUp && gen === shellGen) closeSheet();
  }

  function openSheet(token) {
    if (frameUp) return;
    // Re-checked here too: the round-trip above is async, and an update that
    // lands mid-flight is exactly when the frame would be born dead.
    if (!extensionAlive()) { reloadNotice(); closeSheet(); return; }

    // Normally the shell is already up (openShell ran at click time); this keeps
    // the direct call working on its own.
    var parts, back = document.getElementById(BACK_ID), shim = document.getElementById(SHIM_ID);
    if (!shellUp || !back || !shim) {
      openShell();
      back = document.getElementById(BACK_ID);
      shim = document.getElementById(SHIM_ID);
    }
    parts = sheetParts('frame');
    var frame = parts.frame;
    frame.src = chrome.runtime.getURL('index.html') + '?mgpEmbed=1&mgpSheet=share&t=' + encodeURIComponent(token);
    // z-index puts the frame under the shim regardless of insertion order.
    document.body.appendChild(frame);
    sheetOpen = true;
    frameUp = true;

    // The shim never outlives the sheet: if the page never says it is ready we
    // reveal the frame anyway rather than leaving a spinner on screen forever.
    // v2026-10-19 · JAVASCRIPT-4B: six seconds is a slow computer, not a bug (one report, the sheet may well have opened
    // a moment later). Reveal at 6 s as before; report only a sheet still silent at 20 s, with what tells the causes
    // apart: did the frame's page load at all (blocked/blank) or load and never start (the app inside failed).
    var openedAt = Date.now(), frameLoaded = false;
    try { frame.addEventListener('load', function () { frameLoaded = true; }); } catch (_) {}
    shimTimer = setTimeout(function () {
      shimTimer = null;
      var n = document.getElementById(SHIM_ID);
      if (n && n.parentElement) n.parentElement.removeChild(n);
      frame.style.opacity = '1';
    }, 6000);
    staleTimer = setTimeout(function () {
      staleTimer = null;
      // A tab in the background is throttled by Chrome (nothing renders), and a dead extension (update) is told to the
      // person by reloadNotice: neither is our defect.
      if (!frameUp || document.visibilityState === 'hidden' || !extensionAlive()) return;
      report('share-sheet', 'never signalled ready', 'error', {
        after_ms: Date.now() - openedAt, frame_loaded: frameLoaded, online: navigator.onLine !== false,
      });
    }, 20000);

    onSheetMessage = function (e) {
      if (e.source !== frame.contentWindow) return;         // only our own frame
      var d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.mgpShareReady) {
        if (shimTimer) { clearTimeout(shimTimer); shimTimer = null; }
        if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
        var n = document.getElementById(SHIM_ID);
        if (n && n.parentElement) n.parentElement.removeChild(n);
        frame.style.opacity = '1';
      } else if (d.mgpShareClose) {
        closeSheet();
      } else if (d.mgpShareRunning) {
        if (shimTimer) { clearTimeout(shimTimer); shimTimer = null; }
        if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
      } else if (d.mgpShareResize && typeof d.mgpShareResize.h === 'number') {
        var want = Math.min(640, Math.max(320, d.mgpShareResize.h));
        frame.style.height = want + 'px';
      }
    };
    window.addEventListener('message', onSheetMessage);
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  if (!isFacebookHost(location.hostname)) return;      // S1

  readUserLang();
  readCampaignState();
  // 🔑 The competitor's boot is `ne(); new MutationObserver(...)` — the pass runs
  // SYNCHRONOUSLY, then the observer takes over. Ours went straight to
  // schedulePass(), so the first button could not appear for DEBOUNCE_MS at
  // best, and on a feed that never stops mutating the debounce kept re-arming
  // until the STARVE_MS ceiling — up to 1.2s of "why is it not there yet".
  // Our debounce numbers are already his (350/1200); this was the whole gap.
  try { runPass(); } catch (_) {}
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes.isPostingInProgress) readCampaignState();
      if (changes.mgpLang) readUserLang();
    });
  } catch (_) {}

  try {
    new MutationObserver(schedulePass).observe(document.body || document.documentElement,
      { childList: true, subtree: true });
  } catch (_) {}
  window.addEventListener('scroll', schedulePass, { passive: true });
  window.addEventListener('focus', schedulePass);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) schedulePass(); });
  schedulePass();

  // ── v2026-10-16 · MGP opens itself once for a new install that never signed in ──────────────────────
  // Liran: "is there no way to open the extension for them ourselves — once?" This only REPORTS a group page; the
  // worker decides (handleFbGroupVisit: the test arm, signed out, ≤14 days, an active tab, at most once). It runs
  // only for an install in the 'open' arm that has not been shown yet — for everyone else it reads one key and stops.
  (function fbGroupOpenOnce() {
    var RESERVED = /^(feed|discover|joins|create|notifications|search|you|explore|your_groups|categories)$/i;
    function isGroupPage() {
      var m = String(location.pathname || '').match(/^\/groups\/([^/]+)\/?$/);
      return !!(m && !RESERVED.test(m[1]));
    }
    var sentFor = '';
    var timer = null;
    var stopped = false;   // an answer can arrive before the timer exists — the flag, not the timer, decides
    function stop() { stopped = true; if (timer) { clearInterval(timer); timer = null; } }
    function tick() {
      // review · never while MGP itself is posting (its own window shows group pages)
      if (stopped || campaignRunning || document.hidden || !isGroupPage() || sentFor === location.pathname) return;
      sentFor = location.pathname;
      try {
        chrome.runtime.sendMessage({ action: 'mgpFbGroupVisit' }, function (r) {
          void chrome.runtime.lastError;
          // decided for good (opened / signed in / not in the test / expired) → stop; a busy moment → the next group page
          if (r && r.result && r.result !== 'not_active' && r.result !== 'failed') stop();
        });
      } catch (_) { stop(); }
    }
    try {
      chrome.storage.local.get(['mgp_exp_fb_open', '_mgpFbOpenDone'], function (d) {
        if (chrome.runtime.lastError || !d || d.mgp_exp_fb_open !== 'open' || d._mgpFbOpenDone) return;
        tick();
        if (!stopped) timer = setInterval(tick, 2000);   // Facebook moves between pages without loading them
      });
    } catch (_) {}
  })();
})();
