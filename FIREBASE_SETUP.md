# PostFlow Firebase setup

This guide configures the Firebase backend for the development branch. The extension does not include any service-account key or admin credential.

## 1. Existing Firebase project

PostFlow is configured for Firebase project `postflow-nz786` (display name PostFlow). It already has a Web app and a Standard default Firestore database in Sydney (`australia-southeast1`). Use this existing project; do not provision another database for this integration.

In **Authentication → Sign-in method**, keep **Email/Password** enabled.

You do not need to add billing for initial development. Keep usage within the free quotas and do not enable paid services unless you intentionally choose to.

## 2. Add the public web configuration

The web dashboard uses `firebase-config.js`; the Chrome extension uses `extension/firebase-config.js`. Both contain the same public Web app configuration values:

- `apiKey`
- `authDomain`
- `projectId`
- `appId`

These are client configuration values, not service-account credentials. Never put a service-account JSON file, private key, Admin SDK credential or other secret in the extension.

## 3. Keep Firebase and Facebook sign-in separate

Firebase Authentication manages the PostFlow account with email and password. Facebook Login is a separate Meta OAuth connection used only to access Pages for the user's publishing workflow. Do not enable Facebook as a Firebase Auth provider for this app.

1. In Firebase Console → Authentication → Sign-in method, keep **Email/Password** enabled.
2. In Meta for Developers, configure **Facebook Login for the Web** for the dashboard's deployed domain and any local development domain used for testing.
3. PostFlow asks Meta for `pages_show_list`, `pages_manage_posts`, and `pages_read_engagement` to find managed Pages and publish supported Page content. Meta app roles can test while the app is in Development mode. Other users require the relevant Meta review and access approval.
4. Keep the Meta App Secret on Meta's servers only; do not place it in this repository, browser extension, web app, or Firebase client config.
5. Page access tokens are held in memory for the current browser session and are not written to local storage or Firestore. Users reconnect Facebook after a browser restart. A production backend would be needed to store and refresh tokens server-side.

The web dashboard's Meta App ID is set in Settings (with the existing app as its default). The extension does not use Meta OAuth for PostFlow sign-in. If you use a different Meta app, enter that app's public ID in the dashboard; keep its App Secret on Meta's servers only.

## 4. Deploy Firestore security rules

In Firebase Console → Firestore Database → Rules, publish the contents of `firebase/firestore.rules`.

The rules only allow an authenticated user to read or write the workspace document under their own Firebase UID. Do not test with open/public rules.

## 5. Test the web app and extension

1. Run the web dashboard on an authorized Firebase Auth domain and create a PostFlow account.
2. Save a draft, sign out, and sign back in. Confirm the Firebase document at `users/{your-uid}/workspace/main` contains the workspace.
3. Open the dashboard in another browser/device and sign in with the same account to check cross-device data recovery.
4. Test reset password with an email address you can access, then confirm logout blocks the dashboard.
5. Load or reload the extension from `chrome://extensions`, sign in with the same Firebase account, and confirm its campaign/group workspace still syncs alongside the web dashboard.
6. Separately connect Facebook from the web app's Settings, select a Page, and test only with a Page and Meta app you control. Reconnect after a browser restart. Do not treat an unreviewed Meta app as available to the public.

## Current limitations

- Sync stores the web dashboard and extension workspace state together in one Firestore document (up to 850 KB of UTF-8 serialized workspace data). It is not a real-time collaborative editor; changes are pushed after local edits and pulled at sign-in or manual sync.
- Per-account local caches prevent one PostFlow account from inheriting another account's workspace on the same browser. If the same item changes on two devices, the syncing device's version wins; if one device deletes an item that the other edited, PostFlow keeps the edited item and reports the conflict.
- The sign-in screen's “Keep me signed in” option stores the Firebase session in browser IndexedDB (or the extension's local storage); turning it off keeps it only for the current browser session. Facebook credentials never enter Firebase workspace sync.
- Media blobs remain in browser IndexedDB and are not uploaded to Firestore. Page tokens remain in memory and require reconnection after a restart.
- Publishing remains user-controlled. Scheduled posts are local plans only; dependable background scheduling needs a server-side job runner. PostFlow does not auto-click Facebook's website or publish to groups through unofficial automation.
