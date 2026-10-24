// src/facebook.js
// Handles Facebook SDK loading, OAuth login, fetching pages, and Graph API publishing.

export function loadFacebookSdk(appId) {
  return new Promise((resolve, reject) => {
    if (!appId) {
      reject(new Error("Facebook App ID is not configured. Please add it in Settings."));
      return;
    }

    if (window.FB) {
      resolve(window.FB);
      return;
    }

    window.fbAsyncInit = function() {
      window.FB.init({
        appId: appId,
        cookie: true,
        xfbml: true,
        version: "v18.0"
      });
      resolve(window.FB);
    };

    if (document.getElementById("facebook-jssdk")) {
      resolve(window.FB);
      return;
    }

    const js = document.createElement("script");
    js.id = "facebook-jssdk";
    js.src = "https://connect.facebook.net/en_US/sdk.js";
    js.onerror = () => reject(new Error("Failed to load Facebook SDK. Check your network or ad blocker."));
    document.body.appendChild(js);
  });
}

export async function fbLogin(appId) {
  const FB = await loadFacebookSdk(appId);
  return new Promise((resolve, reject) => {
    FB.login((response) => {
      if (response.authResponse) {
        resolve(response.authResponse);
      } else {
        reject(new Error("Facebook sign-in was cancelled or authorization was incomplete."));
      }
    }, { scope: "pages_show_list,pages_manage_posts,pages_read_engagement" });
  });
}

export async function fbGetLoginStatus(appId) {
  try {
    const FB = await loadFacebookSdk(appId);
    return new Promise((resolve) => {
      FB.getLoginStatus((response) => resolve(response));
    });
  } catch {
    return { status: "unknown" };
  }
}

export async function fetchFacebookPages(accessToken) {
  try {
    const response = await fetch(`https://graph.facebook.com/v18.0/me/accounts?access_token=${accessToken}`);
    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message || "Failed to fetch Facebook pages.");
    }
    return data.data || [];
  } catch (error) {
    console.error("Error fetching Facebook pages:", error);
    throw error;
  }
}

export async function publishToFacebookGraph({ pageId, pageAccessToken, caption, mediaFile }) {
  if (!pageId || !pageAccessToken) {
    throw new Error("Selected page is not connected to a valid Facebook Page Access Token.");
  }

  if (mediaFile) {
    // Publish photo with caption using Graph API /photos endpoint
    const formData = new FormData();
    formData.append("access_token", pageAccessToken);
    formData.append("caption", caption || "");
    formData.append("source", mediaFile);

    const response = await fetch(`https://graph.facebook.com/v18.0/${pageId}/photos`, {
      method: "POST",
      body: formData,
    });
    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message || "Graph API photo publishing failed.");
    }
    return data;
  } else {
    // Publish text-only post to page feed
    const response = await fetch(`https://graph.facebook.com/v18.0/${pageId}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: caption,
        access_token: pageAccessToken,
      }),
    });
    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message || "Graph API feed publishing failed.");
    }
    return data;
  }
}