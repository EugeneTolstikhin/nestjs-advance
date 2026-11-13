# Simulated payment flow

The provider is now a **separate sibling application**, `../payment-simulator`.
The shop retains only the provider interface/factory, the HTTP adapter, checkout
coordination, and BullMQ workers. See its [README](../payment-simulator/README.md)
for the provider contract and independent setup.

## Start both applications

From the repository root, in separate terminals:

```sh
npm --prefix payment-simulator run start:dev
npm --prefix backend run start:dev
```

The backend still needs its normal MongoDB and Redis services. The simulator
needs neither: it persists its own ledger in `payment-simulator/data/payments.sqlite`.
Dependencies were installed separately and matching local API secrets configured.
For a fresh clone run `npm ci` in each project, then configure both environments.

Backend `.env` settings:

```dotenv
PAYMENT_PROVIDERS=simulated
PAYMENT_SIMULATOR_URL=http://localhost:4400
PAYMENT_SIMULATOR_SECRET=<same-secret-as-the-simulator>
SHOP_ORIGIN=http://localhost:3000
JOBS_DRIVER=bullmq
```

`PAYMENT_PROVIDERS=disabled` is the default when absent; unknown provider names
are rejected. Simulated payments are rejected in production. The factory selects
the adapter; replacing it later requires implementing `PaymentProvider` methods
`create`, `get`, and `cancel`, then adding provider-specific verification/recovery.
Do not enable the simulator as a real production payment integration.

## Configurable payment methods

A **provider** is an integration adapter. A **method** is what the buyer chooses
(card, PayPal, bank transfer, etc.). One provider can expose several methods;
several registered provider adapters can be configured together.

Edit `src/payments/payment-options.json` to add/remove options or set `enabled`
to `false`. Restart/rebuild the backend after a change. Nest copies this file into
the build. `PAYMENT_OPTIONS_FILE` can point to a separate server-controlled JSON
file in a deployed environment. The initial choices are card, PayPal and bank
transfer, all explicitly **simulated** and routed to the same local provider.
Neither real PayPal nor a real bank is contacted.

```json
{
  "id": "card",
  "label": "Credit or debit card",
  "description": "Test a card payment without entering card details.",
  "provider": "simulated",
  "method": "card",
  "enabled": true
}
```

The unique `id` identifies the public option. `provider` chooses the registered
adapter; `method` is the provider-native method identifier. Labels/descriptions
are escaped by Handlebars. Buyers see only enabled options whose adapter is
configured. They must choose explicitly; there is no implicit browser default.
`GET /checkout/payment-options` exposes the public set to authenticated buyers.
`POST /checkout/:id/payment` accepts only `{ "revision": 3, "optionId": "card" }`.
Clients cannot supply a provider, native method, credentials, amount or status.
The server rejects unknown/disabled option IDs and duplicate configuration IDs.

`PAYMENT_PROVIDERS=simulated` selects available adapters. It accepts a comma-separated
list when more adapters have been registered. The old singular `PAYMENT_PROVIDER`
remains a fallback for existing environments. Add an adapter implementing
`PaymentProvider`, including `supports(method)` and its `simulated` flag, register
its builder in the factory, then configure any supported options. Adding another
method to an existing capable adapter requires no checkout/worker code changes.

The selected public option, provider, native method and label are saved with the
payment attempt. It cannot be switched mid-payment; resume or cancel that attempt
first. Disabling/removing an option prevents new selections but does not block
jobs reconciling existing attempts. Keep the corresponding adapter configured
until outstanding payments settle. Old intents without method metadata keep their
legacy simulator behavior; no SQL migration is needed for these additional JSON fields.
The independent simulator accepts any well-formed method identifier and displays
it on the hosted page, allowing new demo methods without provider-side code changes.

## Buyer flow

1. Reserve the cart, save delivery details, select shipping, and review.
2. Select an available payment method and click **Continue to payment**. The server rechecks ownership, revision,
   deadline, current product/seller/prices, and snapshots the reviewed total.
3. SQL persists a pending parent order with seller order snapshots and a stable
   payment reference. Duplicate confirms reuse that reference.
4. The `payment-processing` BullMQ worker creates the payment using the factory's
   HTTP adapter. Open the provider page and choose approve, decline, cancel, or a
   delayed response. No real money or card details are involved.
