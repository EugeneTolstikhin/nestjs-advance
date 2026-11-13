const { beforeEach, afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { DataSource } = require('typeorm');
const build = process.env.TEST_BUILD_DIR || '../dist';
const { Products } = require(`${build}/products/products.entity`);
const { ProductMedia } = require(`${build}/products/media/product-media.entity`);
const { ProductMediaService } = require(`${build}/products/media/product-media.service`);
const { ProductsService } = require(`${build}/products/products.service`);
const { InlineJobQueue } = require(`${build}/jobs/job-queue`);
const { CheckoutSession, StockReservation } = require(`${build}/checkout/checkout-session.entity`);
const { CheckoutService } = require(`${build}/checkout/checkout.service`);
const { CartService } = require(`${build}/cart/cart.service`);
let db, products, checkout, cartService, directory, p, q;
const carts = new Map(); const buyer = randomUUID(), other = randomUUID(), seller = randomUUID();
const store = { get: async id => carts.get(id) ?? null };
const cart = (id, items) => carts.set(id, { _id: id, items, createdAt: new Date(), updatedAt: new Date() });
async function boot() {
    db = await new DataSource({ type: 'better-sqlite3', database: join(directory, 'checkout.sqlite'), entities: [Products, ProductMedia, CheckoutSession, StockReservation], synchronize: true }).initialize();
    products = new ProductsService(db.getRepository(Products), new ProductMediaService(db, new InlineJobQueue()));
    checkout = new CheckoutService(store, products);
    cartService = new CartService(store, db.getRepository(Products), db.getRepository(ProductMedia));
}
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'checkout-reservations-')); carts.clear();
    process.env.MEDIA_STORAGE_DIR = join(directory, 'media'); await boot();
    p = await products.createProduct({ name: 'Book', description: 'First', price: 1.25, stock: 5 }, seller);
    q = await products.createProduct({ name: 'Bag', description: 'Second', price: 2, stock: 5 }, seller);
    cart(buyer, { [p.id]: 2 }); cart(other, { [p.id]: 1 });
});
afterEach(async () => { if (db?.isInitialized) await db.destroy(); await rm(directory, { recursive: true, force: true }); });
const reserve = async id => checkout.reserve(id, (await checkout.preview(id)).quote.quoteHash);
const count = () => db.getRepository(StockReservation).count();

