# my-plants-api

The **NestJS backend** for MyPlants: the deterministic **care engine** that decides what
plant-care action to take and when — watering, fertilizing, repotting, maintenance — adapting to
each plant's species, its physical spot, and the local climate. It **advises**; it never performs
care.

Everything here is **100% deterministic** — no runtime AI, no AI keys in production. Care is
modeled as parameters and formulas that recompute (scheduling, the informative viability
semaphore, feedback adaptation, and the moving module), never as a hardcoded calendar. Data lives
in MariaDB via Prisma.

The API also embeds an **admin knowledge-chat realtime engine** (`@retaxmaster/claude-realtime-server`)
used to drive the knowledge-engine research flow from the UI. This is the one place `claude` is
spawned, and it is an admin-only, isolated runtime — separate from the deterministic care app.

## Where it fits

```
my-plants-species-schema   the curated-record contract (dependency)
        │
        └── my-plants-api   ← you are here (care engine + REST API over MariaDB)
                    ▲
                    └── my-plants-web talks to it over a server-side BFF proxy
```

Sibling repos:

- [my-plants-species-schema](https://github.com/RetaxMaster/my-plants-species-schema) — record contract (dependency)
- [my-plants-knowledge-engine](https://github.com/RetaxMaster/my-plants-knowledge-engine) — curates the records this API reads
- [my-plants-web](https://github.com/RetaxMaster/my-plants-web) — the frontend that consumes this API

## Requirements

- Node.js 20+
- A local MariaDB server (shared with the knowledge engine)
- The `@retaxmaster/my-plants-species-schema` package (packed tarball)

## Install & configure

```bash
npm install
cp .env.example .env   # then edit the values below
```

Key environment variables (see `.env.example` for the full annotated list):

| Var | Meaning |
|---|---|
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | MariaDB connection (separate vars, never a connection string) |
| `PORT` | HTTP port (dev default `8000`) |
| `HOST` | Bind interface — leave unset for dev; `127.0.0.1` behind a reverse proxy |
| `DEFAULT_CITY_TZ` | Primary garden city / canonical timezone (e.g. `America/Mexico_City`) |
| `WEB_ORIGIN` | Browser origin allowed by CORS (the web app) |
| `JWT_SECRET` / `JWT_EXPIRES_IN` / `SESSION_ABSOLUTE_MAX_DAYS` | Auth (sliding session with an absolute cap) |
| `R2_*` | Optional Cloudflare R2 image storage — image upload stays disabled until all are set |
| `KNOWLEDGE_CHAT_ENGINE_*` / `KNOWLEDGE_ENGINE_CWD` / `KNOWLEDGE_CHAT_LOG_DIR` / `CLAUDE_BIN` | Admin knowledge-chat realtime engine |

Secrets are never committed — only `.env.example` is tracked.

## Database (Prisma)

```bash
npm run prisma:generate   # generate the Prisma client (writes prisma env first)
npm run prisma:migrate    # apply migrations (prisma migrate deploy)
```

Migrations are **hand-authored** SQL applied with `migrate deploy` (the shadow-DB `migrate dev`
flow is not used here).

## Run

```bash
npm run dev      # nest start --watch
npm run start    # node dist/main.js (after npm run build)
```

## Scripts

```bash
npm run build        # nest build
npm test             # unit tests (vitest)
npm run test:e2e     # e2e tests (vitest, separate config)
npm run typecheck    # tsc --noEmit
npm run user:create  # create an app user
npm run user:list    # list users
```

## Notes

- **Dates/times matter.** This is a date-heavy scheduling engine; the code binds native datetime
  objects (never ISO strings compared against DB columns) so timezone parsing can't shift due
  dates.
- The care-engine semantics (place association, scheduling, viability, feedback/adaptation,
  moving) are documented in the orchestrator workspace under `docs/care-engine.md`.
