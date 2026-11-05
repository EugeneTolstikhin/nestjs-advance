# Registration, users, and authentication

## One account for buying and selling

Each verified email/phone belongs to one MongoDB user, regardless of role. Accounts
store `roles: ['buyer']`, `roles: ['seller']` or `roles: ['buyer', 'seller']`, with
separate `buyerProfile` and `sellerProfile` fields. Credentials, verified contacts
and the user ID are shared. Registration's `typeOfUser` selects only the initial
role; it is not the stored account shape or a JWT claim anymore.

After login, open **My account** (`/account`) in the navbar. The SurveyJS profile
forms enable the other role and save each profile independently. The initial role
is retained. Once both roles are enabled, buying and selling use the same session;
no role switch or second registration is required. Existing seller-only accounts
can likewise enable buying. Profile fields remain optional, as in registration.

The authenticated API is:

- `GET /account`: account page, including the enabled roles.
- `GET /account/schema`: SurveyJS schemas and the owner's current profile values.
- `POST /account/buyer`: buyer profile, such as `{ "deliveryAddress": "Home address" }`.
- `POST /account/seller`: seller profile, such as `{ "companyName": "My shop" }`.

POSTs replace only that role's profile, atomically add its role without duplicates,
and return a refreshed JWT/session with a refreshed HttpOnly cookie. Omitted fields
in that profile are cleared. The other profile is preserved. API clients must use
the returned token for newly enabled permissions; older tokens retain their claims
until expiry. New JWTs contain `sub` and `roles`; role guards permit an operation
when any required role matches. Public registration/profile requests cannot assign
admin access. Account endpoints accept the session cookie or a Bearer token;
mutations require JSON and reject cross-origin browser requests. Product write
APIs accept Bearer tokens or the HttpOnly browser session, with the same role checks.

Profile endpoints identify the owner solely from the verified session/JWT. A request
cannot submit another user ID, edit contacts or grant arbitrary roles. The owner's
profile response is unmasked and marked `Cache-Control: no-store` so their own
saved values can be edited. No public endpoint exposes these profiles.

MongoDB unique contact indexes remain global. A second registration with an
existing contact returns 409 and directs the user to log in. If email and phone
belong to different existing accounts, registration fails; accounts are never
automatically merged and contacts are never transferred.

On the next user-database connection an idempotent migration converts existing
`typeOfUser`/`profile` documents to `roles` and the corresponding profile field,
preserving user IDs, credentials, contacts, verification dates and timestamps.
Old signed tokens with `typeOfUser` are accepted for their remaining lifetime.
Already-pending Redis registrations are normalized when inserted after verification.
New sessions and newly saved documents use only the new role/profile structure.

## Start locally

MongoDB Community 8.0 is installed locally. Start it if necessary:

```sh
brew services start mongodb-community@8.0
```

Startup reads `backend/.env` automatically. It contains a persistent `JWT_SECRET`
and these local MongoDB settings:

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DATABASE=nestjs_advance
```

From `backend/`, run `npm run start:dev`, then open
`http://localhost:3000/auth/register`. The navbar Register link opens this page.
Users are stored in MongoDB's `users` collection; products remain in SQLite.
The official MongoDB Node driver is used through `UsersRepository`.

## Shared authentication storage (Redis)

Redis is installed and running locally as a Homebrew service. The project's
gitignored `.env` selects it:

```dotenv
AUTH_STORAGE=redis
REDIS_URL=redis://127.0.0.1:6379
REDIS_KEY_PREFIX=nestjs-advance:auth:
```

Restart the application after changing these settings. To manage Redis:

```sh
brew services start redis
redis-cli -u redis://127.0.0.1:6379 PING
brew services stop redis
```

`PING` returns `PONG`. Redis uses port 6379 and database 0 locally; no password is
configured for this local instance. Keep it bound to loopback for local use.
For a new machine, run `brew install redis` first.

`AuthStorageModule` selects an `AuthStateStore` implementation. `AUTH_STORAGE=memory`
uses a bounded, process-local store and requires no Redis. When the variable is
absent, memory is the default. Redis mode shares login/registration challenges,
verification attempts, resend state, password limits, and request counters across
application instances. All instances must use the same Redis URL/database, key
prefix and `JWT_SECRET`. Use a different prefix for unrelated environments.
MongoDB remains the permanent user store; Redis is only for temporary auth state.

State updates use optimistic compare-and-set with a Redis Lua script. Concurrent
verification cannot reuse a consumed login code or overwrite an attempt counter.
Every entry has a TTL; updates preserve the challenge's original deadline. Keys
are HMAC hashes so emails, phones, IPs and challenge IDs do not appear in key
names. Registration values contain pending profile data and bcrypt password hashes;
OTP values contain HMAC hashes, never plaintext passwords or codes.

