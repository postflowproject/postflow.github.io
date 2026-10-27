import { firebaseConfig } from "./firebase-config.js";

const TEMP_SESSION_KEY = "postflow.firebase.temporary-session";
const AUTH_DB = "postflow-auth-session";
const AUTH_STORE = "sessions";
const BASE_KEY = uid => `postflow.firebase.baseline:${uid}`;
const DOC_URL = uid => `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseConfig.projectId)}/databases/(default)/documents/users/${encodeURIComponent(uid)}/workspace/main`;
const AUTH_URL = path => `https://identitytoolkit.googleapis.com/v1/${path}?key=${encodeURIComponent(firebaseConfig.apiKey)}`;
const TOKEN_URL = `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(firebaseConfig.apiKey)}`;
let session = null;

function authError(message = "REQUEST_FAILED") {
  const code = String(message).split(" : ")[0];
  const messages = {
    EMAIL_EXISTS: "That email already has a PostFlow account. Sign in instead.",
    INVALID_EMAIL: "Enter a valid email address.",
    INVALID_PASSWORD: "The email or password is incorrect.",
    EMAIL_NOT_FOUND: "The email or password is incorrect.",
    INVALID_LOGIN_CREDENTIALS: "The email or password is incorrect.",
    WEAK_PASSWORD: "Choose a stronger password (at least 6 characters).",
    TOO_MANY_ATTEMPTS_TRY_LATER: "Too many attempts. Wait a while, then try again.",
    OPERATION_NOT_ALLOWED: "Email and password sign-in is not enabled for this Firebase project.",
    API_KEY_INVALID: "Firebase configuration is invalid.",
    PROJECT_NOT_FOUND: "The Firebase project could not be found.",
  };
  return messages[code] || (code === "NETWORK_ERROR" ? "Could not reach Firebase. Check your connection." : String(message).replaceAll("_", " ").toLowerCase());
}

async function postJson(url, body, encoded = false) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": encoded ? "application/x-www-form-urlencoded" : "application/json" },
      body: encoded ? new URLSearchParams(body).toString() : JSON.stringify(body),
    });
  } catch {
    throw new Error("NETWORK_ERROR");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(authError(data.error?.message || "REQUEST_FAILED"));
  return data;
}

function openAuthDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) { reject(new Error("Persistent sign-in storage is unavailable in this browser.")); return; }
    const request = indexedDB.open(AUTH_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(AUTH_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open secure sign-in storage."));
  });
}

async function readPersistentSession() {
  const db = await openAuthDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(AUTH_STORE, "readonly").objectStore(AUTH_STORE).get("current");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Could not read the saved sign-in."));
    });
  } finally { db.close(); }
}

async function writePersistentSession(value) {
  const db = await openAuthDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(AUTH_STORE, "readwrite");
      const store = transaction.objectStore(AUTH_STORE);
      if (value) store.put(value, "current");
      else store.delete("current");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Could not save the sign-in."));
      transaction.onabort = () => reject(transaction.error || new Error("Could not save the sign-in."));
    });
  } finally { db.close(); }
}

async function saveSession(value, remember = true) {
  session = value;
  localStorage.removeItem("postflow.firebase.session");
  sessionStorage.removeItem(TEMP_SESSION_KEY);
  if (value && remember) await writePersistentSession(value);
  else await writePersistentSession(null).catch(() => {});
  if (value && !remember) sessionStorage.setItem(TEMP_SESSION_KEY, JSON.stringify(value));
}

function sessionFrom(data, remember) {
  return {
    idToken: data.idToken || data.id_token,
    refreshToken: data.refreshToken || data.refresh_token,
    expiresAt: Date.now() + Number(data.expiresIn || data.expires_in || 3600) * 1000,
    user: {
      uid: data.localId || data.user_id || data.user?.uid,
      email: data.email || data.user?.email || "",
    },
    remember,
  };
}

export async function createAccount(email, password, remember = true) {
  const data = await postJson(AUTH_URL("accounts:signUp"), { email: email.trim(), password, returnSecureToken: true });
  const next = sessionFrom(data, remember);
  await saveSession(next, remember);
  return next;
}

export async function signIn(email, password, remember = true) {
  const data = await postJson(AUTH_URL("accounts:signInWithPassword"), { email: email.trim(), password, returnSecureToken: true });
  const next = sessionFrom(data, remember);
  await saveSession(next, remember);
  return next;
}

export async function sendPasswordReset(email) {
  await postJson(AUTH_URL("accounts:sendOobCode"), { requestType: "PASSWORD_RESET", email: email.trim() });
}

export async function signOut() { await saveSession(null); }

