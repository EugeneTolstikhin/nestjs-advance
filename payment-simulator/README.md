# Local payment provider simulator

An independent NestJS application representing an external payment provider. It
has its own npm dependencies, build, environment, SQLite ledger and hosted payment
page. It imports no shop code, connects to neither the shop database nor Redis,
and never charges real money. Requires Node.js 24 or later.

## Run independently

From this directory:

```sh
npm ci
cp .env.example .env  # First setup only; preserve an existing .env.
npm run start:dev
```

Set `PAYMENT_SIMULATOR_SECRET` to the **same** random secret as in
`../backend/.env`. The repository's local setup already has matching secrets;
there is no need to regenerate them on every start. The example intentionally
contains no secret. `SHOP_ORIGIN` must match the shop's browser origin exactly.

Default configuration:

```dotenv
NODE_ENV=development
PAYMENT_SIMULATOR_URL=http://localhost:4400
SHOP_ORIGIN=http://localhost:3000
PAYMENT_SIMULATOR_SECRET=<shared-with-shop-at-least-32-characters>
```

The simulator loads **only its own `.env`**, relative to the built application,
regardless of the shell's working directory. Restart after editing configuration.
The SQLite database defaults to `data/payments.sqlite` in this project. Set
`PAYMENT_SIMULATOR_DATABASE` to an absolute path to override it. Database files,
local configuration, dependencies and build output are ignored by Git.

Other commands:

```sh
npm run build       # TypeScript plus the hosted page template
npm run start       # Build and start the provider
npm run typecheck
npm test            # Isolated ledger and hosted-page HTTP tests
```

The shop runs separately, for example `npm --prefix ../backend run start:dev`.
No backend build is needed to start or test this application. The provider binds
to loopback and refuses production mode. Do not enter real card/bank details.

## HTTP contract

Merchant endpoints require `Authorization: Bearer <shared secret>`. They use
JSON, never browser cookies. The merchant's adapter owns its corresponding HTTP
client types; there are no cross-project source imports.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/payments` | Create/retrieve an idempotent payment by merchant reference |
| GET | `/api/payments/:reference` | Read the persisted authoritative outcome |
| POST | `/api/payments/:reference/cancel` | Cancel only if still pending |
| GET | `/pay/:opaque-token` | Hosted development payment page |
| POST | `/pay/:opaque-token` | Submit a simulated outcome; requires same-origin form submission |

Create request: `reference` (UUID), `amountCents` (nonnegative safe integer),
`currency` (`EUR`), `expiresAt` (Unix milliseconds), `method` (optional provider-native identifier; legacy requests omit it), and `returnUrl` (the configured
shop origin, `/checkout` path). All responses include these fields plus `status`
(`pending`, `succeeded`, `failed`, `cancelled`, `expired`) and `paymentUrl`.
Reusing a reference with different details returns 409. Terminal outcomes cannot
be reversed by repeating a form submission or cancellation.

The hosted page offers approve, decline, cancel, and approve with a temporary
10-second API outage. The last choice persists success **before** hiding it,
letting the merchant test an uncertain result and later reconciliation. Unpaid
payments expire at their fixed deadline. The return URL carries only a checkout
identifier, never an assertion that payment succeeded.

API queries and updates use bound SQLite parameters. Hosted URLs contain random
capability tokens; responses are private/no-store and use `Referrer-Policy:
same-origin` so tokens are not sent to the shop or other origins. Native form
posts retain their origin, and foreign/null origins are rejected. The content
security policy allows form submission to this provider and the configured shop
origin so browsers can follow the 303 return redirect. No third-party assets or card fields are used.

For the full shop/provider/BullMQ tests, run `npm run test:payments` from the
backend with development watchers stopped. Those tests build this project and
start isolated provider/Redis processes and temporary databases; they do not use
your normal provider ledger.

The method identifier is persisted with the intent and shown on the hosted page.
This generic simulator can exercise any well-formed configured method, including
card, PayPal and bank transfer. These are simulated choices, not connections to
real card networks, PayPal or banking systems. Method selection and provider
routing belong to the shop configuration; the simulator imports no shop catalog.

Hosted-page regression tests exercise all four decisions, response policies,
redirects and rejected origins using a temporary local provider process. They need
permission to listen on localhost and do not use your normal provider ledger.
