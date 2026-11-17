# Nest Shop delivery simulator

Independent local carrier app with its own package, environment, SQLite ledger
and browser dashboard. It sends no real parcels and accepts no customer addresses.
Use Node 24 or later (the repository `.nvmrc` selects the shop's Node 24).

```sh
npm ci
cp .env.example .env
# Set DELIVERY_SIMULATOR_SECRET to the same random secret as backend/.env.
npm run start:dev
```

Open **http://localhost:4500**. Each seller order created after payment appears
with a tracking number, status history and a form for allowed transitions:

```text
label_created → picked_up → in_transit → out_for_delivery → delivered
       ↓             ↓           ↓               ↓
   cancelled         └──────── delivery_failed ────┘
                                   ↓
                         retry: in_transit
                         return: returning_to_sender → returned_to_sender
```

Delivered, cancelled and returned-to-sender shipments are terminal. Returned to sender means the sender has received the parcel. Stale forms are rejected: refresh the
dashboard after another update. Forms use same-origin checks and signed versioned
tokens. Tracking pages at `/track/:trackingNumber` are read-only. Dashboard control
is intended only for local development; the server binds to loopback and refuses
production mode.

Authenticated provider API:

- `POST /api/shipments`: `{ reference, method, country }`; reference is a seller
  order UUID, country is DE. Repeated identical references return the same shipment.
- `GET /api/shipments/:reference`: current status and complete sequenced history.

Both require `Authorization: Bearer <DELIVERY_SIMULATOR_SECRET>`. No backend source
is imported. State persists in `data/shipments.sqlite`, override with
`DELIVERY_SIMULATOR_DATABASE`. The shop polls this API using background jobs and
emails each new event. See [shop confirmation](../backend/ORDERS.md).

`npm test` checks persistence, idempotency, stale updates and allowed transitions.
`npm run build` creates the standalone build; `npm run start:built` runs it.

The dashboard displays all nine status labels. Its status selector disables
transitions unavailable from the current step. For a new label, choose Picked up
first; In transit becomes available next, followed by Out for delivery and
Delivered. Delivery failed is available during transport and can return to In
transit. Cancelled is available before pickup. Tracking history includes timestamps.

A failed delivery can instead start a return. Returning to sender ends with Returned to sender (received); it cannot resume buyer delivery. This carrier event does not automatically refund payment or replenish product stock.
