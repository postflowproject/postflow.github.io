// MultiGroupPoster · AI assistants (MCP), v2026-10-18.
// The person connects Claude, ChatGPT, Gemini, Grok or Codex once, with a 6-digit code (Help → Connect an AI assistant).
// The assistant creates posts on mcp.multiplegroupposter.com; this file picks them up and runs them through the worker's
// own POST_PAYLOAD handler, exactly like the Publish button, then reports the result back.
// Nothing here touches the network until the person asks for a code: no alarm, no poll.
// Loaded by mgp-service-worker.js with importScripts, before any message listener is registered.
const MGP_AI_BASE = 'https://mcp.multiplegroupposter.com';
const MGP_AI_KEY = '_mgpAiBridge';            // { installId, secret, pairedAt }
const MGP_AI_JOB_KEY = '_mgpAiActiveJob';     // the publish_now job a running campaign belongs to
const MGP_AI_ALARM = 'mgp_ai_poll';
const MGP_AI_PAIR_TTL_MS = 25 * 60 * 1000;    // the code lives 20 min on the server

// The worker's own message handlers, kept so a job goes through them exactly like the popup's message.
const __mgpMsgListeners = [];
(() => {
  try {
    const add = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
    chrome.runtime.onMessage.addListener = (fn) => { __mgpMsgListeners.push(fn); return add(fn); };
  } catch (_) {}
})();
function mgpAiDispatch(msg, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const answer = (r) => { if (!done) { done = true; resolve(r); } };
    const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('index.html'), origin: 'mgp-ai-bridge' };
    for (const fn of __mgpMsgListeners) { try { fn(msg, sender, answer); } catch (e) { console.warn('[ai] listener threw', e && e.message); } }
    setTimeout(() => answer({ noAnswer: true }), timeoutMs);
  });
}

async function mgpAiGet(key) { try { return (await chrome.storage.local.get(key))[key] || null; } catch (_) { return null; } }
const mgpAiCreds = () => mgpAiGet(MGP_AI_KEY);
/** The remote switch: flags.aiAssistant === false turns the whole thing off for everyone (no poll, jobs refused). */
async function mgpAiEnabled() { const f = await mgpAiGet('_remoteFlags'); return !(f && f.aiAssistant === false); }
function mgpAiTrack(event, props) { try { if (typeof ampSend === 'function') void ampSend(event, props); } catch (_) {} }

async function mgpAiFetch(p, opts = {}) {
  const c = await mgpAiCreds();
  if (!c) throw new Error('not connected');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs || 40000);
  try {
    return await fetch(MGP_AI_BASE + p, { ...opts, signal: ctl.signal, headers: { ...(opts.headers || {}), 'x-mgp-install': c.installId, 'x-mgp-secret': c.secret } });
  } finally { clearTimeout(t); }
}
function mgpAiEnsureAlarm() {
  try { chrome.alarms.get(MGP_AI_ALARM, (a) => { if (!a) chrome.alarms.create(MGP_AI_ALARM, { periodInMinutes: 0.5 }); }); } catch (_) {}
}
function mgpAiClearAlarm() { try { chrome.alarms.clear(MGP_AI_ALARM); } catch (_) {} }

/** "Connect an AI assistant": a fresh 6-digit code (valid 60 min) for the assistant's sign-in page. */
async function mgpAiPair() {
  if (!(await mgpAiEnabled())) return { ok: false, reason: 'off' };
  const c = await mgpAiCreds();
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  let j;
  try {
    const r = await fetch(MGP_AI_BASE + '/ext/pair', { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c ? { installId: c.installId, secret: c.secret } : {}) });
    if (!r.ok) return { ok: false, reason: 'server_' + r.status };
    j = await r.json();
  } catch (_) { return { ok: false, reason: 'offline' }; } finally { clearTimeout(t); }
  await chrome.storage.local.set({ [MGP_AI_KEY]: { installId: j.installId, secret: j.secret, pairedAt: (c && c.pairedAt) || Date.now(), codeAt: Date.now() } });
  mgpAiEnsureAlarm();
  mgpAiKick();
  mgpAiTrack('ai_assistant_code', { first: !c });
  return { ok: true, code: j.code, url: MGP_AI_BASE + '/mcp', expiresIn: j.expires_in || 1200 };
}