async function refreshSession(saved) {
  const data = await postJson(TOKEN_URL, { grant_type: "refresh_token", refresh_token: saved.refreshToken }, true);
  const next = sessionFrom(data, saved.remember !== false);
  await saveSession(next, next.remember);
  return next;
}

export async function restoreSession() {
  let saved;
  try { saved = await readPersistentSession(); } catch { saved = null; }
  if (!saved) {
    try {
      const raw = sessionStorage.getItem(TEMP_SESSION_KEY);
      saved = raw ? JSON.parse(raw) : null;
    } catch { saved = null; }
  }
  if (!saved) return null;
  try {
    if (!saved.idToken || !saved.refreshToken || !saved.user?.uid) throw new Error("INVALID_SESSION");
    if (saved.expiresAt < Date.now() + 60000) saved = await refreshSession(saved);
    const check = await postJson(AUTH_URL("accounts:lookup"), { idToken: saved.idToken });
    const account = check.users?.[0];
    if (!account) throw new Error("INVALID_SESSION");
    saved.user = { uid: account.localId, email: account.email || saved.user.email };
    await saveSession(saved, saved.remember !== false);
    return session;
  } catch (error) {
    if (error.message === "NETWORK_ERROR" && saved.user?.uid) {
      session = saved;
      return session;
    }
    await signOut();
    return null;
  }
}

export async function getIdToken() {
  if (!session) return null;
  if (session.expiresAt < Date.now() + 60000) {
    try { session = await refreshSession(session); } catch { return null; }
  }
  return session.idToken;
}

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameItem = (a, b) => equal(a, b);
function mergeList(local = [], remote = [], base = []) {
  const ids = new Set([...base, ...local, ...remote].map(item => item?.id).filter(Boolean));
  const baseMap = new Map(base.map(item => [item.id, item]));
  const localMap = new Map(local.map(item => [item.id, item]));
  const remoteMap = new Map(remote.map(item => [item.id, item]));
  const merged = [];
  const conflicts = [];
  for (const id of ids) {
    const b = baseMap.get(id), l = localMap.get(id), r = remoteMap.get(id);
    const localChanged = !sameItem(l, b), remoteChanged = !sameItem(r, b);
    if (localChanged && remoteChanged && !sameItem(l, r)) conflicts.push(id);
    // When one side deletes an item the other side edited, keep the edited item to avoid data loss.
    const chosen = l === undefined && remoteChanged ? r
      : r === undefined && localChanged ? l
        : localChanged ? l
          : remoteChanged ? r : l ?? r;
    if (chosen) merged.push(chosen);
  }
  return { items: merged, conflicts };
}

export function mergeWorkspace(local, remote, base) {
  if (!remote) return { data: local, conflicts: [] };
  if (!base) {
    const lists = Object.fromEntries(["drafts", "queue", "history", "pages"].map(key => [key, mergeList(local[key] || [], remote[key] || [])]));
    return { data: {
      ...remote,
      ...Object.fromEntries(Object.entries(lists).map(([key, result]) => [key, result.items])),
      settings: { ...(remote.settings || {}), ...(local.settings || {}) },
    }, conflicts: [] };
  }
  const result = { ...remote };
  const conflicts = [];
  for (const key of ["drafts", "queue", "history", "pages"]) {
    const merged = mergeList(local[key] || [], remote[key] || [], base[key] || []);
    result[key] = merged.items;
    conflicts.push(...merged.conflicts.map(id => `${key}:${id}`));
  }
  const settings = { ...(remote.settings || {}) };
  for (const key of new Set([...Object.keys(base.settings || {}), ...Object.keys(local.settings || {}), ...Object.keys(remote.settings || {})])) {
    const localChanged = !equal(local.settings?.[key], base.settings?.[key]);
    const remoteChanged = !equal(remote.settings?.[key], base.settings?.[key]);
    if (localChanged && remoteChanged && !equal(local.settings?.[key], remote.settings?.[key])) conflicts.push(`settings:${key}`);
    if (localChanged && (!remoteChanged || equal(local.settings?.[key], remote.settings?.[key]))) {
      if (local.settings?.[key] === undefined && remoteChanged) continue;
      if (local.settings?.[key] === undefined) delete settings[key];
      else settings[key] = local.settings[key];
    }
  }
  result.settings = settings;
  return { data: result, conflicts };
}

