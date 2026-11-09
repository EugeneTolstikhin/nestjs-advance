# Product seller ownership

`products.sellerId` references the account's string `_id` in MongoDB. SQLite has
an index for seller-specific lists; no cross-database foreign key is possible.
New products always take their seller ID from the authenticated JWT `sub`.
Request bodies cannot assign or change ownership.

- `/shop`, `GET /products`, and `GET /products/:id` remain public across sellers.
- `/my-shop` and `GET /products/my` require a seller and show only their listings.
- The edit page uses `getOwnedProductById`; public reads use `getProductById`.
- PUT, PATCH, restock and media changes require product ownership.
- Sellers can delete their own products. Administrators can delete any product,
  including an unassigned legacy listing; the override is derived from verified
  roles, never a request-body field. Admins do not gain general seller edit access.
- Buyers' carts can contain products from different sellers.

## Existing products

Legacy products have no trustworthy seller ID. The schema deliberately permits
NULL **for legacy ownership awaiting assignment**. Development synchronization
adds the nullable column and its index without deleting existing rows. No seller
can claim such a product by editing it or supplying an ID in a request body.

Production disables synchronization. For databases without a sellerId column,
apply `migrations/002-product-seller.sql` once before starting the upgraded app.
Do not apply it if the column already exists.

Use the assignment tool to explicitly choose existing seller accounts:

```sh
npm run products:owners -- --list
```

Create a local file named `product-owners.local.json` mapping product UUIDs to
seller account UUIDs (MongoDB `_id`):

```json
{
  "550e8400-e29b-41d4-a716-446655440000": "550e8400-e29b-41d4-a716-446655440001"
}
```

Then assign the chosen owners:

```sh
npm run products:owners -- --assign product-owners.local.json
```

The tool loads `.env`, checks that every account exists in MongoDB and has the
seller role, and applies the mapping in one SQLite transaction. Unknown products,
missing accounts, buyer-only accounts and attempts to replace an existing owner
fail without partial changes. Repeating the same mapping is safe. `--list` is
read-only; `--database path.sqlite` selects a different database explicitly.
No assignments are made automatically when the application starts.

## Verification

`npm run test:ownership` builds and checks public reads, private seller lists,
editor isolation, mutation ownership, the admin deletion exception and migration
assignments. The HTTP tests use temporary SQLite/media storage and an isolated
account repository. Stop development watchers before running build-based tests.