/** Disconnect every assistant: the server forgets this install, its sign-ins stop working, and polling stops. */
async function mgpAiUnpair() {
  try { await mgpAiFetch('/ext/unpair', { method: 'POST', timeoutMs: 10000 }); } catch (_) {}
  await chrome.storage.local.remove([MGP_AI_KEY, MGP_AI_JOB_KEY]);
  mgpAiClearAlarm();
  mgpAiTrack('ai_assistant_disconnect', {});
  return { ok: true };
}

/** For the Help screen: connected or not, how many assistants signed in, the last post. */
async function mgpAiStatus() {
  const c = await mgpAiCreds();
  if (!c) return { connected: false, assistants: 0, enabled: await mgpAiEnabled() };
  let s = null;
  try { const r = await mgpAiFetch('/ext/status', { timeoutMs: 8000 }); if (r.ok) s = await r.json(); } catch (_) {}
  return { connected: true, assistants: s ? Number(s.assistants) || 0 : null, pending: (s && Array.isArray(s.pending)) ? s.pending.slice(0, 3) : [], lastJob: (s && s.lastJob) || null, enabled: await mgpAiEnabled() };
}

/** The last step of connecting: the person picks the number the sign-in page shows (or refuses). A guessed code alone gets nothing. */
async function mgpAiApprove(id, allow, pick) {
  try {
    const r = await mgpAiFetch('/ext/approve', { method: 'POST', timeoutMs: 10000, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: String(id || ''), allow: allow === true, pick: Number(pick) || 0 }) });
    if (!r.ok) return { ok: false, reason: 'server_' + r.status };
    const out = await r.json();
    mgpAiTrack('ai_assistant_approve', { allow: allow === true, outcome: out.status || 'error' });
    return { ...out, ok: out.ok !== false };
  } catch (_) { return { ok: false, reason: 'offline' }; }
}

async function mgpAiReport(jobId, status, detail, extra = {}) {
  try { await mgpAiFetch('/ext/jobs/' + jobId, { method: 'POST', timeoutMs: 15000, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, detail, ...extra }) }); } catch (_) {}
}
async function mgpAiSyncLists() {
  const d = await chrome.storage.local.get('fb-group-lists');
  const lists = ((d['fb-group-lists'] && d['fb-group-lists'].state && d['fb-group-lists'].state.groupLists) || [])
    .slice(0, 200)   // what the server keeps; a huge set of lists must still fit its 128 KB limit
    .map((l) => ({ id: String(l.id).slice(0, 64), name: String(l.name || '').slice(0, 120), count: (l.urls || []).length }));
  // v2026-10-19 · what the assistant needs to guide the person before a post fails: signed in? plan? version (no email)
  // (a failure here must never stop the lists or the posts)
  const status = {};
  try {
    const sync = await chrome.storage.sync.get(['user', 'postsRemaining', 'isPremium']);
    status.version = String((chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '');
    status.signedIn = !!(sync.user && sync.user.email);
    status.premium = sync.isPremium === true;
    if (typeof sync.postsRemaining === 'number' && Number.isFinite(sync.postsRemaining)) status.freeRunsLeft = sync.postsRemaining;
  } catch (_) {}
  await mgpAiFetch('/ext/sync', { method: 'POST', timeoutMs: 15000, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lists, ...status }) });
}

/** A photo as the media picker stores it: JPEG, the long side at most 1920 px, on white (a transparent PNG must not turn black). */
async function mgpAiReencode(blob) {
  const bmp = await createImageBitmap(blob);
  const MAX = 1920; let w = bmp.width, h = bmp.height;
  if (w > MAX || h > MAX) { const k = Math.min(MAX / w, MAX / h); w = Math.round(w * k); h = Math.round(h * k); }
  const c = new OffscreenCanvas(w, h); const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
}
const mgpAiHtml = (text) => String(text || '').split(/\r?\n/).map((line) => '<p>' + (line.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch])) || '<br>') + '</p>').join('');