test('reservation snapshots server prices, persists the machine and does not deduct physical stock or clear the cart', async () => {
    const result = await reserve(buyer);
    assert.equal(result.status, 'reserved'); assert.equal(result.step, 'delivery');
    assert.equal(result.subtotalCents, 250); assert.equal(result.items[0].sellerId, seller);
    assert.equal((await products.getProductById({ id: p.id })).stock, 5);
    assert.equal((await products.getProductById({ id: p.id })).availableStock, 3);
    assert.equal(carts.get(buyer).items[p.id], 2); assert.equal(await count(), 1);
    assert.equal((await db.getRepository(CheckoutSession).findOneByOrFail({ id: result.id })).machineSnapshot.value, 'delivery');
});
test('competing buyers cannot reserve the last units twice', async () => {
    await products.patchProduct(p.id, { stock: 1, expectedStock: 5 }, seller);
    const buyers = Array.from({ length: 12 }, () => randomUUID());
    buyers.forEach(id => cart(id, { [p.id]: 1 }));
    const quotes = await Promise.all(buyers.map(id => checkout.preview(id)));
    const results = await Promise.allSettled(buyers.map((id, i) => checkout.reserve(id, quotes[i].quote.quoteHash)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.getStatus() === 409));
    assert.equal(await count(), 1); assert.equal((await products.getProductById({ id: p.id })).stock, 1);
});
test('same-account retries and separate devices reuse one reservation without extending the deadline', async () => {
    const quote = (await checkout.preview(buyer)).quote;
    const results = await Promise.all(Array.from({ length: 10 }, () => checkout.reserve(buyer, quote.quoteHash)));
    assert.equal(new Set(results.map(result => result.id)).size, 1);
    assert.equal(new Set(results.map(result => result.expiresAt)).size, 1); assert.equal(await count(), 1);
    cart(buyer, { [q.id]: 1 });
    const changed = await checkout.preview(buyer);
    assert.equal(changed.checkout.id, results[0].id);
    await assert.rejects(checkout.reserve(buyer, changed.quote.quoteHash), error => error.getStatus() === 409);
    assert.equal((await checkout.get(buyer, results[0].id)).items[0].productId, p.id);
});
test('price and cart changes require a new review before reserving', async () => {
    const quote = (await checkout.preview(buyer)).quote;
    await products.patchProduct(p.id, { price: 2 }, seller);
    await assert.rejects(checkout.reserve(buyer, quote.quoteHash), error => error.getStatus() === 409);
    assert.equal(await count(), 0);
    const updated = (await checkout.preview(buyer)).quote; assert.equal(updated.subtotalCents, 400);
    cart(buyer, { [p.id]: 3 });
    await assert.rejects(checkout.reserve(buyer, updated.quoteHash), error => error.getStatus() === 409);
    assert.equal(await count(), 0);
});
test('empty, removed, invalid-quantity, unsafe-price and unassigned-seller carts cannot reserve', async () => {
    for (const items of [{}, { [randomUUID()]: 1 }, { [p.id]: 0 }, { [p.id]: 100 }]) {
        cart(buyer, items); const preview = await checkout.preview(buyer);
        assert.equal(preview.quote.canReserve, false);
        await assert.rejects(checkout.reserve(buyer, preview.quote.quoteHash), error => error.getStatus() === 409);
    }
    cart(buyer, { [p.id]: 1 });
    await db.getRepository(Products).update(p.id, { sellerId: null });
    assert.match((await checkout.preview(buyer)).quote.issues[0].message, /seller/);
    await db.getRepository(Products).update(p.id, { sellerId: seller, price: -1 });
    assert.match((await checkout.preview(buyer)).quote.issues[0].message, /price/);
    assert.equal(await count(), 0);
});
test('a failing second product leaves no partial hold on the first product', async () => {
    cart(buyer, { [p.id]: 2, [q.id]: 2 });
    const quote = (await checkout.preview(buyer)).quote;
    cart(other, { [q.id]: 5 }); await reserve(other);
    await assert.rejects(checkout.reserve(buyer, quote.quoteHash), error => error.getStatus() === 409);
    assert.equal((await products.getProductById({ id: p.id })).availableStock, 5);
    assert.equal(await db.getRepository(CheckoutSession).countBy({ buyerId: buyer }), 0);
});
test('cancellation is private, revision-checked and idempotent', async () => {
    const session = await reserve(buyer);
    await assert.rejects(checkout.get(other, session.id), error => error.getStatus() === 404);
    await assert.rejects(checkout.cancel(other, session.id, 1), error => error.getStatus() === 404);
    await assert.rejects(checkout.cancel(buyer, session.id, 2), error => error.getStatus() === 409);
    const cancelled = await checkout.cancel(buyer, session.id, 1);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.step, 'cancelled'); assert.equal(cancelled.revision, 2);
    assert.equal((await checkout.cancel(buyer, session.id, 1)).revision, 2);
    assert.equal(await count(), 0); assert.equal((await products.getProductById({ id: p.id })).availableStock, 5);
});
test('expiry frees availability even before cleanup and remains correct across restart', async () => {
    const session = await reserve(buyer);
    await db.getRepository(CheckoutSession).update(session.id, { expiresAt: Date.now() - 1 });
    assert.equal((await products.getProductById({ id: p.id })).availableStock, 5);
    await db.destroy(); await boot();
    const expired = await checkout.get(buyer, session.id);
    assert.equal(expired.status, 'expired'); assert.equal(expired.step, 'expired'); assert.equal(await count(), 0);
    const next = await reserve(buyer); assert.notEqual(next.id, session.id);
});
test('active reservations resume after restart with the original deadline', async () => {
    const session = await reserve(buyer); await db.destroy(); await boot();
    const resumed = (await checkout.preview(buyer)).checkout;
    assert.equal(resumed.id, session.id); assert.equal(resumed.expiresAt, session.expiresAt); assert.equal(resumed.step, 'delivery');
    assert.equal((await checkout.cancel(buyer, resumed.id, resumed.revision)).status, 'cancelled');
});
test('stock corrections, admin deletion and direct deductions cannot consume reserved stock', async () => {
    cart(buyer, { [p.id]: 3 }); const session = await reserve(buyer);
    await assert.rejects(products.patchProduct(p.id, { stock: 2, expectedStock: 5 }, seller), error => error.getStatus() === 409);
    await assert.rejects(products.deleteProduct({ id: p.id }, seller, { isAdmin: true }), error => error.getStatus() === 409);
    await products.patchProduct(p.id, { stock: 3, expectedStock: 5 }, seller);
    await assert.rejects(products.withStockTransaction(manager => products.deductStock([{ productId: p.id, quantity: 1 }], manager)), error => error.getStatus() === 409);
    await products.restockProduct(p.id, 2, seller);
    assert.equal((await products.getProductById({ id: p.id })).availableStock, 2);
    await checkout.cancel(buyer, session.id, session.revision);
    assert.equal((await products.getProductById({ id: p.id })).availableStock, 5);
});
test('a buyer retains availability for their own hold while other buyers see only free units', async () => {
    await reserve(buyer);
    assert.equal((await cartService.get(buyer)).items[0].stock, 5);
    assert.equal((await cartService.get(other)).items[0].stock, 3);
});

