function findComposer() {
  const candidates = [...document.querySelectorAll('[contenteditable="true"][role="textbox"], [contenteditable="true"]')];
  return candidates.find(el => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !el.closest('[aria-hidden="true"]');
  });
}
function insertText(element, text) {
  element.focus();
  element.click();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  element.dispatchEvent(new InputEvent("input", {bubbles:true, inputType:"insertText", data:text}));
  element.dispatchEvent(new Event("change", {bubbles:true}));
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "POSTFLOW_FILL_CAPTION") return;
  const composer = findComposer();
  if (!composer) {
    sendResponse({ok:false, message:"Couldn't find a visible post composer. Open the group's post composer first, then retry."});
    return;
  }
  insertText(composer, String(message.caption || ""));
  sendResponse({ok:true});
});
