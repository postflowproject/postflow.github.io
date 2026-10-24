# PostFlow Group Post Helper

Portable Chrome extension for preparing captions and working through Facebook Groups one at a time.

## Install on another Windows laptop

1. Download this repository (Code → Download ZIP) and extract it, or clone it with Git.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the repository's `extension` folder.
5. Sign in to Facebook in that Chrome profile, open Facebook Groups, and click the PostFlow extension.
6. Choose **Open full dashboard** for the larger workspace.

## Features

- Full dark dashboard with group list, caption composer, progress counters, and workflow status.
- Finds visible group links on the current Facebook Groups page. Scroll the list and scan again to collect more; Facebook does not expose groups that have not loaded.
- Imports and exports group URL lists as plain-text files.
- Saves caption, group list, recent caption history, and progress in Chrome local storage on that laptop.
- Opens the next group not marked posted.
- Inserts the caption into a visible composer after you open it.
- Lets you manually mark a group posted and reset progress without deleting Facebook content.
- Stops caption filling if it detects a login/checkpoint/restriction screen and warns if the exact caption was used before.

## Posting and safety

You must add/select the video, check the destination group and caption, and click Publish yourself. The extension does not automatically submit posts, bypass membership or posting permissions, defeat checkpoints, or evade rate limits. Only post content you are allowed to share and follow each group's rules.

Progress is a local manual record; it does not verify a successful Facebook publication and does not automatically sync to another laptop.
