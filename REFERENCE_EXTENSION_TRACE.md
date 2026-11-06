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

The worker also uses Chrome alarms for retry scheduling, including an internal `_retryQueue` stored in extension local storage. Durable job state, serialization, restart recovery, bounded retries and duplicate prevention are useful concepts for PostFlow.

## External-service boundary

The reference bundle contains calls to vendor endpoints such as:
- `https://server.multiplegroupposter.com`
- `https://subscription.multiplegroupposter.com`
- `https://login.multiplegroupposter.com`

It also contains Firebase-related client code for the vendor's own services. These are part of the archived reference only. PostFlow must not call vendor endpoints, reuse vendor credentials, or depend on Firebase or any paid backend.

## Security and implementation decisions

- Do not send Facebook cookies, CSRF tokens, browser session material or raw authenticated page state to a PostFlow server.
- Facebook passwords are entered only on Facebook itself; PostFlow must never collect them.
- Keep group selection, drafts and review queue in browser storage.
- Keep publish actions user-controlled. Queue states such as `opened` and `reviewed` are local workflow signals, not proof that Facebook accepted a post.
- Do not add paid services, subscription checks, cloud accounts or billing.

## PostFlow local queue design

A queue job contains:
- Unique job id
- Group URL and display name
- Caption and optional first comment
- Campaign name and order
- Local status: `pending`, `opened`, or `completed`
- Created/opened/reviewed timestamps

The state flow is:
`pending -> opened -> completed`; allow `opened -> pending` to retry/reopen and `completed -> pending` only after an explicit undo. Marking a job complete means the user reviewed/posted manually; it is not proof of publication.

## Known limitations and remaining tests

- Meta no longer provides the Groups API or group-publishing permission. PostFlow can only inspect group links currently loaded in the user's signed-in Facebook browser pages; it cannot guarantee a complete list of every joined group.
- Group discovery, group names/icons, checkboxes and persistence need live testing on the user's current Facebook layout.
- The review queue and caption insertion need an end-to-end Chrome test.
- A manual test post must be performed and confirmed by the user.
