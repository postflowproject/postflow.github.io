const captionEl = document.getElementById("caption");
const groupsEl = document.getElementById("groups");
const statusEl = document.getElementById("status");

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
async function load() {
  const data = await chrome.storage.local.get(["caption", "groups", "discoveredGroups", "nextIndex"]);
  captionEl.value = data.caption || "";
  const groups = data.discoveredGroups?.length ? data.discoveredGroups : (data.groups || []);
  groupsEl.value = groups.join("\n");
  if (data.discoveredGroups?.length) setStatus("Found " + data.discoveredGroups.length + " group link(s) on Facebook.");
}
async function save() {
  const groups = parseGroups(groupsEl.value);
  const invalid = groups.filter(url => !validGroupUrl(url));
  if (invalid.length) { setStatus("Check this group URL: " + invalid[0]); return false; }
  const data = await chrome.storage.local.get(["nextIndex"]);
  await chrome.storage.local.set({caption:captionEl.value, groups, nextIndex:Math.min(data.nextIndex || 0, Math.max(groups.length - 1, 0))});
  setStatus("Saved caption and " + groups.length + " group(s).");
  return true;
}
document.getElementById("findGroups").addEventListener("click", async () => {
  await chrome.storage.local.set({caption:captionEl.value});
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if (tab?.url?.startsWith("https://www.facebook.com/groups/")) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id,{type:"POSTFLOW_SCAN_GROUPS"});
      if (result?.groups?.length) {
        groupsEl.value = result.groups.join("\n");
        await chrome.storage.local.set({discoveredGroups:result.groups,groups:result.groups});
        setStatus("Found " + result.groups.length + " group link(s). Check the list and save.");
      } else setStatus("No group links found yet. Open Facebook Groups and scroll the groups list, then retry.");
    } catch { setStatus("Refresh the Facebook Groups tab and try again."); }
  } else {
    await chrome.tabs.create({url:"https://www.facebook.com/groups/",active:true});
    setStatus("Opened Facebook Groups. Wait for it to load, then reopen PostFlow and click Find my Facebook groups.");
  }
});
document.getElementById("save").addEventListener("click", save);
document.getElementById("openNext").addEventListener("click", async () => {
  if (!(await save())) return;
  const data = await chrome.storage.local.get(["groups","nextIndex"]);
  const groups = data.groups || [];
  if (!groups.length) return setStatus("No groups saved yet. Click Find my Facebook groups first.");
  const index = (data.nextIndex || 0) % groups.length;
  await chrome.tabs.create({url:groups[index],active:true});
  await chrome.storage.local.set({currentGroupIndex:index,nextIndex:(index+1)%groups.length});
  setStatus("Opened group " + (index+1) + " of " + groups.length + ". Review before posting.");
});
document.getElementById("fillCaption").addEventListener("click", async () => {
  if (!(await save())) return;
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if (!tab?.id || !tab.url?.startsWith("https://www.facebook.com/groups/")) return setStatus("Open a Facebook Group first.");
  try {
    const result = await chrome.tabs.sendMessage(tab.id,{type:"POSTFLOW_FILL_CAPTION",caption:captionEl.value});
    setStatus(result?.ok ? "Caption inserted. Add the video and review before publishing." : (result?.message || "Couldn't find the post composer."));
  } catch { setStatus("Refresh the Facebook Group tab, then try again."); }
});
load().catch(() => setStatus("Couldn't load saved settings."));
