# Email delivery

Email OTPs use Nodemailer SMTP inside the existing BullMQ worker. No additional
worker command is needed: Nest starts the worker with the application. Phone OTPs
still follow `otp.config.json` (LOG by default).

## Development: Mailpit

Mailpit is already installed and running on this Mac. To set it up elsewhere:

```sh
brew install mailpit
brew services start mailpit
```

The backend `.env` now contains these development email settings:

```dotenv
EMAIL_PROVIDER=mailpit
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_REQUIRE_TLS=false
SMTP_FROM="Nest Shop <no-reply@nest-shop.test>"
SMTP_USER=
SMTP_PASS=
SMTP_TIMEOUT_MS=10000
```

Restart the app and keep Redis running. Register or log in using an email OTP,
then open **http://localhost:8025** to read the captured email and its code. Mailpit
captures messages locally instead of delivering to the named inbox. These default
SMTP settings use no authentication or encryption on the local connection.
`.env.example` contains the same email values; merge them with existing
JWT/database/Redis configuration rather than replacing your whole `.env`.

If `EMAIL_PROVIDER` is omitted, development defaults to Mailpit, production to
SMTP, and tests to LOG. `EMAIL_PROVIDER=LOG` explicitly restores development email
logging. Email settings from `.env` override the old JSON email setting; the JSON
file now configures phone delivery only.

## Production: your SMTP provider

Set production environment variables or update the deployed `.env` with your
provider's real SMTP configuration. `.env.production.example` is a credential-free
reference; it is not automatically loaded. Only `.env` and process environment
variables are read by the application.

```dotenv
NODE_ENV=production
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.your-provider.example
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_FROM="Nest Shop <no-reply@your-domain.example>"
SMTP_USER=your-provider-username
SMTP_PASS=your-provider-password
SMTP_TIMEOUT_MS=10000
```

Replace the host, credentials and sender with the values provided by your SMTP
provider. Use a sender/domain that the provider permits. On port 587, TLS is
negotiated with STARTTLS (`SMTP_SECURE=false`, `SMTP_REQUIRE_TLS=true`). For
implicit TLS, normally port 465, set `SMTP_SECURE=true`; STARTTLS is unnecessary.
TLS certificate verification remains enabled.

Production startup rejects Mailpit/LOG email delivery, missing SMTP host/sender/
credentials, malformed settings and unencrypted SMTP configuration. Production
credentials are never added to the development `.env` or committed examples.
Sending requires the provider account/domain setup and real credentials; none are
invented by this integration.

## Queue behavior

HTTP success means the message is queued. The worker sends the exact code generated
for the challenge and checks expiry, replacement and consumption before each
attempt. Email failures never silently fall back to LOG. Transport timeouts and
SMTP 4xx responses retry through BullMQ. SMTP authentication failures and SMTP 5xx
responses fail permanently with sanitized error messages.

Retries reuse a stable Message-ID derived from the job ID. SMTP has no universal
idempotency mechanism: a stable Message-ID does **not** guarantee deduplication by
the receiving server. A connection failure after acceptance can still result in
duplicate delivery, using the same OTP. SMTP acceptance also does not guarantee
delivery into a real recipient's inbox.

The adapter sends text and HTML versions, bounds SMTP network timeouts, and does
not log credentials, recipients or codes. Preview codes in Mailpit rather than the
terminal for email; LOG phone codes still appear in the development terminal.

## Tests

```sh
npm test
npm run test:email
```

The email integration test requires local Redis and the `mailpit` binary in PATH.
It starts a separate Mailpit process on temporary ports with a temporary inbox,
uses isolated Redis keys, and verifies registration/login through the real BullMQ
and SMTP path. It does not use or delete messages in your existing Mailpit inbox,
and does not contact a production provider. `TEST_REDIS_URL` and
`TEST_MAILPIT_BINARY` can override local test dependencies.
