# PostFlow Firebase setup

This guide configures the Firebase backend for the development branch. The extension does not include any service-account key or admin credential.

## 1. Create the Firebase project

1. Open https://console.firebase.google.com/ and create a project for PostFlow.
2. In Project settings, add a **Web app** and copy its configuration values.
3. In **Authentication → Sign-in method**, enable **Email/Password**.
4. In **Firestore Database**, create the default database. Choose a region you can use consistently; changing it later can require a migration.

You do not need to add billing for initial development. Keep usage within the free quotas and do not enable paid services unless you intentionally choose to.

## 2. Add the public web configuration

Edit `extension/firebase-config.js` and fill these values from the Firebase Web app configuration:

- `apiKey`
- `authDomain`
- `projectId`
- `appId`

These are client configuration values, not service-account credentials. Never put a service-account JSON file, private key, Admin SDK credential or other secret in the extension.

## 3. Enable Facebook sign-in for the extension

The extension can use Facebook for PostFlow account sign-in while keeping email/password available. Facebook sign-in requests only the user's public profile and email; it does not request Facebook Page publishing permissions.

1. In Facebook for Developers, use the PostFlow Meta app and enable **Facebook Login**. Keep the app in Development mode while testing; only app roles and test users can sign in until Meta approves/publishes the app.
2. In Firebase Console → Authentication → Sign-in method, enable **Facebook**. Enter the Meta App ID and App Secret in Firebase Console. Do not put the App Secret in this repository or the extension.
3. In Firebase's Facebook provider settings, copy the OAuth redirect URI and add it to the Meta app's **Valid OAuth Redirect URIs**.
4. Load the extension in Chrome and copy its ID from `chrome://extensions`. The extension callback URL is `https://<EXTENSION_ID>.chromiumapp.org/firebase-facebook`. Add that exact URL to the Meta app's **Valid OAuth Redirect URIs**, and add `<EXTENSION_ID>.chromiumapp.org` to Firebase Authentication → Settings → Authorized domains.
5. If the unpacked extension gets a different ID on another computer or after changing its folder, update both allowlists for the new ID. A published Chrome Web Store extension keeps a stable ID.

The current PostFlow Meta App ID is configured in `extension/firebase-config.js`. If you use a different Meta app, replace that public App ID there. Its App Secret must remain only in Firebase Console.

## 4. Deploy Firestore security rules

In Firebase Console → Firestore Database → Rules, publish the contents of `firebase/firestore.rules`.

The rules only allow an authenticated user to read or write the workspace document under their own Firebase UID. Do not test with open/public rules.

## 5. Load and test the extension

1. Open `chrome://extensions`.
2. Enable Developer mode and choose **Load unpacked** (or reload the existing unpacked extension folder).
3. Open PostFlow, create an account, then sign out and sign in again.
4. Confirm a workspace document appears at `users/{your-uid}/workspace/main` in Firestore.
5. Open the same extension on another Chrome profile/device, sign in with the same account, and confirm campaigns/groups appear.
6. Test password reset using an email address you can access, then test logout and verify the workspace is blocked until sign-in.

## Current limitations

- The client is a development scaffold and has not been end-to-end tested against a live Firebase project yet.
- Sync currently stores the supported workspace state as one Firestore document (up to 850 KB of serialized workspace data). It is not a real-time collaborative editor; changes are pushed after local storage changes and pulled at sign-in.
- When local and cloud values both changed since the last sync, PostFlow keeps the local value for that field and reports the conflict in the dashboard status. On a device without sync history, non-empty local values are preserved; empty defaults are filled from the cloud.
- The sign-in screen's “Keep me signed in” option stores the session across browser restarts. Turning it off keeps the session only for the current browser session.
- Publishing remains user-controlled. PostFlow does not send Facebook cookies/session tokens to Firebase and does not auto-click Publish.