Redis mode returns 503 on storage failure and does not fall back to memory.
Connections and commands have bounded timeouts and offline command queuing is
disabled ([Redis client reliability guidance](https://redis.io/docs/latest/develop/clients/nodejs/produsage/)).
No `KEYS`, `FLUSHDB` or `FLUSHALL` commands are used by the application.

Pending state survives application restarts while Redis retains it. Memory mode
loses it on restart; switching stores or changing `JWT_SECRET` also invalidates
pending state and starts new rate-limit keys. Redis data loss/eviction can reset
limits: use a dedicated instance with `noeviction` and suitable persistence when
deploying. This local setup uses the installed Redis service's persistence defaults.
An app crash during an external delivery or final MongoDB insert can leave a
registration marked in progress until its TTL; start a new registration (or log
in if insertion succeeded). Redis and MongoDB do not share a transaction.

## SurveyJS registration

The page uses the locally installed SurveyJS Form Library (no CDN or frontend
framework), rendered inside a Handlebars page. It supports buyer and seller
accounts, with common account/personal fields and these optional profiles:

- Buyer: delivery address.
- Seller: company name, business address, VAT number.

At least one of email or phone is required. If both are provided, both must be
verified. Phone numbers must use E.164 format, such as `+4917612345678`. Each
contact receives its own six-digit code and has its own verification state.
Email addresses are normalized to lowercase. Public registration cannot create
admins or submit verification/permission fields.

Development emails are sent through SMTP to Mailpit: open `http://localhost:8025`
to read the verification code. Unconfigured phone delivery uses LOG; look for
`[DEV OTP] Phone (...) code: ...` in the server terminal. Production email uses
SMTP settings from environment variables; see [EMAIL.md](./EMAIL.md). LOG and
Mailpit email delivery are blocked in production. The phone provider adapter is
still a placeholder, and queued delivery does not itself complete registration.

A user document is inserted only after every supplied contact has been verified.
Successful completion sets a 15-minute HttpOnly, SameSite=Lax session cookie
(Secure in production) and redirects the browser to `/shop`. The navbar reads
this verified session and looks up the stored user. Passwords and confirmation
values are never stored: only the bcrypt hash is persisted. MongoDB unique
indexes enforce unique email addresses and phone numbers, including concurrent
registration attempts.

## API contract

All authentication POST requests require `Content-Type: application/json`.
Cross-origin browser authentication POSTs are rejected. Cookie credentials are
used for the server-rendered user context and product management UI. Product writes
use `SameOriginGuard` and `SessionAuthGuard`, accepting the session cookie or a
Bearer token. POST/PUT/PATCH requests require JSON; DELETE may omit its body.
Cross-origin writes are rejected for all these methods.

1. `POST /auth/register` with `{ "user": { ...registrationFields } }` returns
   202 with a secret `challengeId`, expiry, and the required contact checks.
   It returns no session/JWT and writes no user document yet. `username` remains
   an optional email alias for older API clients, but the form uses `email`.
2. `POST /auth/register/verify` with
   `{ "challengeId": "...", "channel": "email", "code": "123456" }` (or
   channel `phone`) returns `{ "registered": false, "challenge": ... }` while
   another contact remains. Once all checks pass, it inserts the user, sets the
   session cookie, and returns `registered: true` with the JWT/session response.
3. `POST /auth/register/resend` with `{ "challengeId": "...", "channel": "email" }`
   sends a replacement code after the cooldown. Earlier codes are invalidated.

Example registration body:

```json
{
  "user": {
    "typeOfUser": "seller",
    "email": "seller@example.com",
    "phone": "+4917612345678",
    "password": "Password1!",
    "confirmPassword": "Password1!",
    "firstName": "Test",
    "lastName": "Seller",
    "dob": "2000-01-01",
    "nationality": "Germany",
    "sellerProfile": {
      "companyName": "Example shop",
      "businessAddress": "Example address",
      "vatNumber": "EXAMPLE"
    }
  }
}
```

Use `buyerProfile: { "deliveryAddress": "..." }` with `typeOfUser: "buyer"`.
Omit either contact when not supplied. For phone-only registration, omit `email`
and `username` entirely. Fields belonging to the other role are rejected.

## OTP limits and lifecycle

- Pending registrations expire after 10 minutes; individual codes after 5 minutes.
- Each contact has at most 5 verification attempts across code resends.
- Resends require a 60-second cooldown. The contact request quota is shared between
  login and registration: at most 5 requests per contact per 15 minutes.
- Starting registration is limited to 10 requests per IP per 15 minutes.
- Registration starts are capped at 1000 per 10-minute window across the store.
- Pending registrations are held in the selected auth store. They retain a bcrypt
  password hash, typed registration data, and HMAC hashes of OTPs. Plaintext
  passwords and codes are not retained. Refreshing the browser requires beginning
  a new registration because the UI does not persist the secret challenge ID.
- Successful registration consumes the challenge. Replaying it returns 410.
- Delivery failures and rejected/expired codes do not create a user or session.

These limits are shared in Redis mode and per process in memory mode. Fixed
windows start with the first request. Rejected/delivery-failed requests can consume
IP quota conservatively. Cooldown checks run before contact quota checks, so a
retry within 60 seconds does not spend another contact request. Rate-limit
responses include `retryAfterSeconds` and `retryAt`, and the displayed message
states how many seconds remain. Refreshing the page does not reset Redis limits.
The standalone `/user-interaction` delivery demo also uses
the same contact quota and cooldown, plus ten requests per IP per 15 minutes. It
requires JSON and rejects cross-origin browser requests. It only demonstrates
delivery and does not create a login challenge or authenticate anyone. Provider
spending caps remain separate from request limits.

## Existing login and product permissions

The signed-in navbar includes **Logout**. It sends a JSON `POST /auth/logout`,
which expires the HttpOnly session cookie and returns `204`. The browser then
returns to `/`, showing the guest navbar. Logout also works for expired or absent
sessions. Cross-origin requests are rejected by the authentication guard.
This clears the browser session; previously issued API bearer JWTs remain valid
until their 15-minute expiry (there is no server-side token revocation list).

`POST /auth/login` reads registered MongoDB users and accepts
`{ "user": { "username": "email@example.com", "password": "Password1!" } }`.
For a phone-only account, `username` is the verified E.164 phone number. This
existing endpoint checks the password and returns a JWT plus the browser cookie.
The SurveyJS page at `GET /auth/login` supports email/password, email/OTP and
phone/OTP. OTP is an alternative to the password, not a second step after it.
On success all methods set the same HttpOnly cookie and redirect to `/shop`.
Passwords, OTPs and JWTs are never saved to browser storage.

Request a login code with `POST /auth/login/otp`:

```json
{ "channel": "email", "contact": "email@example.com" }
```

For phone login use `"channel": "phone"` and an E.164 contact such as
`"+4917612345678"`. The endpoint returns `202` with `challengeId`, `expiresAt`
and `resendAt`. Unknown/unverified contacts receive the same response, but no
code is sent and they cannot log in. The selected contact must already be verified
on a registered account. The OTP factory selects Mailpit email in development,
production SMTP from environment settings, and LOG for an unconfigured phone
provider. The SMS adapter remains a placeholder. Delivery runs through BullMQ.

Submit the code with `POST /auth/login/otp/verify`:

```json
{ "challengeId": "<64-character ID from the request>", "code": "123456" }
```

Success returns `200` with the JWT/session and sets the cookie. Codes expire after
five minutes and allow five attempts. Challenges are consumed before session
creation to prevent concurrent reuse. Resend uses `/auth/login/otp` again after
60 seconds and replaces older challenges for that contact. Limits per 15 minutes:
five code requests per contact, ten per IP, ten password attempts per username,
and twenty password attempts per IP. Login starts are capped at 1000 per five-minute
window. Login challenges and limits use the selected auth store described above.
Registration codes cannot be used for login. Refreshing the login page starts a
new UI flow; request another code after the cooldown.

The former placeholder `POST /auth/register-by-phone` directs clients to the
complete registration flow instead of reporting false success.

Send `Authorization: Bearer <access_token>` in Posting for product write requests.
The browser UI sends same-origin cookie credentials to these same endpoints.
Seller-only editor pages are `/shop/new`, `/shop/:id/edit` and `/shop/product-schema`.
Catalog management controls on `/shop` follow the role table below. Access is
catalog-wide; product ownership is not currently modeled.

| Operation | Access |
| --- | --- |
| GET `/products` and `/products/:id` | Public |
| POST, PUT, PATCH products | Seller |
| DELETE `/products/:id` | Seller or admin |

The JWT guard checks signatures, expiry, issuer, audience and role. Invalid
credentials return 401; a valid token with an unauthorized role returns 403.

## Verification

```sh
npm test               # Unit tests, OTP expiry/attempt/resend checks, DTO validation
npm run test:auth      # Guard and HTTP integration tests against local MongoDB
npm run test:auth:redis # Two app instances sharing local Redis + MongoDB
npm run test:views     # Handlebars rendering checks
npm run test:products  # SQLite regression checks
```

The HTTP auth suite uses temporary `nestjs_test_*` MongoDB databases and an
in-memory SQLite database. It injects a test OTP sender and deletes its test
databases afterward. No real SMS/email is sent. `TEST_MONGODB_URI` can override
the default local URI; remote hosts are rejected by the test harness.
The Redis suite uses a unique `nestjs-test:*` prefix, removes only its own keys,
and tests cross-instance verification, app restarts, replay prevention, concurrent
attempt limits, TTL expiry and Redis failure behavior. `TEST_REDIS_URL` can
override the default local Redis URL. It never flushes your Redis database.
