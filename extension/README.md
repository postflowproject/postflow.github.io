# PostFlow Group Workspace

A Chrome extension for preparing Facebook group campaigns and working through a user-controlled posting queue. It uses its own PostFlow branding and code.

## Install on Windows / Chrome

1. Download the repository ZIP from GitHub and extract it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose the repository's `extension` folder.
5. Sign in to Facebook in the same Chrome profile. If Facebook was already open before installing/updating, reload the Facebook tab.
6. Open the PostFlow extension and choose the full dashboard.

## Current features

- Dark workspace dashboard with group selection, caption composer, counters and progress.
- Scans visible group links on the current Facebook tab; scroll/load more on Facebook and scan again to discover additional groups.
- Displays discovered group names and selectable checkboxes.
- Imports and exports group URLs as plain text.
- Saves campaign drafts locally, including campaign name, caption, optional first comment and selected group list.
- Loads and deletes saved campaign drafts.
- Optional image/video file picker shows the chosen media filename for the current dashboard session. It does not upload or persist the media file; attach it yourself in Facebook.
- Opens the next selected group not manually marked complete.
- Can fill a caption into a visible Facebook composer and copy the optional first comment.
- Tracks manually marked completion and local activity. This is not proof that Facebook published a post.

## Posting workflow

1. Open Facebook and scan the group list or import group URLs.
2. Select the groups you intend to post to.
3. Write the campaign caption and optional first comment; choose media as a reminder if helpful.
4. Save the campaign draft.
5. Click **Open next selected**, review the destination and group rules, attach media, and use **Fill caption on Facebook** if needed.
6. Check everything and click Facebook's Publish button yourself. Mark the group posted only after you have confirmed it.

The queue is intentionally review-first. PostFlow does not auto-submit bulk posts, bypass Facebook permissions/checkpoints, or attempt to evade platform rate limits. Use only groups where you are permitted to post, and avoid repetitive or unwanted content.

## Data and limitations

Campaigns, captions, selected groups and progress are stored in Chrome local storage for that browser profile; they do not sync automatically to another computer. Group scanning can only find links present in the currently loaded page. Facebook may change its page structure at any time, so the extension must be tested against the current Facebook UI.
