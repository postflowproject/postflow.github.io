/* PostFlow review-first campaign queue.
 * This module prepares and tracks work. It never clicks Facebook's Publish button.
 */
(() => {
  "use strict";
  const KEY = "postflowReviewQueue";
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
  const normalize = (value) => {
    try {
      const u = new URL(typeof value === "string" ? value : value?.url);
      if (u.protocol !== "https:" || !/(^|\.)facebook\.com$/i.test(u.hostname) ||
          !/^\/groups\/[^/?#]+/i.test(u.pathname)) return "";
      u.search = "";
      u.hash = "";
      return u.href.replace(/\/$/, "");
    } catch { return ""; }
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
      <p class="sub group-help">Build a saved, ordered checklist for selected groups. Opening a group never publishes automatically; review the audience, caption and media yourself.</p>
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
    jobs = Array.isArray(stored[KEY]) ? stored[KEY].filter(j =>
      j && typeof j.id === "string" && normalize(j.groupUrl) &&
      ["pending", "opened", "completed"].includes(j.status)
    ).map(j => ({ ...j, groupUrl: normalize(j.groupUrl), caption: String(j.caption || ""),
      firstComment: String(j.firstComment || ""), groupName: String(j.groupName || j.groupUrl) })) : [];
    await chrome.storage.local.set({ [KEY]: jobs });
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
    $("reviewQueueCount").textContent = jobs.length + (jobs.length === 1 ? " job" : " jobs");
    $("reviewQueueSummary").textContent = jobs.length
      ? `${complete}/${jobs.length} reviewed · ${pending} pending · ${opened} opened`
      : "No queue built";
    $("reviewQueueProgress").style.width = (jobs.length ? Math.round(complete / jobs.length * 100) : 0) + "%";
    $("reviewQueueItems").innerHTML = jobs.length ? jobs.map((job, index) => {
      const label = job.status === "completed" ? "✓ Reviewed" : job.status === "opened" ? "↗ Opened" : "○ Pending";
      return `<div class="activity-item"><div><strong>${index + 1}. ${esc(job.groupName)}</strong><small>${esc(job.caption.slice(0, 110) || "No caption saved")} · ${label}</small></div><div class="campaign-actions"><button class="button ghost" data-queue-up="${esc(job.id)}" ${index === 0 ? "disabled" : ""} aria-label="Move ${esc(job.groupName)} up">↑</button><button class="button ghost" data-queue-down="${esc(job.id)}" ${index === jobs.length - 1 ? "disabled" : ""} aria-label="Move ${esc(job.groupName)} down">↓</button><button class="button secondary" data-queue-open="${esc(job.id)}">Open</button><button class="button ghost" data-queue-copy="${esc(job.id)}">Copy caption</button><button class="button ghost" data-queue-done="${esc(job.id)}">${job.status === "completed" ? "Undo" : "Reviewed"}</button></div></div>`;
    }).join("") : '<div class="empty">Select groups and build a queue to begin.</div>';
  }

  async function build() {
    try {
      const data = await chrome.storage.local.get(["discoveredGroups", "groups", "selectedGroups", "caption", "firstComment", "campaignName"]);
      const rawGroups = Array.isArray(data.discoveredGroups) && data.discoveredGroups.length
        ? data.discoveredGroups : (Array.isArray(data.groups) ? data.groups : []);
      const seen = new Set();
      const all = rawGroups.map(item => {
        if (typeof item === "string") return { url: normalize(item), name: item };
        return { url: normalize(item?.url), name: String(item?.name || item?.title || item?.url || "") };
      }).filter(g => {
        if (!g.url || seen.has(g.url)) return false;
        seen.add(g.url);
        return true;
      });
      const selected = new Set((Array.isArray(data.selectedGroups) ? data.selectedGroups : []).map(normalize).filter(Boolean));
      const targets = all.filter(g => selected.has(g.url));
      if (!targets.length) return say("Select at least one valid Facebook group first.");
      if (!String(data.caption || "").trim()) return say("Write and save a caption before building the queue.");
      if (!confirm(`Build a review queue for ${targets.length} selected group(s)? This replaces the current review queue.`)) return;
      const now = Date.now();
      jobs = targets.map((group, index) => ({
        id: (crypto.randomUUID ? crypto.randomUUID() : String(now) + "-" + index),
        groupUrl: group.url,
        groupName: group.name || group.url,
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
    } catch (error) {
      say("Couldn't build the queue. Check extension storage permissions and try again.");
    }
  }

  async function openJob(id) {
    const job = jobs.find(item => item.id === id);
    if (!job) return;
    if (!normalize(job.groupUrl)) return say("This queue item has an invalid Facebook group URL.");
    try {
      const tabs = await chrome.tabs.query({ url: ["https://www.facebook.com/*", "https://facebook.com/*"] });
      const existing = tabs.find(tab => normalize(tab.url) === job.groupUrl);
      if (existing?.id) await chrome.tabs.update(existing.id, { active: true });
      else await chrome.tabs.create({ url: job.groupUrl, active: true });
      if (job.status !== "completed") job.status = "opened";
      job.openedAt = Date.now();
      await saveQueue();
      say("Opened " + job.groupName + ". Review and publish manually on Facebook.");
    } catch {
      say("Couldn't open that group tab. Check Chrome tab permissions and try again.");
    }
  }

  async function copyCaption(id) {
    const job = jobs.find(item => item.id === id);
    if (!job) return;
    try {
      await navigator.clipboard.writeText(job.caption);
      say("Caption copied for " + job.groupName + ". Review it before posting.");
    } catch {
      say("Clipboard access was blocked. Open the campaign caption and copy it manually.");
    }
  }

  async function openNext() {
    const job = jobs.find(item => item.status === "pending") || jobs.find(item => item.status === "opened");
    if (!job) return say("No pending queue items.");
    await openJob(job.id);
  }

  async function moveJob(id, direction) {
    const index = jobs.findIndex(item => item.id === id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= jobs.length) return;
    [jobs[index], jobs[next]] = [jobs[next], jobs[index]];
    jobs.forEach((job, order) => { job.order = order; });
    await saveQueue();
    say("Queue order updated. Open next pending follows the new order.");
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
      const copy = event.target.closest("[data-queue-copy]");
      const done = event.target.closest("[data-queue-done]");
      if (open) await openJob(open.dataset.queueOpen);
      else if (copy) await copyCaption(copy.dataset.queueCopy);
      else if (done) await markReviewed(done.dataset.queueDone);
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    injectUI();
    bind();
    try { await loadQueue(); }
    catch { say("Couldn't load the saved queue. Refresh the dashboard and try again."); }
  });
})();