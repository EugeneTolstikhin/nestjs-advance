const { before, beforeEach, after, afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { DataSource } = require('typeorm');
const build = process.env.TEST_BUILD_DIR || '../dist';
const { Products } = require(`${build}/products/products.entity`);
const { ProductMedia } = require(`${build}/products/media/product-media.entity`);
const { ProductsService } = require(`${build}/products/products.service`);
const { ProductMediaService } = require(`${build}/products/media/product-media.service`);
const { CheckoutSession, StockReservation } = require(`${build}/checkout/checkout-session.entity`);
const { CheckoutService } = require(`${build}/checkout/checkout.service`);
const { PaymentsService } = require(`${build}/payments/payments.service`);
const { PaymentProviderFactory } = require(`${build}/payments/payment-provider`);
const { InlineJobQueue } = require(`${build}/jobs/job-queue`);
let directory, providerProcess, origin, secret, db, products, checkout, payments, factory, jobs, product;
const buyer = randomUUID(), other = randomUUID(), seller = randomUUID();
const carts = new Map(); let cleanupFails = false;
const store = { get: async id => carts.get(id), clearPurchasedIfUnchanged: async (id, items, revision) => {
  if (cleanupFails) throw new Error('Simulated MongoDB outage');
  const cart = carts.get(id); if (!cart || (cart.revision ?? 0) !== revision) return false;
  items.forEach(item => delete cart.items[item.productId]); cart.revision = revision + 1; return true;
} };
const address = { fullName: 'Test Buyer', email: 'buyer@example.test', addressLine1: 'Street 12', postalCode: '10115', city: 'Berlin', country: 'DE' };
async function until(read) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('Timed out waiting for payment'); }
async function port() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const p = server.address().port; await new Promise(resolve => server.close(resolve)); return p; }
before(async () => {
 directory = await mkdtemp(join(tmpdir(), 'payment-provider-')); origin = `http://127.0.0.1:${await port()}`; secret = randomBytes(32).toString('hex');
 Object.assign(process.env, { NODE_ENV: 'test', PAYMENT_PROVIDER: 'simulated', PAYMENT_SIMULATOR_URL: origin, PAYMENT_SIMULATOR_SECRET: secret, SHOP_ORIGIN: 'http://localhost:3000', MEDIA_STORAGE_DIR: join(directory, 'media') });
 providerProcess = spawn(process.execPath, [resolve(__dirname, '../../payment-simulator/dist/main.js')], { env: { ...process.env, PAYMENT_SIMULATOR_DATABASE: join(directory, 'provider.sqlite') }, stdio: ['ignore', 'ignore', 'pipe'] });
 let output = ''; providerProcess.stderr.on('data', chunk => output += chunk);
 await until(async () => { if (providerProcess.exitCode !== null) throw new Error(output); try { return (await fetch(`${origin}/api/payments/none`)).status === 401; } catch { return false; } });
});
beforeEach(async () => {
 cleanupFails = false; carts.clear();
 db = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Products, ProductMedia, CheckoutSession, StockReservation], synchronize: true }).initialize();
 products = new ProductsService(db.getRepository(Products), new ProductMediaService(db, new InlineJobQueue()));
 checkout = new CheckoutService(store, products); factory = new PaymentProviderFactory(); jobs = new InlineJobQueue();
 payments = new PaymentsService(products, checkout, factory, jobs, store);
 await jobs.register('payment-processing', data => payments.process(data.checkoutId));
 product = await products.createProduct({ name: 'Book', description: 'A book', price: 1.25, stock: 5 }, seller);
 carts.set(buyer, { _id: buyer, items: { [product.id]: 2 }, revision: 0 });
});
afterEach(async () => { payments.onModuleDestroy(); await until(async () => !payments.scanning); await db.destroy(); });
after(async () => { if (providerProcess?.exitCode === null) { providerProcess.kill(); await new Promise(resolve => providerProcess.once('exit', resolve)); } await rm(directory, { recursive: true, force: true }); });
async function review() { let s = await checkout.reserve(buyer, (await checkout.preview(buyer)).quote.quoteHash); s = await checkout.saveDelivery(buyer, s.id, { ...address, revision: s.revision }); return checkout.selectShipping(buyer, s.id, { method: 'standard', revision: s.revision }); }
async function start() { const s = await review(); await payments.start(buyer, s.id, s.revision); return until(async () => { const current = await checkout.get(buyer, s.id); return current.payment.paymentUrl ? current : false; }); }
async function decide(session, decision) {
 const result = await fetch(session.payment.paymentUrl, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ decision }), redirect: 'manual' });
 assert.equal(result.status, 303); assert.equal(result.headers.get('location'), `http://localhost:3000/checkout?session=${session.id}`);
}

