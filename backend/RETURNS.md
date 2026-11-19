# Returns

Open **My orders** in the shop navigation, then choose **Return items** for a delivered purchase. Order cards and return forms show product photos, purchase dates and seller names. Existing returns are available through **My returns**, and sellers can use **Review customer returns**.
The buyer and owning seller can access a return's private details and photos.

## Buyer-requested returns

A buyer selects a delivered seller shipment, quantities and reasons, then submits
its return request. The seller approves or rejects it in the Returns UI. Rejection
requires an explanation. Approval queues creation of a separate return shipment
through the delivery provider factory. Its reference is the return UUID, linked
to the original shipment. The buyer receives instructions and tracking by email.
The local simulator dashboard distinguishes return shipments from outbound ones.

Requests reserve the declared quantities against further requests. Rejected
requests release those quantities. Multiple partial requests are supported within
the original purchased quantities. A new request ID handles browser retries
without creating another return. Existing paid orders are supported.

## Failed outbound delivery

When the original carrier reports returning_to_sender or returned_to_sender,
background reconciliation creates one automatic return for the entire seller
shipment. Its expected contents come from the paid snapshot. It follows the
original tracking number and requires seller inspection after arrival. Previously
returned shipments are discovered as well. Other sellers' shipments are separate.

## Inspection and resolution

After carrier receipt, the seller records each item's received and sellable
quantities, the quantity to restore to stock, and the quantity approved for refund.
Notes are required. Missing quantities or damaged items record a discrepancy.

The seller can request buyer clarification. Buyers respond in the return message
history and can attach evidence photos. The seller records a discrepancy
resolution before finalizing. Updating inspection resets that resolution.

A carrier claim can be opened for a discrepancy. Its notes and outcome are
recorded independently of the refund. Open http://localhost:4500 and use **Carrier
claims** to mark the simulated investigation investigating, approved or rejected,
with an explanation. Claim notes are sent to the simulator. Evidence photos are
kept privately in the shop and are available to the buyer and seller for review.

Finalizing is explicit. Stock adjustments and the saved refund intent are applied
in one SQL transaction. The return revision and resolved status prevent repeated
finalization from restocking twice. The seller can approve item refunds and an
optional shipping refund, bounded by the original seller shipment charge and
previous returns. No refund eligibility, deadline or fee policy is imposed by this
development feature. Sellers review and explain their decisions.

A refund job uses the original payment provider and a stable return reference.
The local payment simulator acknowledges successful refunds, preserves them across
restarts and prevents refunding above the original paid amount. A pending/unknown
provider response is retried with that same reference. Real adapters implement
the refund method on PaymentProvider and must honor its idempotency reference.
The UI and notification history distinguish approved, completed and provider-rejected refunds. Sellers can retry a failed refund after reviewing its cause, using the same reference.

## Background work and storage

BullMQ queues **return-processing** and **return-email** handle return shipping,
tracking, carrier claims, refunds and notifications. Saved SQL state and an email
outbox allow recovery after a service or Redis interruption. Email IDs and leases
prevent ordinary replay duplicates. SMTP delivery retains its at-least-once
limitations. Both buyer and seller receive updates at their verified account
email. Unavailable verified destinations are skipped and updates remain in the UI.

Returns are in the SQLite order_returns table. Development synchronization creates
the table. Production deployments can apply migrations/006-order-returns.sql.
Private evidence defaults to storage/private/returns and is configurable with
RETURN_EVIDENCE_DIR. Uploads accept up to five JPEG/PNG/WebP images per request,
five MB each, and 20 per return. Images are decoded, resized and stripped of
metadata. Back up private files alongside the SQL database.

RETURNS_ENABLED=false pauses return reconciliation and worker registration after
restart. Delivery, payment and email settings use the existing provider factories.
Start Redis, Mailpit and both simulators for the complete development workflow.
The buyer UI uses the shop's Handlebars layout and browser TypeScript.

Run npm run test:returns for the isolated Redis/Mailpit/two-simulator integration
test. Stop the dev watcher before that script's standard build. Unit/browser
tests use npm test. The normal dev workflow does not require a separate frontend
framework.
