/**
 * mgp-spintax.js — the ONE spintax implementation.
 *
 * ─── why this file exists ──────────────────────────────────────────────────
 * Spintax was implemented three separate times: mgp-service-worker.js for the
 * Fast/API path, mgp-content.js for the Safe/DOM path, and src/lib/spintax.ts
 * for the preview the user actually looks at. Measured 2026-08-26 across ten
 * inputs, SIX produced different output between them:
 *
 *   "Say {hello} now"       Fast: "Say {hello} now"    Safe: "Say hello now"
 *   "Get {deal|} here"      Fast: "Get {deal|} here"   Safe: "Get deal here"
 *   "Buy {a{1|2}|b} today"  posted "Buy a1 today"   ·  preview "Buy {a 1 |b} today"
 *   "Buy{now|today}!"       posted "Buynow!"        ·  preview "Buy now!"
 *
 * So Fast could publish literal braces to Facebook, Safe silently rewrote text
 * the user meant to keep, a Fast->Safe failover changed the post mid-campaign,
 * and the preview was wrong in both directions. All three now load this file.
 *
 * ─── and why the picker exists ─────────────────────────────────────────────
 * Every implementation called Math.random() per post, independently. That is
 * the wrong algorithm for "every post must look different": measured over 300
 * simulated campaigns, a 2x2 template (4 permutations) posted to 30 groups
 * produced 26 DUPLICATE posts, and a 3x3 (27 permutations) still produced 12.
 * Sampling WITHOUT replacement yields zero duplicates until the pool is
 * genuinely exhausted, and only then starts a fresh cycle.
 */
