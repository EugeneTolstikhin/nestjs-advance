-- Apply after 005 when production schema synchronization is disabled.
BEGIN TRANSACTION;
CREATE TABLE IF NOT EXISTS order_returns (
 id text PRIMARY KEY NOT NULL,
 checkoutId text NOT NULL,
 sellerOrderId text NOT NULL,
 buyerId text NOT NULL,
 sellerId text NOT NULL,
 kind text NOT NULL,
 automaticReference text,
 status text NOT NULL,
 revision integer NOT NULL DEFAULT 1,
 createdAt integer NOT NULL,
 nextCheckAt integer NOT NULL DEFAULT 0,
 data text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS UQ_return_automatic ON order_returns (automaticReference);
CREATE INDEX IF NOT EXISTS IDX_return_buyer ON order_returns (buyerId);
CREATE INDEX IF NOT EXISTS IDX_return_seller ON order_returns (sellerId);
CREATE INDEX IF NOT EXISTS IDX_return_order ON order_returns (checkoutId, sellerOrderId);
COMMIT;
