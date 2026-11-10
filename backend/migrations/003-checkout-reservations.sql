-- Apply once before deploying checkout when production synchronization is disabled.
BEGIN TRANSACTION;
CREATE TABLE checkout_sessions (
    id text PRIMARY KEY NOT NULL,
    buyerId text NOT NULL,
    activeBuyerId text,
    status text NOT NULL CONSTRAINT CHK_checkout_status CHECK (status IN ('reserved', 'cancelled', 'expired')),
    expiresAt integer NOT NULL,
    createdAt integer NOT NULL,
    revision integer NOT NULL DEFAULT 1,
    machineVersion integer NOT NULL DEFAULT 1,
    machineSnapshot text NOT NULL,
    quoteHash text NOT NULL,
    cartHash text NOT NULL,
    items text NOT NULL,
    subtotalCents integer NOT NULL,
    currency text NOT NULL DEFAULT 'EUR'
);
CREATE INDEX IDX_checkout_expiry ON checkout_sessions (status, expiresAt);
CREATE INDEX IDX_checkout_buyer ON checkout_sessions (buyerId);
CREATE UNIQUE INDEX UQ_checkout_active_buyer ON checkout_sessions (activeBuyerId);
CREATE TABLE stock_reservations (
    checkoutId text NOT NULL,
    productId text NOT NULL,
    quantity integer NOT NULL CONSTRAINT CHK_reservation_quantity CHECK (typeof(quantity) = 'integer' AND quantity > 0 AND quantity <= 99),
    PRIMARY KEY (checkoutId, productId)
);
CREATE INDEX IDX_reservation_product ON stock_reservations (productId);
COMMIT;