test('the production migration supports reservations and enforces one active session per buyer', async () => {
    const { readFileSync } = require('node:fs');
    await db.query('DROP TABLE stock_reservations'); await db.query('DROP TABLE checkout_sessions');
    db.driver.databaseConnection.exec(readFileSync('migrations/003-checkout-reservations.sql', 'utf8'));
    db.driver.databaseConnection.exec(readFileSync('migrations/004-checkout-details.sql', 'utf8'));
    db.driver.databaseConnection.exec(readFileSync('migrations/005-simulated-payments.sql', 'utf8'));
    const session = await reserve(buyer);
    const stored = await db.getRepository(CheckoutSession).findOneByOrFail({ id: session.id });
    await assert.rejects(db.getRepository(CheckoutSession).insert({ ...stored, id: randomUUID() }), /UNIQUE/);
    assert.equal(await count(), 1);
});

const address = { fullName: 'Test Buyer', email: 'buyer@example.test', addressLine1: 'Teststrasse 1', postalCode: '10115', city: 'Berlin', country: 'DE' };
test('delivery, per-seller shipping and review persist separately from payment and fulfillment', async () => {
    await db.getRepository(Products).update(q.id, { sellerId: other });
    cart(buyer, { [p.id]: 2, [q.id]: 1 });
    const held = await reserve(buyer);
    const shipping = await checkout.saveDelivery(buyer, held.id, { ...address, revision: held.revision });
    assert.equal(shipping.step, 'shipping'); assert.equal(shipping.revision, 2);
    assert.equal(shipping.delivery.email, address.email); assert.equal(shipping.totalCents, null);
    assert.deepEqual(shipping.shippingOptions.map(option => option.shippingCents), [998, 1998]);
    const review = await checkout.selectShipping(buyer, held.id, { revision: 2, method: 'standard' });
    assert.equal(review.step, 'review'); assert.equal(review.subtotalCents, 450);
    assert.equal(review.shippingCents, 998); assert.equal(review.totalCents, 1448);
    assert.equal(review.phase, 'checkout'); assert.equal(review.paymentStatus, 'not_started'); assert.equal(review.fulfillmentStatus, 'not_started');
    assert.equal(review.expiresAt, held.expiresAt);
    await db.destroy(); await boot();
    const resumed = (await checkout.preview(buyer)).checkout;
    assert.equal(resumed.step, 'review'); assert.equal(resumed.totalCents, 1448);
    assert.deepEqual(resumed.delivery, address);
    assert.equal((await products.getProductById({ id: p.id })).stock, 5);
    assert.equal(carts.get(buyer).items[p.id], 2);
});
test('editing the address invalidates shipping and stale or out-of-order commands fail', async () => {
    let session = await reserve(buyer);
    await assert.rejects(checkout.selectShipping(buyer, session.id, { revision: 1, method: 'standard' }), error => error.getStatus() === 409);
    await assert.rejects(checkout.back(buyer, session.id, 1), error => error.getStatus() === 409);
    session = await checkout.saveDelivery(buyer, session.id, { ...address, revision: 1 });
    await assert.rejects(checkout.selectShipping(buyer, session.id, { revision: 1, method: 'standard' }), error => error.getStatus() === 409);
    await assert.rejects(checkout.selectShipping(buyer, session.id, { revision: 2, method: 'free' }), error => error.getStatus() === 400);
    session = await checkout.selectShipping(buyer, session.id, { revision: 2, method: 'express' });
    assert.equal(session.shippingCents, 999);
    await assert.rejects(checkout.saveDelivery(buyer, session.id, { ...address, revision: 3 }), error => error.getStatus() === 409);
    session = await checkout.back(buyer, session.id, 3);
    session = await checkout.back(buyer, session.id, session.revision);
    session = await checkout.saveDelivery(buyer, session.id, { ...address, city: 'Hamburg', revision: session.revision });
    assert.equal(session.step, 'shipping'); assert.equal(session.shipping, null); assert.equal(session.totalCents, null);
    assert.equal(session.delivery.city, 'Hamburg');
});
test('detail writes enforce ownership, expiry, normalized input and contact/address validation', async () => {
    const held = await reserve(buyer);
    await assert.rejects(checkout.saveDelivery(other, held.id, { ...address, revision: 1 }), error => error.getStatus() === 404);
    for (const changes of [{ fullName: '   ' }, { postalCode: 'ABC' }, { country: 'US' }, { email: 'bad' }, { email: undefined }, { phone: 'invalid' }]) {
        await assert.rejects(checkout.saveDelivery(buyer, held.id, { ...address, ...changes, revision: 1 }), error => error.getStatus() === 400);
    }
    let session = await checkout.saveDelivery(buyer, held.id, { ...address, email: undefined, phone: '+4917612345678', fullName: ' Test Buyer ', revision: 1 });
    assert.equal(session.delivery.fullName, 'Test Buyer'); assert.equal(session.delivery.email, undefined);
    await db.getRepository(CheckoutSession).update(held.id, { expiresAt: Date.now() - 1 });
    await assert.rejects(checkout.selectShipping(buyer, held.id, { revision: session.revision, method: 'standard' }), error => error.getStatus() === 409);
    assert.equal(await count(), 0);
    assert.equal((await db.getRepository(CheckoutSession).findOneByOrFail({ id: held.id })).status, 'expired');
});
test('concurrent detail writes accept only one revision and cancellation/expiry work from review', async () => {
    const held = await reserve(buyer);
    const results = await Promise.allSettled([1, 2].map(() => checkout.saveDelivery(buyer, held.id, { ...address, revision: 1 })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected')[0].reason.getStatus(), 409);
    const review = await checkout.selectShipping(buyer, held.id, { revision: 2, method: 'standard' });
    const cancelled = await checkout.cancel(buyer, held.id, review.revision);
    assert.equal(cancelled.step, 'cancelled'); assert.equal(await count(), 0);
    let next = await reserve(buyer);
    next = await checkout.saveDelivery(buyer, next.id, { ...address, revision: next.revision });
    next = await checkout.selectShipping(buyer, next.id, { revision: next.revision, method: 'standard' });
    await db.getRepository(CheckoutSession).update(next.id, { expiresAt: Date.now() - 1 });
    assert.equal((await checkout.get(buyer, next.id)).step, 'expired');
    assert.equal(await count(), 0);
});
