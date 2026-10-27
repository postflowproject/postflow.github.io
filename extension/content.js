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
  try{const s=getSelection(),r=document.createRange();r.selectNodeContents(el);s.removeAllRanges();s.addRange(r);inserted=document.execCommand("insertText",false,text);}catch{ /* Use the textContent fallback if insertText is unavailable. */ }
  if(!inserted)el.textContent=text;
  el.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:text}));
  el.dispatchEvent(new Event("change",{bubbles:true}));
}
const IGNORED_GROUP_PATHS=new Set(["feeds","discover","joins","create","your_groups","requests","search","notifications","suggested","gaming","watch","events","member_requests","pending","admin"]);
function normalizeGroupLink(rawHref) {
  try {
    const u=new URL(rawHref,location.href);
    if(!/(^|\.)facebook\.com$/i.test(u.hostname)||u.protocol!=="https:")return null;
    const m=u.pathname.match(/^\/groups\/([^/?#]+)\/?$/i);
    if(!m||IGNORED_GROUP_PATHS.has(m[1].toLowerCase()))return null;
    u.hostname="www.facebook.com";u.pathname="/groups/"+m[1]+"/";u.search="";u.hash="";
    return u.href;
  } catch { return null; }
}
function normalizeText(value) {
  return String(value||"").replace(/[\u200B-\u200D\uFEFF]/g,"").trim().replace(/\s+/g," ");
}
function usableName(value,url) {
  const name=normalizeText(value);
  if(!name||name.length>160||/^\d+$/.test(name)||/^https?:\/\//i.test(name)||/facebook\.com\/groups\//i.test(name))return "";
  if(/^(see all|view all|groups|join group|visit group|group|joined|join|members|posts)$/i.test(name))return "";
  const slug=url?.match(/\/groups\/([^/]+)/)?.[1]||"";
  if(slug&&name.toLowerCase()===slug.toLowerCase())return "";
  return name;
}
function extractNameFromCard(anchor,url) {
  const direct=[
    anchor.querySelector('[dir="auto"]')?.innerText,
    anchor.querySelector("strong")?.innerText,
    anchor.getAttribute("aria-label"),
    anchor.getAttribute("title"),
    anchor.innerText
  ];
  for(const value of direct){const name=usableName(value,url);if(name)return name;}
  // Facebook often puts the destination link and the human-readable title in sibling elements.
  let node=anchor;
  for(let depth=0;node&&depth<6;depth++,node=node.parentElement){
    const rect=node.getBoundingClientRect();
    if(depth>0&&(rect.width<100||rect.height<25||rect.height>600))continue;
    const candidates=[
      node.querySelector('a[aria-label]')?.getAttribute("aria-label"),
      node.querySelector('a[title]')?.getAttribute("title"),
      ...[...node.querySelectorAll('[dir="auto"],h1,h2,h3,h4,strong,[role="heading"]')].slice(0,12).map(el=>el.innerText)
    ];
    for(const value of candidates){const name=usableName(value,url);if(name&&!/^(join|joined|visit group|view group|see more)$/i.test(name))return name;}
  }
  return "";
}
function collectGroupLinks() {
  const found=new Map();
  for(const a of document.querySelectorAll('a[href]')) {
    const url=normalizeGroupLink(a.getAttribute("href")||a.href);
    if(!url)continue;
    const name=extractNameFromCard(a,url);
    const previous=found.get(url);
    if(!previous||(!previous.name&&name)||(name&&name.length>previous.name.length))found.set(url,{url,name:name||previous?.name||""});
  }
  return [...found.values()];
}
function scrollableAreas() {
  return [...document.querySelectorAll('div,main,[role="main"],[role="feed"],[role="grid"]')]
    .filter(el=>{
      if(el===document.body||el===document.documentElement)return false;
      const s=getComputedStyle(el),r=el.getBoundingClientRect();
      return r.width>240&&r.height>180&&/(auto|scroll)/.test(s.overflowY)&&el.scrollHeight>el.clientHeight+120;
    })
    .sort((a,b)=>(b.clientHeight*b.clientWidth)-(a.clientHeight*a.clientWidth));
}
async function scanGroupLinksDeep() {
  const found=new Map(),add=items=>items.forEach(g=>{
    const old=found.get(g.url);
    if(!old||(!old.name&&g.name)||(g.name&&g.name.length>(old.name||"").length))found.set(g.url,g);
  });
  add(collectGroupLinks());
  const scroller=scrollableAreas()[0]||document.scrollingElement;
  if(!scroller)return [...found.values()];
  const isDocument=scroller===document.scrollingElement;
  const originalTop=isDocument?(window.scrollY||0):scroller.scrollTop;
  let previousCount=-1,stagnant=0;
  try{
    for(let i=0;i<10;i++){
      const current=isDocument?(window.scrollY||0):scroller.scrollTop;
      const maxTop=isDocument?Math.max(0,document.documentElement.scrollHeight-window.innerHeight):Math.max(0,scroller.scrollHeight-scroller.clientHeight);
      if(current>=maxTop-4&&i>0)break;
      const next=Math.min(maxTop,current+Math.max(400,Math.floor((isDocument?window.innerHeight:scroller.clientHeight)*0.8)));
      if(isDocument)window.scrollTo({top:next,behavior:"instant"});else scroller.scrollTop=next;
      await new Promise(resolve=>setTimeout(resolve,350));
      add(collectGroupLinks());
      if(found.size===previousCount)stagnant++;else stagnant=0;
      previousCount=found.size;
      if(stagnant>=3)break;
    }
  }finally{
    if(isDocument)window.scrollTo({top:originalTop,behavior:"instant"});else scroller.scrollTop=originalTop;
  }
  return [...found.values()];
}
chrome.runtime.onMessage.addListener((m,s,reply)=>{
 if(m?.type==="POSTFLOW_SCAN_GROUPS"){
   (async()=>{
     const warning=pageSafetyMessage();
     if(warning){reply({groups:[],groupDetails:[],warning});return;}
     const groupDetails=await scanGroupLinksDeep();
     const named=groupDetails.filter(g=>g.name).length;
     reply({groups:groupDetails.map(g=>g.url),groupDetails,scannedPage:location.pathname,namedCount:named});
   })().catch(()=>reply({groups:[],groupDetails:[],warning:"The scan failed. Refresh the Facebook page and try again."}));
   return true;
 }
 if(m?.type!=="POSTFLOW_FILL_CAPTION")return;
 const warning=pageSafetyMessage();if(warning){reply({ok:false,message:warning});return;}
 const editor=findComposer();if(!editor){reply({ok:false,message:"Couldn't find a visible composer. Open the group's post composer first."});return;}
 insertText(editor,String(m.caption||""));reply({ok:true});
});
