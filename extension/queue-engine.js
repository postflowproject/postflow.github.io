/* PostFlow review-first campaign queue.
 * This module only prepares and tracks work. It never clicks Facebook's Publish button.
 */
(() => {
  "use strict";
  const KEY = "postflowReviewQueue";
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
  const normalize = (value) => {
    try { const u = new URL(value); u.search = ""; u.hash = ""; return u.href.replace(/\/$/, ""); }
    catch { return ""; }
  };
  const statusNode = () => $("status");
  const say = (message) => { if (statusNode()) statusNode().textContent = message; };
  let jobs = [];

  function injectUI() {
    if ($("reviewQueuePanel")) return;
    const panel = document.createElement("section");
    panel.className = "panel";
    panel.id = "reviewQueuePanel";
    panel.innerHTML = `
      <div class="panel-head"><div><p class="eyebrow">06 / CAMPAIGN RUNNER</p><h2>Review queue</h2></div><span class="pill" id="reviewQueueCount">0 jobs</span></div>
      <p class="sub group-help">Build a saved, ordered checklist for your selected groups. Opening a group never publishes automatically; review the audience, caption and media yourself.</p>
      <div class="actions"><button id="buildReviewQueue" class="button primary">Build queue from selection</button><button id="openQueueNext" class="button secondary">Open next pending</button><button id="clearReviewQueue" class="button ghost">Clear queue</button></div>
      <div class="progress-track"><div id="reviewQueueProgress"></div></div>
      <div class="row spread"><small id="reviewQueueSummary">No queue built</small><small>Stored in this Chrome profile</small></div>
      <div id="reviewQueueItems" class="activity-list"><div class="empty">Select groups and build a queue to begin.</div></div>`;
    const campaigns = $("campaigns");
    if (campaigns?.parentNode) campaigns.parentNode.insertBefore(panel, campaigns);
    else document.querySelector("main")?.appendChild(panel);
  }

  async function loadQueue() {
    const stored = await chrome.storage.local.get(KEY);
    jobs = Array.isArray(stored[KEY]) ? stored[KEY] : [];
    render();
  }

  async function saveQueue() {
    await chrome.storage.local.set({ [KEY]: jobs });
    render();
  }

  function render() {
    if (!$("reviewQueueItems")) return;
    const complete = jobs.filter(j => j.status === "completed").length;
    const pending = jobs.filter(j => j.status === "pending").length;
    const opened = jobs.filter(j => j.status === "opened").length;
    $("reviewQueueCount").textContent = jobs.length + " jobs";
    $("reviewQueueSummary").textContent = jobs.length
      ? `${complete}/${jobs.length} reviewed · ${pending} pending · ${opened} opened`
      : "No queue built";
    $("reviewQueueProgress").style.width = (jobs.length ? Math.round(complete / jobs.length * 100) : 0) + "%";
    $("reviewQueueItems").innerHTML = jobs.length ? jobs.map((job, index) => {
      const label = job.status === "completed" ? "✓ Reviewed" : job.status === "opened" ? "↗ Opened" : "○ Pending";
      return `<div class="activity-item"><div><strong>${index + 1}. ${esc(job.groupName)}</strong><small>${esc(job.caption.slice(0, 110) || "No caption saved")} · ${esc(job.status)}</small></div><div class="campaign-actions"><button class="button secondary" data-queue-open="${esc(job.id)}">Open</button><button class="button ghost" data-queue-done="${esc(job.id)}">${job.status === "completed" ? "Undo" : "Reviewed"}</button></div></div>`;
    }).join("") : '<div class="empty">Select groups and build a queue to begin.</div>';
  }

  async function build() {
    const data = await chrome.storage.local.get(["discoveredGroups", "groups", "selectedGroups", "caption", "firstComment", "campaignName"]);
    const all = Array.isArray(data.discoveredGroups) && data.discoveredGroups.length
      ? data.discoveredGroups : (data.groups || []).map(url => ({ url, name: url }));
    const selected = new Set((data.selectedGroups || []).map(normalize));
    const targets = all.filter(g => selected.has(normalize(g.url)) && normalize(g.url));
    if (!targets.length) return say("Select at least one group first.");
    if (!String(data.caption || "").trim()) return say("Write and save a caption before building the queue.");
    if (!confirm(`Build a review queue for ${targets.length} selected group(s)? This will replace the current review queue.`)) return;
    const now = Date.now();
    jobs = targets.map((group, index) => ({
      id: (crypto.randomUUID ? crypto.randomUUID() : String(now) + "-" + index),
      groupUrl: normalize(group.url),
      groupName: String(group.name || group.title || group.url),
      caption: String(data.caption || ""),
      firstComment: String(data.firstComment || ""),
      campaignName: String(data.campaignName || "Untitled campaign"),
      order: index,
      status: "pending",
      createdAt: now,
      openedAt: null,
      reviewedAt: null
    }));
    await saveQueue();
    say("Queue built. Open each group and publish manually after review.");
  }

  async function openJob(id) {
    const job = jobs.find(item => item.id === id);
    if (!job) return;
    if (!/^https:\/\/(www\.)?facebook\.com\/groups\//i.test(job.groupUrl)) return say("This queue item has an invalid Facebook group URL.");
    const tabs = await chrome.tabs.query({ url: ["https://www.facebook.com/*", "https://facebook.com/*"] });
    const existing = tabs.find(tab => normalize(tab.url) === job.groupUrl);
    if (existing?.id) await chrome.tabs.update(existing.id, { active: true });
    else await chrome.tabs.create({ url: job.groupUrl, active: true });
    job.status = job.status === "completed" ? "completed" : "opened";
    job.openedAt = Date.now();
    await saveQueue();
    say("Opened " + job.groupName + ". Review and publish manually on Facebook.");
  }

  async function openNext() {
    const job = jobs.find(item => item.status === "pending") || jobs.find(item => item.status === "opened");
    if (!job) return say("No pending queue items. Mark reviewed items as needed.");
    await openJob(job.id);
  }

  async function markReviewed(id) {
    const job = jobs.find(item => item.id === id);
    if (!job) return;
    if (job.status === "completed") {
      job.status = "pending";
      job.reviewedAt = null;
    } else {
      if (!confirm("Mark this queue item reviewed? This is a manual checklist status only; PostFlow cannot verify publication.")) return;
      job.status = "completed";
      job.reviewedAt = Date.now();
    }
    await saveQueue();
    say("Queue updated. Publication is not verified by PostFlow.");
  }

  function bind() {
    $("buildReviewQueue")?.addEventListener("click", build);
    $("openQueueNext")?.addEventListener("click", openNext);
    $("clearReviewQueue")?.addEventListener("click", async () => {
      if (!jobs.length) return;
      if (!confirm("Clear the saved review queue? This will not delete drafts or Facebook posts.")) return;
      jobs = [];
      await saveQueue();
      say("Review queue cleared.");
    });
    $("reviewQueueItems")?.addEventListener("click", async event => {
      const open = event.target.closest("[data-queue-open]");
      const done = event.target.closest("[data-queue-done]");
      if (open) await openJob(open.dataset.queueOpen);
      if (done) await markReviewed(done.dataset.queueDone);
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    injectUI();
    bind();
    await loadQueue();
  });
})();
