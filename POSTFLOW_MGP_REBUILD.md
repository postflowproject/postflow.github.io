# PostFlow Multi-Group Poster Rebuild

This branch is the development track for an original PostFlow implementation informed by the reference extension retained in `bffigfjkllaipccbpnmckgfhmdmlgdda/1.2.9.93_0/`.

## Reference audit — initial findings

Reference extension version: 1.2.9.93.

Key components:
- `mgp-service-worker.js` (~1.33 MB): MV3 background/service worker; likely central coordinator for queues, alarms, storage, posting workflow, authentication, and remote-service calls. Needs targeted call-graph review.
- `mgp-content.js` (~463 KB): Facebook-page interaction and content-script logic.
- `mgp-engine-core.js` (~276 KB), `mgp-engine-safety.js`, `mgp-engine-ui.js`, `mgp-engine.html`: posting engine UI and safety-related logic.
- `mgp-ai-bridge.js`, `mgp-alwaysactive-*.js`, `mgp-bootstrap.js`: supporting bridge/runtime code.
- `firebase-app-compat.js`, `firebase-firestore-compat.js`: Firebase client SDKs.
- `assets/index-*.js`, `assets/App-*.js`: bundled frontend UI.
- `manifest.json`: declares Chrome storage, cookies, tabs, scripting, alarms, idle, power and declarative network request permissions; Facebook, Firebase and Multi Group Poster service domains are permitted.

Remote-service domains present in the manifest include:
- `login.multiplegroupposter.com`, `auth.multiplegroupposter.com`, `auth2.multiplegroupposter.com`
- `server.multiplegroupposter.com`, `subscription.multiplegroupposter.com`
- `firestore.googleapis.com`, `firebasestorage.googleapis.com`

The folder is a browser extension client, not proof that the vendor's server-side source is included. Server behaviour and credentials cannot be recreated from the extension alone; we need to identify the client request contracts and implement our own services.

## Rebuild approach

Build PostFlow's own code and backend, using the reference only to understand feature behaviour and integration boundaries. Do not copy vendor branding, private credentials, or attempt to impersonate its services.

### Phase 1 — trace the client
1. Inspect the reference manifest, service worker, content script and UI bundle.
2. Identify storage keys, message types, queue/job state transitions, alarm usage and external HTTP/Firebase calls.
3. Document which capabilities run locally and which depend on vendor servers.
4. Separate reusable generic concepts from vendor-specific/licensed implementation.

### Phase 2 — build the PostFlow foundation
1. Keep the current dashboard and extension as the UI baseline.
2. Add a small API layer and persistent database for campaigns, groups, queue jobs and job results only if cross-device accounts/sync are actually wanted.
3. Add a job lifecycle: queued → running → succeeded/failed/cancelled, with timestamps, retry limits and visible errors.
4. Keep Facebook session-dependent actions in the user's browser; do not send Facebook cookies/session tokens to the backend.
5. Require review and explicit user action for publishing; respect group permissions, platform limits and user safety.

### Phase 3 — test and release
1. Add deterministic tests for queue transitions, retries, persistence and duplicate jobs.
2. Test group discovery on the actual Facebook layouts used by the user.
3. Install the extension from one stable folder and update files in place; reload, do not uninstall/reinstall for each iteration.
4. Merge to `main` only after the end-to-end workflow has been tested.

## First implementation (2026-10-25)

- Added `extension/queue-engine.js` and loaded it from `dashboard.html` on this branch.
- Queue can be built from the currently selected groups and saved caption; each job stores group URL/name, caption, optional first comment, campaign label, order and status.
- Queue can open a group, mark an item manually reviewed, undo that state, and clear the queue. All state stays in `chrome.storage.local`.
- This is a first working foundation, not a full clone: it does not auto-publish, upload media, sync across devices, or call a remote backend. Facebook publication is not verified.
- Browser test and automated syntax/behaviour tests remain outstanding.

## Account and authentication pass (2026-10-26)

- User confirmed that login is required for each PostFlow profile and selected: full-screen login, create account, login, password reset, persistent session, logout, route guard, and cross-device campaign/group sync.
- Added a full-screen auth gate and client flows for email/password signup, login, password recovery, refreshable persisted sessions, and logout. The workspace is inert behind the gate until a session is validated.
- Added a dedicated-project configuration placeholder at `extension/supabase-config.js`; it intentionally contains no project URL or key. No fake login is allowed. Authentication will remain blocked until the user configures a dedicated PostFlow Supabase project.
- Added `supabase/postflow_schema.sql` for user-owned profiles, campaigns and groups with row-level security. It must only be run in a dedicated PostFlow project. The inactive "Gems Updates" project has not been reused.
- Added Supabase host permission and a visible logout control. No billing or subscriptions are included.
- **Not yet complete:** configure a dedicated PostFlow Supabase project, apply and verify the schema, connect actual cloud read/write sync for campaigns/groups, and test auth/session flows in Chrome. Do not present this scaffold as production-ready.

## Status

- [x] Create isolated development branch.
- [x] Record initial reference inventory and backend boundary.
- [x] Trace representative worker message handlers, retry/alarm storage and external service endpoints (see `REFERENCE_EXTENSION_TRACE.md`).
- [ ] Finish tracing exact remote request/response contracts; current audit is an inventory, not a complete contract map.
- [x] Implement a first persistent local review queue in `extension/queue-engine.js`: selected groups + saved caption/comment become ordered jobs with pending/opened/completed states and timestamps, persisted in `chrome.storage.local`.
- [x] Draft a PostFlow-owned campaign/group/job schema and state machine in `REFERENCE_EXTENSION_TRACE.md`.
- [ ] Implement the remote schema/API (not configured yet).\n- [x] Add an honest account/subscription UI shell; controls remain disabled until a dedicated PostFlow service exists.\n- [ ] Confirm whether the user wants login/account support or a local-only extension; if login is wanted, implement authentication only (no billing/subscriptions).
- [ ] Add automated tests for queue transitions and duplicate jobs; the local queue is not yet automated-tested.
- [ ] Integrate the extension and validate end-to-end.
