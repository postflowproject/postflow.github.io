function pageSafetyMessage() {
  const text = (document.body?.innerText || "").slice(0, 12000).toLowerCase();
  const url = location.href.toLowerCase();
  if (/checkpoint|\/recover\/|\/login\//.test(url) ||
      /confirm your identity|security check|suspicious activity|temporarily blocked|you’re temporarily blocked|you are temporarily blocked|unusual activity/.test(text)) {
    return "Facebook is showing a login, checkpoint, or restriction screen. PostFlow stopped; resolve it on Facebook yourself before continuing.";
  }
  return "";
}

function findComposer() {
  const candidates = [...document.querySelectorAll('[contenteditable="true"][role="textbox"], [contenteditable="true"]')];
  return candidates.find(el => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !el.closest('[aria-hidden="true"]') &&
      !el.matches('[aria-disabled="true"]') && !el.closest('[inert]');
  });
}

function insertText(element, text) {
  element.focus();
  element.click();

  // Prefer an editor input command so React/Meta's contenteditable editor sees
  // a user-like edit instead of having its DOM replaced behind its back.
  let inserted = false;
  try {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    inserted = document.execCommand("insertText", false, text);
  } catch {}

  if (!inserted) {
    element.textContent = text;
  }
  element.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: text
  }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function scanGroupLinks() {
  const ignored = new Set(["feeds","discover","joins","create","your_groups","requests","search","notifications","suggested","gaming","watch","events"]);
  const found = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    const raw = a.getAttribute("href");
    if (!raw) continue;
    let url;
    try { url = new URL(raw, location.origin); } catch { continue; }
    if (!["www.facebook.com", "m.facebook.com"].includes(url.hostname)) continue;
    const match = url.pathname.match(/^\/groups\/([^/?#]+)\/?$/);
    if (!match || ignored.has(match[1].toLowerCase())) continue;
    const rect = a.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || a.closest('[aria-hidden="true"]')) continue;
    const name = (a.innerText || a.getAttribute("aria-label") || a.getAttribute("title") || "").trim().replace(/\s+/g, " ");
    if (!name || name.length > 160) continue;
    url.hostname = "www.facebook.com";
    url.search = "";
    url.hash = "";
    found.set(url.href, { url: url.href, name });
  }
  return [...found.values()].map(item => item.url);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "POSTFLOW_SCAN_GROUPS") {
    const warning = pageSafetyMessage();
    sendResponse(warning ? { groups: [], warning } : { groups: scanGroupLinks() });
    return;
  }
  if (message?.type !== "POSTFLOW_FILL_CAPTION") return;
  const warning = pageSafetyMessage();
  if (warning) { sendResponse({ ok: false, message: warning }); return; }
  const composer = findComposer();
  if (!composer) {
    sendResponse({ ok: false, message: "Couldn't find a visible post composer. Open the group's post composer first, then retry." });
    return;
  }
  insertText(composer, String(message.caption || ""));
  sendResponse({ ok: true });
});
