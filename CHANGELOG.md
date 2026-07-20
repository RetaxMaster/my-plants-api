# Changelog — `my-plants-api`

All notable, user-facing changes to the MyPlants API. Newest first.

## Unreleased — Plant Doctor becomes a copilot: your approval is now required

**The Plant Doctor can no longer change your plants on its own.** Until now, the diagnostic agent could
edit a plant's profile, correct a progress entry, and change its watering or misting cadence directly
while it worked. From this release it can only **propose** those changes — you see exactly what it wants
to do and decide.

### Fixed

- **A declined Plant Doctor proposal never actually reached the agent.** Hitting Decline always recorded
  your decision correctly — that part never broke. But the notice telling the agent "the user declined your
  request" was composed and then silently failed to send, so the agent kept working as though you had said
  nothing. **To be clear about what this is and is not:** this was never a consent-gate failure. The gate is
  enforced server-side; nothing was ever auto-approved and no change to a plant was ever written without
  your explicit approval. The only thing that failed was telling the agent afterwards that you had said no —
  a feedback problem, not a permission problem. It is fixed, and the agent is now told every time.
- **A second layer of the same bug, one level down:** even once the notice was composed correctly, the
  database itself refused to store it. A pre-existing CHECK constraint required every turn to carry either a
  user prompt or an agent command — a shape nobody anticipated a decline-only turn (which carries neither,
  only the system notice) into existence, and the mismatch made the whole write illegal. **Migration `0024`**
  widens that constraint to also admit a system-message-only turn; every row already in the database already
  satisfies it, so no backfill runs.
- **The care engine could anchor an adaptation cycle after the very event it was measuring.** When the
  engine learns from how you actually water — nudging a plant's cadence toward your real rhythm — each
  learning cycle is pinned to a reference date (its anchor). In an edge case that anchor could land *after*
  the event the cycle was meant to measure, describing a span of negative length and feeding the adaptation a
  nonsensical interval. The anchor is now clamped so it can never sit later than the event it measures.
  Normal watering is unaffected; only the impossible case is corrected.

### Added

- **Image attachments in both chats.** You can attach photos to a message in the knowledge-engine research
  chat and the per-plant diagnosis chat — up to 6 images per message, 10 MiB each and 20 MiB total, in PNG,
  JPEG, GIF or WebP. The engine stores them for 24 hours so the agent can see them for its own turn; they are
  never written onto the conversation's permanent record.
- **A message queue.** Sending a message while the agent is still working on a turn no longer refuses it —
  it is held and sent automatically the moment the turn ends. If that turn instead fails or is cancelled, the
  message is handed back rather than lost.
- **A native channel for system notices.** Platform notices to the agent — "the user declined your request",
  "the user still has not approved the request", and the like — now travel structurally alongside your
  message instead of being pasted as a `[system] ...` prefix onto the front of it. The retired prefix is
  gone from anything written from this release forward.

### What you'll notice

- **A proposal, not a change.** When the doctor concludes something should change, a banner appears in
  the chat listing every field it wants to touch, with the current value and the proposed one side by
  side. Nothing is written until you approve.
- **You are approving facts, not a description.** The list is built by the server from the actual
  operations, with names it owns ("Every (days)", "Pot type", "Health"). The agent's own one-line summary
  is a caption only — if its prose and its actual request ever disagreed, the list is what happens.
- **You are told when the world moved.** If you edited the same field yourself after the doctor looked,
  the banner shows the *current* value as the before, and also what the doctor originally saw. It never
  presents a stale reading as if it were current.
- **All or nothing.** Approving a proposal with several changes applies every one of them or none. A
  proposal that can no longer be applied — say you deleted the progress entry it wanted to edit — fails
  cleanly with a readable reason and leaves your plant untouched. There is no half-applied state.
- **Declining tells the agent.** Decline and the doctor is informed and picks up the conversation from
  there, immediately if it's idle. Sending it a new message also withdraws whatever was pending, and it
  is told that too, so it never keeps waiting on an answer you already moved past.
- **One request at a time.** The doctor cannot stack up proposals; a new one replaces whatever was
  pending for that conversation.
- **"Skip permissions", if you want it.** You can grant a diagnosis session standing consent, and its
  proposals apply immediately without a banner. It is per conversation, never global, and it records who
  turned it on and when. Turning it off takes effect right away — a proposal already in flight will not
  slip through.
- **Every change is attributable, forever.** The API now keeps an append-only record of who was behind
  each write to a plant — you, or the doctor acting on a proposal you approved (with that proposal's
  identity). That record outlives the conversation it came from, so deleting an old diagnosis chat never
  erases the history of what it changed.

### For integrators

