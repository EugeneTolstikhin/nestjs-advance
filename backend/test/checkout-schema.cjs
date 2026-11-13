const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const build = process.env.TEST_BUILD_DIR || '../dist';
const { CheckoutSession, StockReservation } = require(`${build}/checkout/checkout-session.entity`);

test('development synchronization replaces the legacy status constraint and preserves pending payments and holds', async () => {
 const db = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [CheckoutSession, StockReservation], synchronize: true }).initialize();
 try {
  const table = await db.createQueryRunner().getTable('checkout_sessions');
  const nextCheck = table.checks.find(check => check.name === 'CHK_checkout_status_v2');
  assert.ok(nextCheck);
  const { TableCheck } = require('typeorm');
  await db.createQueryRunner().dropCheckConstraint('checkout_sessions', nextCheck);
  await db.createQueryRunner().createCheckConstraint('checkout_sessions', new TableCheck({ name: 'CHK_checkout_status', expression: "status IN ('reserved', 'cancelled', 'expired')" }));
  const id = randomUUID(); const buyer = randomUUID(); const product = randomUUID();
  const payment = { id: randomUUID(), status: 'unknown', amountCents: 100, currency: 'EUR', nextCheckAt: Date.now(), cancelRequested: false };
  await db.getRepository(CheckoutSession).save({ id, buyerId: buyer, activeBuyerId: buyer, status: 'reserved', expiresAt: Date.now() + 60000, createdAt: Date.now(), revision: 4, machineVersion: 1, machineSnapshot: { value: 'reconciling', context: { paymentAttemptId: payment.id } }, quoteHash: 'quote', cartHash: 'cart', items: [{ productId: product, quantity: 2 }], subtotalCents: 100, currency: 'EUR', payment, order: { id: randomUUID(), status: 'pending' } });
  await db.getRepository(StockReservation).save({ checkoutId: id, productId: product, quantity: 2 });
  await assert.rejects(db.getRepository(CheckoutSession).update(id, { status: 'completed' }), /CHECK constraint failed/);
  await db.synchronize();
  const upgraded = await db.getRepository(CheckoutSession).findOneByOrFail({ id });
  assert.deepEqual(upgraded.payment, payment); assert.equal(upgraded.revision, 4); assert.equal(upgraded.activeBuyerId, buyer);
  assert.equal(await db.getRepository(StockReservation).countBy({ checkoutId: id }), 1);
  await db.getRepository(CheckoutSession).update(id, { status: 'completed' });
  assert.equal((await db.getRepository(CheckoutSession).findOneByOrFail({ id })).status, 'completed');
  const changed = await db.createQueryRunner().getTable('checkout_sessions');
  assert.equal(changed.checks.some(check => check.name === 'CHK_checkout_status'), false);
 } finally { await db.destroy(); }
});
