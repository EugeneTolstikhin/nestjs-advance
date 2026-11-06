# Background jobs

OTP delivery and media processing use BullMQ and local Redis. The Nest application
starts the workers automatically; run the app normally with `npm run start:dev`.
Keep Redis running:

```sh
brew services start redis
```

Configuration (defaults shown):

```dotenv
JOBS_DRIVER=bullmq
# Uses REDIS_URL when JOBS_REDIS_URL is omitted.
REDIS_URL=redis://127.0.0.1:6379
JOBS_REDIS_PREFIX=nestjs-advance:jobs
```

Auth state and jobs use separate Redis key prefixes. `JOBS_REDIS_URL` can point to
a separate Redis instance later. Redis is required: an enqueue failure returns
503 instead of falling back to synchronous delivery. `JOBS_DRIVER=inline` is an
explicit synchronous adapter for tests/development and is rejected in production.
For production, configure Redis persistence/backups (for example AOF) and
`maxmemory-policy noeviction`; persistence settings determine survival of Redis
restarts. Redis alone does not back up SQLite, MongoDB or media files.

## OTP delivery

The existing `OtpFactory.create(channel).sendOtp(...)` interface now queues work.
Development email uses Mailpit SMTP; phone defaults to the local SMSpit inbox.
Production email uses SMTP credentials from `.env`. See [EMAIL.md](./EMAIL.md).
See [SMS.md](./SMS.md) for the SMS simulator and configuration.
HTTP success means **queued**, not delivered.
Registration/login still create and verify their own challenges, enforce rate
limits, and check registered/verified contacts before sending login codes.

Challenges are saved before jobs are added. Workers skip expired, replaced,
consumed, verified or locked-out challenges. Retries reuse the same code and the
same provider idempotency key, and check challenge validity again on each attempt.
Codes and recipients are encrypted with AES-256-GCM in Redis jobs, using a key
derived from the persistent `JWT_SECRET`. Rotating that secret invalidates pending
encrypted jobs. Only hashes are stored in auth challenge state. Job failure logs
contain queue/job IDs and attempt counts, not provider responses or OTP payloads.
LOG deliberately prints the code in development and is blocked in production.

Jobs make up to three attempts with exponential delays (1 second, then 2 seconds).
Provider 4xx errors other than 408/429, and unimplemented adapters (501), stop
immediately. Completed jobs are removed; failed jobs retain encrypted payloads for
inspection with bounded retention (one day / 500 jobs per queue, pruned when other
jobs fail). Request a fresh code after expiry or terminal delivery failure.
If the app stops between saving a challenge and adding its job, the user must
request a new code; challenge state and the BullMQ enqueue are not one transaction.

SMTP email is implemented in `EmailOtpHandler`, configured through `SMTP_*`
environment variables. To integrate SMS or a future email API adapter:

1. Implement `sendOtp(recipient, code, options)` in `SmsOtpHandler` or
   `EmailOtpHandler`. Use the supplied code; never generate a new code in an adapter.
2. Pass `options.idempotencyKey` to providers that support it. Bound network calls
   with a timeout and throw on failure. Translate permanent rejection into a Nest
   4xx exception; allow temporary transport/provider failures to retry.
3. Configure the provider in `otp.config.json` and its credentials in environment
   variables. The worker resolves the configured adapter for every attempt.

Delivery is at least once: a worker can stop after the provider accepts a message
but before BullMQ records success. A stable provider idempotency key is needed to
avoid duplicate sends; providers without that feature may deliver duplicates.
The phone adapter implements SMSpit development capture; real provider adapters
remain extension points. The SMTP adapter uses a stable Message-ID
for retries, which does not guarantee SMTP deduplication. Provider failures never
silently fall back to LOG.

## Media processing

The flow is `reserved → uploading → processing → ready` (or `failed`).
The final tus PATCH acknowledges stored bytes and enqueues a job containing only
the media ID. Validation, WebP conversion and video posters run in the media
worker. The editor displays **Processing…**, polls the owner-only status endpoint,
and permits product save only when all selected media are ready. Invalid content
is reported in ticket status rather than synchronously rejecting the final PATCH.
Files remain private to the uploader until attached to a saved product.

Media jobs use deterministic IDs and recheck database state, so duplicate attempts
skip ready/deleted media. Processing is serialized with product updates, deletion
and cleanup. Deleted/expired drafts are not published by a later queued job.
Invalid content fails permanently; unexpected processing failures retry, then mark
the ticket failed. Failed files continue to reserve disk quota until removed.
Pending complete uploads are reconciled from SQLite at startup and every ten
minutes to repair a crash between the database update and queue insertion.

Add future media operations to the media worker processing pipeline in
`ProductMediaService.validate` (or extract it into a dedicated processor service).
Controllers continue to accept uploads and expose status. Keep operations
repeatable: retries may run after a previous attempt partially wrote derived files.

This local setup runs workers inside the Nest process, with four concurrent OTP
jobs and one media job. They are durable queue jobs, not a separately deployed
worker service. SQLite, local file access, tus locks and admission limits still
target **one Nest process on one machine**. Before separating or scaling workers,
provide shared storage, coordinated file locks/quotas and durable shared auth state.
Keep `AUTH_STORAGE=redis` for auth state that must survive app restarts.

## Extending jobs

`src/jobs/job-queue.ts` defines the typed `JobPayloads` producer boundary and Redis
adapter. Domain modules register handlers and enqueue typed payloads; they do not
depend on BullMQ objects. New notification types can add their own job payload and
handler while reusing connection setup, retries and graceful shutdown. Split out
separate workers when deployment needs justify it.

## Verification

```sh
npm test
npm run test:jobs
```

The jobs integration suite uses local Redis with unique test prefixes, temporary
SQLite databases and media directories. It covers provider retries, encrypted
payloads, stale OTP skipping, worker restart, real tus uploads, processing status,
private/public access, deletion before processing, and permanent validation failure.