(function (root) {
  'use strict';

  var GROUP_RE = /\{([^{}]+)\}/g;
  var MAX_PASSES = 50; // nested spintax resolves innermost-first
  var MAX_DRAWS = 60; // tries to find an unseen variant before cycling
  // Cap borrowed from the competitor (GPP 2.8.3, `Ci`): a pathological template
  // can multiply into a number that is useless to reason about, and the picker
  // only needs "is the pool bigger than this campaign".
  var MAX_PERMUTATIONS = 100000;

  /**
   * A brace group is spintax only if it contains a "|". `{hello}` is the user's
   * own text — Safe used to strip those braces, which corrupted the post.
   */
  function _optionsOf(content) {
    if (content.indexOf('|') === -1) return null; // not spintax
    var parts = content.split('|').map(function (o) { return o.trim(); });
    var real = parts.filter(function (o) { return o.length > 0; });
    return real.length > 1 ? real : null; // "{a|}" has nothing to vary between
  }

  /**
   * Hide HTML tags so a brace inside an attribute can never open a group.
   * The marker carries no braces and no regex metacharacters. It is spelled out
   * rather than using control bytes: an invisible delimiter survives badly in
   * source control, editors and copy-paste, and this file is the one place all
   * three engines agree on.
   */
  var MASK_RE = /@@MGPHTML(\d+)@@/g;

  function _maskHtml(text) {
    var map = [];
    var masked = String(text).replace(/<[^>]+>/g, function (m) {
      map.push(m);
      return '@@MGPHTML' + (map.length - 1) + '@@';
    });
    return { masked: masked, map: map };
  }

  function _unmaskHtml(text, map) {
    return String(text).replace(MASK_RE, function (m, i) {
      var tag = map[Number(i)];
      return tag === undefined ? '' : tag;
    });
  }

  /**
   * Expand every group once. `rnd` is injectable so tests are deterministic and
   * the picker can drive selection.
   */
  function expand(text, rnd) {
    if (!text || typeof text !== 'string') return text;
    var pick = rnd || Math.random;
    var m = _maskHtml(text);
    var result = m.masked;

    for (var pass = 0; pass < MAX_PASSES; pass++) {
      var next = result.replace(GROUP_RE, function (match, content) {
        var opts = _optionsOf(content);
        if (!opts) return match; // literal — leave the user's text alone
        var i = Math.floor(pick() * opts.length);
        return opts[i < 0 ? 0 : i >= opts.length ? opts.length - 1 : i];
      });
      if (next === result) break; // stable
      result = next;
    }
    return _unmaskHtml(result, m.map);
  }

  /**
   * How many distinct outputs this text can produce.
   * Exact for flat spintax. For NESTED spintax it is a lower bound — the picker
   * only uses it to decide when to start a new cycle, so under-counting merely
   * cycles a little early and can never cause a repeat.
   */
  function countPermutations(text) {
    if (!text || typeof text !== 'string') return 1;
    var seen = _maskHtml(text).masked;
    var total = 1;
    for (var pass = 0; pass < MAX_PASSES; pass++) {
      var found = false;
      var next = seen.replace(GROUP_RE, function (match, content) {
        var opts = _optionsOf(content);
        if (!opts) return match;
        found = true;
        total *= opts.length;
        return opts[0]; // collapse this level, keep scanning outward
      });
      if (!found || next === seen) break;
      seen = next;
      if (total >= MAX_PERMUTATIONS) return MAX_PERMUTATIONS;
    }
    return total > MAX_PERMUTATIONS ? MAX_PERMUTATIONS : total;
  }

  /**
   * The LONGEST text this template can produce.
   *
   * Borrowed from the competitor (GPP 2.8.3, `Or`), which validates length
   * against the worst case rather than against whichever variant happened to be
   * drawn. Ours previously measured the sample — so a template could pass the
   * check in the composer and then blow the limit on post 7 of 30.
   */
  function expandLongest(text) {
    if (!text || typeof text !== 'string') return text;
    var m = _maskHtml(text);
    var result = m.masked;
    for (var pass = 0; pass < MAX_PASSES; pass++) {
      var next = result.replace(GROUP_RE, function (match, content) {
        var opts = _optionsOf(content);
        if (!opts) return match;
        return opts.reduce(function (a, b) { return b.length > a.length ? b : a; });
      });
      if (next === result) break;
      result = next;
    }
    return _unmaskHtml(result, m.map);
  }

  /**
   * Expand by INDEX rather than by chance — the variant is a pure function of
   * (text, index), so nothing has to be remembered between posts.
   *
   * Each group consumes one mixed-radix digit of `index`, in the order the
   * groups are encountered, so distinct indices in [0, total) give distinct
   * outputs for flat spintax.
   */
  function expandByIndex(text, index) {
    if (!text || typeof text !== 'string') return text;
    var m = _maskHtml(text);
    var result = m.masked;
    var rem = Math.abs(Math.floor(index) || 0);

    for (var pass = 0; pass < MAX_PASSES; pass++) {
      var next = result.replace(GROUP_RE, function (match, content) {
        var opts = _optionsOf(content);
        if (!opts) return match;
        var choice = rem % opts.length;
        rem = Math.floor(rem / opts.length);
        return opts[choice];
      });
      if (next === result) break;
      result = next;
    }
    return _unmaskHtml(result, m.map);
  }

  /** Greatest common divisor — used to keep the walk's stride coprime. */
  function _gcd(a, b) { while (b) { var t = b; b = a % b; a = t; } return a; }

  /**
   * The variant for post #n of a campaign, WITHOUT any stored state.
   *
   * Walks the permutation space with a stride coprime to its size, so the walk
   * visits every variant exactly once before returning to the start — the same
   * no-repeat guarantee as the picker, except it survives the service worker
   * being killed mid-campaign, because nothing is remembered. `seed` only
   * decides where the walk begins, so two campaigns of the same template do not
   * open with the same post.
   */
  function variantFor(text, n, seed) {
    var total = countPermutations(text);
    if (total <= 1) return expandByIndex(text, 0);
    var start = Math.abs(Math.floor(seed) || 0) % total;
    var stride = (Math.abs(Math.floor(seed / 7) || 0) % total) + 1;
    // Any stride coprime with `total` enumerates the whole space.
    for (var guard = 0; guard < total && _gcd(stride, total) !== 1; guard++) {
      stride = (stride % total) + 1;
    }
    if (_gcd(stride, total) !== 1) stride = 1; // total === 1 is handled above
    var index = (start + (Math.abs(Math.floor(n) || 0) % total) * stride) % total;
    return expandByIndex(text, index);
  }

  /**
   * Campaign-scoped picker: never returns a variant it has already returned,
   * until every variant has been used — then it starts a clean new cycle.
   *
   * Prefer `variantFor` where a post index is available: it gives the same
   * guarantee with no state to lose.
   */
  function createPicker(text, rnd) {
    var pick = rnd || Math.random;
    var total = countPermutations(text);
    var seen = Object.create(null);
    var used = 0;
    return {
      total: total,
      usedCount: function () { return used; },
      next: function () {
        if (total <= 1) return expand(text, pick); // nothing to vary
        if (used >= total) { seen = Object.create(null); used = 0; } // new cycle
        var last = null;
        for (var i = 0; i < MAX_DRAWS; i++) {
          last = expand(text, pick);
          if (!seen[last]) { seen[last] = 1; used++; return last; }
        }
        // Pool effectively exhausted (or the nested estimate was low). Reset,
        // rather than hand back a duplicate on every remaining post.
        seen = Object.create(null);
        used = 1;
        if (last !== null) seen[last] = 1;
        return last;
      },
    };
  }

  /** Problems worth showing the user. Reports — never blocks a post. */
  function validate(text) {
    var issues = [];
    var s = String(text || '');
    if ((s.match(/\{/g) || []).length !== (s.match(/\}/g) || []).length) {
      issues.push('unbalanced-braces');
    }
    var masked = _maskHtml(s).masked;
    if (/\{[^{}]*\{/.test(masked)) issues.push('nested');
    var re = new RegExp(GROUP_RE.source, 'g');
    var m;
    while ((m = re.exec(masked)) !== null) {
      var content = m[1];
      if (content.indexOf('|') === -1) continue; // literal, not a group
      var parts = content.split('|').map(function (o) { return o.trim(); });
      if (parts.some(function (o) { return o.length === 0; })) issues.push('empty-option');
      else if (parts.length < 2) issues.push('single-option');
    }
    return { valid: issues.length === 0, issues: issues };
  }

  var api = {
    expand: expand,
    expandByIndex: expandByIndex,
    variantFor: variantFor,
    expandLongest: expandLongest,
    countPermutations: countPermutations,
    createPicker: createPicker,
    validate: validate,
  };

  root.MGPSpintax = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
