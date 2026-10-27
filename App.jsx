// src/App.jsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearMedia, deleteMedia, getAllMedia, getMediaFile, saveMedia } from "./mediaDb";
import {
  STORAGE_KEY,
  DEFAULT_SETTINGS,
  NAVIGATION,
  createInitialState,
  makeId,
  formatBytes,
  formatDate,
  fileKind,
  normaliseFilename,
  parseCSV,
  csvDateTime,
} from "./utils";
import { fbLogin, fetchFacebookPages, fetchFacebookPostPermalink, publishToFacebookGraph } from "./facebook";
import { createAccount, loadAndSyncWorkspace, restoreSession, sanitizeWorkspace, sendPasswordReset, signIn, signOut, syncWorkspace } from "./firebase-web";
import { StatCard, EmptyState, StatusBadge } from "./UI";
import "./App.css";

export default function App() {
  const initial = useMemo(() => createInitialState(), []);

  const [activePage, setActivePage] = useState("dashboard");
  const [drafts, setDrafts] = useState(initial.drafts);
  const [queue, setQueue] = useState(initial.queue);
  const [history, setHistory] = useState(initial.history);
  const [pages, setPages] = useState(initial.pages);
  const [settings, setSettings] = useState(initial.settings);

  const [currentUser, setCurrentUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authConfirm, setAuthConfirm] = useState("");
  const [rememberSession, setRememberSession] = useState(true);
  const [authMessage, setAuthMessage] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState("Workspace sync is preparing.");

  // Facebook Connection State
  const [fbConnected, setFbConnected] = useState(false);
  const [fbBusy, setFbBusy] = useState(false);

  const [media, setMedia] = useState([]);
  const [mediaUrls, setMediaUrls] = useState({});
  const [mediaSearch, setMediaSearch] = useState("");
  const [mediaFilter, setMediaFilter] = useState("All");
  const [historySearch, setHistorySearch] = useState("");
  const [queueFilter, setQueueFilter] = useState("All");

  const [caption, setCaption] = useState("");
  const [selectedMedia, setSelectedMedia] = useState([]);
  const [selectedPage, setSelectedPage] = useState("");
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("09:00");
  const [draftName, setDraftName] = useState("");
  const [newPageName, setNewPageName] = useState("");
  const [csvMessage, setCsvMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [storageError, setStorageError] = useState("");
  const [busy, setBusy] = useState(false);
  const [queueRunning, setQueueRunning] = useState(false);
  const [queuePaused, setQueuePaused] = useState(false);
  const [, setCurrentPostId] = useState(null);

  const fileInputRef = useRef(null);
  const csvInputRef = useRef(null);
  const mediaUrlRef = useRef({});
  const queueRef = useRef(queue);
  const runningRef = useRef(false);
  const pausedRef = useRef(false);
  const stopRef = useRef(false);
  const pageTokensRef = useRef({});
  const hydratedUserRef = useRef(null);
  const authGenerationRef = useRef(0);
  const currentUserRef = useRef(null);
  const hydrateGuardRef = useRef(false);

  useEffect(() => { queueRef.current = queue; }, [queue]);
  useEffect(() => { runningRef.current = queueRunning; }, [queueRunning]);
  useEffect(() => { pausedRef.current = queuePaused; }, [queuePaused]);

  const persist = useCallback(() => {
    if (!currentUser || hydratedUserRef.current !== currentUser.uid) return;
    try {
      const key = `${STORAGE_KEY}:${currentUser.uid}`;
      localStorage.setItem(key, JSON.stringify(sanitizeWorkspace({ drafts, queue, history, pages, settings })));
      setStorageError("");
    } catch (error) {
      console.error("PostFlow persistence failed:", error);
      setStorageError("Browser storage is full or unavailable. Remove old data or media and try again.");
    }
  }, [currentUser, drafts, queue, history, pages, settings]);

  useEffect(() => {
    if (settings.autoSave && !hydrateGuardRef.current) persist();
  }, [settings.autoSave, persist]);

  const activateSession = useCallback(async (authSession) => {
    const generation = ++authGenerationRef.current;
    const user = authSession.user;
    setAuthReady(false);
    setSyncStatus("Loading your PostFlow workspace…");
    const accountKey = `${STORAGE_KEY}:${user.uid}`;
    const hasAccountCopy = Boolean(localStorage.getItem(accountKey));
    const legacyMigrated = localStorage.getItem("postflow.firebase.legacy-migrated") === "true";
    const hasLegacyCopy = !legacyMigrated && Boolean(localStorage.getItem(STORAGE_KEY));
    const cached = createInitialState(user.uid);
    const localWorkspace = sanitizeWorkspace({
      drafts: cached.drafts, queue: cached.queue, history: cached.history, pages: cached.pages, settings: cached.settings,
    });

    try {
      const result = await loadAndSyncWorkspace(user.uid, localWorkspace, hasAccountCopy || hasLegacyCopy);
      if (generation !== authGenerationRef.current) return;
      hydrateGuardRef.current = true;
      setDrafts(result.data.drafts || []);
      setQueue(result.data.queue || []);
      setHistory(result.data.history || []);
      setPages(result.data.pages || []);
      setSettings({ ...DEFAULT_SETTINGS, ...(result.data.settings || {}) });
      localStorage.setItem(accountKey, JSON.stringify(sanitizeWorkspace(result.data)));
      if (hasLegacyCopy) {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.setItem("postflow.firebase.legacy-migrated", "true");
      }
      currentUserRef.current = user;
      hydratedUserRef.current = user.uid;
      setCurrentUser(user);
      setSyncStatus(result.status);
      setAuthReady(true);
      queueMicrotask(() => { hydrateGuardRef.current = false; });
    } catch (error) {
      if (generation !== authGenerationRef.current) return;
      hydrateGuardRef.current = true;
      setDrafts(localWorkspace.drafts || []);
      setQueue(localWorkspace.queue || []);
      setHistory(localWorkspace.history || []);
      setPages(localWorkspace.pages || []);
      setSettings({ ...DEFAULT_SETTINGS, ...(localWorkspace.settings || {}) });
      localStorage.setItem(accountKey, JSON.stringify(localWorkspace));
      if (hasLegacyCopy) {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.setItem("postflow.firebase.legacy-migrated", "true");
      }
      currentUserRef.current = user;
      hydratedUserRef.current = user.uid;
      setCurrentUser(user);
      setSyncStatus(`Showing this device's saved workspace. Cloud sync paused: ${error.message}`);
      setAuthReady(true);
      queueMicrotask(() => { hydrateGuardRef.current = false; });
    }
  }, []);

  useEffect(() => {
    const generation = ++authGenerationRef.current;
    restoreSession().then((saved) => {
      if (generation !== authGenerationRef.current) return;
      if (saved) activateSession(saved);
      else setAuthReady(true);
    }).catch(() => {
      if (generation === authGenerationRef.current) setAuthReady(true);
    });
    return () => { authGenerationRef.current += 1; };
  }, [activateSession]);

  useEffect(() => {
    if (!authReady || !currentUser || hydratedUserRef.current !== currentUser.uid || hydrateGuardRef.current) return undefined;
    const uid = currentUser.uid;
    const snapshot = sanitizeWorkspace({ drafts, queue, history, pages, settings });
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const result = await syncWorkspace(uid, snapshot);
        if (!cancelled && currentUserRef.current?.uid === uid) {
          const syncedWorkspace = {
            drafts: result.data.drafts || [],
            queue: result.data.queue || [],
            history: result.data.history || [],
            pages: result.data.pages || [],
            settings: { ...DEFAULT_SETTINGS, ...(result.data.settings || {}) },
          };
          if (JSON.stringify(syncedWorkspace) !== JSON.stringify(snapshot)) {
            try {
              localStorage.setItem(`${STORAGE_KEY}:${uid}`, JSON.stringify(sanitizeWorkspace(syncedWorkspace)));
            } catch {
              setStorageError("Browser storage is full or unavailable. Remove old data or media and try again.");
            }
            setDrafts(syncedWorkspace.drafts);
            setQueue(syncedWorkspace.queue);
            setHistory(syncedWorkspace.history);
            setPages(syncedWorkspace.pages);
            setSettings(syncedWorkspace.settings);
          }
          setSyncStatus(result.conflicts.length
            ? "Synced. This device's edit was kept for conflicting items; edited items were preserved over deletions."
            : "Synced to your PostFlow account.");
        }
      } catch (error) {
        if (!cancelled && currentUserRef.current?.uid === uid) setSyncStatus(`Cloud sync paused: ${error.message}`);
      }
    }, 900);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [authReady, currentUser, drafts, queue, history, pages, settings]);

  const refreshMedia = useCallback(async () => {
    try {
      const items = await getAllMedia();
      setMedia(items);
      const nextUrls = {};

      for (const item of items) {
        if (!item.type.startsWith("image/") && !item.type.startsWith("video/")) continue;
        const savedFile = await getMediaFile(item.id);
        if (savedFile?.blob) {
          nextUrls[item.id] = URL.createObjectURL(savedFile.blob);
        }
      }

      Object.values(mediaUrlRef.current).forEach(URL.revokeObjectURL);
      mediaUrlRef.current = nextUrls;
      setMediaUrls(nextUrls);
    } catch (error) {
      console.error("Could not load Media Library:", error);
      setStorageError("Could not access the Media Library in this browser.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) refreshMedia(); });
    return () => { cancelled = true; Object.values(mediaUrlRef.current).forEach(URL.revokeObjectURL); };
  }, [refreshMedia]);

  const notify = (message) => {
    setNotice(message);
    window.setTimeout(() => {
      setNotice((current) => (current === message ? "" : current));
    }, 3500);
  };

  const totalMediaSize = useMemo(() => media.reduce((total, item) => total + item.size, 0), [media]);

  const stats = useMemo(() => ({
    drafts: drafts.length,
    pending: queue.filter((item) => item.status === "Pending").length,
    completed: history.filter((item) => item.status === "Completed").length,
    failed: queue.filter((item) => item.status === "Failed").length,
  }), [drafts, queue, history]);

  const mediaByName = useMemo(() => {
    const map = new Map();
    for (const item of media) map.set(normaliseFilename(item.name), item);
    return map;
  }, [media]);

  function resolveMediaNames(names = []) {
    return names.map((name) => {
      const match = mediaByName.get(normaliseFilename(name));
      return { name, mediaId: match?.id || null, missing: !match };
    });
  }

  // Connect Facebook Account & Fetch Pages
  async function handleConnectFacebook() {
    const facebookAppId = settings.facebookAppId || "1470881274913401";
    if (!facebookAppId) {
      notify("Please enter your Facebook App ID in Settings first.");
      setActivePage("settings");
      return;
    }
    setFbBusy(true);
    try {
      const authResponse = await fbLogin(facebookAppId);
      const token = authResponse.accessToken;
      const fbPages = await fetchFacebookPages(token);
      // Keep OAuth tokens only in memory; never save them to local or cloud workspace data.
      pageTokensRef.current = Object.fromEntries(fbPages.map(page => [page.id, page.access_token]));
      const formattedPages = fbPages.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category || "Facebook Page",
        isFacebook: true,
        createdAt: new Date().toISOString(),
      }));

      // Merge avoiding duplicates
      setPages((current) => {
        const existingLocal = current.filter((cp) => !cp.isFacebook);
        return [...formattedPages, ...existingLocal];
      });
      setFbConnected(true);
      notify(`Successfully connected to Facebook! Loaded ${fbPages.length} page(s).`);
    } catch (error) {
      console.error("Facebook login error:", error);
      notify(error.message || "Failed to connect to Facebook.");
    } finally {
      setFbBusy(false);
    }
  }

  function handleDisconnectFacebook() {
    setFbConnected(false);
    pageTokensRef.current = {};
    notify("PostFlow stopped using Facebook Page access in this tab. Reconnect to publish again.");
  }

  async function handleMediaUpload(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    setBusy(true);
    try {
      let added = 0;
      for (const file of files) {
        await saveMedia(file);
        added += 1;
      }
      await refreshMedia();
      notify(`${added} file${added === 1 ? "" : "s"} added to Media Library.`);
    } catch (error) {
      console.error(error);
      notify("Upload failed. Check your browser storage space.");
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  }

  async function removeMedia(id) {
    const item = media.find((entry) => entry.id === id);
    if (settings.confirmDelete && !window.confirm(`Delete "${item?.name || "this file"}" from Media Library?`)) return;
    try {
      await deleteMedia(id);
      await refreshMedia();
      setSelectedMedia((current) => current.filter((itemId) => itemId !== id));
      notify("Media file deleted.");
    } catch (error) {
      console.error(error);
      notify("Could not delete the media file.");
    }
  }

  async function clearAllMedia() {
    if (!window.confirm("Permanently delete every file in the Media Library?")) return;
    try {
      await clearMedia();
      setSelectedMedia([]);
      await refreshMedia();
      notify("Media Library cleared.");
    } catch (error) {
      console.error(error);
      notify("Could not clear Media Library.");
    }
  }

  function toggleSelectedMedia(id) {
    setSelectedMedia((current) =>
      current.includes(id) ? current.filter((itemId) => itemId !== id) : [...current, id]
    );
  }

  function resetComposer() {
    setCaption("");
    setSelectedMedia([]);
    setSelectedPage("");
    setScheduleDate("");
    setScheduleTime("09:00");
    setDraftName("");
  }

  function buildPost(status = "Pending") {
    const mediaItems = selectedMedia.map((id) => media.find((item) => item.id === id)).filter(Boolean);
    const destination = pages.find((page) => page.id === selectedPage || page.name === selectedPage);
    return {
      id: makeId(),
      caption: caption.trim(),
      mediaIds: mediaItems.map((item) => item.id),
      mediaNames: mediaItems.map((item) => item.name),
      page: destination?.name || selectedPage,
      pageId: destination?.id || "",
      scheduledAt: scheduleDate ? new Date(`${scheduleDate}T${scheduleTime || "09:00"}`).toISOString() : "",
      status,
      progress: 0,
      createdAt: new Date().toISOString(),
    };
  }

  function validateComposer() {
    if (!caption.trim() && selectedMedia.length === 0) {
      notify("Add a caption or select at least one media file.");
      return false;
    }
    if (scheduleDate) {
      const scheduled = new Date(`${scheduleDate}T${scheduleTime || "09:00"}`);
      if (Number.isNaN(scheduled.getTime())) {
        notify("Please enter a valid schedule date and time.");
        return false;
      }
      if (scheduled.getTime() < Date.now()) {
        notify("The scheduled date and time must be in the future.");
        return false;
      }
    }
    return true;
  }

  function saveDraft() {
    if (!validateComposer()) return;
    const draft = buildPost("Draft");
    draft.name = draftName.trim() || `Draft ${drafts.length + 1}`;
    setDrafts((current) => [draft, ...current]);
    resetComposer();
    notify("Draft saved.");
  }

  function addToQueue() {
    if (!validateComposer()) return;
    const status = scheduleDate ? "Scheduled" : "Pending";
    const post = buildPost(status);
    setQueue((current) => [...current, post]);
    resetComposer();
    setActivePage("queue");
    notify(status === "Scheduled" ? "Post scheduled locally." : "Post added to queue.");
  }

  function loadDraft(draft) {
    setCaption(draft.caption || "");
    setSelectedMedia((draft.mediaIds || []).filter((id) => media.some((item) => item.id === id)));
    setSelectedPage(draft.pageId || draft.page || "");
    setScheduleDate(draft.scheduledAt ? new Date(draft.scheduledAt).toLocaleDateString("en-CA") : "");
    setScheduleTime(draft.scheduledAt ? new Date(draft.scheduledAt).toTimeString().slice(0, 5) : "09:00");
    setDraftName(draft.name || "");
    setActivePage("bulk");
    notify("Draft loaded into the composer.");
  }

  function deleteDraft(id) {
    if (settings.confirmDelete && !window.confirm("Delete this draft?")) return;
    setDrafts((current) => current.filter((draft) => draft.id !== id));
    notify("Draft deleted.");
  }

  async function handleCSVImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const rows = parseCSV(text);
      if (!rows.length) {
        setCsvMessage("No posts found. Check your CSV headers and rows.");
        return;
      }

      const imported = rows.map((row) => {
        const names = row.mediaName.split(/[;|]/).map((name) => name.trim()).filter(Boolean);
        const resolved = resolveMediaNames(names);
        const scheduledAt = csvDateTime(row.date, row.time);
        return {
          id: makeId(),
          caption: row.caption,
          mediaIds: resolved.filter((item) => item.mediaId).map((item) => item.mediaId),
          mediaNames: names,
          missingMedia: resolved.filter((item) => item.missing).map((item) => item.name),
          page: row.page,
          pageId: pages.find((page) => page.name === row.page)?.id || "",
          scheduledAt,
          status: scheduledAt ? "Scheduled" : "Pending",
          progress: 0,
          createdAt: new Date().toISOString(),
        };
      });

      setQueue((current) => [...current, ...imported]);
      const missingCount = imported.reduce((total, post) => total + (post.missingMedia?.length || 0), 0);
      setCsvMessage(`Imported ${imported.length} post(s). ${missingCount} missing media reference(s).`);
      setActivePage("queue");
      notify("CSV import finished.");
    } catch (error) {
      console.error(error);
      setCsvMessage("Could not read the CSV file.");
    } finally {
      event.target.value = "";
    }
  }

  function downloadCSVTemplate() {
    const template = [
      "caption,media filename,page,schedule date,schedule time",
      '"Your post caption","example.jpg","My Page","2030-01-01","09:00"',
      '"Another caption","video.mp4","My Page","",""',
    ].join("\r\n");
    const blob = new Blob([template], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "postflow-template.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function addPage() {
    const name = newPageName.trim();
    if (!name) { notify("Enter a page name first."); return; }
    if (pages.some((page) => page.name.toLowerCase() === name.toLowerCase())) {
      notify("That page name already exists.");
      return;
    }
    setPages((current) => [...current, { id: makeId(), name, createdAt: new Date().toISOString() }]);
    setNewPageName("");
    notify("Local page entry added.");
  }

  function updatePost(id, changes) {
    setQueue((current) => current.map((post) => (post.id === id ? { ...post, ...changes } : post)));
  }

  function removePost(id) {
    if (settings.confirmDelete && !window.confirm("Remove this queue item?")) return;
    setQueue((current) => current.filter((post) => post.id !== id));
    notify("Queue item removed.");
  }

  function retryPost(id) {
    updatePost(id, { status: "Pending", progress: 0, error: "" });
  }

  function clearCompleted() {
    setQueue((current) => current.filter((post) => post.status !== "Completed"));
    notify("Completed queue items cleared.");
  }

  function resetQueue() {
    if (!window.confirm("Reset the queue and remove every queue item?")) return;
    stopRef.current = true;
    runningRef.current = false;
    pausedRef.current = false;
    setQueueRunning(false);
    setQueuePaused(false);
    setCurrentPostId(null);
    setQueue([]);
    notify("Queue reset.");
  }

  function movePost(id, direction) {
    setQueue((current) => {
      const index = current.findIndex((post) => post.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length || current[index].status === "Processing" || current[nextIndex].status === "Processing") {
        return current;
      }
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }

  // Queue Runner with Real Facebook Graph API Publishing
  async function startQueue() {
    if (runningRef.current) return;
    stopRef.current = false;
    pausedRef.current = false;
    runningRef.current = true;
    setQueueRunning(true);
    setQueuePaused(false);

    let activeId = null;
    try {
      while (!stopRef.current) {
        if (pausedRef.current) {
          await new Promise((resolve) => window.setTimeout(resolve, 200));
          continue;
        }
        const next = queueRef.current.find((post) => post.status === "Pending");
        if (!next) break;

        activeId = next.id;
        setCurrentPostId(activeId);

        try {
          // A live Page post needs a clear, per-post confirmation of its destination and exact content.
          const targetPageObj = pages.find((p) => p.id === next.pageId) || pages.find((p) => p.name === next.page);
          const pageAccessToken = targetPageObj?.isFacebook ? pageTokensRef.current[targetPageObj.id] : null;
          const isRealFbPage = Boolean(targetPageObj && pageAccessToken);

          if (targetPageObj?.isFacebook && !pageAccessToken) {
            throw new Error("Reconnect Facebook in Settings before publishing to this Page. The Page access token is only kept in memory and does not survive a browser restart.");
          }

          if (isRealFbPage) {
            const attachmentNames = (next.mediaNames || []).join(", ") || "none";
            const confirmed = window.confirm(
              `Publish this post to the Facebook Page “${targetPageObj.name}”?\n\nPost content:\n${next.caption || "(no caption)"}\n\nAttachments: ${attachmentNames}\n\nChoose OK to send this exact post to Meta.`,
            );
            if (!confirmed) {
              stopRef.current = true;
              setQueue((current) => current.map((post) => (post.id === activeId ? { ...post, status: "Pending", progress: 0, error: "Not published. Confirmation was cancelled." } : post)));
              break;
            }
          }

          // Persist the in-flight marker before contacting Meta so a restart never auto-retries an uncertain publish.
          const processingQueue = queueRef.current.map((post) => (post.id === activeId ? { ...post, status: "Processing", progress: 10 } : post));
          queueRef.current = processingQueue;
          setQueue(processingQueue);
          localStorage.setItem(`${STORAGE_KEY}:${currentUser.uid}`, JSON.stringify(sanitizeWorkspace({ drafts, queue: processingQueue, history, pages, settings })));

          if (isRealFbPage) {
            if ((next.mediaIds || []).length > 1) {
              throw new Error("Direct Facebook Page publishing currently sends one image or one video per post. Split multiple attachments into separate posts.");
            }
            let mediaFileObj = null;
            if (next.mediaIds && next.mediaIds.length > 0) {
              const savedMedia = await getMediaFile(next.mediaIds[0]);
              if (!savedMedia?.blob || !savedMedia.file) throw new Error("The selected media is stored only in another browser. Add the file to this device's Media Library before publishing.");
              mediaFileObj = savedMedia.file;
            }

            setQueue((current) => current.map((post) => (post.id === activeId ? { ...post, progress: 50 } : post)));

            // Publish via Graph API
            const publication = await publishToFacebookGraph({
              pageId: targetPageObj.id,
              pageAccessToken,
              caption: next.caption,
              mediaFile: mediaFileObj,
              onProgress: (progress) => setQueue((current) => current.map((post) => (post.id === activeId ? { ...post, progress } : post))),
            });
            const facebookPostId = publication.post_id || publication.id || "";
            const permalink = await fetchFacebookPostPermalink(facebookPostId, pageAccessToken);

            const completedAt = new Date().toISOString();
            const historyItem = {
              ...next,
              status: "Completed",
              progress: 100,
              completedAt,
              facebookPostId,
              facebookPostUrl: permalink,
              result: `Successfully published live to Facebook Page: ${targetPageObj.name}`,
            };

            setQueue((current) => current.map((post) => (post.id === activeId ? { ...post, status: "Completed", progress: 100 } : post)));
            setHistory((current) => [historyItem, ...current]);
          } else {
            // Simulate completion if no real Facebook page is assigned
            for (let progress = 20; progress <= 100; progress += 20) {
              while (pausedRef.current && !stopRef.current) {
                await new Promise((resolve) => window.setTimeout(resolve, 200));
              }
              if (stopRef.current) break;
              await new Promise((resolve) => window.setTimeout(resolve, 350));
              setQueue((current) => current.map((post) => (post.id === activeId ? { ...post, progress } : post)));
            }

            if (stopRef.current) {
              setQueue((current) => current.map((post) => (post.id === activeId ? { ...post, status: "Pending", progress: 0 } : post)));
              break;
            }

            const completedAt = new Date().toISOString();
            const finished = queueRef.current.find((post) => post.id === activeId);
            const historyItem = {
              ...finished,
              status: "Completed",
              progress: 100,
              completedAt,
              result: "Simulated completion — local destination not linked to Facebook",
            };

            setQueue((current) => current.map((post) => (post.id === activeId ? { ...post, status: "Completed", progress: 100 } : post)));
            setHistory((current) => [historyItem, ...current]);
          }
        } catch (apiError) {
          console.error("Publishing error:", apiError);
          if ([190, 102].includes(Number(apiError.code))) {
            pageTokensRef.current = {};
            setFbConnected(false);
          }
          const failureMessage = /network|fetch|load failed|failed to fetch/i.test(apiError.message)
            ? (/duplicate/i.test(apiError.message) ? apiError.message : `${apiError.message} Facebook may have received the request; check the Page before retrying to avoid a duplicate.`)
            : apiError.message;
          setQueue((current) => current.map((post) => (post.id === activeId ? { ...post, status: "Failed", error: failureMessage } : post)));
          const historyItem = {
            ...next,
            status: "Failed",
            completedAt: new Date().toISOString(),
            result: `Failed: ${failureMessage}`,
          };
          setHistory((current) => [historyItem, ...current]);
        }
      }
    } finally {
      runningRef.current = false;
      setQueueRunning(false);
      setQueuePaused(false);
      setCurrentPostId(null);
    }
    notify(stopRef.current ? "Queue stopped." : "Queue processing finished.");
  }

  const pauseQueue = () => { pausedRef.current = true; setQueuePaused(true); };
  const resumeQueue = () => { pausedRef.current = false; setQueuePaused(false); };
  const stopQueue = () => { stopRef.current = true; pausedRef.current = false; setQueuePaused(false); };
  const clearHistory = () => { if (window.confirm("Delete all history records?")) { setHistory([]); notify("History cleared."); } };

  function clearAllSavedData() {
    if (!window.confirm("This removes drafts, queue items, history, local page entries, settings and all media files. Continue?")) return;
    stopRef.current = true;
    setDrafts([]); setQueue([]); setHistory([]); setPages([]); setSettings(DEFAULT_SETTINGS); setSelectedMedia([]);
    setFbConnected(false); pageTokensRef.current = {};
    localStorage.removeItem(STORAGE_KEY);
    if (currentUser) localStorage.removeItem(`${STORAGE_KEY}:${currentUser.uid}`);
    clearMedia().then(refreshMedia).then(() => notify("All PostFlow local data has been cleared.")).catch(console.error);
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    const email = authEmail.trim();
    if (!email) { setAuthMessage("Enter your email address."); return; }
    if (authMode === "reset") {
      setAuthBusy(true); setAuthMessage("");
      try {
        await sendPasswordReset(email);
        setAuthMessage("If an account exists for that email, a password reset link has been sent.");
      } catch (error) { setAuthMessage(error.message); }
      finally { setAuthBusy(false); }
      return;
    }
    if (authPassword.length < 6) { setAuthMessage("Use a password with at least 6 characters."); return; }
    if (authMode === "signup" && authPassword !== authConfirm) { setAuthMessage("The passwords do not match."); return; }
    setAuthBusy(true); setAuthMessage("");
    try {
      const authSession = authMode === "signup"
        ? await createAccount(email, authPassword, rememberSession)
        : await signIn(email, authPassword, rememberSession);
      setAuthPassword(""); setAuthConfirm("");
      await activateSession(authSession);
    } catch (error) { setAuthMessage(error.message || "Could not sign in. Check your connection and Firebase setup."); }
    finally { setAuthBusy(false); }
  }

  async function handleSignOut() {
    authGenerationRef.current += 1;
    stopRef.current = true;
    pageTokensRef.current = {};
    setFbConnected(false);
    await signOut();
    currentUserRef.current = null;
    hydratedUserRef.current = null;
    setCurrentUser(null);
    setAuthMode("login");
    setAuthPassword("");
    setAuthMessage("");
    setAuthReady(true);
  }

  const filteredMedia = useMemo(() => media.filter((item) => {
    const matchesSearch = item.name.toLowerCase().includes(mediaSearch.toLowerCase());
    const matchesType = mediaFilter === "All" ||
      (mediaFilter === "Images" && item.type.startsWith("image/")) ||
      (mediaFilter === "Videos" && item.type.startsWith("video/")) ||
      (mediaFilter === "Other" && !item.type.startsWith("image/") && !item.type.startsWith("video/"));
    return matchesSearch && matchesType;
  }), [media, mediaSearch, mediaFilter]);

  const filteredQueue = useMemo(() => queue.filter((post) => queueFilter === "All" || post.status === queueFilter), [queue, queueFilter]);

  const filteredHistory = useMemo(() => history.filter((item) => {
    const query = historySearch.toLowerCase();
    return (item.caption || "").toLowerCase().includes(query) || (item.page || "").toLowerCase().includes(query) || (item.status || "").toLowerCase().includes(query);
  }), [history, historySearch]);

  function renderComposer() {
    return (
      <div className="composer-layout">
        <section className="panel composer-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">CONTENT STUDIO</span>
              <h2>Create a post</h2>
              <p>Prepare a post and add it to your queue.</p>
            </div>
            <span className="heading-icon">✦</span>
          </div>

          <label className="field-label" htmlFor="post-caption">Caption</label>
          <textarea
            id="post-caption"
            className="text-input caption-input"
            placeholder="What would you like to share?"
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            maxLength={63206}
          />

          <div className="character-count">{caption.length.toLocaleString()} characters</div>

          <label className="field-label" htmlFor="draft-name">Draft name (optional)</label>
          <input
            id="draft-name"
            className="text-input"
            placeholder="e.g. Monday promotion"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
          />

          <div className="field-row">
            <div className="field-group">
              <label className="field-label" htmlFor="page-select">Destination Page</label>
              <select
                id="page-select"
                className="text-input"
                value={selectedPage}
                onChange={(event) => setSelectedPage(event.target.value)}
              >
                <option value="">No page selected</option>
                {pages.map((page) => (
                  <option key={page.id} value={page.id}>
                    {page.name} {page.isFacebook ? " (Facebook Page)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-group">
              <label className="field-label" htmlFor="post-date">Schedule date</label>
              <input
                id="post-date"
                type="date"
                className="text-input"
                value={scheduleDate}
                onChange={(event) => setScheduleDate(event.target.value)}
              />
            </div>
          </div>

          <div className="field-row">
            <div className="field-group">
              <label className="field-label" htmlFor="post-time">Schedule time</label>
              <input
                id="post-time"
                type="time"
                className="text-input"
                value={scheduleTime}
                onChange={(event) => setScheduleTime(event.target.value)}
                disabled={!scheduleDate}
              />
            </div>
            <div className="field-group">
              <label className="field-label">Attached media</label>
              <div className="attached-count">
                <span>▧</span> {selectedMedia.length} selected
              </div>
            </div>
          </div>

          <div className="composer-actions">
            <button className="btn btn-secondary" onClick={saveDraft}>
              Save draft
            </button>
            <button className="btn btn-primary" onClick={addToQueue}>
              {scheduleDate ? "Schedule locally ↗" : "Add to queue ↗"}
            </button>
          </div>

          {scheduleDate && (
            <p className="inline-notice">
              Scheduled for {formatDate(new Date(`${scheduleDate}T${scheduleTime}`).toISOString())}.
            </p>
          )}
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">MEDIA LIBRARY</span>
              <h2>Attach files</h2>
              <p>Select existing files or upload new media.</p>
            </div>
            <button
              className="btn btn-secondary btn-small"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              + Upload
            </button>
          </div>

          <input
            ref={fileInputRef}
            className="hidden-input"
            type="file"
            accept="image/*,video/*"
            multiple
            onChange={handleMediaUpload}
          />

          {media.length === 0 ? (
            <EmptyState
              icon="▧"
              title="Your library is empty"
              detail="Upload images or videos to attach them to your posts."
              action={
                <button
                  className="btn btn-primary"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Upload media
                </button>
              }
            />
          ) : (
            <div className="attach-grid">
              {media.map((item) => {
                const selected = selectedMedia.includes(item.id);

                return (
                  <button
                    type="button"
                    key={item.id}
                    className={`attach-item ${selected ? "selected" : ""}`}
                    onClick={() => toggleSelectedMedia(item.id)}
                    title={item.name}
                  >
                    <div className="attach-preview">
                      {mediaUrls[item.id] && item.type.startsWith("image/") ? (
                        <img src={mediaUrls[item.id]} alt={item.name} />
                      ) : mediaUrls[item.id] && item.type.startsWith("video/") ? (
                        <video src={mediaUrls[item.id]} muted />
                      ) : (
                        <span>{item.type.startsWith("video/") ? "▶" : "▧"}</span>
                      )}
                      <span className="select-check">{selected ? "✓" : "+"}</span>
                    </div>
                    <span className="attach-name">{item.name}</span>
                    <span className="attach-size">{formatBytes(item.size)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    );
  }

  function renderDashboard() {
    return (
      <>
        <section className="hero-panel">
          <div className="hero-copy">
            <span className="eyebrow">YOUR CONTENT WORKSPACE</span>
            <h2>Make every post<br /><span>count.</span></h2>
            <p>Organise your content, publish to Facebook Pages and keep your workflow in one place.</p>
            <button className="btn btn-primary" onClick={() => setActivePage("bulk")}>
              Create a post <span>↗</span>
            </button>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="hero-orb">P</div>
            <div className="floating-card floating-card-top">✦ <span>Content ready</span></div>
            <div className="floating-card floating-card-bottom">↗ <span>{fbConnected ? "Facebook Connected" : "Local mode"}</span></div>
          </div>
        </section>

        <div className="stats-grid">
          <StatCard label="Saved drafts" value={stats.drafts} detail="Ready to edit" icon="▤" />
          <StatCard label="Pending posts" value={stats.pending} detail="Waiting in queue" icon="◷" />
          <StatCard label="Completed" value={stats.completed} detail="Successfully published" icon="✓" />
          <StatCard label="Failed posts" value={stats.failed} detail="Need attention" icon="!" />
        </div>

        <div className="dashboard-grid">
          <section className="panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">WORKFLOW</span>
                <h2>Quick actions</h2>
              </div>
            </div>
            <div className="quick-actions">
              {[
                ["▤", "Create bulk posts", "Compose and prepare content", "bulk"],
                ["▧", "Manage media", "Organise images and videos", "media"],
                ["◷", "View queue", "Review posts awaiting processing", "queue"],
                ["↺", "Review history", "See your saved activity", "history"],
              ].map(([icon, title, description, page]) => (
                <button className="quick-action" key={page} onClick={() => setActivePage(page)}>
                  <span className="quick-icon">{icon}</span>
                  <span className="quick-copy">
                    <strong>{title}</strong>
                    <small>{description}</small>
                  </span>
                  <span className="quick-arrow">↗</span>
                </button>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">RECENT ACTIVITY</span>
                <h2>Latest posts</h2>
              </div>
              <button className="text-button" onClick={() => setActivePage("history")}>View all ↗</button>
            </div>

            {history.length === 0 ? (
              <EmptyState
                icon="↺"
                title="Nothing here yet"
                detail="Completed posts and publications will appear here."
              />
            ) : (
              <div className="compact-list">
                {history.slice(0, 4).map((item) => (
                  <div className="compact-row" key={`${item.id}-${item.completedAt}`}>
                    <span className="compact-icon">▤</span>
                    <div className="compact-copy">
                      <strong>{item.caption || "Media post"}</strong>
                      <small>{formatDate(item.completedAt)}</small>
                    </div>
                    <StatusBadge status={item.status} />
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </>
    );
  }

  function renderQueue() {
    const processing = queue.find((post) => post.status === "Processing");

    return (
      <>
        <div className="page-intro-row">
          <div>
            <span className="eyebrow">POST OPERATIONS</span>
            <h2>Queue manager</h2>
            <p>Control the order and publication of your queued posts to Facebook.</p>
          </div>
          <div className="queue-controls">
            {!queueRunning ? (
              <button className="btn btn-primary" onClick={startQueue} disabled={!queue.some((p) => p.status === "Pending")}>
                ▶ Start queue
              </button>
            ) : queuePaused ? (
              <button className="btn btn-primary" onClick={resumeQueue}>▶ Resume</button>
            ) : (
              <button className="btn btn-secondary" onClick={pauseQueue}>Ⅱ Pause</button>
            )}
            {queueRunning && (
              <button className="btn btn-danger" onClick={stopQueue}>■ Stop</button>
            )}
            <button className="btn btn-secondary" onClick={clearCompleted}>Clear completed</button>
          </div>
        </div>

        {processing && (
          <div className="simulation-banner">
            <span className="pulse-dot" />
            <div>
              <strong>Processing queue</strong>
              <p>Publishing posts to Facebook Graph API...</p>
            </div>
            <span className="banner-percent">{processing.progress}%</span>
          </div>
        )}

        <div className="stats-grid compact-stats">
          {["Pending", "Scheduled", "Processing", "Completed", "Failed"].map((status) => (
            <StatCard
              key={status}
              label={status}
              value={queue.filter((post) => post.status === status).length}
              detail="Queue items"
              icon={
                status === "Completed" ? "✓" :
                status === "Failed" ? "!" :
                status === "Processing" ? "↻" : "◷"
              }
            />
          ))}
        </div>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">YOUR POSTS</span>
              <h2>Queue items <span className="muted-count">{queue.length}</span></h2>
            </div>
            <div className="toolbar">
              <select
                className="text-input compact-select"
                value={queueFilter}
                onChange={(event) => setQueueFilter(event.target.value)}
              >
                {["All", "Pending", "Scheduled", "Processing", "Completed", "Failed"].map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
              <button className="btn btn-secondary btn-small" onClick={() => csvInputRef.current?.click()}>
                Import CSV
              </button>
              <button className="btn btn-secondary btn-small" onClick={downloadCSVTemplate}>
                CSV template
              </button>
              <input
                ref={csvInputRef}
                type="file"
                className="hidden-input"
                accept=".csv,text/csv"
                onChange={handleCSVImport}
              />
            </div>
          </div>

          {csvMessage && <p className="inline-notice">{csvMessage}</p>}

          {filteredQueue.length === 0 ? (
            <EmptyState
              icon="☷"
              title="Your queue is clear"
              detail="Create a post or import a CSV to get started."
              action={<button className="btn btn-primary" onClick={() => setActivePage("bulk")}>Create a post</button>}
            />
          ) : (
            <div className="post-list">
              {filteredQueue.map((post) => (
                <article className="post-row" key={post.id}>
                  <div className="post-number">
                    {queue.findIndex((item) => item.id === post.id) + 1}
                  </div>
                  <div className="post-main">
                    <div className="post-row-top">
                      <strong>{post.caption || "Media post"}</strong>
                      <StatusBadge status={post.status} />
                    </div>
                    <p className="post-caption">{post.caption || "No caption supplied."}</p>
                    <div className="post-meta">
                      <span>▧ {(post.mediaNames || []).length} media</span>
                      <span>▣ {post.page || "No page"}</span>
                      <span>◷ {post.scheduledAt ? formatDate(post.scheduledAt) : "No schedule"}</span>
                    </div>

                    {(post.missingMedia || []).length > 0 && (
                      <p className="warning-text">
                        Missing media: {post.missingMedia.join(", ")}
                      </p>
                    )}

                    {post.error && (
                      <p className="warning-text">Error: {post.error}</p>
                    )}

                    {post.status === "Processing" && (
                      <div className="progress-track">
                        <div className="progress-fill" style={{ width: `${post.progress || 0}%` }} />
                      </div>
                    )}
                  </div>

                  <div className="post-actions">
                    <button
                      className="icon-button"
                      title="Move up"
                      disabled={post.status === "Processing"}
                      onClick={() => movePost(post.id, -1)}
                    >↑</button>
                    <button
                      className="icon-button"
                      title="Move down"
                      disabled={post.status === "Processing"}
                      onClick={() => movePost(post.id, 1)}
                    >↓</button>
                    {post.status === "Failed" && (
                      <button className="icon-button" title="Retry" onClick={() => retryPost(post.id)}>↻</button>
                    )}
                    <button
                      className="icon-button icon-danger"
                      title="Remove"
                      disabled={post.status === "Processing"}
                      onClick={() => removePost(post.id)}
                    >×</button>
                  </div>
                </article>
              ))}
            </div>
          )}

          {queue.length > 0 && (
            <div className="panel-footer">
              <span>{queue.length} total queue items</span>
              <button className="text-button danger-text" onClick={resetQueue}>Reset entire queue</button>
            </div>
          )}
        </section>
      </>
    );
  }

  function renderMediaLibrary() {
    return (
      <>
        <div className="page-intro-row">
          <div>
            <span className="eyebrow">ASSET MANAGEMENT</span>
            <h2>Media library</h2>
            <p>Your uploaded files are stored in this browser using IndexedDB.</p>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
          >
            + Upload media
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden-input"
            accept="image/*,video/*"
            multiple
            onChange={handleMediaUpload}
          />
        </div>

        <div className="stats-grid">
          <StatCard label="Total files" value={media.length} detail="Stored locally" icon="▧" />
          <StatCard label="Storage used" value={formatBytes(totalMediaSize)} detail="Approximate media size" icon="▤" />
          <StatCard label="Images" value={media.filter((item) => item.type.startsWith("image/")).length} detail="Image assets" icon="▧" />
          <StatCard label="Videos" value={media.filter((item) => item.type.startsWith("video/")).length} detail="Video assets" icon="▶" />
        </div>

        <section className="panel">
          <div className="media-toolbar">
            <input
              className="text-input search-input"
              placeholder="Search filenames..."
              value={mediaSearch}
              onChange={(event) => setMediaSearch(event.target.value)}
            />
            <select
              className="text-input compact-select"
              value={mediaFilter}
              onChange={(event) => setMediaFilter(event.target.value)}
            >
              {["All", "Images", "Videos", "Other"].map((filter) => (
                <option key={filter}>{filter}</option>
              ))}
            </select>
            <button className="btn btn-secondary" onClick={refreshMedia}>↻ Refresh</button>
          </div>

          {filteredMedia.length === 0 ? (
            <EmptyState
              icon="▧"
              title={media.length ? "No matching files" : "Upload your first asset"}
              detail={media.length ? "Try a different search or filter." : "Images and videos you upload will be saved in this browser."}
              action={!media.length ? <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()}>Choose files</button> : null}
            />
          ) : (
            <div className="media-grid">
              {filteredMedia.map((item) => (
                <article className="media-card" key={item.id}>
                  <div className="media-preview">
                    {mediaUrls[item.id] && item.type.startsWith("image/") ? (
                      <img src={mediaUrls[item.id]} alt={item.name} />
                    ) : mediaUrls[item.id] && item.type.startsWith("video/") ? (
                      <video src={mediaUrls[item.id]} controls preload="metadata" />
                    ) : (
                      <div className="media-placeholder">
                        <span>{item.type.startsWith("video/") ? "▶" : "▧"}</span>
                        <small>{fileKind(item)}</small>
                      </div>
                    )}
                    <span className="media-type">{fileKind(item)}</span>
                  </div>
                  <div className="media-card-content">
                    <strong title={item.name}>{item.name}</strong>
                    <div className="media-card-meta">
                      <span>{formatBytes(item.size)}</span>
                      <span>{new Date(item.createdAt).toLocaleDateString()}</span>
                    </div>
                    <div className="media-card-actions">
                      <button
                        className="btn btn-secondary btn-small"
                        onClick={() => {
                          toggleSelectedMedia(item.id);
                          setActivePage("bulk");
                        }}
                      >
                        {selectedMedia.includes(item.id) ? "Selected" : "Use in post"}
                      </button>
                      <button className="icon-button icon-danger" onClick={() => removeMedia(item.id)} title="Delete media">×</button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}

          <div className="panel-footer">
            <span>{filteredMedia.length} of {media.length} files</span>
            {media.length > 0 && (
              <button className="text-button danger-text" onClick={clearAllMedia}>Delete all media</button>
            )}
          </div>
        </section>
      </>
    );
  }

  function renderDrafts() {
    return (
      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">SAVED CONTENT</span>
            <h2>Your drafts</h2>
            <p>Drafts are saved locally in your browser.</p>
          </div>
          <button className="btn btn-primary" onClick={() => setActivePage("bulk")}>+ New draft</button>
        </div>

        {drafts.length === 0 ? (
          <EmptyState icon="▤" title="No drafts saved" detail="Save a post from the composer to keep working on it later." action={<button className="btn btn-primary" onClick={() => setActivePage("bulk")}>Create draft</button>} />
        ) : (
          <div className="post-list">
            {drafts.map((draft) => (
              <article className="post-row" key={draft.id}>
                <div className="post-number">▤</div>
                <div className="post-main">
                  <strong>{draft.name || "Untitled draft"}</strong>
                  <p className="post-caption">{draft.caption || "No caption"}</p>
                  <div className="post-meta">
                    <span>▧ {(draft.mediaIds || []).length} media</span>
                    <span>▣ {draft.page || "No page"}</span>
                    <span>◷ {formatDate(draft.createdAt)}</span>
                  </div>
                </div>
                <div className="post-actions">
                  <button className="btn btn-secondary btn-small" onClick={() => loadDraft(draft)}>Edit</button>
                  <button className="icon-button icon-danger" onClick={() => deleteDraft(draft.id)}>×</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    );
  }

  function renderHistory() {
    return (
      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">ACTIVITY LOG</span>
            <h2>Post history</h2>
            <p>Completed and published activity records.</p>
          </div>
          <button className="btn btn-secondary" onClick={clearHistory} disabled={!history.length}>Clear history</button>
        </div>

        <div className="media-toolbar">
          <input
            className="text-input search-input"
            placeholder="Search captions, pages or statuses..."
            value={historySearch}
            onChange={(event) => setHistorySearch(event.target.value)}
          />
          <span className="muted-count">{filteredHistory.length} records</span>
        </div>

        {filteredHistory.length === 0 ? (
          <EmptyState icon="↺" title="No history found" detail="Completed publications will be recorded here." />
        ) : (
          <div className="post-list">
            {filteredHistory.map((item, index) => (
              <article className="post-row" key={`${item.id}-${item.completedAt || index}`}>
                <div className="post-number">✓</div>
                <div className="post-main">
                  <div className="post-row-top">
                    <strong>{item.caption || "Media post"}</strong>
                    <StatusBadge status={item.status || "Completed"} />
                  </div>
                  <div className="post-meta">
                    <span>▣ {item.page || "No page"}</span>
                    <span>▧ {(item.mediaNames || []).length} media</span>
                    <span>◷ {formatDate(item.completedAt)}</span>
                    {item.facebookPostId && <span>Facebook ID: {item.facebookPostId}</span>}
                  </div>
                  {item.facebookPostUrl && <a className="text-button" href={item.facebookPostUrl} target="_blank" rel="noreferrer">Open Facebook post ↗</a>}
                  <p className="simulation-note">{item.result || "Activity record."}</p>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    );
  }

  function renderScheduler() {
    const scheduled = queue.filter((post) => post.status === "Scheduled");

    return (
      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">PLANNING</span>
            <h2>Scheduler</h2>
            <p>Review locally scheduled posts before processing.</p>
          </div>
          <button className="btn btn-primary" onClick={() => setActivePage("bulk")}>+ Schedule post</button>
        </div>

        {scheduled.length === 0 ? (
          <EmptyState icon="◷" title="Nothing scheduled" detail="Choose a future date and time in the post composer." action={<button className="btn btn-primary" onClick={() => setActivePage("bulk")}>Schedule a post</button>} />
        ) : (
          <div className="post-list">
            {[...scheduled]
              .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
              .map((post) => (
                <article className="post-row" key={post.id}>
                  <div className="post-number">◷</div>
                  <div className="post-main">
                    <strong>{post.caption || "Media post"}</strong>
                    <p className="post-caption">Scheduled for {formatDate(post.scheduledAt)}</p>
                    <div className="post-meta"><span>▣ {post.page || "No page"}</span></div>
                  </div>
                  <div className="post-actions">
                    <button className="btn btn-secondary btn-small" onClick={() => {
                      setCaption(post.caption || "");
                      setSelectedMedia(post.mediaIds || []);
                      setSelectedPage(post.pageId || post.page || "");
                      setScheduleDate(new Date(post.scheduledAt).toLocaleDateString("en-CA"));
                      setScheduleTime(new Date(post.scheduledAt).toTimeString().slice(0, 5));
                      setQueue((current) => current.filter((item) => item.id !== post.id));
                      setActivePage("bulk");
                    }}>Edit</button>
                    <button className="icon-button icon-danger" onClick={() => removePost(post.id)}>×</button>
                  </div>
                </article>
              ))}
          </div>
        )}
      </section>
    );
  }

  function renderPages() {
    return (
      <>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">DESTINATIONS</span>
              <h2>Facebook Pages & Destinations</h2>
              <p>Connect your Facebook account to manage and post to your Facebook Pages.</p>
            </div>
            {fbConnected ? (
              <button className="btn btn-secondary btn-small" onClick={handleDisconnectFacebook} disabled={fbBusy}>
                Disconnect Facebook
              </button>
            ) : (
              <button className="btn btn-primary" onClick={handleConnectFacebook} disabled={fbBusy}>
                {fbBusy ? "Connecting..." : "Connect Facebook ↗"}
              </button>
            )}
          </div>

          <p className="inline-notice">
            Facebook Groups are not available to discover or publish through Meta’s official Graph API. PostFlow can list every Page returned by your approved account access and publish to a Page after you confirm each post.
          </p>

          <form className="add-page-form" onSubmit={(event) => {
            event.preventDefault();
            addPage();
          }}>
            <input
              className="text-input"
              placeholder="Or enter a local page label..."
              value={newPageName}
              onChange={(event) => setNewPageName(event.target.value)}
            />
            <button className="btn btn-secondary" type="submit">Add local entry</button>
          </form>

          {pages.length === 0 ? (
            <EmptyState icon="▣" title="No pages connected" detail="Connect your Facebook account or add local entries to organise your post queue." />
          ) : (
            <div className="post-list">
              {pages.map((page) => (
                <article className="post-row" key={page.id}>
                  <div className="page-avatar">{page.name.slice(0, 1).toUpperCase()}</div>
                  <div className="post-main">
                    <strong>{page.name}</strong>
                    <p className="post-caption">
                      {page.isFacebook ? `Facebook Page (${page.category || "Connected"})` : "Local page entry"}
                    </p>
                  </div>
                  <button className="icon-button icon-danger" onClick={() => {
                    if (!settings.confirmDelete || window.confirm(`Remove "${page.name}"?`)) {
                      setPages((current) => current.filter((item) => item.id !== page.id));
                    }
                  }}>×</button>
                </article>
              ))}
            </div>
          )}
        </section>
      </>
    );
  }

  function renderSettings() {
    return (
      <>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">FACEBOOK API CONFIGURATION</span>
              <h2>Meta Integration</h2>
              <p>Connect a Facebook account to discover and publish to Pages you manage. This connection is separate from your PostFlow account.</p>
            </div>
          </div>

          <div className="settings-list">
            <div className="setting-row">
              <div>
                <strong>Facebook App ID</strong>
                <p>From your app dashboard at developers.facebook.com</p>
              </div>
              <input
                className="text-input"
                style={{ maxWidth: "260px" }}
                placeholder="e.g. 123456789012345"
                value={settings.facebookAppId || ""}
                onChange={(event) => {
                  const val = event.target.value;
                  setSettings((current) => ({ ...current, facebookAppId: val }));
                }}
              />
            </div>
            <div className="setting-row">
              <div>
                <strong>Facebook Status</strong>
                <p>{fbConnected ? "Connected to Facebook API" : "Not connected"}</p>
              </div>
              {fbConnected ? (
                <button className="btn btn-secondary btn-small" onClick={handleDisconnectFacebook}>Disconnect</button>
              ) : (
                <button className="btn btn-primary btn-small" onClick={handleConnectFacebook} disabled={fbBusy}>Connect Now</button>
              )}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">POSTFLOW ACCOUNT</span>
              <h2>Workspace sync</h2>
              <p>Signed in as {currentUser?.email || "your PostFlow account"}. Facebook credentials are never saved with this workspace.</p>
            </div>
          </div>
          <div className="settings-list">
            <div className="setting-row">
              <div><strong>Cloud status</strong><p>{syncStatus}</p></div>
              <button className="btn btn-secondary" type="button" onClick={async () => {
                try {
                  const result = await syncWorkspace(currentUser.uid, sanitizeWorkspace({ drafts, queue, history, pages, settings }));
                  const data = result.data;
                  setDrafts(data.drafts || []); setQueue(data.queue || []); setHistory(data.history || []); setPages(data.pages || []); setSettings({ ...DEFAULT_SETTINGS, ...(data.settings || {}) });
                  setSyncStatus(result.conflicts.length ? "Synced with conflict handling; this device's version was kept for conflicting edits." : "Synced to your PostFlow account.");
                } catch (error) { setSyncStatus(`Cloud sync paused: ${error.message}`); }
              }}>Sync now</button>
            </div>
            <div className="setting-row">
              <div><strong>PostFlow sign-in</strong><p>Email and password managed by Firebase Authentication.</p></div>
              <button className="btn btn-secondary" type="button" onClick={handleSignOut}>Sign out</button>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">PREFERENCES</span>
              <h2>Settings</h2>
              <p>Configure how PostFlow behaves in this browser.</p>
            </div>
          </div>

          <div className="settings-list">
            <div className="setting-row">
              <div><strong>Automatic saving</strong><p>Save drafts, queue, history, pages and preferences to local storage.</p></div>
              <label className="switch">
                <input type="checkbox" checked={settings.autoSave} onChange={(event) => setSettings((current) => ({ ...current, autoSave: event.target.checked }))} />
                <span />
              </label>
            </div>
            <div className="setting-row">
              <div><strong>Confirm before deletion</strong><p>Ask before removing drafts, queue items or media.</p></div>
              <label className="switch">
                <input type="checkbox" checked={settings.confirmDelete} onChange={(event) => setSettings((current) => ({ ...current, confirmDelete: event.target.checked }))} />
                <span />
              </label>
            </div>
            <div className="setting-row">
              <div><strong>Export saved data</strong><p>Download your drafts, queue, history, pages and settings as a JSON backup.</p></div>
              <button className="btn btn-secondary" onClick={() => {
                const backup = {
                  exportedAt: new Date().toISOString(),
                  drafts, queue, history, pages, settings,
                };
                const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = "postflow-backup.json";
                anchor.click();
                URL.revokeObjectURL(url);
              }}>Export JSON</button>
            </div>
          </div>
        </section>

        <section className="panel danger-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">DANGER ZONE</span>
              <h2>Storage management</h2>
              <p>These actions cannot be undone.</p>
            </div>
          </div>
          <div className="setting-row">
            <div><strong>Delete all media</strong><p>Remove every image and video from IndexedDB.</p></div>
            <button className="btn btn-danger" onClick={clearAllMedia}>Delete media</button>
          </div>
          <div className="setting-row">
            <div><strong>Reset all PostFlow data</strong><p>Remove saved drafts, queue, history, page entries, preferences and media.</p></div>
            <button className="btn btn-danger" onClick={clearAllSavedData}>Reset all data</button>
          </div>
        </section>
      </>
    );
  }

  const pageDetails = {
    dashboard: ["Overview", "Your workspace at a glance."],
    bulk: ["Bulk posts", "Create, organise and prepare content."],
    scheduler: ["Scheduler", "Plan your upcoming content."],
    queue: ["Queue manager", "Manage and process queued posts."],
    media: ["Media library", "Manage your image and video assets."],
    history: ["History", "Review past activity."],
    pages: ["Pages", "Organise destinations for your posts."],
    settings: ["Settings", "Manage your workspace preferences."],
    drafts: ["Drafts", "Continue where you left off."],
  };

  const [pageTitle, pageSubtitle] = pageDetails[activePage] || pageDetails.dashboard;

  // Firebase protects the PostFlow workspace; Facebook Page authorization is a separate connection.
  if (!authReady || !currentUser) {
    const signup = authMode === "signup";
    const reset = authMode === "reset";
    return (
      <main className="login-screen">
        <section className="login-card" aria-labelledby="postflow-auth-title">
          <div className="login-brand-mark"><span>P</span></div>
          <p className="login-eyebrow">POSTFLOW ACCOUNT</p>
          <h1 id="postflow-auth-title">{!authReady ? "Loading your workspace" : signup ? "Create your account" : reset ? "Reset your password" : "Welcome back"}</h1>
          <p className="login-description">{!authReady ? "Checking your saved sign-in and workspace…" : signup ? "Create a free account to keep your PostFlow workspace in sync." : reset ? "We’ll send a password reset link to your email." : "Sign in to open your workspace and sync across devices."}</p>
          {authReady && <form className="login-auth-form" onSubmit={handleAuthSubmit}>
            <label htmlFor="postflow-auth-email">Email address</label>
            <input id="postflow-auth-email" className="login-auth-input" type="email" autoComplete="email" required value={authEmail} onChange={event => setAuthEmail(event.target.value)} placeholder="you@example.com" />
            {!reset && <>
              <label htmlFor="postflow-auth-password">Password</label>
              <input id="postflow-auth-password" className="login-auth-input" type="password" autoComplete={signup ? "new-password" : "current-password"} minLength={6} required value={authPassword} onChange={event => setAuthPassword(event.target.value)} placeholder="At least 6 characters" />
            </>}
            {signup && <>
              <label htmlFor="postflow-auth-confirm">Confirm password</label>
              <input id="postflow-auth-confirm" className="login-auth-input" type="password" autoComplete="new-password" minLength={6} required value={authConfirm} onChange={event => setAuthConfirm(event.target.value)} placeholder="Enter your password again" />
            </>}
            {!reset && <label className="login-remember"><input type="checkbox" checked={rememberSession} onChange={event => setRememberSession(event.target.checked)} /> Keep me signed in on this device</label>}
            {authMessage && <p className="login-notice" role="status">{authMessage}</p>}
            <button className="login-auth-submit" disabled={authBusy} type="submit">{authBusy ? "Please wait…" : reset ? "Send reset link" : signup ? "Create account" : "Sign in"}</button>
          </form>}
          {authReady && <div className="login-auth-links">
            <button type="button" onClick={() => { setAuthMode(signup ? "login" : "signup"); setAuthMessage(""); }}>{signup ? "Already have an account? Sign in" : "Create account"}</button>
            {!signup && <button type="button" onClick={() => { setAuthMode(reset ? "login" : "reset"); setAuthMessage(""); }}>{reset ? "Back to sign in" : "Forgot password?"}</button>}
          </div>}
          <p className="login-footnote">Your PostFlow account is separate from Facebook. Connect a Facebook Page after signing in.</p>
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setActivePage("dashboard")} aria-label="PostFlow home">
          <span className="brand-mark"><span>P</span></span>
          <span className="brand-copy"><strong>postflow<span>.</span></strong><small>CONTENT STUDIO</small></span>
        </button>

        <div className="workspace-switcher">
          <div className="workspace-avatar">P</div>
          <div><strong>My workspace</strong><small>{fbConnected ? "Facebook Connected" : "Local mode"}</small></div>
          <span className="workspace-chevron">⌄</span>
        </div>

        <div className="nav-section-label">WORKSPACE</div>
        <nav className="sidebar-nav">
          {NAVIGATION.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${activePage === item.id ? "active" : ""}`}
              onClick={() => setActivePage(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
              {item.id === "queue" && queue.length > 0 && <span className="nav-count">{queue.length}</span>}
            </button>
          ))}
          <button
            className={`nav-item ${activePage === "drafts" ? "active" : ""}`}
            onClick={() => setActivePage("drafts")}
          >
            <span className="nav-icon">▤</span>
            <span>Drafts</span>
            {drafts.length > 0 && <span className="nav-count">{drafts.length}</span>}
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-status">
            <span className={`status-indicator ${fbConnected ? "status-completed" : ""}`} />
            <div><strong>{fbConnected ? "Live Facebook" : "Local mode"}</strong><small>{fbConnected ? "API Connected" : "Facebook not connected"}</small></div>
          </div>
          <button className="nav-item" onClick={() => setActivePage("settings")}>
            <span className="nav-icon">⚙</span><span>Preferences</span>
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Workspace</span><span className="breadcrumb-slash">/</span><strong>{pageTitle}</strong>
          </div>
          <div className="topbar-actions">
            <span className="save-indicator" title={syncStatus}><span /> {syncStatus.startsWith("Cloud sync paused") ? "Sync paused" : "Cloud sync"}</span>
            <button className="btn btn-secondary btn-small" type="button" onClick={handleSignOut}>Sign out</button>
            <button className="topbar-avatar" onClick={() => setActivePage("settings")}>P</button>
          </div>
        </header>

        <div className="page-content">
          <div className="page-heading">
            <div>
              <h1>{pageTitle}</h1>
              <p>{pageSubtitle}</p>
            </div>
            {activePage !== "bulk" && activePage !== "settings" && (
              <button className="btn btn-primary" onClick={() => setActivePage("bulk")}>
                <span>+</span> Create post
              </button>
            )}
          </div>

          {storageError && <div className="error-banner">⚠ {storageError}</div>}

          {activePage === "dashboard" && renderDashboard()}
          {activePage === "bulk" && renderComposer()}
          {activePage === "queue" && renderQueue()}
          {activePage === "media" && renderMediaLibrary()}
          {activePage === "drafts" && renderDrafts()}
          {activePage === "history" && renderHistory()}
          {activePage === "scheduler" && renderScheduler()}
          {activePage === "pages" && renderPages()}
          {activePage === "settings" && renderSettings()}

          <footer className="app-footer">
            <span>PostFlow <span className="footer-dot">●</span> System 5</span>
            <span>{fbConnected ? "Connected to Meta Graph API" : "Local workspace · Simulated publishing"}</span>
          </footer>
        </div>
      </main>

      {notice && (
        <div className="toast" role="status">
          <span className="toast-check">✓</span>{notice}
        </div>
      )}
    </div>
  );
}
