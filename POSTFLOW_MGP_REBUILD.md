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
2. Add a small API layer and persistent database for campaigns, groups, queue jobs and job results.
3. Add a job lifecycle: queued → running → succeeded/failed/cancelled, with timestamps, retry limits and visible errors.
4. Keep Facebook session-dependent actions in the user's browser; do not send Facebook cookies/session tokens to the backend.
5. Require review and explicit user action for publishing; respect group permissions, platform limits and user safety.

### Phase 3 — test and release
1. Add deterministic tests for queue transitions, retries, persistence and duplicate jobs.
2. Test group discovery on the actual Facebook layouts used by the user.
3. Install the extension from one stable folder and update files in place; reload, do not uninstall/reinstall for each iteration.
4. Merge to `main` only after the end-to-end workflow has been tested.

## Status

- [x] Create isolated development branch.
- [x] Record initial reference inventory and backend boundary.
- [ ] Trace worker entry points and message handlers.
- [ ] Trace remote-service request contracts.
- [ ] Design PostFlow-owned schema and API.
- [ ] Implement and test the queue/backend.
- [ ] Integrate the extension and validate end-to-end.
