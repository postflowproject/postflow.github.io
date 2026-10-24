# PostFlow Group Post Helper (prototype)

This is a portable Chrome extension prototype for preparing the same caption for Facebook Groups one at a time.

## Install on any Windows laptop

1. Download or clone this repository.
2. Open Chrome and visit `chrome://extensions`.
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select the `extension` folder.
5. Sign in to Facebook in that Chrome profile.

## Current prototype

- Stores a caption and a list of Facebook Group URLs locally in Chrome.
- Opens the next group in the list.
- Can attempt to fill the caption into a visible post composer after you open it.
- You still select/upload the video and review/click Publish yourself for each group.

Facebook changes its page markup often, so caption insertion may need adjustments. This extension does not bypass group membership, posting permissions, rate limits, or other Facebook controls. It does not automatically submit posts.