- **Breaking:** a `scope:'doctor'` token now receives **403** on `PATCH /plants/:id/profile`,
  `PATCH /plants/:id/progress/:entryId`, `PUT /plants/:id/frequency` and
  `DELETE /plants/:id/frequency/:task`. Owner and admin tokens are unaffected — only the doctor lost
  access. Its single write is `POST /plants/:id/diagnose/sessions/:sessionId/proposals`.
- **New endpoints** under `/plants/:id/diagnose/sessions/:sessionId`: `POST proposals`,
  `GET proposals/pending`, `POST proposals/:proposalId/approve`, `POST proposals/:proposalId/decline`,
  and `GET`/`PATCH settings`. Full contracts in `docs/api/README.md`.
- **A doctor token is now sealed to its session and run**, so it cannot file a proposal against another
  conversation about the same plant.
- **Requires migration `0022`.** It adds the proposal and origin-audit tables, the skip-permissions and
  queued-message columns, and a new `LAUNCHING` run status. **No new environment variable.**
- **`LAUNCHING` is a new value on the run status field.** Clients that render run status should treat it
  as active, alongside `QUEUED` and `RUNNING`.
- The session/run-creation endpoints on both chat surfaces accept an optional `attachments` array
  (`id`, `filename`, `mimeType`, base64 `data`), validated server-side (6 files max, 10 MiB each, 20 MiB
  total, PNG/JPEG/GIF/WebP only); the engine re-validates independently regardless.
- New env vars `KNOWLEDGE_CHAT_UPLOAD_DIR` and `PLANT_DOCTOR_UPLOAD_DIR`, each defaulting to its own
  `storage/` subdirectory (created at boot, `0700`) — set them only if you want the upload root elsewhere.
- **Requires migration `0024`** (see Fixed above): `knowledge_chat_runs`'s prompt/command CHECK constraint
  is renamed and widened; no environment variable changes.
- Attachment and transport failures now surface as a small set of stable codes (`attachment_too_large`,
  `attachment_corrupt`, `attachments_unavailable`, `message_too_long`, `payload_too_large`, …) instead of the
  engine's own free-text error prose, so a client can branch on them without parsing English.

### Under the hood

- The plant, progress, frequency and feedback writes now live in **one implementation each**, shared by
  the owner's own endpoints and the proposal applier. An approved proposal takes literally the same code
  path your own edit does, so the two can never drift apart.
- Run start-up takes a **launch lease** before spawning an agent process, and always records that
  process's identity — which is what lets a deploy wait for in-flight diagnoses instead of orphaning
  them.
- Messages sent to the agent about your decisions are delivered **at most once**, surviving a crash or a
  failed launch without either duplicating or vanishing.
- `@retaxmaster/agents-realtime-server` and `-protocol` are upgraded to `3.0.0`; the same client line
  reaches `3.0.1` in `my-plants-web` (a client-only, documentation-only point release — no behaviour differs
  from `3.0.0`).
- A queued system message is now delivered by launching the agent from the run row the platform already
  admitted, rather than from a separately-passed input — the same at-most-once guarantee above now also
  covers the message that used to go missing (see Fixed).
- **The Plant Doctor's proposal-operation contract now lives in the shared
  `@retaxmaster/my-plants-species-schema` package**, with the API keeping only a thin NestJS adapter over it.
  This is an internal refactor — the `POST …/proposals` request and response contract is unchanged, no
  migration and no new environment variable — that retires a hand-maintained copy of the operation shapes so
  the API and the doctor can never disagree about what a proposal may contain.

### For developers

- **`npm run qa:reset` builds a known QA scenario on demand.** It rebuilds a complete garden — a healthy
  plant, one with an empty profile for the copilot to fill, one badly overdue, and one with a
  photographed history of declining health — for a dedicated QA account. It is a *reset*, not a seeder:
  running it again returns to exactly the same state, so it works equally well before a QA pass and
  after one. The scenario is described in `docs/local-development.md`.
- The QA account now owns its own plants. It previously owned none, so QA reached real plants by
  impersonating their owner — and a QA run destroyed a real progress entry. It keeps its admin rights;
  it simply no longer has a reason to borrow someone else's garden.
- **New `APP_ENV` variable**, defaulting to `production` when unset. Nothing in the app's behaviour
  branches on it; it exists so destructive local tooling can refuse to run anywhere it was not
  explicitly invited. Local `.env` files need `APP_ENV=development`; production needs no change.
- **Two one-time operator scripts** promote pre-3.0.x database rows off the old `[system]`-prefixed
  convention onto the new structural shape: `npm run migrate:promote-system-messages` (survey-first,
  backup-verified, read-only until told to apply) followed by `npm run migrate:normalize-system-marker`
  (strips the retired prefix from the columns it left behind). Neither runs automatically as part of a
  deploy.
