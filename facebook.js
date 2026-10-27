// Facebook SDK login, Page discovery, and Graph API publishing.
const GRAPH_VERSION = "v26.0";
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
    const error = new Error(data?.error?.message || `Facebook request failed (${response.status}).`);
    error.code = data?.error?.code;
    error.subcode = data?.error?.error_subcode;
    throw error;
  }
  return data;
}

function graphUpload(url, body, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.upload.onprogress = event => {
      if (event.lengthComputable && onProgress) onProgress(Math.min(88, Math.round((event.loaded / event.total) * 88)));
    };
    request.onerror = () => reject(new Error("Network connection dropped during Facebook upload. Check the Page before retrying to avoid a duplicate."));
    request.onload = () => {
      let data;
      try { data = JSON.parse(request.responseText); } catch { reject(new Error("Facebook returned an unreadable upload response.")); return; }
      if (request.status < 200 || request.status >= 300 || data?.error) {
        const error = new Error(data?.error?.message || `Facebook upload failed (${request.status}).`);
        error.code = data?.error?.code;
        error.subcode = data?.error?.error_subcode;
        reject(error);
        return;
      }
      if (onProgress) onProgress(90);
      resolve(data);
    };
    request.send(body);
  });
}

export async function fetchFacebookPages(accessToken) {
  if (!accessToken) throw new Error("Facebook login did not return an access token.");
  const params = new URLSearchParams({
    access_token: accessToken,
    fields: "id,name,category,access_token",
    limit: "100",
  });
  let nextUrl = `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?${params}`;
  const pages = [];
  const seenUrls = new Set();
  while (nextUrl) {
    const url = new URL(nextUrl);
    if (url.protocol !== "https:" || url.hostname !== "graph.facebook.com" || !url.pathname.startsWith(`/${GRAPH_VERSION}/`)) {
      throw new Error("Facebook returned an unexpected Page-list pagination URL.");
    }
    if (seenUrls.has(url.href)) throw new Error("Facebook returned a repeated Page-list pagination URL.");
    seenUrls.add(url.href);
    const data = await graphRequest(url.href);
    pages.push(...(data.data || []));
    nextUrl = data.paging?.next || "";
  }
  return pages;
}

export async function publishToFacebookGraph({ pageId, pageAccessToken, caption = "", mediaFile, onProgress }) {
  if (!pageId || !pageAccessToken) throw new Error("This destination has no valid Facebook Page access token.");

  const video = mediaFile?.type?.startsWith("video/");
  const image = mediaFile?.type?.startsWith("image/");
  if (mediaFile && !image && !video) throw new Error("Choose an image or video file supported by Facebook Pages.");
  const edge = video ? "videos" : image ? "photos" : "feed";
  const endpoint = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pageId)}/${edge}`;

  const body = new FormData();
  body.append("access_token", pageAccessToken);
  if (mediaFile) {
    body.append("source", mediaFile, mediaFile.name || "post-image");
    body.append(video ? "description" : "caption", caption);
  } else {
    if (!caption.trim()) throw new Error("Add a caption or attach an image before publishing.");
    body.append("message", caption);
  }

  if (mediaFile) return graphUpload(endpoint, body, onProgress);
  return graphRequest(endpoint, { method: "POST", body });
}

export async function fetchFacebookPostPermalink(postId, pageAccessToken) {
  if (!postId || !pageAccessToken) return "";
  const params = new URLSearchParams({ fields: "permalink_url", access_token: pageAccessToken });
  try {
    const data = await graphRequest(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(postId)}?${params}`);
    return data.permalink_url || "";
  } catch {
    return "";
  }
}
