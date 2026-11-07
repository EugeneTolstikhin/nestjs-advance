-- Apply once to an existing production SQLite database before running the stock-enabled app.
-- Development uses TypeORM synchronize instead.
BEGIN TRANSACTION;
ALTER TABLE products ADD COLUMN stock INTEGER NOT NULL DEFAULT 0
    CONSTRAINT CHK_products_stock CHECK (typeof(stock) = 'integer' AND stock >= 0 AND stock <= 2147483647);
COMMIT;
