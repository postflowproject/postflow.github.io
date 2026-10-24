// worker_safety.js — Safety UI controllers for worker.html.
// Handles toasts (duplicate / cap warnings), settings persistence, health
// dashboard rendering, and the ban-backoff banner. All state is read/written
// via chrome.storage.local; background.js owns the actual logic.
// Extracted from inline <script> because MV3 CSP blocks inline execution.

// ── Toast: duplicate-content warning ─────────────────────────────────────────
(function () {
  const host = document.getElementById('toastHost');
  if (!host) return;
  const seen = { duplicate: 0 };

  function showToast({ title, body, variant, ttlMs = 6000 }) {
    const el = document.createElement('div');
    el.className = 'toast' + (variant ? ' toast-' + variant : '');
    const t = document.createElement('div');
    t.className = 'toast-title';
    t.textContent = title;
    const b = document.createElement('div');
    b.className = 'toast-body';
    b.textContent = body;
    el.appendChild(t);
    el.appendChild(b);
    host.appendChild(el);
    setTimeout(() => {
      el.style.animation = 'toastOut .2s ease forwards';
      setTimeout(() => el.remove(), 220);
    }, ttlMs);
  }

  function handleWarning(w) {
    if (!w || !w.ts || w.ts <= seen.duplicate) return;
    seen.duplicate = w.ts;
    showToast({
      title: 'Similar content detected',
      body: 'This post closely matches a recent one. Consider rewording to avoid Facebook spam flags.',
      variant: 'warning',
    });
  }

  try {
    chrome.storage.local.get('_lastDuplicateWarning', (items) => {
      if (items && items._lastDuplicateWarning) {
        seen.duplicate = items._lastDuplicateWarning.ts || 0;
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes._lastDuplicateWarning) handleWarning(changes._lastDuplicateWarning.newValue);
    });
  } catch (_) {}
})();

// ── Health dashboard (Today vs Safety floor, Smart delay tier, Strikes) ─────
// Renders live values from _postHistory, _banStrikes, _lastPostSuccessAt.
// Tier table below MUST stay in sync with getDelayTier() in background.js.
(function () {
  const SAFETY_FLOOR = 200;
  const dashDay     = document.getElementById('dashPostsToday');
  const dashDaySub  = document.getElementById('dashPostsTodaySub');
  const dashTier    = document.getElementById('dashDelayTier');
  const dashTierSub = document.getElementById('dashDelayTierSub');
  const dashStrk    = document.getElementById('dashStrikes');
  const dashStrkSub = document.getElementById('dashStrikesSub');
  const dashLast    = document.getElementById('dashLastSuccess');
  const dashLastSub = document.getElementById('dashLastSuccessSub');
  if (!dashDay) return;

  const STRIKE_HOURS = [24, 72, 168, 720];

  function getDelayTier(n) {
    if (n <  10) return { delayMultiplier: 1.0, restMultiplier: 0.8 };
    if (n <  30) return { delayMultiplier: 1.5, restMultiplier: 1.0 };
    if (n <  60) return { delayMultiplier: 2.5, restMultiplier: 1.2 };
    if (n < 100) return { delayMultiplier: 4.0, restMultiplier: 1.4 };
    return              { delayMultiplier: 6.0, restMultiplier: 1.5 };
  }

  function render(items) {
    const hist = Array.isArray(items?._postHistory) ? items._postHistory : [];
    // Calendar day (resets at local midnight), matches background.js:getPostsToday.
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const startOfDay = d.getTime();
    let dailyCnt = 0;
    for (const e of hist) {
      if (!e || !e.ts) continue;
      if (e.ts >= startOfDay) dailyCnt++;
    }

    if (dashDay) {
      dashDay.textContent = dailyCnt + ' / ' + SAFETY_FLOOR;
      const ratio = dailyCnt / SAFETY_FLOOR;
      dashDay.className = 'metric-value dash-card-value ' +
        (dailyCnt >= SAFETY_FLOOR ? 'error' : ratio >= 0.8 ? 'warn' : 'ok');
      if (dashDaySub) {
        dashDaySub.textContent = dailyCnt >= SAFETY_FLOOR
          ? 'Safety limit reached'
          : (SAFETY_FLOOR - dailyCnt) + ' posts left today';
      }
    }

    if (dashTier) {
      const tier = getDelayTier(dailyCnt);
      dashTier.textContent = tier.delayMultiplier.toFixed(1) + '×';
      dashTier.className = 'metric-value dash-card-value ' +
        (tier.delayMultiplier >= 4.0 ? 'error' :
         tier.delayMultiplier >= 2.0 ? 'warn'  : 'ok');
      if (dashTierSub) {
        const restMin = (3 * tier.restMultiplier).toFixed(1);
        dashTierSub.textContent = `Rest ~${restMin}m / 3 posts`;
      }
    }

    const strikes = items?._banStrikes || 0;
    if (dashStrk) {
      dashStrk.textContent = String(strikes);
      dashStrk.className = 'metric-value dash-card-value ' +
        (strikes >= 2 ? 'error' : strikes >= 1 ? 'warn' : 'ok');
    }
    if (dashStrkSub) {
      if (strikes === 0) {
        dashStrkSub.textContent = 'Clean';
      } else {
        const hrs = STRIKE_HOURS[Math.min(strikes - 1, STRIKE_HOURS.length - 1)];
        dashStrkSub.textContent = 'Next: ' + (hrs >= 24 ? Math.round(hrs/24) + 'd' : hrs + 'h');
      }
    }

    const lastTs = items?._lastPostSuccessAt || 0;
    if (dashLast) {
      if (!lastTs) {
        dashLast.textContent = '—';
        dashLast.className = 'dash-card-value';
        if (dashLastSub) dashLastSub.textContent = 'No posts yet';
      } else {
        const mins = Math.floor((Date.now() - lastTs) / 60000);
        const hrs  = Math.floor(mins / 60);
        const label = hrs >= 24 ? Math.floor(hrs/24) + 'd ago'
                    : hrs > 0   ? hrs + 'h ago'
                    : mins > 0  ? mins + 'm ago'
                    : 'just now';
        dashLast.textContent = label;
        dashLast.className = 'dash-card-value ok';
        if (dashLastSub) dashLastSub.textContent = new Date(lastTs).toLocaleString();
      }
    }
  }

  function loadAll() {
    try {
      chrome.storage.local.get(
        ['_postHistory', '_banStrikes', '_lastPostSuccessAt'],
        render
      );
    } catch (_) {}
  }

  loadAll();
  setInterval(loadAll, 30000);

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const keys = ['_postHistory', '_banStrikes', '_lastPostSuccessAt'];
      if (keys.some((k) => k in changes)) loadAll();
    });
  } catch (_) {}
})();

