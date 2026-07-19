# Changelog — `my-plants-api`

All notable, user-facing changes to the MyPlants API. Newest first.

## Unreleased — Plant Doctor becomes a copilot: your approval is now required

**The Plant Doctor can no longer change your plants on its own.** Until now, the diagnostic agent could
edit a plant's profile, correct a progress entry, and change its watering or misting cadence directly
while it worked. From this release it can only **propose** those changes — you see exactly what it wants
to do and decide.

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

### Under the hood

- The plant, progress, frequency and feedback writes now live in **one implementation each**, shared by
  the owner's own endpoints and the proposal applier. An approved proposal takes literally the same code
  path your own edit does, so the two can never drift apart.
- Run start-up takes a **launch lease** before spawning an agent process, and always records that
  process's identity — which is what lets a deploy wait for in-flight diagnoses instead of orphaning
  them.
- Messages sent to the agent about your decisions are delivered **at most once**, surviving a crash or a
  failed launch without either duplicating or vanishing.

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