test('independent provider uses authenticated idempotent requests, hosts the payment page, and completion deducts stock only once', async () => {
 const s = await start(); assert.equal(s.paymentStatus, 'pending'); assert.equal(s.order.status, 'pending'); assert.equal(s.totalCents, 749);
 assert.equal((await products.getProductById({ id: product.id })).stock, 5);
 const page = await fetch(s.payment.paymentUrl); assert.match(await page.text(), /No real money/);
 const again = await payments.start(buyer, s.id, 1); assert.equal(again.payment.id, s.payment.id);
 await decide(s, 'approve'); await payments.process(s.id); await payments.process(s.id);
 const paid = await checkout.get(buyer, s.id);
 assert.equal(paid.status, 'completed'); assert.equal(paid.paymentStatus, 'succeeded'); assert.equal(paid.order.status, 'paid');
 assert.equal(paid.fulfillmentStatus, 'unfulfilled'); assert.equal(paid.order.sellerOrders[0].totalCents, 749);
 assert.equal((await products.getProductById({ id: product.id })).stock, 3); assert.equal(await db.getRepository(StockReservation).count(), 0);
 assert.deepEqual(carts.get(buyer).items, {}); assert.equal(paid.order.cleanup, 'cleared_or_preserved');
 await decide(s, 'decline'); await payments.process(s.id); assert.equal((await checkout.get(buyer, s.id)).paymentStatus, 'succeeded');
});

test('decline and provider-confirmed cancellation release holds without deducting stock or clearing the cart', async () => {
 for (const choice of ['decline', 'cancel']) {
  const s = await start(); await decide(s, choice); await payments.process(s.id);
  const failed = await checkout.get(buyer, s.id); assert.equal(failed.status, 'cancelled'); assert.equal(failed.paymentStatus, choice === 'decline' ? 'failed' : 'cancelled');
  assert.equal((await products.getProductById({ id: product.id })).stock, 5); assert.equal(carts.get(buyer).items[product.id], 2);
  assert.equal(await db.getRepository(StockReservation).count(), 0);
 }
});

test('an unknown outcome pins even an elapsed hold; later reconciliation confirms success', async () => {
 const s = await start(); await decide(s, 'delayed'); await payments.process(s.id);
 assert.equal((await checkout.get(buyer, s.id)).paymentStatus, 'unknown');
 // An elapsed merchant deadline cannot discard a provider success which is temporarily unreachable.
 await db.getRepository(CheckoutSession).update(s.id, { expiresAt: Date.now() - 1 });
 assert.equal((await products.getProductById({ id: product.id })).availableStock, 3);
 assert.equal((await checkout.get(buyer, s.id)).status, 'reserved');
 // Restore the original deadline; provider responses must match the persisted intent exactly.
 await db.getRepository(CheckoutSession).update(s.id, { expiresAt: s.expiresAt });
 await new Promise(resolve => setTimeout(resolve, 10100)); await payments.process(s.id);
 assert.equal((await checkout.get(buyer, s.id)).status, 'completed');
});

test('a failed SQL finalization rolls back all stock changes, and replay recovers safely', async () => {
 const s = await start(); await decide(s, 'approve'); const deduct = products.deductStock.bind(products);
 products.deductStock = async (...args) => { await deduct(...args); throw new Error('Simulated order transaction failure'); };
 await payments.process(s.id); assert.equal((await checkout.get(buyer, s.id)).paymentStatus, 'unknown');
 assert.equal((await checkout.get(buyer, s.id)).payment.lastFailure, 'finalization');
 assert.equal((await products.getProductById({ id: product.id })).stock, 5); assert.equal(await db.getRepository(StockReservation).count(), 1);
 products.deductStock = deduct; await payments.process(s.id); await payments.process(s.id);
 assert.equal((await products.getProductById({ id: product.id })).stock, 3);
});

test('cart cleanup retries after Mongo failure and never removes a concurrent cart edit', async () => {
 const s = await start(); cleanupFails = true; await decide(s, 'approve');
 await assert.rejects(payments.process(s.id), /MongoDB/);
 assert.equal((await checkout.get(buyer, s.id)).status, 'completed'); assert.equal((await products.getProductById({ id: product.id })).stock, 3);
 carts.get(buyer).items[product.id] = 3; carts.get(buyer).revision++;
 cleanupFails = false; await payments.process(s.id);
 assert.equal(carts.get(buyer).items[product.id], 3); assert.equal((await products.getProductById({ id: product.id })).stock, 3);
});

