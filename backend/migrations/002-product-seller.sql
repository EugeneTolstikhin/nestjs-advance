-- Apply once to an existing production SQLite database that has no sellerId column.
-- NULL preserves legacy rows until an administrator explicitly assigns ownership.
BEGIN TRANSACTION;
ALTER TABLE products ADD COLUMN sellerId varchar;
CREATE INDEX IDX_products_sellerId ON products (sellerId);
COMMIT;
