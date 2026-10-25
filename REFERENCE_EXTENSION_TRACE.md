# Reference Extension Trace — PostFlow Rebuild

Audit date: 2026-10-25
Reference inspected: `bffigfjkllaipccbpnmckgfhmdmlgdda/1.2.9.93_0/`

## Confirmed architecture from the bundled service worker

The reference worker is about 1.3 MB and has many separate message listeners rather than one central dispatcher. Its observed action names include:

- `commentQueue`
- `mgpGroupRefusals`
- `mgpRecentSamePost`
- `mgpGroupTypes`
- `mgpListingAddressSearch`
- `collectJoinedGroups`
- `resolveGroupNames`
- `silentSyncGroupNames`
- `resolveGroupId`
- `fetchLinkPreview`
- `syncScheduledListUrls`
- `removeGroupsFromScheduled`
- `fbLoginRequested`
- media/share staging actions such as `mgpStageShare`, `mgpTakeShare`, `mgpCopyMedia`, and `mgpAddShareMedia`

The worker also uses Chrome alarms for retry scheduling, including an internal `_retryQueue` stored in extension local storage. It defers retries while another campaign is posting and re-arms alarms when work remains. This confirms that durable job state, serialization, restart recovery, bounded retries and duplicate prevention are important concepts for PostFlow.

## External-service boundary

The worker defines these vendor endpoints:
- `https://server.multiplegroupposter.com`
- `https://subscription.multiplegroupposter.com`
- `https://login.multiplegroupposter.com`

Observed remote calls include a `/api/docids/config` read and a `/api/templates/config` read from the vendor API. It also contains vendor-specific Firebase Storage and Firestore configuration reads, plus telemetry/feedback integrations. Those services are not part of this repository's backend and should not be treated as PostFlow dependencies.

## Security and implementation decisions

- Do not send Facebook cookies, CSRF tokens, browser session material or raw authenticated page state to a PostFlow server.
- Do not point PostFlow at vendor endpoints or reuse vendor Firebase projects/configuration as a substitute for a backend.
- Keep group selection, drafts and review queue in the extension until the user opts into a PostFlow account/sync service.
- Keep publish actions user-controlled. Queue states such as `opened` and `reviewed` are local workflow signals, not proof that Facebook accepted a post.
- Before a future API is implemented, define authentication, ownership checks, retention, idempotency keys, rate limits and deletion behaviour.

## PostFlow queue design proposal

A future sync-capable schema can use:
- `campaigns`: id, owner_id, title, caption, first_comment, created_at, updated_at
- `campaign_groups`: campaign_id, group_url, display_name, position, selected
- `queue_jobs`: id, campaign_id, group_url, status, attempt_count, next_attempt_at, opened_at, reviewed_at, last_error, idempotency_key
- `job_events`: id, job_id, event_type, details, created_at

Proposed state machine:
`pending -> opened -> reviewed`; allow `opened -> pending` to retry/reopen and `reviewed -> pending` only after an explicit undo. Reserve `failed` for an actual operation failure, not for an unverified Facebook publish. Any server-side retry must be bounded, idempotent and visible to the user.

## What remains unverified

- Full Firebase project/auth configuration and exact sign-in contract.
- Full API request/response contracts for campaigns, schedules and subscriptions.
- Browser behaviour on the user's Facebook account and current layouts.
- Automated tests and end-to-end Chrome testing of PostFlow's new queue.

The vendor bundle is minified/large and includes substantial platform-specific behaviour; this trace is a focused inventory, not a complete security audit or proof that its server-side source is available.
