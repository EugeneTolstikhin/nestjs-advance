# Product stock

Stock is an integer from 0 to 2,147,483,647 in SQLite. Existing products and API
creations that omit stock start at 0 (out of stock). The seller form defaults to 0.

## Seller UI

On **Add product**, enter the initial **Stock quantity**.
On **Edit product**, either:

- Correct **Stock quantity** to the actual total. Saving sends the original count
  as `expectedStock`; a stale count returns 409 instead of overwriting another change.
- Leave that total unchanged and enter **Add a new delivery to stock**. The units
  are added to the latest database count, including any intervening purchases.

Do one stock operation per save. Normal name/description/price edits preserve the
latest stock. The shop labels out-of-stock products and disables adding them.
The cart caps increases at current stock (and its existing 99-per-product limit).
Saved carts are rechecked when displayed/refreshed; products can still be removed
or decreased if availability changes. Cart additions do **not** reserve stock.

## Checkout reservations

Buyers can now explicitly reserve a validated cart from `/checkout` for 15 minutes.
This leaves physical `stock` unchanged; `availableStock` excludes active holds.
Expiry is checked using SQL timestamps, and cancellation releases held units.
Sellers cannot set stock below active reservations or delete a reserved product.
See [CHECKOUT.md](./CHECKOUT.md) for the current flow and migration.

Future order finalization must consume its own reservation inside the same SQL
transaction before calling `deductStock`. That method protects all still-active
holds; it must not consume another checkout's reserved units.

## API

Product writes and restocking retain the existing seller-only authorization and
same-origin protection. Reads include `stock`.

- `POST /products`: optional `stock` alongside name, description, price and media IDs.
- `PUT` / `PATCH /products/:id`: omit stock to preserve it; send
  `{ "stock": 12, "expectedStock": 8 }` to correct it, or
  `{ "restockQuantity": 5 }` to add five units. PUT also requires the existing name,
  description and price fields.
- `POST /products/:id/restock`: `{ "quantity": 5 }` adds five units atomically.

## Future checkout integration

There is no checkout/payment flow yet. The current UI never deducts stock.
`ProductsService` provides the server-side building blocks for finalizing orders:

```ts
await productsService.withStockTransaction(async manager => {
  // Check/insert the unique order/payment reference first. A repeat payment
  // callback must return the existing order without deducting stock twice.
  await productsService.deductStock(orderItems, manager);
  // Persist the completed order and its lines using this same manager.
});
```

`orderItems` contains `{ productId, quantity }` entries. Duplicate lines are combined.
Each SQL decrement checks sufficient stock in the UPDATE condition. Missing or
insufficient products return 409; any failed line or order write rolls back all
stock changes. The wrapper serializes transactions on the app's shared SQLite
connection with other product/media writes. External payment calls belong outside
this SQL transaction; payment failure/refund handling must be designed with checkout.
No public stock-deduction endpoint is exposed.

## Database upgrade and verification

Development's existing TypeORM synchronization adds the column while preserving
product rows. Set the real counts for existing products in their edit forms.
Production disables synchronization: apply `migrations/001-product-stock.sql`
once to the existing database before starting the upgraded app.

`npm run test:stock` builds and tests persistence, concurrent restocks/purchases,
SQL constraints, stale edits, order rollback and legacy schema synchronization.
Stop development watchers before invoking a full build/test command.