export function sanitizeWorkspace(data) {
  const stripSecrets = value => {
    if (Array.isArray(value)) return value.map(stripSecrets);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/token|secret|credential/i.test(key))
      .map(([key, child]) => [key, stripSecrets(child)]));
  };
  const safe = {
    ...stripSecrets(data),
    drafts: data.drafts || [], queue: data.queue || [], history: data.history || [],
    pages: stripSecrets(data.pages || []),
    settings: Object.fromEntries(Object.entries(stripSecrets(data.settings || {})).filter(([key]) => !/facebookconnected/i.test(key))),
  };
  delete safe.facebookAccessToken;
  delete safe.facebookToken;
  delete safe.accessToken;
  const serialized = JSON.stringify(safe);
  if (new TextEncoder().encode(serialized).length > 850000) throw new Error("Workspace is too large to sync in a single Firestore document. Remove old records and retry.");
  return safe;
}

async function firestoreRequest(uid, method = "GET", body, precondition) {
  const idToken = await getIdToken();
  if (!idToken) throw new Error("Your Firebase session expired. Sign in again to sync.");
  let url = DOC_URL(uid);
  if (method === "PATCH") url += precondition ? `?currentDocument.updateTime=${encodeURIComponent(precondition)}` : "?currentDocument.exists=false";
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${idToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || `Workspace sync failed (${response.status}).`);
    error.status = response.status;
    error.code = data.error?.status;
    throw error;
  }
  return data;
}

function decodeDocument(document) {
  try { return JSON.parse(document.fields?.data?.stringValue || "null"); } catch { return null; }
}

function workspaceBody(data) {
  return { fields: { data: { stringValue: JSON.stringify(sanitizeWorkspace(data)) }, updatedAt: { timestampValue: new Date().toISOString() } } };
}

export async function loadAndSyncWorkspace(uid, local, hasLocalWorkspace = true) {
  let base;
  try { base = JSON.parse(localStorage.getItem(BASE_KEY(uid)) || "null"); } catch { /* Merge without a prior baseline. */ }
  let remote;
  try { remote = await firestoreRequest(uid); }
  catch (error) { if (!(error.status === 404 && error.code === "NOT_FOUND")) throw error; }
  if (!remote) {
    const data = sanitizeWorkspace(local);
    try {
      const created = await firestoreRequest(uid, "PATCH", workspaceBody(data), null);
      localStorage.setItem(BASE_KEY(uid), JSON.stringify(data));
      return { data, updateTime: created.updateTime, conflicts: [], status: "Workspace saved to your PostFlow account." };
    } catch (error) {
      if (!(error.status === 409 || error.status === 412 || error.code === "ABORTED" || error.code === "FAILED_PRECONDITION")) throw error;
      remote = await firestoreRequest(uid);
    }
  }
  const remoteData = decodeDocument(remote);
  if (!remoteData || typeof remoteData !== "object" || Array.isArray(remoteData)) throw new Error("Cloud workspace is invalid; local data has been left unchanged.");
  const merged = hasLocalWorkspace ? mergeWorkspace(sanitizeWorkspace(local), sanitizeWorkspace(remoteData), base) : { data: remoteData, conflicts: [] };
  const data = sanitizeWorkspace(merged.data);
  const saved = await firestoreRequest(uid, "PATCH", workspaceBody(data), remote.updateTime);
  localStorage.setItem(BASE_KEY(uid), JSON.stringify(data));
  return { data, updateTime: saved.updateTime, conflicts: merged.conflicts, status: merged.conflicts.length ? "Workspace synced; this device's version was kept for conflicting edits, and edited items were preserved over deletions." : "Workspace synced to your PostFlow account." };
}

export async function syncWorkspace(uid, local) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const remote = await firestoreRequest(uid);
      const remoteData = decodeDocument(remote);
      if (!remoteData || typeof remoteData !== "object" || Array.isArray(remoteData)) throw new Error("Cloud workspace is invalid.");
      let base = null;
      try { base = JSON.parse(localStorage.getItem(BASE_KEY(uid)) || "null"); } catch { base = null; }
      const merged = mergeWorkspace(sanitizeWorkspace(local), sanitizeWorkspace(remoteData), base);
      const data = sanitizeWorkspace(merged.data);
      await firestoreRequest(uid, "PATCH", workspaceBody(data), remote.updateTime);
      localStorage.setItem(BASE_KEY(uid), JSON.stringify(data));
      return { data, conflicts: merged.conflicts };
    } catch (error) {
      if (error.status === 404 && error.code === "NOT_FOUND") {
        try {
          const data = sanitizeWorkspace(local);
          await firestoreRequest(uid, "PATCH", workspaceBody(data));
          localStorage.setItem(BASE_KEY(uid), JSON.stringify(data));
          return { data, conflicts: [] };
        } catch (createError) {
          if (createError.status === 409 || createError.status === 412) continue;
          throw createError;
        }
      }
      if ((error.status === 409 || error.status === 412 || error.code === "ABORTED" || error.code === "FAILED_PRECONDITION") && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error("Another device changed the workspace repeatedly. Try syncing again.");
}
