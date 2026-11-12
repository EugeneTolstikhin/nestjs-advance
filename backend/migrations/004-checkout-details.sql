-- Run once after 003-checkout-reservations.sql with the application stopped.
-- Development uses TypeORM synchronize; do not also run this there.
BEGIN TRANSACTION;
ALTER TABLE checkout_sessions ADD COLUMN delivery text;
ALTER TABLE checkout_sessions ADD COLUMN shipping text;
COMMIT;
