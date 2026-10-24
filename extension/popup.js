const captionEl = document.getElementById("caption");
const groupsEl = document.getElementById("groups");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");

function parseGroups(value) {
  return [...new Set(value.split(/\r?\n/).map(v => v.trim()).filter(Boolean))];
}
function validGroupUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)facebook\.com$/i.test(url.hostname) && /^\/groups\/[^/?#]+/.test(url.pathname);
  } catch { return false; }
}
function setStatus(message) { statusEl.textContent = message; }
function captionKey(value) { return value.trim().replace(/\s+/g, " ").toLowerCase(); }

async function load() {
  const data = await chrome.storage.local.get(["caption", "groups", "discoveredGroups", "nextIndex", "completedGroups"]);
  captionEl.value = data.caption || "";
  const groups = data.discoveredGroups?.length ? data.discoveredGroups : (data.groups || []);
  groupsEl.value = groups.join("\n");
  renderProgress(groups, data.completedGroups || []);
  if (data.discoveredGroups?.length) setStatus("Found " + data.discoveredGroups.length + " group link(s) visible on Facebook.");
}
function renderProgress(groups, completed) {
  const done = new Set(completed || []);
  progressEl.textContent = groups.length ? "Progress: " + groups.filter(url => done.has(url)).length + " of " + groups.length + " marked posted." : "No groups saved yet.";
}
async function save() {
  const groups = parseGroups(groupsEl.value);
  const invalid = groups.filter(url => !validGroupUrl(url));
  if (invalid.length) { setStatus("Check this group URL: " + invalid[0]); return false; }
  const data = await chrome.storage.local.get(["nextIndex", "completedGroups"]);
  const completedGroups = (data.completedGroups || []).filter(url => groups.includes(url));
  await chrome.storage.local.set({ caption: captionEl.value, groups, discoveredGroups: groups, nextIndex: Math.min(data.nextIndex || 0, Math.max(groups.length - 1, 0)), completedGroups });
  renderProgress(groups, completedGroups);
  setStatus("Saved caption and " + groups.length + " group(s).");
  return true;
}
document.getElementById("dashboard").addEventListener("click", async () => { await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html"), active: true }); });
document.getElementById("findGroups").addEventListener("click", async () => {
  await chrome.storage.local.set({ caption: captionEl.value });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.startsWith("https://www.facebook.com/groups/")) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: "POSTFLOW_SCAN_GROUPS" });
      if (result?.warning) return setStatus(result.warning);
      if (result?.groups?.length) {
        const existing = new Set(parseGroups(groupsEl.value));
        result.groups.forEach(url => existing.add(url));
        groupsEl.value = [...existing].join("\n");
        await chrome.storage.local.set({ discoveredGroups: [...existing], groups: [...existing] });
        renderProgress([...existing], (await chrome.storage.local.get(["completedGroups"])).completedGroups || []);
        setStatus("Found " + result.groups.length + " visible group link(s). Check the list and save.");
      } else setStatus("No group links found on this page. Open Facebook Groups, scroll the list so more groups load, then retry.");
    } catch { setStatus("Refresh the Facebook Groups tab and try again."); }
  } else {
    await chrome.tabs.create({ url: "https://www.facebook.com/groups/", active: true });
    setStatus("Opened Facebook Groups. Wait for it to load, then reopen PostFlow and click Find my Facebook groups.");
  }
});
document.getElementById("save").addEventListener("click", save);
document.getElementById("openNext").addEventListener("click", async () => {
  if (!(await save())) return;
  const data = await chrome.storage.local.get(["groups", "nextIndex", "completedGroups"]);
  const groups = data.groups || [];
  if (!groups.length) return setStatus("No groups saved yet. Click Find my Facebook groups first.");
  const completed = new Set(data.completedGroups || []);
  const start = (data.nextIndex || 0) % groups.length;
  let index = -1;
  for (let offset = 0; offset < groups.length; offset++) {
    const candidate = (start + offset) % groups.length;
    if (!completed.has(groups[candidate])) { index = candidate; break; }
  }
  if (index < 0) return setStatus("All saved groups are marked posted. Reset progress if you want to review the list again.");
  await chrome.tabs.create({ url: groups[index], active: true });
  await chrome.storage.local.set({ currentGroupIndex: index, nextIndex: (index + 1) % groups.length });
  setStatus("Opened group " + (index + 1) + " of " + groups.length + ". Add video and review before publishing.");
});
document.getElementById("fillCaption").addEventListener("click", async () => {
  if (!(await save())) return;
  const caption = captionEl.value.trim();
  if (!caption) return setStatus("Write a caption first.");
  const data = await chrome.storage.local.get(["captionHistory"]);
  const key = captionKey(caption);
  const history = data.captionHistory || [];
  if (history.some(item => item.key === key)) {
    const proceed = confirm("This exact caption was used before in PostFlow. Continue only if this is intentional and appropriate for the group.");
    if (!proceed) return setStatus("Cancelled. Edit the caption or choose another group.");
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://www.facebook.com/groups/")) return setStatus("Open a Facebook Group first.");
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: "POSTFLOW_FILL_CAPTION", caption });
    if (result?.ok) {
      history.unshift({ key, caption, time: Date.now() });
      await chrome.storage.local.set({ captionHistory: history.slice(0, 100) });
      setStatus("Caption inserted. Add the video and review before publishing.");
    } else setStatus(result?.message || "Couldn't find the post composer.");
  } catch { setStatus("Refresh the Facebook Group tab, then try again."); }
});
document.getElementById("markPosted").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !validGroupUrl(tab.url)) return setStatus("Open the group you just posted in first.");
  const data = await chrome.storage.local.get(["groups", "completedGroups"]);
  const groups = data.groups || [];
  const group = new URL(tab.url); group.search = ""; group.hash = "";
  const url = group.href.replace(/\/$/, "");
  const normalizedGroups = groups.map(value => value.replace(/\/$/, ""));
  if (!normalizedGroups.includes(url)) return setStatus("This group isn't in your saved list. Save the group URL first.");
  const completed = new Set(data.completedGroups || []);
  completed.add(url);
  await chrome.storage.local.set({ completedGroups: [...completed] });
  renderProgress(groups, [...completed]);
  setStatus("Marked this group as posted. Use Open next group when ready.");
});
document.getElementById("resetProgress").addEventListener("click", async () => {
  if (!confirm("Reset all marked-posted progress? This does not delete any Facebook posts.")) return;
  await chrome.storage.local.set({ completedGroups: [], nextIndex: 0 });
  const data = await chrome.storage.local.get(["groups"]);
  renderProgress(data.groups || [], []);
  setStatus("Progress reset. No Facebook posts were changed.");
});
load().catch(() => setStatus("Couldn't load saved settings."));