/** Removes the given MediaDB keys (a finished job's photos must not stay in the composer). */
function mgpAiDropMedia(keys) {
  return new Promise((res) => {
    if (!keys || !keys.length) return res(0);
    const q = indexedDB.open('MediaDB', 1);
    q.onsuccess = () => { const tx = q.result.transaction('media', 'readwrite'); for (const k of keys) tx.objectStore('media').delete(k); tx.oncomplete = () => { q.result.close(); res(keys.length); }; tx.onerror = () => res(0); };
    q.onerror = () => res(0);
  });
}

/** Free posts left, the same rule as the Publish button: the cached plan, and the server once (≤ 4 s) before refusing. */
async function mgpAiPlanAllows(email) {
  const sync = await chrome.storage.sync.get(['postsRemaining', 'isPremium']);
  const remaining = typeof sync.postsRemaining !== 'undefined' ? sync.postsRemaining : 6;
  if (sync.isPremium || remaining > 0) return true;
  try {
    const live = await Promise.race([
      Promise.all([fetchSubscriptionStatus(email), getCredits(email)]),
      new Promise((r) => setTimeout(() => r(null), 4000)),
    ]);
    if (live && ((live[0] && live[0].isPremium === true) || (live[1] && Number(live[1].credits) > 0))) return true;
  } catch (_) {}
  return false;
}

class MgpAiRefusal extends Error { constructor(code, msg) { super(msg); this.code = code; } }

