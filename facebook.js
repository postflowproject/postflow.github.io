// Facebook SDK login, Page discovery, and Graph API publishing.
const GRAPH_VERSION = "v23.0";
let sdkPromise = null;
let initializedAppId = null;

export function loadFacebookSdk(appId) {
  if (!appId?.trim()) {
    return Promise.reject(new Error("Enter your Facebook App ID in PostFlow Settings first."));
  }
  if (window.FB && initializedAppId === appId) return Promise.resolve(window.FB);
  if (sdkPromise && initializedAppId === appId) return sdkPromise;

  initializedAppId = appId;
  sdkPromise = new Promise((resolve, reject) => {
    const initialize = () => {
      if (!window.FB) {
        sdkPromise = null;
        reject(new Error("Facebook SDK loaded without its API. Refresh the page and try again."));
        return;
      }
      try {
        window.FB.init({ appId, cookie: true, xfbml: false, version: GRAPH_VERSION });
        resolve(window.FB);
      } catch (error) {
        sdkPromise = null;
        reject(error);
      }
    };

    if (window.FB) {
      initialize();
      return;
    }

    let script = document.getElementById("facebook-jssdk");
    if (script) {
      script.addEventListener("load", initialize, { once: true });
      script.addEventListener("error", () => {
        sdkPromise = null;
        reject(new Error("Could not load Facebook SDK. Check your connection or content blocker."));
      }, { once: true });
      if (window.FB) initialize();
      return;
    }

    window.fbAsyncInit = initialize;
    script = document.createElement("script");
    script.id = "facebook-jssdk";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error("Could not load Facebook SDK. Check your connection or content blocker."));
    };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

export async function fbLogin(appId) {
  const FB = await loadFacebookSdk(appId);
  return new Promise((resolve, reject) => {
    FB.login((response) => {
      if (response?.authResponse?.accessToken) {
        resolve(response.authResponse);
      } else {
        reject(new Error("Facebook login was cancelled or denied. Check your Meta app's Facebook Login settings and allowed domains."));
      }
    }, { scope: "pages_show_list,pages_manage_posts,pages_read_engagement" });
  });
}

export async function fbGetLoginStatus(appId) {
  try {
    const FB = await loadFacebookSdk(appId);
    return await new Promise((resolve) => FB.getLoginStatus(resolve));
  } catch {
    return { status: "unknown" };
  }
}

async function graphRequest(url, options = {}) {
  const response = await fetch(url, options);
  let data;
  try { data = await response.json(); } catch { throw new Error("Facebook returned an unreadable response."); }
  if (!response.ok || data?.error) {
    throw new Error(data?.error?.message || `Facebook request failed (${response.status}).`);
  }
  return data;
}

export async function fetchFacebookPages(accessToken) {
  if (!accessToken) throw new Error("Facebook login did not return an access token.");
  const params = new URLSearchParams({
    access_token: accessToken,
    fields: "id,name,category,access_token",
    limit: "100",
  });
  const data = await graphRequest(`https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?${params}`);
  return data.data || [];
}

export async function publishToFacebookGraph({ pageId, pageAccessToken, caption = "", mediaFile }) {
  if (!pageId || !pageAccessToken) throw new Error("This destination has no valid Facebook Page access token.");

  const endpoint = mediaFile
    ? `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pageId)}/photos`
    : `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pageId)}/feed`;

  const body = new FormData();
  body.append("access_token", pageAccessToken);
  if (mediaFile) {
    if (!mediaFile.type?.startsWith("image/")) {
      throw new Error("Direct publishing currently supports images. Video publishing needs Facebook's video upload endpoint.");
    }
    body.append("source", mediaFile, mediaFile.name || "post-image");
    body.append("caption", caption);
  } else {
    if (!caption.trim()) throw new Error("Add a caption or attach an image before publishing.");
    body.append("message", caption);
  }

  return graphRequest(endpoint, { method: "POST", body });
}