// ── Safety-floor confirm modal ───────────────────────────────────────────────
// background.js writes `_safetyConfirmRequest` when a batch would cross the
// 200/day floor. We show a modal and write back `_safetyConfirmResponse` with
// the user's decision.
(function () {
  const modal   = document.getElementById('sfModal');
  const numbers = document.getElementById('sfModalNumbers');
  const body    = document.getElementById('sfModalBody');
  const accept  = document.getElementById('sfModalAccept');
  const cancel  = document.getElementById('sfModalCancel');
  if (!modal || !accept || !cancel) return;

  let lastTs = 0;
  let currentReqTs = 0;

  function hide() {
    modal.classList.remove('visible');
    currentReqTs = 0;
  }

  function respond(decision) {
    if (!currentReqTs) { hide(); return; }
    try {
      chrome.storage.local.set({
        _safetyConfirmResponse: { decision, ts: Date.now(), reqTs: currentReqTs },
      });
    } catch (_) {}
    hide();
  }

  function show(req) {
    if (!req || !req.ts || req.ts <= lastTs) return;
    lastTs = req.ts;
    currentReqTs = req.ts;
    const posts = Number(req.postsToday) || 0;
    const batch = Number(req.batchSize)  || 0;
    const floor = Number(req.floor)      || 200;
    const proj  = Number(req.projected)  || (posts + batch);
    body.textContent =
      `Publishing ${batch} more posts would put you at ${proj} posts in the last 24 hours — above the ${floor}/day safety threshold.`;
    if (numbers) {
      numbers.textContent =
        `Already today: ${posts}   ·   This batch: ${batch}   ·   Projected: ${proj}/${floor}`;
    }
    modal.classList.add('visible');
  }

  accept.addEventListener('click', () => respond('accept'));
  cancel.addEventListener('click', () => respond('cancel'));

  try {
    chrome.storage.local.get('_safetyConfirmRequest', (items) => {
      if (items && items._safetyConfirmRequest) show(items._safetyConfirmRequest);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes._safetyConfirmRequest) {
        const v = changes._safetyConfirmRequest.newValue;
        if (v) show(v);
        else hide();
      }
    });
  } catch (_) {}
})();

// ── Ban banner removed (2026-05-01) ─────────────────────────────────────────
// The cross-campaign cooldown system was removed; banner has nothing to show.
// Hide the banner element on load so any leftover DOM from the HTML template
// doesn't render. Kept the DOM structure for backward compatibility.
(function () {
  const banner = document.getElementById('banBanner');
  if (banner) banner.classList.remove('visible');
})();