5. Return to checkout. The shop polls its own saved status; workers query the
   authenticated provider API. A redirect or browser-supplied status never proves
   payment.
6. On verified success, a single SQLite transaction consumes the hold, deducts
   stock, marks the parent order paid and completes the persisted XState workflow.
   Seller fulfillment remains `unfulfilled`.

Payment/order snapshots currently live as JSON in the checkout row, giving one
payment intent/order per checkout and an atomic commit boundary. These are not
separate order-management tables, an order-history UI or seller fulfillment tools.
The confirmation page can resume by its owner-only `?session=<checkout-id>` URL.
Invoice generation and delivery remain future work.

## Jobs and recovery

The persisted payment intent doubles as an SQL outbox: workers are dispatched from
due rows every second, including after a restart. Redis enqueue failure leaves
work in SQL for another attempt. This is distinct from OTP's immediate enqueue
failure behavior. Provider I/O is always outside SQLite transactions.

Pending payments are checked roughly every two seconds, uncertain results roughly
every five seconds. An uncertain/pending intent pins its stock even after the
original checkout deadline until the provider confirms a terminal outcome. This
prevents releasing goods after a payment may already have succeeded. The local
provider expires unpaid intents at that deadline; after recovery, a previously
persisted success is still finalized. A permanently unavailable provider requires
recovery, not an automatic unverified release.

Decline, verified cancellation and verified expiry release stock without a
physical deduction. The payment screen offers **Try another payment method**:
it revalidates the current cart, reserves available stock in a new checkout,
retains the saved delivery details and recomputes shipping, then returns directly
to review with no method preselected. The buyer reviews the current total and can
choose another method without navigating back through delivery/shipping.
Unavailable items or changed quotes must be resolved first. No payment starts
until the buyer confirms the replacement checkout.

`POST /checkout/:id/retry` accepts `{ "revision": 5, "quoteHash": "..." }` and is
allowed only for an owned, definitively failed/cancelled/expired payment with an
unpaid terminal checkout. It cannot be used for pending/unknown/successful payments.
The old checkout links to its replacement in the same stock transaction, so
repeated requests or another device resume that replacement rather than create
duplicate holds or charges. The original payment stays terminal and its order is
preserved. A previously linked replacement can also be resumed from the old
payment screen, including after a lost response or completion. There is no second
attempt/charge in the old checkout. Cancelling
from the shop requests provider cancellation and waits for its outcome. A success
which won the race is finalized rather than reported as cancelled.

Paid-order finalization is idempotent. If SQL fails, the transaction rolls back
stock/order changes and the worker reconciles the same provider reference again.
Cart cleanup is a separate durable effect: MongoDB cannot share SQLite's
transaction. It removes purchased lines only if the cart's revision still matches
the reserved snapshot. Concurrent edits are preserved. Mongo failure does not
undo a paid order; cleanup retries without deducting stock again. An old cart
without a revision is treated as revision zero until its next mutation. Sessions
created before cart revisions were captured skip cleanup and preserve the cart.

Development schema synchronization adds the new fields. With synchronization
disabled, apply `migrations/005-simulated-payments.sql` once after 004, with the app
stopped and a backup. The migration preserves existing sessions and their holds.

## Verification

With development watchers stopped:

```sh
npm run test:payments
```

This builds both applications and uses temporary databases, an isolated provider
process and an isolated Redis process for real BullMQ coverage. Redis must be
installed in PATH, or set `TEST_REDIS_BINARY`. Tests cover approvals, declines,
cancellation races, expiry, delayed/unknown results, transaction rollback, duplicate
processing, cart cleanup failures and concurrent edits. No normal inbox, provider
ledger, production provider or real payment is touched.

Development upgrades also replace the legacy checkout-status CHECK constraint
with `CHK_checkout_status_v2`, which accepts `completed`. The new constraint name
is deliberate: TypeORM does not reliably replace a changed CHECK expression
when its name is unchanged. Schema regression tests verify that synchronization
preserves pending payment records and reservation rows before allowing completion.
Do not replay migration 005 against a database that already has payment records;
development synchronization performs this upgrade without clearing those records.
Provider communication errors and local verification/finalization failures now
have distinct sanitized retry diagnostics. Neither path logs provider secrets or
buyer details, and both retain the same payment reference.
