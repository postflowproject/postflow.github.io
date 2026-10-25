const $=id=>document.getElementById(id);
const state={caption:"",firstComment:"",campaignName:"",groups:[],selected:[],completed:[],history:[],campaigns:[]};
const norm=v=>{try{const u=new URL(typeof v==="string"?v:v.url);u.search="";u.hash="";return u.href.replace(/\/$/,"")}catch{return ""}};
const valid=v=>{try{const u=new URL(norm(v));return u.protocol==="https:"&&/(^|\.)facebook\.com$/i.test(u.hostname)&&/^\/groups\/[^/?#]+/.test(u.pathname)}catch{return false}};
const uniqueGroups=arr=>{const m=new Map();for(const item of arr){const g=typeof item==="string"?{url:item,name:item}:item;if(!valid(g.url))continue;const url=norm(g.url);if(!m.has(url))m.set(url,{url,name:(g.name||g.title||url).trim()});else if(g.name&&m.get(url).name===url)m.get(url).name=g.name;}return [...m.values()]};
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const captionKey=v=>v.trim().replace(/\s+/g," ").toLowerCase();
function status(s){$("status").textContent=s}
async function activeFacebookTab(){const [t]=await chrome.tabs.query({active:true,currentWindow:true});return t?.url&&/^https:\/\/(www\.)?facebook\.com\//i.test(t.url)?t:null}
async function load(){const d=await chrome.storage.local.get(["caption","firstComment","campaignName","groups","discoveredGroups","selectedGroups","completedGroups","captionHistory","dashboardActivity","postflowCampaigns"]);state.caption=d.caption||"";state.firstComment=d.firstComment||"";state.campaignName=d.campaignName||"";state.groups=uniqueGroups(d.discoveredGroups?.length?d.discoveredGroups:(d.groups||[]));state.selected=(d.selectedGroups||state.groups.map(g=>g.url)).map(norm);state.completed=(d.completedGroups||[]).map(norm);state.history=d.dashboardActivity||[];state.campaigns=d.postflowCampaigns||[];$("caption").value=state.caption;$("firstComment").value=state.firstComment;$("campaignName").value=state.campaignName;render()}
function render(){const done=new Set(state.completed),sel=new Set(state.selected);$("total").textContent=state.groups.length;$("done").textContent=state.groups.filter(g=>done.has(norm(g))).length;$("remaining").textContent=state.groups.filter(g=>sel.has(norm(g))&&!done.has(norm(g))).length;$("length").textContent=$("caption").value.length;$("captionCount").textContent=$("caption").value.length+" characters";$("groupPill").textContent=state.groups.length+" groups";$("groupSummary").textContent=state.groups.filter(g=>sel.has(norm(g))).length+" selected · "+state.groups.length+" found";const pct=state.groups.length?Math.round(state.groups.filter(g=>done.has(norm(g))).length/state.groups.length*100):0;$("progressBar").style.width=pct+"%";$("progressText").textContent=pct+"% complete";
$("groupChoices").innerHTML=state.groups.length?state.groups.map(g=>'<label class="group-choice"><input type="checkbox" data-group="'+esc(norm(g))+'" '+(sel.has(norm(g))?"checked":"")+'><span class="group-icon" aria-hidden="true">👥</span><span class="group-name">'+esc(g.name)+'</span><span class="group-status">'+(done.has(norm(g))?"✓ Posted":"")+'</span></label>').join(""):'<div class="empty">Open Facebook, then click “Scan this tab” to find group links loaded on that page.</div>';
$("activityList").innerHTML=state.groups.length?state.groups.map((g,i)=>'<div class="activity-item"><div><strong>'+esc(g.name)+'</strong><small>Group '+(i+1)+'</small></div><span class="state">'+(done.has(norm(g))?"✓ Marked posted":"○ Pending")+'</span></div>').join(""):'<div class="empty">No groups scanned yet.</div>';
$("campaignCount").textContent=state.campaigns.length+" saved";$("campaignList").innerHTML=state.campaigns.length?state.campaigns.map(c=>'<div class="campaign-item"><div class="campaign-main"><strong>'+esc(c.name||"Untitled campaign")+'</strong><small>'+esc((c.caption||"").slice(0,115)||"No caption")+'</small><small>'+((c.selected||[]).length)+' selected groups · '+new Date(c.updatedAt||c.createdAt||Date.now()).toLocaleString()+'</small></div><div class="campaign-actions"><button class="button secondary" data-load-campaign="'+esc(c.id)+'">Load</button><button class="button ghost" data-delete-campaign="'+esc(c.id)+'">Delete</button></div></div>').join(""):'<div class="empty">Save a campaign draft to see it here.</div>'}
async function persist(){state.groups=uniqueGroups(state.groups);await chrome.storage.local.set({groups:state.groups.map(g=>g.url),discoveredGroups:state.groups,selectedGroups:state.selected,completedGroups:state.completed,dashboardActivity:state.history});render()}
async function saveDraft(){state.caption=$("caption").value;state.firstComment=$("firstComment").value;state.campaignName=$("campaignName").value.trim();await chrome.storage.local.set({caption:state.caption,firstComment:state.firstComment,campaignName:state.campaignName});status("Draft saved locally.");render()}
$("caption").addEventListener("input",()=>{$("captionCount").textContent=$("caption").value.length+" characters";$("length").textContent=$("caption").value.length});
$("save").addEventListener("click",async()=>{await saveDraft();const campaign={id:crypto.randomUUID(),name:state.campaignName||"Untitled campaign",caption:state.caption,firstComment:state.firstComment,selected:[...state.selected],groups:state.groups.map(g=>({url:g.url,name:g.name})),createdAt:Date.now(),updatedAt:Date.now()};state.campaigns.unshift(campaign);state.campaigns=state.campaigns.slice(0,50);await chrome.storage.local.set({postflowCampaigns:state.campaigns});render();status("Campaign draft saved. It does not publish anything.")});
$("clearCaption").addEventListener("click",()=>{$("caption").value="";saveDraft()});
$("refresh").addEventListener("click",()=>load().then(()=>status("Workspace refreshed.")));
$("scan").addEventListener("click",async()=>{const tab=await activeFacebookTab();if(!tab)return status("Open Facebook in a normal tab first, then scan again.");try{const r=await chrome.tabs.sendMessage(tab.id,{type:"POSTFLOW_SCAN_GROUPS"});if(r?.warning)return status(r.warning);if(!r?.groupDetails?.length)return status("No group links found on this page. Open Facebook Groups or your groups list, scroll to load more, then scan again.");const before=state.groups.length;const found=uniqueGroups(r.groupDetails);state.groups=uniqueGroups([...state.groups,...found]);const oldSel=new Set(state.selected);for(const g of found)if(!oldSel.has(norm(g)))state.selected.push(norm(g));await persist();status("Found "+(state.groups.length-before)+" new group(s). Tick the groups you want.");}catch{status("Refresh this Facebook tab, then try scanning again. If it was open before installing PostFlow, reload it first.")}});
$("groupChoices").addEventListener("change",async e=>{const input=e.target.closest("input[data-group]");if(!input)return;const url=input.dataset.group;state.selected=input.checked?[...new Set([...state.selected,url])]:state.selected.filter(x=>x!==url);await chrome.storage.local.set({selectedGroups:state.selected});render()});
$("selectAll").addEventListener("click",async()=>{state.selected=state.groups.map(g=>norm(g));await chrome.storage.local.set({selectedGroups:state.selected});render();status("All scanned groups selected.")});
$("selectNone").addEventListener("click",async()=>{state.selected=[];await chrome.storage.local.set({selectedGroups:[]});render();status("Selection cleared.")});
$("openNext").addEventListener("click",async()=>{const chosen=state.groups.filter(g=>state.selected.includes(norm(g.url))&&!state.completed.includes(norm(g.url)));if(!chosen.length)return status("Select at least one unfinished group first.");const g=chosen[0];await chrome.tabs.create({url:g.url,active:true});status("Opened "+g.name+". Review, attach media, and publish manually.")});
$("fill").addEventListener("click",async()=>{const caption=$("caption").value.trim();if(!caption)return status("Write a caption first.");const tab=await activeFacebookTab();if(!tab)return status("Open the chosen Facebook group in a tab first.");const d=await chrome.storage.local.get(["captionHistory"]);const history=d.captionHistory||[],key=captionKey(caption);if(history.some(x=>x.key===key)&&!confirm("This exact caption was used before in PostFlow. Continue only if intentional and appropriate for the group."))return status("Cancelled.");try{const r=await chrome.tabs.sendMessage(tab.id,{type:"POSTFLOW_FILL_CAPTION",caption});if(!r?.ok)return status(r?.message||"Couldn't find a visible composer.");history.unshift({key,caption,time:Date.now()});await chrome.storage.local.set({caption,captionHistory:history.slice(0,100)});renderCaptionHistory();status("Caption filled. Attach media and review before publishing.");}catch{status("Reload the Facebook tab and open its post composer first.")}});
$("copyComment").addEventListener("click",async()=>{const comment=$("firstComment").value.trim();if(!comment)return status("Write a first comment first.");try{await navigator.clipboard.writeText(comment);await chrome.storage.local.set({firstComment:comment});status("First comment copied. Paste it after publishing if appropriate.");}catch{status("Clipboard access was blocked. Select and copy the comment manually.")}});
$("mark").addEventListener("click",async()=>{const tab=await activeFacebookTab();if(!tab||!valid(tab.url))return status("Open the group you just posted in first.");const url=norm(tab.url);if(!state.groups.some(g=>norm(g.url)===url))return status("This group hasn't been scanned into PostFlow yet.");if(!state.completed.includes(url))state.completed.push(url);state.history.unshift({message:"Manually marked posted: "+url,time:Date.now()});await persist();status("Marked posted manually; Facebook publication is not verified.")});
$("reset").addEventListener("click",async()=>{if(!confirm("Reset PostFlow progress? This will not delete Facebook posts."))return;state.completed=[];await persist();status("Progress reset.")});
$("campaignList").addEventListener("click",async e=>{const loadBtn=e.target.closest("[data-load-campaign]"),delBtn=e.target.closest("[data-delete-campaign]");if(loadBtn){const c=state.campaigns.find(x=>x.id===loadBtn.dataset.loadCampaign);if(!c)return;$("campaignName").value=c.name||"";$("caption").value=c.caption||"";$("firstComment").value=c.firstComment||"";state.caption=c.caption||"";state.firstComment=c.firstComment||"";state.campaignName=c.name||"";state.groups=uniqueGroups([...state.groups,...(c.groups||[])]);state.selected=(c.selected||[]).map(norm);await chrome.storage.local.set({caption:state.caption,firstComment:state.firstComment,campaignName:state.campaignName,selectedGroups:state.selected});await persist();status("Campaign loaded. Groups and selections saved. Check them before using the queue.");}if(delBtn){if(!confirm("Delete this saved campaign draft?"))return;state.campaigns=state.campaigns.filter(x=>x.id!==delBtn.dataset.deleteCampaign);await chrome.storage.local.set({postflowCampaigns:state.campaigns});render();status("Saved campaign deleted.")}});
$("export").addEventListener("click",()=>{const blob=new Blob([state.groups.map(g=>g.url).join("\n")],{type:"text/plain"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="postflow-groups.txt";a.click();URL.revokeObjectURL(a.href)});
$("import").addEventListener("click",()=>$("file").click());
$("file").addEventListener("change",async e=>{const f=e.target.files?.[0];if(!f)return;const imported=uniqueGroups((await f.text()).split(/\r?\n/).filter(Boolean));state.groups=uniqueGroups([...state.groups,...imported]);state.selected=[...new Set([...state.selected,...imported.map(g=>norm(g))])];await persist();status("Imported group URLs.");e.target.value=""});
$("mediaFile").addEventListener("change",e=>{const f=e.target.files?.[0];$("mediaInfo").textContent=f?("Selected for this dashboard session: "+f.name+" · "+(f.size/1024/1024).toFixed(2)+" MB. Attach it manually on Facebook."): "Choose an image/video to keep its name visible while this dashboard is open. Attach it manually on Facebook.";});
load().catch(()=>status("Couldn't load local workspace data."));


let previewedVariations = [];
function renderCaptionHistory() {
  const target = $("captionHistoryList");
  if (!target) return;
  chrome.storage.local.get(["captionHistory"]).then(data => {
    const items = (data.captionHistory || []).slice(0, 30);
    target.innerHTML = items.length ? items.map((item, index) =>
      '<div class="history-item"><div class="history-copy"><strong>' + esc(item.caption || "") +
      '</strong><small>' + esc(new Date(item.time || Date.now()).toLocaleString()) +
      '</small></div><button class="button secondary" data-use-history="' + index + '">Use caption</button></div>'
    ).join("") : '<div class="empty">No caption history yet. Fill a caption on Facebook to add it here.</div>';
  });
}
$("previewVariations")?.addEventListener("click", () => {
  previewedVariations = [...new Set($("variationInput").value.split(/\r?\n/).map(x => x.trim()).filter(Boolean))].slice(0, 50);
  $("variationList").innerHTML = previewedVariations.length ? previewedVariations.map((caption, index) =>
    '<div class="variation-item"><div class="variation-copy"><strong>Variation ' + (index + 1) + '</strong><p>' + esc(caption) + '</p><small>' + caption.length + ' characters</small></div><button class="button secondary" data-use-variation="' + index + '">Use</button></div>'
  ).join("") : '<div class="empty">Paste at least one caption, with each variation on a separate line.</div>';
  status(previewedVariations.length + " caption variation(s) ready to review.");
});
$("clearVariations")?.addEventListener("click", () => {
  $("variationInput").value = "";
  previewedVariations = [];
  $("variationList").innerHTML = '<div class="empty">Add captions, one per line, then preview.</div>';
});
$("variationList")?.addEventListener("click", async event => {
  const button = event.target.closest("[data-use-variation]");
  if (!button) return;
  const caption = previewedVariations[Number(button.dataset.useVariation)];
  if (typeof caption !== "string") return;
  $("caption").value = caption;
  await saveDraft();
  status("Selected variation loaded into the composer. Review before use.");
});
$("captionHistoryList")?.addEventListener("click", async event => {
  const button = event.target.closest("[data-use-history]");
  if (!button) return;
  const data = await chrome.storage.local.get(["captionHistory"]);
  const item = (data.captionHistory || []).slice(0, 30)[Number(button.dataset.useHistory)];
  if (!item) return;
  $("caption").value = item.caption || "";
  await saveDraft();
  status("Previous caption loaded into the composer.");
});
$("clearCaptionHistory")?.addEventListener("click", async () => {
  if (!confirm("Clear locally saved caption history? This does not delete posts or drafts.")) return;
  await chrome.storage.local.set({captionHistory: []});
  renderCaptionHistory();
  status("Caption history cleared.");
});
renderCaptionHistory();
