# PostFlow Multi-Group Poster Rebuild

This is the development track for PostFlow. Work only on `postflow-mgp-rebuild`; do not modify `main`.

## Product requirements

- Facebook only.
- Completely free: no subscriptions, paid tiers, billing, or paid APIs.
- No Firebase, Supabase, cloud database, PostFlow email/password account, or cloud sync.
- React/Vite dashboard state is stored in browser localStorage and media in IndexedDB.
- Extension campaigns, groups, selections, history and review queue are stored in `chrome.storage.local`.
- Facebook authentication is handled by Facebook in the user's browser. PostFlow does not collect or store Facebook passwords.
- Group posting stays review-first and user-controlled. PostFlow can prepare captions, open a selected group and track progress; the user performs the final publish action.

## Reference extension

The original Multi Group Poster reference bundle remains under `bffigfjkllaipccbpnmckgfhmdmlgdda/1.2.9.93_0/` for behaviour research only. Its bundled Firebase SDKs and vendor services are not PostFlow dependencies and must not be called by PostFlow.

## Current implementation

- React/Vite content dashboard with drafts, queue, media library, history, settings and Facebook Page connection.
- Chrome extension with local campaign drafts, Facebook group scanning, group selection, caption tools, activity tracking and review queue.
- Firebase authentication, Firestore sync, configuration, rules and setup files have been removed.
- Both dashboard and extension use local browser storage only.

## Important Facebook limitation

Meta removed the Groups API and group-publishing permissions. PostFlow cannot use an official Graph API endpoint to list every group or publish to Groups. The extension can inspect group links that Facebook has loaded in the user's signed-in browser page; the user may need to scroll/load more and scan again. Discovery is not guaranteed to include every group and may need maintenance when Facebook changes its interface.

## Next tasks

1. Improve group discovery and ensure each result has a readable group name, icon/avatar when available, and a selection checkbox.
2. Test the scanner using the user's normal Facebook browser session.
3. Confirm selected groups persist after closing and reopening the extension.
4. Test the review queue, caption insertion and manual posting flow with a group the user controls.
5. Run `npm run build` and `npm run lint`; load the extension unpacked and test it in Chrome.
6. Keep all changes on this branch until the complete workflow is verified.
