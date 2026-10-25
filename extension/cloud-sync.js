(() => {
  "use strict";
  const cfg = window.POSTFLOW_FIREBASE_CONFIG || {};
  const keys = [
    "caption", "firstComment", "campaignName", "groups", "discoveredGroups",
    "selectedGroups", "completedGroups", "dashboardActivity", "postflowCampaigns",
    "postflowReviewQueue", "captionHistory"
  ];
  let activeUser = null;
  let syncing = false;
  let timer = null;
  let lastPulled = false;
  const endpoint = uid => "https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(cfg.projectId) + "/databases/(default)/documents/users/" +
    encodeURIComponent(uid) + "/workspace/main";
  function encodeData(data) {
    return { fields: { data: { stringValue: JSON.stringify(data) }, updatedAt: { timestampValue: new Date().toISOString() } } };
  }
  function decodeData(doc) {
    const raw = doc?.fields?.data?.stringValue;
    if (typeof raw !== "string") return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  async function token() {
    const value = window.PostFlowAuth?.getAccessToken?.();
    if (!value) throw new Error("Sign in to sync your workspace.");
    return value;
  }
  async function request(url, options = {}) {
    const idToken = await token();
    const response = await fetch(url, { ...options, headers: {
      "Authorization": "Bearer " + idToken,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }});
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const message = body.error?.message || "Cloud sync failed (" + response.status + ").";
      if (response.status === 404) return null;
      throw new Error(message);
    }
    return response.status === 204 ? {} : response.json();
  }
  async function localData() {
    const data = await chrome.storage.local.get(keys);
    return Object.fromEntries(keys.filter(key => data[key] !== undefined).map(key => [key, data[key]]));
  }
  async function push() {
    if (!activeUser || syncing || !cfg.projectId) return;
    syncing = true;
    try {
      const data = await localData();
      await request(endpoint(activeUser.uid), { method: "PATCH", body: JSON.stringify(encodeData(data)) });
      setStatus("Synced to your PostFlow account.");
    } catch (error) { setStatus("Cloud sync paused: " + error.message); }
    finally { syncing = false; }
  }
  async function pullOrSeed() {
    if (!activeUser || !cfg.projectId) return;
    syncing = true;
    try {
      const doc = await request(endpoint(activeUser.uid));
      if (!doc) {
        await request(endpoint(activeUser.uid), { method: "PATCH", body: JSON.stringify(encodeData(await localData())) });
        setStatus("Workspace saved to your PostFlow account.");
      } else {
        const remote = decodeData(doc);
        if (remote && typeof remote === "object") {
          await chrome.storage.local.set(remote);
          setStatus("Workspace synced from your PostFlow account.");
        } else {
          await push();
        }
      }
      lastPulled = true;
    } catch (error) { setStatus("Cloud sync paused: " + error.message); }
    finally { syncing = false; }
  }
  function setStatus(text) {
    const status = document.getElementById("status");
    if (status) status.textContent = text;
  }
  function schedulePush() {
    if (!activeUser || syncing || !lastPulled) return;
    clearTimeout(timer);
    timer = setTimeout(push, 900);
  }
  window.addEventListener("postflow:authenticated", event => {
    const uid = event.detail?.user?.uid;
    if (!uid || uid === activeUser?.uid) return;
    activeUser = { uid };
    lastPulled = false;
    pullOrSeed();
  });
  window.addEventListener("postflow:logout", () => {
    activeUser = null; lastPulled = false; clearTimeout(timer);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || syncing || !activeUser || !lastPulled) return;
    if (keys.some(key => changes[key])) schedulePush();
  });
  window.PostFlowCloudSync = {
    syncNow: push,
    isReady: () => Boolean(cfg.projectId && activeUser && lastPulled)
  };
})();
