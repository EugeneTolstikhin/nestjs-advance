# Buyer shopping carts

The navbar cart icon opens `/cart`. Guests see a login/registration message and
seller-only accounts are prompted to add a buyer profile in My account. An account
with both buyer and seller roles can shop. A buyer sees saved cart contents or
**Your shopping cart is empty**.

Catalog cards have **Add to cart**. The cart page offers quantity increase/decrease,
full-item removal and current totals. Reducing a quantity from one removes the
line. Guest/seller add attempts show a friendly message; the API independently
enforces authentication and the buyer role.

## Persistence and device synchronization

Carts live in MongoDB's `carts` collection, using the existing `MONGODB_URI` and
`MONGODB_DATABASE` settings. No additional database service or environment keys are
needed. Keep the local MongoDB service running as for user accounts.

Each document's `_id` is the authenticated account ID. `items` maps product UUIDs
to quantities; `createdAt`/`updatedAt` track edits. The built-in unique `_id` index
guarantees one cart per account. No cart owner is accepted from request bodies or
URLs. Carts contain product references and quantities, not client-supplied prices.

The same account sees the same cart after signing in on another browser/device.
Logout and JWT expiry do not delete it. The cart survives application restarts.
MongoDB updates are atomic per document, including increments and quantity/product
limits, so concurrent devices do not overwrite the entire cart with stale copies.
Concurrent removal and addition of the same item follow MongoDB's write order.

The cart page reads fresh data when opened, when the browser regains focus or
visibility, and every 15 seconds while visible. This is polling, not WebSocket
push; another device's open cart updates on the next refresh. Pending stale reads
cannot overwrite a later local mutation. No cart contents are stored in browser
local storage. Private responses use `Cache-Control: no-store`; expired sessions
clear displayed cart contents and show a login link.

## Catalog and limits

Product names, prices and cover media are read from the current SQLite catalog.
Totals use integer cents before formatting, so decimal multiplication does not
accumulate floating-point rounding errors. Currency formatting follows the existing
catalog: two decimals followed by the euro symbol, including after browser refreshes
and quantity changes.

A deleted product remains visible as unavailable until removed. It cannot be
added/increased and is excluded from the total. This avoids silently losing a
buyer's saved selection. Carts do not reserve stock or lock catalog prices.
The maximum is 100 distinct products and 99 units per product, enforced in MongoDB
in the same atomic operation as the change. Increases are also capped at the
latest available stock count read from SQLite, excluding other buyers’ active
checkout reservations. A buyer’s own held units remain available in their cart. Out-of-stock products cannot be added;
saved lines show stock warnings if quantities become unavailable. These checks
do not reserve inventory: final checkout must recheck and deduct stock within
the order transaction. See [STOCK.md](./STOCK.md).

The **Proceed to checkout** button opens cart review and explicit, expiring stock
reservation. See [CHECKOUT.md](./CHECKOUT.md). Merely viewing or editing a cart
still creates no stock reservation.

## API

All data/mutation routes require a buyer session cookie or a verified bearer token:

| Method | Route | Body | Result |
| --- | --- | --- | --- |
| GET | `/cart` | — | Handlebars page, or an explanatory access message |
| GET | `/cart/data` | — | Own cart with current product data and totals |
| POST | `/cart/items/:productId` | `{}` | Add one unit |
| PATCH | `/cart/items/:productId` | `{ "delta": 1 }` or `{ "delta": -1 }` | Change quantity by one |
| DELETE | `/cart/items/:productId` | — | Remove the whole line; safe to repeat |

Mutations return the refreshed cart with HTTP 200. POST/PATCH require JSON.
Unknown body fields, invalid UUIDs and invalid deltas are rejected. Same-origin
checks protect browser writes. Non-buyers receive 403, unauthenticated/expired
sessions 401, missing products 404, limit conflicts 409 and unavailable MongoDB 503.
The HTML access message is served without disclosing cart data.

## Verification

```sh
npm test
npm run test:cart
```

The cart integration tests use isolated local MongoDB databases and temporary
SQLite/media directories. They verify account/role isolation, independent sessions,
logout/restart persistence, concurrent first additions, atomic limits, current
prices, deleted products, input validation and origin checks. DOM tests cover add
messages, empty carts, safe rendering, quantity/removal controls, focus, session
expiry and stale refresh races. Existing application data is not modified.
