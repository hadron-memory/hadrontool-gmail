# Agent dev guide — hadrontool-gmail

**hadrontool-gmail** is an independently-deployed **Gmail email tool** for the Hadron
platform: it owns the Google provider relationship — OAuth refresh tokens, mail
operations, Pub/Sub watch notifications — behind a **provider-neutral, agent-agnostic**
HTTP surface. Core (hadron-server) keeps the contract, identity, and authorization; this
tool does the provider transformation. **One tool per provider**: this is the Gmail
sibling of `hadrontool-ms-exchange`; provider-neutrality lives at the core boundary
(dispatch by `connection.provider`), not inside a multi-provider tool.

**Status: implemented (v1), pre-deploy.** Design: [docs/architecture.md](docs/architecture.md).
Build tracking + decisions: hadron-server#580.

## Commands

```bash
npm run dev          # tsx watch (port 8080)
npm test             # vitest — real HTTP + Postgres over a FAKE Gmail provider
npm run typecheck
npm run db:push      # sync the tool's own DB (dev)
npm run db:test-setup # one-time: schema into hadrontool_gmail_test
```

Local DBs: `hadrontool_gmail` (dev, via `.env`), `hadrontool_gmail_test`
(pinned by vitest.config.ts — tests never touch dev data).

**Prisma 7** (engine-less; differs from hadron-server's Prisma 6): the CLI
connection URL lives in `prisma.config.ts` (NOT in the schema datasource
block); the runtime client connects through `@prisma/adapter-pg` (src/db.ts);
the generated client is TypeScript under `src/generated/prisma/` (gitignored —
`prisma generate` runs in typecheck/pretest/build); `db push` no longer
auto-generates.

## Structure

- `src/ops/` — the provider-neutral operation registry (spec 002 names + typed errors);
  `POST /ops/<operation>`, idempotency for mutating ops. Byte-for-byte the
  hadrontool-ms-exchange contract.
- `src/providers/gmail/` — the ONLY Google-specific layer (`GmailProvider` interface in
  `types.ts`; REST impl in `client.ts`; OAuth in `auth.ts`; the MIME builder/parser in
  `mime.ts` — Gmail traffics in raw RFC 2822, so reply semantics live there as pure
  functions with their own test suite; folder↔label registry in `labels.ts`). Tests
  inject fakes from `src/test/fakes.ts`.
- `src/routes/` — `ops` (internal), `connections` (internal; OAuth-code exchange +
  folder subscriptions), `webhooks` (the ONE public route: Pub/Sub push envelope,
  verification-token check, decode, async history processing).
- `src/history.ts` — history-delta processing: the per-connection cursor
  (`Watch.lastHistoryId`) is the PRIMARY at-least-once mechanism; the dedupe ledger adds
  message-level idempotency; the cursor only advances when every message succeeded.
- `src/watches.ts` — watch + folder-subscription domain logic. Gmail has ONE watch per
  mailbox (not per folder); `SubscribedFolder` rows gate which events forward. A
  re-watch must NEVER fast-forward a live cursor.
- `src/events/forwarder.ts` — the tool→core event seam (HTTP now, NATS-wrappable later).
- `src/jobs/renewal.ts` — watch renewal worker (6h cycle, 24h lookahead vs the 7-day
  watch life), history sweep (recovers deltas whose processing failed after the push was
  acked — Pub/Sub is acked before processing), ledger pruning.

## Use of Hadron

This tool has no memory of its own yet — work against the shared ones:

- `hrn:memory:hadronmemory.com::dev` — shared findings, conventions, ops, the `preflight` routing index
- `hrn:memory:hadronmemory.com::specs` — product specs (loc-as-citation)
- `hrn:memory:hadronmemory.com::hadron-server` — the platform core this tool integrates with

(1) **Query Hadron before reading code/design.** Run `hadron_find_nodes` first, then
`hadron_get_node` on promising hits; cite node `loc` values.

(2) Read `hadron_get_node hrn:node:hadronmemory.com::dev::instructions` once per session, and
`hadron_get_node hrn:node:hadronmemory.com::dev::preflight` before a change.

(3) Capture a non-obvious finding the moment it emerges (`hadron_create_node` / `hadron_update_node`).

(4) The **Hadron CLI is a superset of the MCP tools.**

**Contract & design sources**:
- Spec 002 — *Generic Email Tool* (spec-kits): operation names, typed error codes.
- `hadronmemory.com::hadrontool-pdf::reference:hadrontool-email` — the extraction decisions.
- `hadronmemory.com::hadron-server::findings:oauth-rotation-persist-on-failure` — why
  rotation persists on BOTH paths even though Google rarely rotates.

## Key invariants

- **Agent-agnostic.** No agent name or agent-specific code appears in this tool or the
  platform — the email surface is generic.
- **Provider-neutral surface, provider-specific internals.** Gmail API shapes and label
  ids never cross `src/ops/` — everything is normalized (`EmailMessage`); error codes
  come from the spec 002 typed catalog and are stable public surface. The neutral
  `complete` flag state is REJECTED (typed validation_error), never silently degraded.
- **The tool owns the provider; core owns the contract.** Authorization happens in core
  BEFORE any call reaches this tool; never re-implement it here. Refresh tokens are
  encrypted under the tool's OWN key and never leave the service.
- **The history cursor only advances on success.** Pub/Sub pushes are acked immediately,
  so the cursor (plus the worker's sweep) is the retry mechanism — losing that property
  silently drops mail events.
- **Event transport is HTTP now, bus-ready.** All tool→core delivery goes through the
  single forwarder seam; at-least-once semantics with cursor + dedupe (inbound) and
  idempotency keys (mutating ops).
- **Only `/webhooks/gmail` is public.** The operations plane stays internal
  (`komodo_default`, container-name URL).
- **Restricted scopes, real consequences.** `gmail.modify`/`gmail.send` need Google
  verification for production; in Testing status refresh tokens die after 7 days and
  users cap at 100. Don't debug "connection keeps going ERROR after a week" as a code
  bug — check the consent screen status first.
