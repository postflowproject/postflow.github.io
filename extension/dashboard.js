const $ = id => document.getElementById(id);
const state = { caption: "", groups: [], completed: [], currentIndex: null, history: [] };
const norm = value => { try { const u = new URL(value.trim()); u.search = ""; u.hash = ""; return u.href.replace(/\/$/, ""); } catch { return ""; } };
const valid = value => { try { const u = new URL(value); return u.protocol === "https:" && /(^|\.)facebook\.com$/i.test(u.hostname) && /^\/groups\/[^/?#]+/.test(u.pathname); } catch { return false; } };
const unique = values => [...new Set(values.map(v => v.trim()).filter(Boolean))];
function status(message) { $("status").textContent = message; }
function captionKey(value) { return value.trim().replace(/\\s+/g, " ").toLowerCase(); }
async function getGroupTab() { const [active] = await chrome.tabs.query({active:true,currentWindow:true}); if(active?.url?.startsWith("https://www.facebook.com/groups/")) return active; const tabs = await chrome.tabs.query({url:"https://www.facebook.com/groups/*"}); return tabs.length ? tabs[tabs.length - 1] : null; }
function parseGroups() { return unique($("groups").value.split(/\r?\n/)); }
async function load() {
 const d = await chrome.storage.local.get(["caption","groups","discoveredGroups","completedGroups","currentGroupIndex","captionHistory","dashboardActivity"]);
 state.caption = d.caption || ""; state.groups = d.discoveredGroups?.length ? d.discoveredGroups : (d.groups || []);
 state.completed = (d.completedGroups || []).map(norm).filter(Boolean); state.currentIndex = Number.isInteger(d.currentGroupIndex) ? d.currentGroupIndex : null;
 state.history = d.dashboardActivity || [];
 $("caption").value = state.caption; $("groups").value = state.groups.join("\n"); render();
}
function render() {
 const done = new Set(state.completed); const count = state.groups.filter(g => done.has(norm(g))).length;
 $("total").textContent = state.groups.length; $("done").textContent = count; $("remaining").textContent = state.groups.length-count;
 $("groupPill").textContent = state.groups.length+" groups"; $("length").textContent = $("caption").value.length;
 $("captionCount").textContent = $("caption").value.length+" characters";
 $("groupSummary").textContent = state.groups.length ? count+" of "+state.groups.length+" marked posted" : "No groups saved.";
 const pct = state.groups.length ? Math.round(count/state.groups.length*100) : 0;
 $("progressBar").style.width = pct+"%"; $("progressText").textContent = pct+"% complete";
 const items = state.groups.map((url,i)=>({url,i,done:done.has(norm(url))})).slice(0,100);
 $("activityList").innerHTML = items.length ? items.map(({url,i,done})=>'<div class="activity-item"><div><strong>'+escapeHtml(url)+'</strong><small>Group '+(i+1)+' of '+state.groups.length+'</small></div><span class="state">'+(done?'✓ Marked posted':'○ Pending')+'</span></div>').join("") : '<div class="empty">Nothing here yet. Save a group list to get started.</div>';
}
function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
async function persist() { await chrome.storage.local.set({caption:state.caption,groups:state.groups,discoveredGroups:state.groups,completedGroups:state.completed,dashboardActivity:state.history}); render(); }
async function saveCaption(){state.caption=$("caption").value; await chrome.storage.local.set({caption:state.caption}); render(); status("Caption saved locally.");}
async function saveGroups(){
 const groups=parseGroups(); const invalid=groups.find(g=>!valid(g));
 if(invalid){status("Invalid Facebook group URL: "+invalid);return false;}
 state.groups=groups; state.completed=state.completed.filter(g=>groups.some(v=>norm(v)===g));
 state.history.unshift({message:"Saved group list ("+groups.length+")",time:Date.now()}); state.history=state.history.slice(0,80);
 await persist(); status("Saved "+groups.length+" group(s)."); return true;
}
$("caption").addEventListener("input",()=>{ $("captionCount").textContent=$("caption").value.length+" characters"; $("length").textContent=$("caption").value.length; });
$("save").addEventListener("click",saveCaption);
$("clearCaption").addEventListener("click",()=>{$("caption").value="";state.caption="";saveCaption();});
$("saveGroups").addEventListener("click",saveGroups);
$("refresh").addEventListener("click",()=>load().then(()=>status("Workspace refreshed.")));
$("scan").addEventListener("click",async()=>{
 const tab=await getGroupTab();
 if(tab?.url?.startsWith("https://www.facebook.com/groups/")){
  try{const r=await chrome.tabs.sendMessage(tab.id,{type:"POSTFLOW_SCAN_GROUPS"});if(r?.warning)return status(r.warning);
   state.groups=unique([...state.groups,...(r?.groups||[])]);$("groups").value=state.groups.join("\n");await saveGroups();status("Scanned current page. Review the list and save.");}
  catch{status("Refresh the Facebook Groups tab and retry.");}
 }else{await chrome.tabs.create({url:"https://www.facebook.com/groups/",active:true});status("Opened Facebook Groups. Load the page, then return and scan.");}
});
$("fill").addEventListener("click",async()=>{
 const caption=$("caption").value.trim(); if(!caption)return status("Write a caption first.");
 const tab=await getGroupTab();
 if(!tab?.id||!tab.url?.startsWith("https://www.facebook.com/groups/"))return status("Open a Facebook Group first.");
 const data = await chrome.storage.local.get(["captionHistory"]);
 const key = captionKey(caption); const history = data.captionHistory || [];
 if (history.some(item => item.key === key)) {
  if (!confirm("This exact caption was used before in PostFlow. Continue only if this is intentional and appropriate for the group.")) return status("Cancelled. Edit the caption or choose another group.");
 }
 try {
  const r = await chrome.tabs.sendMessage(tab.id,{type:"POSTFLOW_FILL_CAPTION",caption});
  if (r?.ok) {
   state.caption=caption;
   history.unshift({key,caption,time:Date.now()});
   await chrome.storage.local.set({caption,captionHistory:history.slice(0,100)});
   status("Caption filled. Add your video and review before publishing.");
  } else status(r?.message||"Couldn't find a visible composer.");
 } catch { status("Refresh the Facebook Group tab and try again."); }
});
$("openNext").addEventListener("click",async()=>{
 if(!(await saveGroups()))return;
 const completed=new Set(state.completed); const i=state.groups.findIndex(g=>!completed.has(norm(g)));
 if(i<0)return status("All groups are marked posted. Reset progress to start again.");
 state.currentIndex=i;await chrome.storage.local.set({currentGroupIndex:i,nextIndex:(i+1)%state.groups.length});
 await chrome.tabs.create({url:state.groups[i],active:true});status("Opened group "+(i+1)+". Review, attach media, and publish manually.");
});
$("mark").addEventListener("click",async()=>{
 const tab=await getGroupTab(); if(!tab?.url||!valid(tab.url))return status("Open the Facebook group you just posted in first.");
 const url=norm(tab.url); if(!state.groups.some(g=>norm(g)===url))return status("This group is not in the saved list.");
 if(!state.completed.includes(url))state.completed.push(url);
 state.history.unshift({message:"Manually marked posted: "+url,time:Date.now()});state.history=state.history.slice(0,80);
 await persist();status("Marked posted. This is a manual record, not Facebook verification.");
});
$("reset").addEventListener("click",async()=>{if(!confirm("Reset all PostFlow progress? This will not delete Facebook posts."))return;state.completed=[];state.history.unshift({message:"Progress reset",time:Date.now()});await persist();status("Progress reset.");});
$("export").addEventListener("click",()=>{const blob=new Blob([parseGroups().join("\n")+"\n"],{type:"text/plain"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="postflow-groups.txt";a.click();URL.revokeObjectURL(a.href);status("Exported group list.");});
$("import").addEventListener("click",()=>$("file").click());
$("file").addEventListener("change",async e=>{const f=e.target.files?.[0];if(!f)return;const text=await f.text();$("groups").value=unique(text.split(/\r?\n/)).join("\n");await saveGroups();e.target.value="";});
load().catch(()=>status("Couldn't load local workspace data."));
