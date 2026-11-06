# PostFlow

A Facebook-focused content planning dashboard and Chrome extension.

## Current direction

- Free to use: no paid plans, subscriptions, billing, or paid backend.
- No Firebase, Supabase, or PostFlow account system.
- Dashboard data is stored locally in the browser; extension data is stored in `chrome.storage.local`.
- Facebook group discovery reads links currently loaded in the user's Facebook pages. It cannot guarantee every joined group because Meta no longer provides the Groups API.
- Posting to Facebook Groups remains manual: PostFlow prepares captions and a review queue, then the user reviews and publishes on Facebook.

## Development

Work on the `postflow-mgp-rebuild` branch only.

```bash
npm install
npm run dev
npm run build
npm run lint
```

For the Chrome extension, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the `extension` folder.

## Next work

1. Finish the Facebook group scanner and show useful group names/icons with checkboxes.
2. Test scanning against the user's logged-in Facebook session.
3. Verify the review queue and a user-confirmed manual test post.
