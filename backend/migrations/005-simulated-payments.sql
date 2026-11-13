-- Apply once after 004 with the application stopped and a database backup.
-- The table rebuild adds the completed status while preserving active checkouts.
BEGIN TRANSACTION;
CREATE TABLE checkout_sessions_next (
 id text PRIMARY KEY NOT NULL, buyerId text NOT NULL, activeBuyerId text,
 status text NOT NULL CONSTRAINT CHK_checkout_status_v2 CHECK (status IN ('reserved', 'cancelled', 'expired', 'completed')),
 expiresAt integer NOT NULL, createdAt integer NOT NULL, revision integer NOT NULL DEFAULT 1,
 machineVersion integer NOT NULL DEFAULT 1, machineSnapshot text NOT NULL,
 quoteHash text NOT NULL, cartHash text NOT NULL, items text NOT NULL,
 subtotalCents integer NOT NULL, currency text NOT NULL DEFAULT 'EUR', delivery text, shipping text,
 payment text, "order" text, cartRevision integer
);
INSERT INTO checkout_sessions_next (id,buyerId,activeBuyerId,status,expiresAt,createdAt,revision,machineVersion,machineSnapshot,quoteHash,cartHash,items,subtotalCents,currency,delivery,shipping)
 SELECT id,buyerId,activeBuyerId,status,expiresAt,createdAt,revision,machineVersion,machineSnapshot,quoteHash,cartHash,items,subtotalCents,currency,delivery,shipping FROM checkout_sessions;
DROP TABLE checkout_sessions;
ALTER TABLE checkout_sessions_next RENAME TO checkout_sessions;
CREATE INDEX IDX_checkout_expiry ON checkout_sessions(status,expiresAt);
CREATE INDEX IDX_checkout_buyer ON checkout_sessions(buyerId);
CREATE UNIQUE INDEX UQ_checkout_active_buyer ON checkout_sessions(activeBuyerId);
COMMIT;
