# PostFlow Chrome Extension

A free, Facebook-only helper for preparing group posts and tracking a review-first workflow.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `extension` folder.

## Use

1. Sign in to Facebook normally in Chrome.
2. Open your Facebook Groups page or another page showing your groups.
3. Open PostFlow and choose **Scan this Facebook tab**.
4. Select the groups you want with the checkboxes.
5. Save a campaign and build a review queue.
6. Open each group, review the caption and attachments, then publish manually on Facebook.

## Storage and privacy

- Campaigns, captions, group lists, selected groups, progress and queue items are stored in `chrome.storage.local`.
- No Firebase, cloud account, subscription, paid service, or external PostFlow backend is used.
- PostFlow never asks for or stores your Facebook password.
- The extension only reads group links currently loaded in the Facebook page. Scroll/load more and scan again to discover additional visible groups.
- Meta no longer provides an official Groups API or group-publishing permission, so the extension cannot guarantee it will find every group or publish automatically.

## Limitations

The extension prepares captions and a review queue. You remain responsible for checking each destination, adding media and clicking Publish yourself. A locally marked item is not proof Facebook accepted a post.