async function mgpAiRun(job) {
  if (!(await mgpAiEnabled())) throw new MgpAiRefusal('off', 'Posting from AI assistants is turned off right now.');
  await mgpAiReport(job.id, 'running', 'picked up by MultiGroupPoster');
  const d = await chrome.storage.local.get(['fb-group-lists', 'fb-post-scheduler', '_activeProfileId']);
  const list = ((d['fb-group-lists'] && d['fb-group-lists'].state && d['fb-group-lists'].state.groupLists) || []).find((l) => l.id === job.listId);
  if (!list) throw new MgpAiRefusal('list_missing', 'That group list is not in MultiGroupPoster any more.');
  const urls = (list.urls || []).filter(Boolean);
  if (!urls.length) throw new MgpAiRefusal('list_empty', 'That group list has no groups.');

  if (job.mode !== 'draft') {
    // one post from the assistant at a time: a second one must not touch the first one's mark or results
    if (await mgpAiGet(MGP_AI_JOB_KEY)) throw new MgpAiRefusal('busy', 'MultiGroupPoster is still posting the previous post from the assistant.');
    const sync = await chrome.storage.sync.get(['user']);
    const email = sync && sync.user && sync.user.email;
    if (!email) throw new MgpAiRefusal('not_signed_in', 'MultiGroupPoster is not signed in.');
    if (!(await mgpAiPlanAllows(email))) throw new MgpAiRefusal('free_plan_used_up', 'The free posts are used up.');
  }

  // the media, into MediaDB exactly as the media picker saves it
  const imageIds = [], videoIds = [];
  let order = Date.now() * 1000;
  for (const m of job.media || []) {
    const r = await mgpAiFetch(new URL(m.url).pathname, { timeoutMs: 120000 });
    if (!r.ok) throw new MgpAiRefusal('media_missing', 'A photo or video is no longer available (older than 24 hours).');
    let blob = await r.blob();
    const isVideo = /^video\//.test(m.mime || blob.type || '');
    if (!isVideo) blob = await mgpAiReencode(blob);
    const key = 'ai_' + job.id + '_' + m.id;
    const name = String(m.name || 'photo').replace(/\.[^.]+$/, '') + (isVideo ? '.mp4' : '.jpg');
    const saved = await saveFileToIndexedDB(key, new File([blob], name, { type: isVideo ? (m.mime || blob.type) : 'image/jpeg' }), order++);
    if (saved && saved.ok === false) throw new MgpAiRefusal('storage', saved.diskFull ? 'The computer\'s disk is full.' : 'The photo could not be saved.');
    (isVideo ? videoIds : imageIds).push(key);
  }

  if (job.mode === 'draft') {
    const ps = d['fb-post-scheduler'] || { state: {}, version: 0 };
    ps.state = ps.state || {};
    ps.state.draftPost = { ...(ps.state.draftPost || {}), content: mgpAiHtml(job.text), comments: job.firstComment ? [{ text: job.firstComment, imageId: null, delayMinutes: 0 }] : [], commentText: job.firstComment || '' };
    ps.state.selectedListIds = [list.id]; ps.state.selectedGroupId = list.id; ps.state.selectionMode = 'lists';
    await chrome.storage.local.set({ 'fb-post-scheduler': ps });
    // an open popup holds its own copy and would write it back over this draft: ask it to read the saved state again
    try { chrome.runtime.sendMessage({ action: 'AI_DRAFT_WRITTEN' }, () => void chrome.runtime.lastError); } catch (_) {}
    await mgpAiReport(job.id, 'draft_ready', 'Waiting in MultiGroupPoster: open it, check the post and press Publish. ' + imageIds.length + ' photo(s), ' + videoIds.length + ' video(s), list "' + list.name + '".');
    mgpAiTrack('ai_assistant_job', { mode: 'draft', groups: urls.length, media: imageIds.length + videoIds.length, outcome: 'draft_ready' });
    return;
  }

  // publish now: the same payload the Publish button builds
  const actor = d._activeProfileId || null;
  let me = null; try { me = await getFbCookie('c_user'); } catch (_) {}
  const payload = {
    action: '',
    post: { title: 'title 1', text: mgpAiHtml(job.text), image_ids: imageIds, links: [], video_id: videoIds,
      commentText: job.firstComment || '', comments: job.firstComment ? [{ text: job.firstComment, imageId: null, delayMinutes: 0 }] : [],
      imageSetsEnabled: false, imageSets: [], listing: null },
    group: { urls },
    timeInSeconds: 10, background: '', activeIndex: '0', activeIndexProducts: '', avoidNightTimePosting: false,
    brandMode: { actorId: actor, actorType: actor && me && actor !== me ? 'page' : 'personal', pageName: null },
    deliveryOptions: { pacingEnabled: true, postsBefore: 1, waitMinutes: 1, randomizeWait: false, randomOrder: false, postingMethod: job.method === 'safe' ? 'safe' : 'fast', humanLevel: 0, postCount: 25, isNewAccount: false, boostPacing: false },
    _scope: { mode: 'lists', bundleIds: [list.id] },
    // the worker merges the popup's last delivery setting over every payload; a method the person named in the chat must survive it
    _mgpAiMethod: job.method === 'safe' || job.method === 'fast' ? job.method : null,
  };
  const resp = await mgpAiDispatch({ action: 'POST_PAYLOAD', payload });
  if (!resp || resp.rejected || resp.noAnswer) {
    await mgpAiDropMedia([...imageIds, ...videoIds]);
    if (!resp || resp.noAnswer) throw new MgpAiRefusal('error', 'MultiGroupPoster did not start the campaign.');
    throw new MgpAiRefusal('busy', resp.reason === 'paused_campaign' ? 'A paused campaign is waiting in MultiGroupPoster.' : 'Another campaign is running in MultiGroupPoster.');
  }
  // the mark is written only once the worker took the campaign (the worker itself empties postsCompleted at the start)
  await chrome.storage.local.set({ [MGP_AI_JOB_KEY]: { id: job.id, media: [...imageIds, ...videoIds], urls, groups: urls.length, method: job.method || null, startedAt: Date.now(), running: false } });
  await mgpAiReport(job.id, 'posting', 'campaign started in Chrome');
  // the end is reported by mgpAiFinishIfDone (storage change or the next poll): it survives the worker being stopped mid-run
}

