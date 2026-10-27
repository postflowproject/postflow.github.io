# PostFlow Group Workspace

A Chrome extension for preparing Facebook Group campaigns. It includes a user-triggered helper that reads group links currently rendered in the Facebook tab and can scroll that page to reveal more links. This is a browser UI workaround, not a Meta API, and results are incomplete and may break when Facebook changes its UI.

## Install on Windows / Chrome

1. Download the repository ZIP from the `postflow-mgp-rebuild` branch and extract it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose the repository's `extension` folder.
5. Sign in to Facebook yourself in the same Chrome profile. Reload an already-open Facebook tab after installing/updating the extension.
6. Click the PostFlow icon to use the compact popup, or open the full dashboard from the popup.
7. Sign in to your separate PostFlow Firebase account in the dashboard to sync the workspace.

## Current features

- Dark workspace dashboard and popup with group selection, caption composer, counters and progress.
- Scan group links in a Facebook tab after you click the scan button. The content script inspects the page DOM and may scroll the page, then restores its prior position. It does not run a scan on page load.
- Display group names found in loaded page links and select groups with checkboxes. Facebook may lazy-load results; repeat the scan after manually loading more. This does not guarantee discovery of every group you can access.
- Import/export group URLs as plain text.
- Save, load and delete campaign drafts with captions, optional first comments and selected groups.
- Choose a local image/video as a reminder; attach it yourself on Facebook.
- Open the next selected group, copy or fill a caption, and track completion manually.
- Keep campaigns, group lists and progress in the user's Firebase workspace and local extension storage.

## Meta API and posting limits

Meta retired the Groups API and the `publish_to_groups` and `groups_access_member_info` permissions in 2024. The scanner is not an official Meta API and cannot verify membership or posting rights. PostFlow does not automate Facebook login and does not click Publish. After reviewing the group and its rules, you must publish yourself.

The web dashboard separately supports Facebook Login for Pages through Meta's official OAuth and Graph API flow. Eligible Pages can be listed and Page posts can be published only with permissions Meta has approved for the app. Before each Page post, PostFlow asks you to confirm the Page and exact content.

## Data and limits

Campaigns, captions, selected groups and progress sync through the authenticated user's Firebase workspace. Media files remain local and are not uploaded by this extension. Facebook may change its page structure at any time, so the optional scanner may stop working or find fewer links.
