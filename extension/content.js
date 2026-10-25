function pageSafetyMessage() {
  const text=(document.body?.innerText||"").slice(0,12000).toLowerCase(), url=location.href.toLowerCase();
  if(/checkpoint|\/recover\/|\/login\//.test(url)||/confirm your identity|security check|suspicious activity|temporarily blocked|you’re temporarily blocked|you are temporarily blocked|unusual activity/.test(text))
    return "Facebook is showing a login, checkpoint, or restriction screen. Resolve it on Facebook yourself first.";
  return "";
}
function findComposer() {
  return [...document.querySelectorAll('[contenteditable="true"][role="textbox"],[contenteditable="true"]')].find(el=>{
    const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&!el.closest('[aria-hidden="true"],[inert]')&&!el.matches('[aria-disabled="true"]');
  });
}
function insertText(el,text){
  el.focus();el.click();let inserted=false;
  try{const s=getSelection(),r=document.createRange();r.selectNodeContents(el);s.removeAllRanges();s.addRange(r);inserted=document.execCommand("insertText",false,text);}catch{}
  if(!inserted)el.textContent=text;
  el.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:text}));
  el.dispatchEvent(new Event("change",{bubbles:true}));
}
function scanGroupLinks(){
  const ignored=new Set(["feeds","discover","joins","create","your_groups","requests","search","notifications","suggested","gaming","watch","events"]);
  const found=new Map();
  for(const a of document.querySelectorAll('a[href]')){
    let u;try{u=new URL(a.getAttribute("href"),location.origin)}catch{continue}
    if(!/(^|\.)facebook\.com$/i.test(u.hostname))continue;
    const m=u.pathname.match(/^\/groups\/([^/?#]+)\/?$/i);if(!m||ignored.has(m[1].toLowerCase()))continue;
    const r=a.getBoundingClientRect();if(r.width<=0||r.height<=0||a.closest('[aria-hidden="true"]'))continue;
    const name=(a.innerText||a.getAttribute("aria-label")||a.getAttribute("title")||"").trim().replace(/\s+/g," ");
    if(!name||name.length>160||/^\d+$/.test(name))continue;
    u.hostname="www.facebook.com";u.search="";u.hash="";
    if(!found.has(u.href))found.set(u.href,{url:u.href,name});
  }
  return [...found.values()];
}
chrome.runtime.onMessage.addListener((m,s,reply)=>{
 if(m?.type==="POSTFLOW_SCAN_GROUPS"){const warning=pageSafetyMessage();const groupDetails=warning?[]:scanGroupLinks();reply({groups:groupDetails.map(g=>g.url),groupDetails,warning});return;}
 if(m?.type!=="POSTFLOW_FILL_CAPTION")return;
 const warning=pageSafetyMessage();if(warning){reply({ok:false,message:warning});return;}
 const editor=findComposer();if(!editor){reply({ok:false,message:"Couldn't find a visible composer. Open the group's post composer first."});return;}
 insertText(editor,String(m.caption||""));reply({ok:true});
});