/** When the campaign of an AI job has finished: send the per-group result, drop its photos. Safe to call any time. */
let _mgpAiFinishing = false;
async function mgpAiFinishIfDone() {
  if (_mgpAiFinishing) return;
  const a = await mgpAiGet(MGP_AI_JOB_KEY);
  if (!a) return;
  const s = await chrome.storage.local.get(['isPostingInProgress', 'postsCompleted', '_campaignHeartbeatAt']);
  const age = Date.now() - a.startedAt;
  if (s.isPostingInProgress !== 'done') {
    if (!a.running && s.isPostingInProgress !== 'paused') { await chrome.storage.local.set({ [MGP_AI_JOB_KEY]: { ...a, running: true } }); return; }
    // still posting (the worker's 20-s alive signal is fresh) or paused (it can resume for 7 days): wait, keep the photos.
    // Only a campaign that is dead for hours (crash, Force Reset without a clean end) stops being waited for, and its
    // photos are then left alone: the engine might still need them if it comes back.
    const beat = Number(s._campaignHeartbeatAt) || 0;
    const dead = s.isPostingInProgress === 'paused' ? age > 8 * 24 * 3600e3 : (Date.now() - beat > 6 * 3600e3 && age > 12 * 3600e3);
    if (!dead) return;
    _mgpAiFinishing = true;
    try {
      await chrome.storage.local.remove(MGP_AI_JOB_KEY);
      const lostMedia = (await mgpAiGet('_mgpAiLostMedia')) || [];
      if ((a.media || []).length) await chrome.storage.local.set({ _mgpAiLostMedia: [...lostMedia, { keys: a.media, at: Date.now() }].slice(-50) });
      await mgpAiReport(a.id, 'failed', 'MultiGroupPoster stopped without finishing this post.', { code: 'lost' });
    } finally { _mgpAiFinishing = false; }
    return;
  } else if (!a.running && age < 2 * 60e3) {
    return;   // the 'done' of the PREVIOUS campaign, read before this one started
  }
  _mgpAiFinishing = true;
  try {
    const norm = (u) => String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
    const mine = new Set((a.urls || []).map(norm));
    const rows = (s.postsCompleted || []).filter((x) => !mine.size || mine.has(norm(x.link)))
      .map((x) => ({ group: x.link, result: x.response, link: x.postUrl || null, error: x.errorType || null, comment: x.comment || null }));
    await chrome.storage.local.remove(MGP_AI_JOB_KEY);
    await mgpAiDropMedia(a.media);
    const ok = rows.filter((r) => r.result === 'successful').length;
    if (!rows.length) {   // ended before posting anything (no internet, a declined safety question, a reset): not a success
      await mgpAiReport(a.id, 'failed', 'MultiGroupPoster stopped before posting to any group.', { code: 'not_posted', results: [] });
      mgpAiTrack('ai_assistant_job', { mode: 'publish_now', groups: a.groups, outcome: 'not_posted' });
      return;
    }
    await mgpAiReport(a.id, 'done', ok + ' of ' + rows.length + ' posted', { results: rows });
    mgpAiTrack('ai_assistant_job', { mode: 'publish_now', groups: a.groups, method: a.method || 'setting', ok, failed: rows.length - ok, outcome: 'done' });
  } finally { _mgpAiFinishing = false; }
}

/**
 * Photos of an AI post that never finished ('lost') stay for a possible comeback; after 8 days they go (once a day).
 * Only THOSE photos (a list kept when the post was given up): never a draft's, never one the person moved into an
 * Image Set, a paused campaign or a schedule (the worker's referencedMediaIds); if that check fails, nothing goes.
 */
