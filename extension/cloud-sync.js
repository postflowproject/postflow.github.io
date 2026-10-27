(() => {
  "use strict";
  const cfg = window.POSTFLOW_FIREBASE_CONFIG || {};
  const keys = ["caption", "firstComment", "campaignName", "groups", "discoveredGroups", "selectedGroups", "completedGroups", "dashboardActivity", "postflowCampaigns", "postflowReviewQueue", "captionHistory"];
  const baselineKey = uid => "postflowSyncBaseline:" + uid;
  const cacheKey = uid => "postflowWorkspaceCache:" + uid;
  const activeUidKey = "postflowWorkspaceActiveUid";
  const legacyMigratedKey = "postflowWorkspaceLegacyMigrated";
  let activeUser = null, generation = 0, busy = false, dirty = false, remoteWrite = false, switching = false, timer = null, baseline = {};
  let accountSwitchPromise = Promise.resolve(), accountSwitchError = null;
  const endpoint = uid => "https://firestore.googleapis.com/v1/projects/" + encodeURIComponent(cfg.projectId) + "/databases/(default)/documents/users/" + encodeURIComponent(uid) + "/workspace/main";
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const meaningful = value => typeof value === "string" ? value.length > 0 : Array.isArray(value) ? value.length > 0 : value && typeof value === "object" ? Object.keys(value).length > 0 : value !== undefined && value !== null && value !== false && value !== 0;
  const isConflict = error => error.status === 409 || error.status === 412 || error.code === "ABORTED" || error.code === "FAILED_PRECONDITION";
  function encodeData(data) {
    const serialized = JSON.stringify(data);
    if (new TextEncoder().encode(serialized).length > 850000) throw new Error("Your workspace is too large to sync in one document.");
    return { fields: { data: { stringValue: serialized }, updatedAt: { timestampValue: new Date().toISOString() } } };
  }
  function decodeData(doc) { try { const raw = doc?.fields?.data?.stringValue; return typeof raw === "string" ? JSON.parse(raw) : null; } catch { return null; } }
  function setStatus(text) { const node = document.getElementById("status"); if (node) node.textContent = text; }
  async function localData() { const data = await chrome.storage.local.get(keys); return Object.fromEntries(keys.filter(key => data[key] !== undefined).map(key => [key, data[key]])); }
  async function saveLocalCache(uid) {
    const data = await localData();
    await chrome.storage.local.set({ [cacheKey(uid)]: data });
  }
  async function switchLocalWorkspace(uid, ticket) {
    switching = true;
    try {
      let stored = await chrome.storage.local.get([activeUidKey, legacyMigratedKey, cacheKey(uid)]);
      const previousUid = stored[activeUidKey];
      if (previousUid) {
        await saveLocalCache(previousUid);
        stored = await chrome.storage.local.get([activeUidKey, legacyMigratedKey, cacheKey(uid)]);
      }
      assertCurrent(uid, ticket);
      let next = stored[cacheKey(uid)];
      if (!next && !stored[legacyMigratedKey] && !previousUid) next = await localData();
      next = next && typeof next === "object" ? next : {};
      const staleKeys = keys.filter(key => next[key] === undefined);
      if (staleKeys.length) await chrome.storage.local.remove(staleKeys);
      remoteWrite = true;
      try { await chrome.storage.local.set(next); }
      finally { remoteWrite = false; }
      await chrome.storage.local.set({ [activeUidKey]: uid, [legacyMigratedKey]: true });
      await saveLocalCache(uid);
    } finally { switching = false; }
  }
  function assertCurrent(uid, ticket) { if (!activeUser || activeUser.uid !== uid || generation !== ticket) throw new Error("Account changed during sync; retry after signing in."); }
  async function request(uid, ticket, url, options = {}) {
    assertCurrent(uid, ticket);
    const idToken = window.PostFlowAuth?.getAccessToken?.();
    if (!idToken) throw new Error("Sign in to sync your workspace.");
    const response = await fetch(url, { ...options, headers: { Authorization: "Bearer " + idToken, "Content-Type": "application/json", ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({})); assertCurrent(uid, ticket);
    if (!response.ok) { const error = new Error(body.error?.message || "Cloud sync failed (" + response.status + ")."); error.status = response.status; error.code = body.error?.status; throw error; }
    return body;
  }
  async function getRemote(uid, ticket) { try { return await request(uid, ticket, endpoint(uid)); } catch (error) { if (error.status === 404 && error.code === "NOT_FOUND") return null; throw error; } }
  async function writeRemote(uid, ticket, data, updateTime) {
    const suffix = updateTime ? "?currentDocument.updateTime=" + encodeURIComponent(updateTime) : "?currentDocument.exists=false";
    return request(uid, ticket, endpoint(uid) + suffix, { method: "PATCH", body: JSON.stringify(encodeData(data)) });
  }
  function merge(local, remote, previous) {
    const result = { ...remote }, conflicts = [];
    for (const key of keys) {
      const hasLocal = Object.prototype.hasOwnProperty.call(local, key), hasRemote = Object.prototype.hasOwnProperty.call(remote, key), hasBase = Object.prototype.hasOwnProperty.call(previous, key);
      const localChanged = hasLocal && (hasBase ? !equal(local[key], previous[key]) : meaningful(local[key]));
      const remoteChanged = hasRemote && (!hasBase || !equal(remote[key], previous[key]));
      if (localChanged && (!hasRemote || !equal(local[key], remote[key]))) { result[key] = local[key]; if (remoteChanged) conflicts.push(key); }
    }
    return { data: result, conflicts };
  }
  async function saveBaseline(uid, data) { baseline = data; await chrome.storage.local.set({ [baselineKey(uid)]: data }); }
  async function pushNow(uid, ticket) {
    if (busy) { dirty = true; return; }
    busy = true; dirty = false;
    try {
      let local = await localData(); assertCurrent(uid, ticket);
      let remote = await getRemote(uid, ticket), attempt = 0;
      while (attempt++ < 3) {
        const cloud = decodeData(remote) || {}, merged = merge(local, cloud, baseline);
        try {
          await writeRemote(uid, ticket, merged.data, remote?.updateTime || null);
          await saveBaseline(uid, merged.data);
          setStatus(merged.conflicts.length ? "Sync completed. Local edits kept for: " + merged.conflicts.join(", ") : "Synced to your PostFlow account."); break;
        } catch (error) {
          if (!isConflict(error) || attempt >= 3) throw error;
          remote = await getRemote(uid, ticket); local = await localData();
        }
      }
    } catch (error) { if (activeUser?.uid === uid && generation === ticket) setStatus("Cloud sync paused: " + error.message); }
    finally { busy = false; if (activeUser?.uid === uid && generation === ticket && dirty) schedulePush(); }
  }
  async function pullOrSeed(uid, ticket) {
    try {
      const local = await localData(); assertCurrent(uid, ticket);
      const stored = await chrome.storage.local.get(baselineKey(uid)); baseline = stored[baselineKey(uid)] || {};
      let remote = await getRemote(uid, ticket);
      if (!remote) {
        try { await writeRemote(uid, ticket, local, null); await saveBaseline(uid, local); setStatus("Workspace saved to your PostFlow account."); }
        catch (error) { if (!isConflict(error)) throw error; remote = await getRemote(uid, ticket); }
      }
      if (remote) {
        const cloud = decodeData(remote);
        if (!cloud || typeof cloud !== "object" || Array.isArray(cloud)) throw new Error("The cloud workspace data is invalid; local data was left unchanged.");
        const merged = merge(local, cloud, baseline);
        remoteWrite = true; try { await chrome.storage.local.set(merged.data); } finally { remoteWrite = false; }
        await saveLocalCache(uid);
        if (!equal(merged.data, cloud)) { await saveBaseline(uid, cloud); await pushNow(uid, ticket); }
        else { await saveBaseline(uid, cloud); setStatus(merged.conflicts.length ? "Cloud sync found local edits; kept local values for: " + merged.conflicts.join(", ") : "Workspace synced from your PostFlow account."); }
      }
    } catch (error) { if (activeUser?.uid === uid && generation === ticket) setStatus("Cloud sync paused: " + error.message); }
  }
  function schedulePush() {
    if (!activeUser || !cfg.projectId) return;
    if (busy) { dirty = true; return; }
    clearTimeout(timer); const uid = activeUser.uid, ticket = generation; timer = setTimeout(() => pushNow(uid, ticket), 800);
  }
  window.addEventListener("postflow:authenticated", event => {
    const uid = event.detail?.user?.uid; if (!uid || uid === activeUser?.uid) return;
    generation++; activeUser = { uid }; dirty = false; clearTimeout(timer); const ticket = generation;
    if (!cfg.projectId) { setStatus("Firebase setup needed: configure extension/firebase-config.js."); return; }
    accountSwitchError = null;
    accountSwitchPromise = switchLocalWorkspace(uid, ticket)
      .then(() => pullOrSeed(uid, ticket))
      .then(() => {
        if (activeUser?.uid === uid && generation === ticket) window.dispatchEvent(new CustomEvent("postflow:workspace-switched", { detail: { uid } }));
      })
      .catch(error => {
        accountSwitchError = error;
        if (activeUser?.uid === uid && generation === ticket) setStatus("Account workspace switch failed: " + error.message);
      });
  });
  window.addEventListener("postflow:logout", () => {
    const uid = activeUser?.uid;
    generation++; activeUser = null; dirty = false; clearTimeout(timer);
    if (!uid) return;
    switching = true;
    saveLocalCache(uid)
      .then(() => chrome.storage.local.set({ [activeUidKey]: null }))
      .catch(error => setStatus("Local account cache could not be saved: " + error.message))
      .finally(() => { switching = false; });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || remoteWrite || switching || !activeUser) return;
    if (keys.some(key => Object.prototype.hasOwnProperty.call(changes, key))) {
      const uid = activeUser.uid, ticket = generation;
      saveLocalCache(uid).then(() => { if (activeUser?.uid === uid && generation === ticket) schedulePush(); });
    }
  });
  window.addEventListener("online", schedulePush);
  window.PostFlowCloudSync = {
    syncNow: () => activeUser ? pushNow(activeUser.uid, generation) : Promise.resolve(),
    waitUntilReady: async uid => {
      if (activeUser?.uid === uid) await accountSwitchPromise;
      if (accountSwitchError && activeUser?.uid === uid) throw accountSwitchError;
    },
    isReady: () => Boolean(cfg.projectId && activeUser),
  };
})();
