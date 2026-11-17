# Paid-order confirmation and delivery

After verified payment, open **View order confirmation** in checkout. The private
`/orders/:checkoutId` page shows each seller order, invoice, tracking number,
status history and email delivery state. It refreshes every five seconds.

Each seller order receives its own shipment and PDF, so a cart with several
sellers can have several tracking numbers and confirmation emails. PDFs use the
immutable paid-order snapshot rather than current product prices or addresses.
The **Open PDF to print** button opens the browser PDF viewer for printing.

## Local setup

Keep Redis, MongoDB, Mailpit, the shop and the payment simulator running as before.
Start the independent carrier in another terminal from the repository root:

```sh
npm --prefix delivery-simulator ci
npm --prefix delivery-simulator run start:dev
```

The current local `.env` files already contain matching delivery secrets. For a
fresh checkout, copy `delivery-simulator/.env.example` to `.env`, generate a random
secret of at least 32 characters, and set the same `DELIVERY_SIMULATOR_SECRET` in
both applications. Backend `.env.example` lists all settings. Use
`DELIVERY_PROVIDER=simulated`, `ORDER_CONFIRMATION_ENABLED=true`,
`DELIVERY_SIMULATOR_URL=http://localhost:4500`, and the existing SMTP settings
(`EMAIL_PROVIDER=mailpit` locally). `SHOP_ORIGIN` must be the browser shop origin.

Open **http://localhost:4500** to change delivery statuses. The shop polls the
carrier through BullMQ, stores every new tracking event, and queues an email for
each event. A quick pair of changes is preserved even between polls. Refresh the
carrier dashboard to see newly created shipments. No address or contact details
are sent to this simulator.

## Jobs and recovery

The SQL paid-order JSON contains invoice state, tracking history and a durable
notification outbox. A two-second reconciliation loop dispatches due work; active
shipments are normally checked every few seconds. These are separate BullMQ jobs:

- `invoice-generation`: render a PDF and atomically store it privately.
- `delivery-sync`: idempotently create a shipment or read its complete history.
- `order-email`: send the invoice attachment or an individual status update.

Jobs contain IDs rather than email contents. Failed work retries; SQL state is
retained through app/Redis restarts. Notification IDs and per-seller sequence
checks prevent ordinary replays and keep emails in tracking order. An SMTP server
can accept a message immediately before a worker crashes, so email remains
at-least-once; a stable Message-ID helps recipients identify duplicates. No
exactly-once SMTP guarantee is claimed. The workflow also initializes existing
paid orders when enabled; set `ORDER_CONFIRMATION_ENABLED=false` to pause it.

Only the buyer account's verified email is used. A delivery-address email is not
implicitly trusted. Buyers without a verified email still receive private PDF
downloads and tracking; their email effects show as skipped. LOG email mode marks
messages logged rather than claiming they were delivered.

## Providers and storage

`DeliveryProviderFactory`, `InvoiceRendererFactory` and `EmailProviderFactory`
create adapters behind interfaces. Add a real carrier adapter to the delivery
factory and select it with configuration; business jobs and UI remain the same.
The current email factory reuses Mailpit/production SMTP configuration. The local
carrier adapter is deliberately rejected in production.

Invoices default to `backend/storage/private/invoices/<sellerOrderId>.pdf`,
configurable with `INVOICE_STORAGE_DIR`. They are excluded from Git, never exposed
as static assets, and require the owning buyer session for download. Back up
these files together with SQL order records. PDFKit embeds Noto Sans fonts; the
font license is in `src/orders/fonts/LICENSE.txt`.

**These are development demo invoices, explicitly marked NOT A TAX INVOICE.**
Seller legal identity, tax/VAT rules, compliant numbering and retention rules must
be implemented before real trading. The current seller ID is a development
reference, not legal issuer data.

## Verification

`npm run test:orders` builds both apps and runs an isolated integration scenario
with Redis, Mailpit, temporary SQLite databases and a delivery simulator. Stop the
shop watcher before this command because the standard build replaces `dist`.
Tests cover multi-seller PDF attachments, private downloads, missed tracking
events, replay protection, SMTP retries and unverified-email handling. Unit/browser
tests run with `npm test`; the carrier has its own `npm test`.

## Failed delivery and return to sender

After `delivery_failed`, the carrier can retry with `in_transit` or choose
`returning_to_sender`. The return ends at `returned_to_sender`, meaning the sender
has received the parcel. Both return events are recorded and emailed like other
tracking events. The shop stops polling that shipment at the final returned state
while still sending outstanding notification emails. Existing failed shipments
can enter this flow without a data migration.

A return is a fulfillment result, not a payment result. It does not automatically
refund the buyer or restock inventory; those require separate business steps.

## Next session: return review, restocking and refunds

Saved on 2026-11-16 at the user's request. This is the agreed continuation plan;
the features below are not implemented yet.

Start with a seller return-review screen and a return record per seller order,
tracking quantities per order item. A carrier's `returned_to_sender` event means
the parcel arrived, not that all expected items are present or sellable.

1. Returning to sender: create/link a return record and notify the seller.
2. Returned to sender: mark the return awaiting inspection and notify the buyer:
   "The seller received your parcel. We're reviewing the return."
3. Seller inspection: record received, sellable, damaged and missing quantities,
   enforce the seller's ownership and validate against purchased quantities.
4. Restock only confirmed sellable quantities. Example: three purchased, two
   returned sellable means stock increases by two. Apply the SQL stock adjustment
   and its return-item ledger entry atomically, with an idempotency constraint so
   repeated clicks, carrier events and BullMQ retries cannot restock twice.
5. Resolve the return through an approved refund or an explicitly arranged
   redelivery. Redelivery requires new shipment tracking and its own inventory
   handling; it must not silently reopen a terminal carrier shipment.

Keep fulfillment, inspection, restocking and refund states independent. A damaged
item may still qualify for a refund; a refund does not itself imply restocking.
Refunds should use the payment provider interface/factory and BullMQ, with states
such as requested, pending, succeeded and failed. Notify the buyer of completion
only after provider confirmation. Extend the independent payment simulator for
refund testing before connecting a real provider. Refund amounts, shipping-fee
treatment and eligibility need explicit business rules before implementation.

Handle partial returns and refunds per seller order/item without changing other
sellers' deliveries. Preserve original order, payment and invoice history; store
return/refund records separately. Send asynchronous buyer emails for receipt,
review outcome and refund progress, using the existing shared email provider.

Persistent working preferences: work on main; do not create branches, stage,
commit or push. The user handles Git. Keep third-party communication behind
interfaces and provider factories. Do not run a normal backend build over dist
while the development watcher is running; use an isolated build for verification.