async function mgpAiSweepOldMedia() {
  const last = Number(await mgpAiGet('_mgpAiSweptAt')) || 0;
  if (Date.now() - last < 24 * 3600e3) return 0;
  const lost = (await mgpAiGet('_mgpAiLostMedia')) || [];
  const due = lost.filter((e) => Date.now() - (Number(e.at) || 0) > 8 * 24 * 3600e3);
  await chrome.storage.local.set({ _mgpAiSweptAt: Date.now() });
  if (!due.length) return 0;
  let refs = null;
  try { refs = typeof referencedMediaIds === 'function' ? await referencedMediaIds() : null; } catch (_) { refs = null; }
  if (!refs) return 0;   // fail closed
  const keep = new Set(((await mgpAiGet(MGP_AI_JOB_KEY)) || {}).media || []);
  const gone = [];
  for (const e of due) for (const k of e.keys || []) if (!refs.has(String(k)) && !keep.has(String(k))) gone.push(String(k));
  await mgpAiDropMedia(gone);
  await chrome.storage.local.set({ _mgpAiLostMedia: lost.filter((e) => !due.includes(e)) });
  return gone.length;
}

let _mgpAiBusy = false;
async function mgpAiPoll(waitSec) {
  if (_mgpAiBusy) return;
  _mgpAiBusy = true;
  try {
    const c = await mgpAiCreds();
    if (!c) { mgpAiClearAlarm(); return; }
    if (!(await mgpAiEnabled())) { mgpAiClearAlarm(); return; }
    await mgpAiFinishIfDone();
    mgpAiSweepOldMedia().catch(() => {});
    await mgpAiSyncLists();
    const r = await mgpAiFetch('/ext/jobs?wait=' + waitSec, { timeoutMs: (waitSec + 15) * 1000 });
    if (r.status === 401) { await chrome.storage.local.remove(MGP_AI_KEY); mgpAiClearAlarm(); return; }   // the server forgot this install
    if (!r.ok) return;
    const body = await r.json();
    // a code that was never used: stop polling once it has expired (nobody connected an assistant)
    if (body.assistants === 0 && Date.now() - (c.codeAt || c.pairedAt || 0) > MGP_AI_PAIR_TTL_MS) {
      await chrome.storage.local.remove(MGP_AI_KEY); mgpAiClearAlarm(); return;
    }
    for (const j of body.jobs || []) {
      await mgpAiRun(j).catch((e) => {
        mgpAiTrack('ai_assistant_job', { mode: j.mode, outcome: 'refused', code: (e && e.code) || 'error' });
        return mgpAiReport(j.id, 'failed', String((e && e.message) || e), { code: (e && e.code) || 'error' });
      });
    }
  } catch (e) {
    console.warn('[ai] poll:', e && e.message);
  } finally {
    _mgpAiBusy = false;
  }
}
function mgpAiKick() { mgpAiPoll(25).catch(() => {}); }

// Messages from the popup (Help → Connect an AI assistant).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.action !== 'AI_ASSISTANT') return false;
  const op = msg.op === 'pair' ? mgpAiPair : msg.op === 'unpair' ? mgpAiUnpair : msg.op === 'approve' ? () => mgpAiApprove(msg.id, msg.allow, msg.pick) : mgpAiStatus;
  op().then(sendResponse, (e) => sendResponse({ ok: false, reason: String((e && e.message) || e) }));
  return true;
});
try {
  chrome.alarms.onAlarm.addListener((a) => { if (a && a.name === MGP_AI_ALARM) mgpAiKick(); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch.isPostingInProgress) return;
    if (ch.isPostingInProgress.newValue === 'done') mgpAiFinishIfDone().catch(() => {});
    else mgpAiGet(MGP_AI_JOB_KEY).then((a) => { if (a && !a.running) return chrome.storage.local.set({ [MGP_AI_JOB_KEY]: { ...a, running: true } }); }).catch(() => {});
  });
} catch (_) {}
// at start: poll only for a connected install; make sure nobody else has a stray alarm
mgpAiCreds().then((c) => { if (c) { mgpAiEnsureAlarm(); setTimeout(mgpAiKick, 2000); } else mgpAiClearAlarm(); }).catch(() => {});
