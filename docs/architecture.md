# hadrontool-gmail — architecture

Status: **implemented (v1)**, pre-deploy. This tool is the third application
of the capability-tool pattern (after hadrontool-pdf and
hadrontool-ms-exchange) and the second email provider tool. The decisions it
inherits were recorded on
[hadron-server#396](https://github.com/hadron-memory/hadron-server/issues/396)
(one tool per provider, HTTP-callback events, tool-owned tokens, owner-only
authorization in core); its build plan is
[hadron-server#580](https://github.com/hadron-memory/hadron-server/issues/580).

## Where this sits

`hadrontool-ms-exchange` is the template: same module shapes, same spec 002
operations contract (byte-for-byte), same typed error catalog, same
Komodo/Doppler/GHCR deployment, same two-plane design. Read its
`docs/architecture.md` for the pattern rationale; this document focuses on
what Gmail changes.

hadron-server needs almost nothing: a `PROVIDER_TOOLS['gmail']` entry in
`emailClient.ts`, an `/auth/gmail` connect-flow trio, and
`provider: 'gmail'` connection rows — every existing email GraphQL/MCP
operation then works for Gmail mailboxes (spec 002 US4 preserved at the core
boundary).

## The two planes

### Operations (request/reply, core → tool, internal)

`POST /ops/<operation>` with spec 002 operation names, bearer-gated
(`GMAIL_TOOL_TOKEN`), internal-only. Every operation loads the connection,
decrypts the refresh token with the tool's key, executes the Gmail call
(acquiring an access token per call, persisting refresh-token rotation on
success AND failure — Google rarely rotates, but the plumbing is the
platform invariant), and maps failures to typed codes. A provider auth
failure (401/403, or the token endpoint's `400 invalid_grant`) marks the
connection `ERROR` so later calls short-circuit as `connection_unauthorized`
until the user reconnects.

**Idempotency**: identical to ms-exchange — reservation INSERT before the
mutation, payload-hash matching, release on failure, replay of completed
keys.

Where Gmail differs inside the operations:

| Neutral operation | Gmail reality |
|---|---|
| `list-folders` | `users.labels.list` (+ per-label `get` for counts) |
| `list-messages(folder)` | folder name → `labelIds` (`inbox`→`INBOX`, `sentitems`→`SENT`, …); `unreadOnly` → `UNREAD` label; offset emulated over page tokens; headers+snippet only (`body: null`) |
| `reply-to-message`, reply drafts | **construct RFC 2822 MIME** (`Re:`, `In-Reply-To`/`References`, reply-all recipient computation excluding self via `users.getProfile`), send with `threadId` — there is no Graph-style `createReply` |
| `move-message` | label swap: add destination, remove the folder-class labels the message carries; `deleteditems` → `users.messages.trash` |
| `flag-message` | `STARRED` on/off; the tri-state `complete` returns `validation_error` (this is exactly why the neutral flag vocabulary exists) |
| `categorize-message` | user labels, create-if-missing, replace-set semantics |
| `mark-read` | modify `UNREAD` label |

The MIME builder/parser (`src/providers/gmail/mime.ts`) is pure and has its
own test suite: address parsing, part-tree body extraction (html over plain,
attachments detected), RFC 2047 subject encoding, base64 body encoding,
header-injection folding, reply recipient math.

### Events (async, tool → core, one public route)

Gmail has no per-message webhooks. Instead:

1. **Watch**: `users.watch({topicName, labelIds: [INBOX, SENT]})` makes Gmail
   publish to a **Cloud Pub/Sub topic**; a push subscription POSTs envelopes
   to `POST /webhooks/gmail` — the ONLY public route.
2. **Authenticity**: the push endpoint URL carries
   `?token=<PUBSUB_VERIFICATION_TOKEN>` (configured on the subscription),
   verified constant-time before any work. There is no clientState — the
   notification payload has no per-connection secret.
3. **Deltas, not messages**: the notification carries only
   `{emailAddress, historyId}`. The tool lists
   `users.history.list(startHistoryId=cursor)` and classifies each
   `messagesAdded` entry by label: `SENT` → `email.sent` (beats `INBOX` for
   self-addressed mail), `INBOX` → `email.received`, `DRAFT`/other → skip.
   Only folders with a `SubscribedFolder` row are forwarded.
4. **At-least-once, two layers**: the per-connection **history cursor**
   (`Watch.lastHistoryId`) advances only after every message in the delta
   was handled — the push is acked (204) before processing, so the cursor is
   the retry mechanism (the next notification, or the worker's sweep,
   re-runs the delta). The **dedupe ledger** (`ProcessedNotification`,
   released on failure) makes overlapping deltas forward each message once.
   A message that vanished before processing (`not_found`) counts as
   handled. A cursor that aged out (Gmail 404s stale `startHistoryId`s) is
   re-baselined to the current profile historyId, loudly.
5. **Forward**: normalized `EmailEvent`s POST to `CORE_EVENTS_URL`
   (hadron-server's `/internal/email-events`) — the same shape
   hadrontool-ms-exchange sends; core's ingress needs zero changes.

Watches expire after ~7 days; the renewal worker (6h cycle, 24h lookahead)
re-watches — Gmail supersedes the old watch server-side, and the re-watch
must NOT fast-forward a live cursor (only a never-initialized cursor adopts
the watch baseline). Connections in `ERROR` are skipped.

## OAuth handoff (who holds what)

Same split as ms-exchange: hadron-server builds the authorize URL
(`GMAIL_CLIENT_ID` is public there) and owns the callback; this tool holds
the **client secret**, exchanges `{code, redirectUri}` at
`POST /connections`, derives the mailbox identity (ID-token claims first,
OpenID userinfo fallback), stores the encrypted refresh token, and returns
the identity.

Gmail specifics:

- The authorize URL MUST carry `access_type=offline&prompt=consent`, or
  Google returns no refresh token (typed `validation_error` names the cause).
- Scopes: `gmail.modify`, `gmail.send`, `openid`, `email` — **restricted**
  scopes. The GCP project is SEPARATE from the Google-login project
  (hadron-server#583): login must never enter restricted-scope verification,
  and the tool-owns-its-secret boundary forbids sharing one client between
  core (login exchange) and this tool (mailbox exchange).
- Core's connect routes are `/auth/gmail` + `/auth/gmail/callback` —
  `/auth/google` is reserved for login.
- While the consent screen is in **Testing** status: 100-user cap, 7-day
  refresh-token expiry. Production needs restricted-scope verification +
  CASA.
- No raw-token import path (ms-exchange's was a one-time core→tool
  migration; Gmail is greenfield).

## Data model

`Connection` (encrypted refresh token, status, identity) →
`Watch` (one per mailbox: expiry + the history cursor) +
`SubscribedFolder` (which neutral folders forward events) +
`ProcessedNotification` (dedupe ledger) + `IdempotencyRecord`.
See [prisma/schema.prisma](../prisma/schema.prisma).

## Deployment

Komodo build → GHCR → `komodo_default`, Doppler-injected secrets (image bakes
the Doppler CLI; Komodo sets only `DOPPLER_TOKEN`), internal-only at
`http://hadrontool-gmail:8080`, plus one public Traefik route for
`/webhooks/gmail`. Remember `--add-host=host.docker.internal:host-gateway`
on Linux deployments (see `hadronmemory.com::dev::ops:alpha:*`).
hadron-server's Doppler config gains `GMAIL_TOOL_URL` + `GMAIL_TOOL_TOKEN` +
`GMAIL_CLIENT_ID`; this tool's config holds `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET` (the mailbox project's client), `DATABASE_URL` (own
database), `TOKEN_ENCRYPTION_KEY`, `PUBSUB_TOPIC`,
`PUBSUB_VERIFICATION_TOKEN`, and `CORE_EVENTS_*`.

GCP per environment: mailbox project, consent screen, OAuth client (redirect
URI = core's `/auth/gmail/callback`), Pub/Sub topic with
`gmail-api-push@system.gserviceaccount.com` as Publisher, push subscription
targeting `https://<public-host>/webhooks/gmail?token=…`.