test('cancel from the shop waits for provider confirmation and a late success wins the cancellation race', async () => {
 let s = await start(); await checkout.cancel(buyer, s.id, s.revision);
 assert.equal(await db.getRepository(StockReservation).count(), 1); await payments.process(s.id);
 assert.equal((await checkout.get(buyer, s.id)).paymentStatus, 'cancelled');
 s = await start(); await decide(s, 'approve'); await checkout.cancel(buyer, s.id, s.revision); await payments.process(s.id);
 assert.equal((await checkout.get(buyer, s.id)).paymentStatus, 'succeeded');
});

test('preparation enforces ownership/review/revision/current prices and provider requests cannot change amounts', async () => {
 let s = await review();
 await assert.rejects(payments.start(other, s.id, s.revision), e => e.getStatus() === 404);
 await assert.rejects(payments.start(buyer, s.id, s.revision - 1), e => e.getStatus() === 409);
 await products.patchProduct(product.id, { price: 2 }, seller);
 await assert.rejects(payments.start(buyer, s.id, s.revision), e => e.getStatus() === 409);
 await products.patchProduct(product.id, { price: 1.25 }, seller);
 await payments.start(buyer, s.id, s.revision); s = await until(async () => { const x = await checkout.get(buyer, s.id); return x.payment?.paymentUrl ? x : false; });
 await assert.rejects(factory.create().create({ reference: s.payment.id, amountCents: 1, currency: 'EUR', expiresAt: s.expiresAt, returnUrl: `http://localhost:3000/checkout?session=${s.id}` }));
 const forbidden = await fetch(`${origin}/api/payments/${s.payment.id}`); assert.equal(forbidden.status, 401);
 const crossOrigin = await fetch(s.payment.paymentUrl, { method: 'POST', headers: { Origin: 'https://attacker.test', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'decision=approve', redirect: 'manual' }); assert.equal(crossOrigin.status, 403);
});

test('legacy sessions without a captured cart revision preserve the cart after payment', async () => {
 const s = await start();
 await db.getRepository(CheckoutSession).update(s.id, { cartRevision: null });
 await decide(s, 'approve'); await payments.process(s.id);
 assert.equal((await checkout.get(buyer, s.id)).status, 'completed');
 assert.equal(carts.get(buyer).items[product.id], 2);
});

test('payment options are persisted, reach the independent provider, and cannot be changed on a live attempt', async () => {
 for (const optionId of ['paypal', 'bank_transfer']) {
  const reviewSession = await review();
  await assert.rejects(payments.start(buyer, reviewSession.id, reviewSession.revision, 'not_enabled'), error => error.getStatus() === 400);
  await payments.start(buyer, reviewSession.id, reviewSession.revision, optionId);
  const intent = await until(async () => { const s = await checkout.get(buyer, reviewSession.id); return s.payment.paymentUrl ? s : false; });
  assert.equal(intent.payment.optionId, optionId); assert.equal(intent.payment.simulated, true);
  const stored = await db.getRepository(CheckoutSession).findOneByOrFail({ id: intent.id });
  assert.equal(stored.payment.provider, 'simulated'); assert.equal(stored.payment.method, optionId);
  const result = await factory.create('simulated').get(intent.payment.id);
  assert.equal(result.method, optionId);
  await assert.rejects(payments.start(buyer, intent.id, intent.revision, 'card'), error => error.getStatus() === 409);
  await decide(intent, 'decline'); await payments.process(intent.id);
 }
});

test('a declined payment can retry directly at review with a different method and a fresh idempotent checkout', async () => {
 const original = await start(); await decide(original, 'decline'); await payments.process(original.id);
 const failed = await checkout.get(buyer, original.id);
 const quote = (await checkout.preview(buyer)).quote;
 const replacements = await Promise.all(Array.from({ length: 6 }, () => checkout.retry(buyer, original.id, failed.revision, quote.quoteHash)));
 assert.equal(new Set(replacements.map(value => value.id)).size, 1);
 const next = replacements[0]; assert.notEqual(next.id, original.id); assert.equal(next.step, 'review');
 assert.equal(next.payment, null); assert.equal(next.order, null); assert.equal(next.status, 'reserved');
 assert.deepEqual(next.delivery, address); assert.equal(next.shipping.method, 'standard'); assert.equal(next.totalCents, original.totalCents);
 assert.equal(await db.getRepository(StockReservation).count(), 1);
 await payments.start(buyer, next.id, next.revision, 'paypal');
 const pending = await until(async () => { const value = await checkout.get(buyer, next.id); return value.payment?.paymentUrl ? value : false; });
 assert.notEqual(pending.payment.id, original.payment.id); assert.equal(pending.payment.optionId, 'paypal');
 await decide(pending, 'approve'); await payments.process(next.id);
 assert.equal((await checkout.get(buyer, next.id)).status, 'completed');
 assert.equal((await checkout.get(buyer, original.id)).paymentStatus, 'failed');
 assert.equal((await products.getProductById({ id: product.id })).stock, 3);
 assert.equal((await checkout.retry(buyer, original.id, failed.revision, quote.quoteHash)).id, next.id);
});

test('retry enforces ownership, confirmed terminal outcomes, current revisions and fresh cart quotes', async () => {
 const original = await start(); let quote = (await checkout.preview(buyer)).quote;
 await assert.rejects(checkout.retry(buyer, original.id, original.revision, quote.quoteHash), error => error.getStatus() === 409);
 await decide(original, 'cancel'); await payments.process(original.id);
 const failed = await checkout.get(buyer, original.id);
 await assert.rejects(checkout.retry(other, original.id, failed.revision, quote.quoteHash), error => error.getStatus() === 404);
 await assert.rejects(checkout.retry(buyer, original.id, failed.revision - 1, quote.quoteHash), error => error.getStatus() === 409);
 await products.patchProduct(product.id, { price: 2 }, seller);
 await assert.rejects(checkout.retry(buyer, original.id, failed.revision, quote.quoteHash), error => error.getStatus() === 409);
 assert.equal(await db.getRepository(StockReservation).count(), 0);
 const second = await products.createProduct({ name: 'Other seller item', description: 'Item', price: 3, stock: 4 }, other);
 carts.get(buyer).items[second.id] = 1; carts.get(buyer).revision++;
 quote = (await checkout.preview(buyer)).quote;
 const next = await checkout.retry(buyer, original.id, failed.revision, quote.quoteHash);
 assert.equal(next.items.length, 2); assert.equal(next.subtotalCents, 700); assert.equal(next.shippingCents, 998); assert.equal(next.totalCents, 1698);
 assert.equal((await checkout.get(buyer, original.id)).paymentStatus, 'cancelled');
});

test('provider-confirmed expiry releases an unpaid reservation', async () => {
 let s = await review();
 await db.getRepository(CheckoutSession).update(s.id, { expiresAt: Date.now() + 1500 });
 await payments.start(buyer, s.id, s.revision);
 await until(async () => (await checkout.get(buyer, s.id)).payment.paymentUrl);
 await new Promise(resolve => setTimeout(resolve, 1600)); await payments.process(s.id);
 const expired = await checkout.get(buyer, s.id);
 assert.equal(expired.status, 'expired'); assert.equal(expired.paymentStatus, 'expired');
 assert.equal((await products.getProductById({ id: product.id })).stock, 5);
 assert.equal(await db.getRepository(StockReservation).count(), 0);
});

test('real BullMQ workers poll the independent provider and finalize a payment through isolated Redis', async () => {
 const { BullJobQueue } = require(`${build}/jobs/job-queue`);
 const redisPort = await port();
 const redisProcess = spawn(process.env.TEST_REDIS_BINARY || 'redis-server', ['--port', String(redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--dir', directory], { stdio: 'ignore' });
 const { createClient } = require('redis');
 const client = createClient({ url: `redis://127.0.0.1:${redisPort}`, socket: { reconnectStrategy: false } }); client.on('error', () => {});
 let queue;
 try {
  await until(async () => { try { if (!client.isOpen) await client.connect(); return await client.ping() === 'PONG'; } catch { return false; } });
  process.env.JOBS_REDIS_URL = `redis://127.0.0.1:${redisPort}`; process.env.JOBS_REDIS_PREFIX = `test-payment-${randomUUID()}`;
  queue = new BullJobQueue(); payments.onModuleDestroy();
  payments = new PaymentsService(products, checkout, factory, queue, store);
  await payments.onModuleInit();
  const reviewed = await review(); await payments.start(buyer, reviewed.id, reviewed.revision);
  const pending = await until(async () => { const s = await checkout.get(buyer, reviewed.id); return s.payment.paymentUrl ? s : false; });
  await decide(pending, 'approve');
  await until(async () => (await checkout.get(buyer, pending.id)).status === 'completed');
  assert.equal((await products.getProductById({ id: product.id })).stock, 3);
 } finally {
  payments.onModuleDestroy(); await queue?.onModuleDestroy(); if (client.isOpen) await client.close();
  if (redisProcess.exitCode === null) { const exit = new Promise(resolve => redisProcess.once('exit', resolve)); redisProcess.kill(); await exit; }
 }
});
