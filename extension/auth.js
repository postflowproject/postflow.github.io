(() => {
  "use strict";
  const cfg = window.POSTFLOW_FIREBASE_CONFIG || {};
  const gate = document.getElementById("authGate");
  const workspace = document.getElementById("workspace");
  const form = document.getElementById("authForm");
  const email = document.getElementById("authEmail");
  const password = document.getElementById("authPassword");
  const remember = document.getElementById("authRemember");
  const confirmWrap = document.getElementById("authConfirmWrap");
  const confirmPassword = document.getElementById("authConfirm");
  const submit = document.getElementById("authSubmit");
  const modeButton = document.getElementById("authMode");
  const forgot = document.getElementById("authForgot");
  const title = document.getElementById("authTitle");
  const subtitle = document.getElementById("authSubtitle");
  const message = document.getElementById("authMessage");
  const configured = Boolean(cfg.apiKey && cfg.projectId);
  const storageKey = "postflowFirebaseSession";
  let mode = "login";
  let session = null;

  const authUrl = path => "https://identitytoolkit.googleapis.com/v1/" + path + "?key=" + encodeURIComponent(cfg.apiKey || "");
  const tokenUrl = () => "https://securetoken.googleapis.com/v1/token?key=" + encodeURIComponent(cfg.apiKey || "");
  function say(text, ok = false) { message.textContent = text; message.classList.toggle("success", ok); }
  function showGate() { gate.hidden = false; workspace.inert = true; }
  function showWorkspace() { gate.hidden = true; workspace.inert = false; }
  function userFrom(data) { return { uid: data.localId || data.userId || data.uid, email: data.email || "" }; }
  function friendlyError(code) {
    const map = {
      EMAIL_EXISTS: "An account already exists for this email. Try signing in.",
      INVALID_EMAIL: "Enter a valid email address.",
      INVALID_PASSWORD: "The email or password is incorrect.",
      EMAIL_NOT_FOUND: "The email or password is incorrect.",
      INVALID_LOGIN_CREDENTIALS: "The email or password is incorrect.",
      WEAK_PASSWORD: "Choose a stronger password (at least 8 characters).",
      USER_DISABLED: "This account has been disabled.",
      TOO_MANY_ATTEMPTS_TRY_LATER: "Too many attempts. Wait a while and try again.",
      OPERATION_NOT_ALLOWED: "Email/password sign-in is not enabled in the Firebase project yet.",
      API_KEY_INVALID: "The Firebase API key is invalid. Check firebase-config.js.",
      PROJECT_NOT_FOUND: "The Firebase project was not found. Check the project configuration."
    };
    return map[code] || String(code || "Request failed. Check your connection and Firebase configuration.").replaceAll("_", " ").toLowerCase();
  }
  async function request(url, body, formEncoded = false) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": formEncoded ? "application/x-www-form-urlencoded" : "application/json" },
      body: formEncoded ? new URLSearchParams(body).toString() : JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(friendlyError(data.error?.message || data.error?.errors?.[0]?.message));
    return data;
  }
  async function saveSession(next, persist = remember?.checked !== false) {
    session = next || null;
    if (session) {
      session.remember = persist;
      const store = persist ? chrome.storage.local : chrome.storage.session;
      const otherStore = persist ? chrome.storage.session : chrome.storage.local;
      await store.set({ [storageKey]: session });
      await otherStore.remove(storageKey);
    } else {
      await Promise.all([chrome.storage.local.remove(storageKey), chrome.storage.session.remove(storageKey)]);
    }
  }
  async function refresh(saved) {
    if (!saved?.refreshToken) return null;
    try {
      const data = await request(tokenUrl(), { grant_type: "refresh_token", refresh_token: saved.refreshToken }, true);
      const next = {
        idToken: data.id_token,
        refreshToken: data.refresh_token || saved.refreshToken,
        expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
        user: { uid: data.user_id || saved.user?.uid, email: saved.user?.email || "" },
        remember: saved.remember !== false
      };
      session = next;
      const store = next.remember === false ? chrome.storage.session : chrome.storage.local;
      await store.set({ [storageKey]: next });
      return next;
    } catch (error) {
      if (/network|fetch/i.test(error.message)) return saved;
      await saveSession(null);
      return null;
    }
  }
  async function validate(next) {
    const data = await request(authUrl("accounts:lookup"), { idToken: next.idToken });
    const user = data.users?.[0];
    if (!user) throw new Error("This session is no longer valid. Sign in again.");
    next.user = { uid: user.localId, email: user.email || next.user?.email || "" };
    return next;
  }
  async function enter(next, persist = next?.remember !== false) {
    await saveSession(next, persist);
    if (!next?.idToken) { showGate(); return; }
    showWorkspace();
    window.dispatchEvent(new CustomEvent("postflow:authenticated", {
      detail: { user: next.user, accessToken: next.idToken, provider: "firebase" }
    }));
  }
  function render() {
    const signup = mode === "signup", reset = mode === "reset";
    confirmWrap.hidden = !signup;
    confirmPassword.required = signup;
    password.hidden = reset;
    password.required = !reset;
    password.autocomplete = signup ? "new-password" : "current-password";
    title.textContent = signup ? "Create your account" : reset ? "Reset your password" : "Welcome back";
    subtitle.textContent = signup
      ? "Create a free PostFlow account to sync campaigns and groups across devices."
      : reset ? "We'll email you a secure password reset link."
      : "Sign in to access your workspace and sync campaigns across devices.";
    submit.textContent = signup ? "Create account" : reset ? "Send reset link" : "Sign in";
    modeButton.textContent = signup ? "Already have an account? Sign in" : "Create account";
    forgot.hidden = signup || reset;
    say("");
  }
  modeButton.addEventListener("click", () => { mode = mode === "signup" ? "login" : "signup"; render(); });
  forgot.addEventListener("click", () => { mode = "reset"; render(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!configured) return say("Firebase setup needed: fill in extension/firebase-config.js and enable Email/Password sign-in in Firebase Console.");
    const mail = email.value.trim(), pw = password.value;
    if (!mail) return say("Enter your email address.");
    if (mode !== "reset" && pw.length < 6) return say("Use a password with at least 6 characters.");
    if (mode === "signup" && pw !== confirmPassword.value) return say("The passwords don't match.");
    const requestedMode = mode;
    submit.disabled = true; submit.textContent = "Please wait…"; say("");
    try {
      if (requestedMode === "reset") {
        await request(authUrl("accounts:sendOobCode"), { requestType: "PASSWORD_RESET", email: mail });
        say("If an account exists for that email, a password reset email has been sent.", true);
      } else {
        const endpoint = requestedMode === "signup" ? "accounts:signUp" : "accounts:signInWithPassword";
        const data = await request(authUrl(endpoint), { email: mail, password: pw, returnSecureToken: true });
        const next = {
          idToken: data.idToken, refreshToken: data.refreshToken,
          expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000,
          user: userFrom(data),
          remember: remember?.checked !== false
        };
        await enter(next, next.remember);
        if (requestedMode === "signup") say("Account created. Check your email if Firebase requires email verification.", true);
      }
    } catch (error) { say(error.message || "Couldn't complete the request."); }
    finally {
      submit.disabled = false;
      submit.textContent = mode === "signup" ? "Create account" : mode === "reset" ? "Send reset link" : "Sign in";
    }
  });
  async function logout() {
    await saveSession(null);
    mode = "login"; render(); showGate();
  }
  document.getElementById("logout")?.addEventListener("click", () => window.dispatchEvent(new Event("postflow:logout")));
  window.addEventListener("postflow:logout", logout);
  async function init() {
    showGate(); render();
    if (!configured) {
      say("Firebase setup needed: fill in extension/firebase-config.js and enable Email/Password sign-in in Firebase Console.");
      return;
    }
    const stored = await chrome.storage.local.get(storageKey);
    const temporary = await chrome.storage.session.get(storageKey);
    let current = stored[storageKey] || temporary[storageKey];
    if (current && remember) remember.checked = current.remember !== false;
    if (current?.expiresAt && current.expiresAt < Date.now() + 60000) current = await refresh(current);
    if (current?.idToken) {
      try { current = await validate(current); await enter(current, current.remember !== false); return; }
      catch (error) {
        if (/network|fetch/i.test(error.message)) {
          await enter(current, current.remember !== false);
          say("Offline: showing this saved session. Cloud sync will resume when you're connected.", true);
          return;
        }
        current = await refresh(current);
        if (current?.idToken) {
          try { current = await validate(current); await enter(current, current.remember !== false); return; }
          catch { /* Keep the gate visible when the refreshed token is rejected. */ }
        }
      }
    }
    await saveSession(null); showGate();
  }
  document.getElementById("accountSignIn")?.addEventListener("click", () => openMode("login"));
  document.getElementById("accountCreate")?.addEventListener("click", () => openMode("signup"));
  document.getElementById("accountReset")?.addEventListener("click", () => openMode("reset"));
  function openMode(nextMode) {
    if (document.getElementById("accountEmail")?.value.trim()) email.value = document.getElementById("accountEmail").value.trim();
    mode = nextMode; render(); showGate();
    email.focus();
  }
  window.PostFlowAuth = {
    openMode,
    getSession: () => session,
    getAccessToken: () => session?.idToken || null,
    getUser: () => session?.user || null,
    logout: () => window.dispatchEvent(new Event("postflow:logout")),
    isConfigured: () => configured
  };
  init().catch(() => { showGate(); say("Couldn't initialize sign-in. Check Firebase configuration and network access."); });
})();
