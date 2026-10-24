const captionEl = document.getElementById("caption");
const groupsEl = document.getElementById("groups");
const statusEl = document.getElementById("status");

function parseGroups(value) {
  return [...new Set(value.split(/\r?\n/).map(v => v.trim()).filter(Boolean))];
}
function validGroupUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.facebook.com" && url.pathname.startsWith("/groups/");
  } catch {
    return false;
  }
}
function setStatus(message) {
  statusEl.textContent = message;
}
async function load() {
  const data = await chrome.storage.local.get(["caption", "groups", "nextIndex"]);
  captionEl.value = data.caption || "";
  groupsEl.value = (data.groups || []).join("\n");
}
async function save() {
  const groups = parseGroups(groupsEl.value);
  const invalid = groups.filter(url => !validGroupUrl(url));
  if (invalid.length) {
    setStatus("Check this URL (must be a facebook.com/groups/ link): " + invalid[0]);
    return false;
  }
  const data = await chrome.storage.local.get(["groups", "nextIndex"]);
  await chrome.storage.local.set({
    caption: captionEl.value,
    groups,
    nextIndex: Math.min(data.nextIndex || 0, Math.max(groups.length - 1, 0))
  });
  setStatus("Saved " + groups.length + " group(s).");
  return true;
}
document.getElementById("save").addEventListener("click", save);
document.getElementById("openNext").addEventListener("click", async () => {
  if (!(await save())) return;
  const data = await chrome.storage.local.get(["groups", "nextIndex"]);
  const groups = data.groups || [];
  if (!groups.length) return setStatus("Add at least one group URL first.");
  const index = (data.nextIndex || 0) % groups.length;
  await chrome.tabs.create({url: groups[index], active: true});
  await chrome.storage.local.set({currentGroupIndex: index, nextIndex: (index + 1) % groups.length});
  setStatus("Opened group " + (index + 1) + " of " + groups.length + ". Review it before posting.");
});
document.getElementById("fillCaption").addEventListener("click", async () => {
  if (!(await save())) return;
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if (!tab?.id || !tab.url?.startsWith("https://www.facebook.com/groups/")) {
    return setStatus("Open a Facebook Group first.");
  }
  try {
    const result = await chrome.tabs.sendMessage(tab.id, {type:"POSTFLOW_FILL_CAPTION", caption:captionEl.value});
    setStatus(result?.ok ? "Caption inserted. Add the video and review before publishing." : (result?.message || "Couldn't find the post composer."));
  } catch {
    setStatus("Refresh the Facebook Group tab, then try again.");
  }
});
load().catch(() => setStatus("Couldn't load saved settings."));
