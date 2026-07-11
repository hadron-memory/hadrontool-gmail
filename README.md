# hadrontool-gmail

Gmail email tool for the Hadron platform — a standalone capability tool that
**owns the Google Gmail provider relationship**: OAuth refresh tokens, mail
operations, and Pub/Sub watch notifications. It exposes a
**provider-neutral** operations surface over HTTP; `hadron-server` stays the
front door (identity, authorization, the email contract) and calls this
service with already-authorized requests.

One tool per provider: this tool is Gmail only — the sibling of
[hadrontool-ms-exchange](https://github.com/hadron-memory/hadrontool-ms-exchange),
implementing the same operations contract byte-for-byte. Provider-neutrality
lives at the core boundary — hadron-server's email surface dispatches by
`connection.provider`.

See [docs/architecture.md](docs/architecture.md) for the boundary, the two
planes, and where Gmail genuinely differs from Exchange. Build tracking:
[hadron-server#580](https://github.com/hadron-memory/hadron-server/issues/580).

> ⚠️ **Google OAuth verification status matters.** `gmail.modify` and
> `gmail.send` are *restricted* scopes. While the GCP project's OAuth consent
> screen is in **Testing** status, refresh tokens **expire after 7 days** and
> at most **100 test users** can connect — fine for development, unusable in
> production. Production requires Google's restricted-scope verification
> (including a CASA assessment). Plan that lead time before launch.

## Surface

| Method | Path | Plane | Purpose |
|---|---|---|---|
| `POST` | `/ops/<operation>` | internal | Provider-neutral mail operations (spec 002 names) |
| `POST` | `/connections` | internal | Create a connection (OAuth code exchange) |
| `GET` | `/connections/:id` | internal | Connection identity + watch/subscription state |
| `DELETE` | `/connections/:id` | internal | Stop the watch + soft-delete |
| `POST` | `/connections/:id/subscriptions` | internal | Subscribe a folder (`inbox`, `sentitems`) to event forwarding |
| `POST` | `/webhooks/gmail` | **public** | Cloud Pub/Sub push notifications (`?token=` verified) |
| `GET` | `/info` | internal | Capabilities (operation list) |
| `GET` | `/healthz` / `/readyz` | — | Liveness / readiness (readiness checks the DB) |

All internal routes require `Authorization: Bearer $GMAIL_TOOL_TOKEN`; in
production the service refuses to start without it. Only `/webhooks/gmail`
may be exposed publicly (Traefik routes that path only), and every push must
carry the `?token=<PUBSUB_VERIFICATION_TOKEN>` configured on the push
subscription.

### Operations (v1)

`list-messages`, `get-message`, `list-folders`, `reply-to-message`,
`move-message`, `save-draft` (fresh or reply draft), `update-draft`,
`send-draft`, `delete-message`, `mark-read`, `flag-message`,
`categorize-message`.

Request body: the operation input (always includes `connectionId`) plus an
optional `idempotencyKey` on mutating operations — a replayed key returns the
stored response without touching Google. Errors use the spec 002 typed
catalog (`connection_not_found`, `connection_unauthorized`,
`provider_rate_limited`, `not_found`, `validation_error`, …) as
`{ "error": "<code>", "message": "…", ...fields }`.

Gmail-specific mappings behind the neutral surface:

- **Folders are labels**: `inbox`→`INBOX`, `sentitems`→`SENT`,
  `drafts`→`DRAFT`, `junkemail`→`SPAM`, `deleteditems`→`TRASH`; anything else
  is treated as a raw label id from `list-folders`. A move is a label swap;
  moving to `deleteditems` uses trash.
- **Flags are the star**: `flagged` adds `STARRED`, `none` removes it, and
  the tri-state `complete` has no Gmail representation — it returns
  `validation_error` instead of silently degrading.
- **Categories are user labels**, created on first use; categorizing
  replaces the message's user-label set (Graph semantics).
- **`list-messages` returns headers + snippet only** (`body: null`,
  `hasAttachments: false`) — Gmail's list surface is id-only, and hydrating
  full bodies per page is not worth the quota; `get-message` returns full
  fidelity.
- **Replies build real MIME**: Gmail has no one-call reply, so the tool
  constructs RFC 2822 (`Re:` subject, `In-Reply-To`/`References`, reply-all
  recipient computation excluding the connected mailbox) and sends on the
  original thread.

```bash
curl -sS -X POST http://hadrontool-gmail:8080/ops/list-messages \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $GMAIL_TOOL_TOKEN" \
  -d '{"connectionId":"…","folder":"inbox","top":10,"unreadOnly":true}'
```

### Events (tool → core)

`users.watch` publishes to a Cloud Pub/Sub topic; the push subscription POSTs
`{emailAddress, historyId}` envelopes to `/webhooks/gmail`. The tool lists
history deltas from the per-connection cursor, classifies new messages by
label (`INBOX`→`email.received`, `SENT`→`email.sent`), and forwards the
normalized events to `CORE_EVENTS_URL` (hadron-server's internal ingress)
with `CORE_EVENTS_TOKEN` — the same `EmailEvent` shape hadrontool-ms-exchange
sends, so core needs zero changes. Unset ⇒ logged and dropped.

Watches expire after ~7 days; the renewal worker re-watches daily, sweeps
pending history (recovering deltas whose processing failed after the push was
acked), and prunes the dedupe/idempotency ledgers.

## Security

- **Bearer token** gate on every internal route; required in production.
- **Refresh tokens** are AES-256-GCM-encrypted at rest under this tool's own
  `TOKEN_ENCRYPTION_KEY` (never core's key) and never leave the service.
- **Push authenticity**: the Pub/Sub push endpoint URL carries a shared
  verification token, compared constant-time before any work; the history
  cursor + dedupe ledger make processing idempotent under at-least-once
  delivery.
- **No authorization logic here**: hadron-server authorizes every request
  *before* calling this tool — the tool never re-implements grants.

## Development

```bash
npm install
cp .env.example .env           # fill in what you need; see comments
createdb hadrontool_gmail && npm run db:push
npm run dev                    # tsx watch on src/index.ts

npm test                       # vitest — requires the test DB once:
createdb hadrontool_gmail_test && npm run db:test-setup
```

Tests run the real HTTP surface + real Postgres over a fake Gmail provider —
no Google credentials needed. The MIME builder/parser has its own suite
(`src/providers/gmail/mime.test.ts`).

## Configuration

See [.env.example](.env.example). Key vars: `GMAIL_TOOL_TOKEN`,
`DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET` (the mailbox GCP project — never the login one),
`PUBSUB_TOPIC`, `PUBSUB_VERIFICATION_TOKEN`, `CORE_EVENTS_URL` /
`CORE_EVENTS_TOKEN`.

## GCP setup (once per environment)

1. Create the **mailbox** GCP project (separate from the login project —
   hadron-server#583 keeps login out of restricted-scope verification).
2. OAuth consent screen: external; scopes `gmail.modify`, `gmail.send`,
   `openid`, `email`. Testing status is fine for development (7-day refresh
   tokens, 100 users — see the warning above).
3. OAuth client (Web application): authorized redirect URI
   `https://<core BASE_URL>/auth/gmail/callback` (+ the localhost variant).
   The client id goes to hadron-server (`GMAIL_CLIENT_ID`), the secret ONLY
   to this tool's Doppler config.
4. Pub/Sub: create the topic, grant
   `gmail-api-push@system.gserviceaccount.com` the **Publisher** role on it,
   then create a **push** subscription targeting
   `https://<public-host>/webhooks/gmail?token=<PUBSUB_VERIFICATION_TOKEN>`.
