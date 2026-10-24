function findComposer() {
  const candidates = [...document.querySelectorAll('[contenteditable="true"][role="textbox"], [contenteditable="true"]')];
  return candidates.find(el => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !el.closest('[aria-hidden="true"]');
  });
}
function insertText(element, text) {
  element.focus(); element.click();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element); range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node); range.setStartAfter(node); range.collapse(true);
  selection.removeAllRanges(); selection.addRange(range);
  element.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:text}));
  element.dispatchEvent(new Event("change",{bubbles:true}));
}
function scanGroupLinks() {
  const ignored = new Set(["feeds","discover","joins","create","your_groups","requests","search","notifications","suggested","gaming","watch","events"]);
  const found = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    const raw = a.getAttribute("href");
    if (!raw) continue;
    let url;
    try { url = new URL(raw, location.origin); } catch { continue; }
    if (url.hostname !== "www.facebook.com" && url.hostname !== "m.facebook.com") continue;
    const match = url.pathname.match(/^\/groups\/([^/?#]+)\/?$/);
    if (!match || ignored.has(match[1].toLowerCase())) continue;
    const name = (a.innerText || a.getAttribute("aria-label") || a.getAttribute("title") || "").trim().replace(/\s+/g," ");
    if (!name || name.length > 160) continue;
    url.hostname = "www.facebook.com";
    url.search = ""; url.hash = "";
    found.set(url.href, {url:url.href,name});
  }
  return [...found.values()].map(item => item.url);
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "POSTFLOW_SCAN_GROUPS") {
    sendResponse({groups:scanGroupLinks()});
    return;
  }
  if (message?.type !== "POSTFLOW_FILL_CAPTION") return;
  const composer = findComposer();
  if (!composer) { sendResponse({ok:false,message:"Couldn't find a visible post composer. Open the group's post composer first, then retry."}); return; }
  insertText(composer,String(message.caption || ""));
  sendResponse({ok:true});
});
