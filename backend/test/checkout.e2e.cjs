process.env.JOBS_DRIVER = 'inline';
process.env.JWT_SECRET = 'checkout-test-secret-at-least-32-characters';
const { before, beforeEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { DataSource } = require('typeorm');
const { Test } = require('@nestjs/testing');
const { JwtService } = require('@nestjs/jwt');
const { getDataSourceToken } = require('@nestjs/typeorm');
const request = require('supertest');
const build = process.env.TEST_BUILD_DIR || '../dist';
const { AppModule } = require(`${build}/app.module`);
const { Products } = require(`${build}/products/products.entity`);
const { ProductsService } = require(`${build}/products/products.service`);
const { ProductMedia } = require(`${build}/products/media/product-media.entity`);
const { CheckoutSession, StockReservation } = require(`${build}/checkout/checkout-session.entity`);
const { UsersRepository } = require(`${build}/auth/users.repository`);
const { CartRepository } = require(`${build}/cart/cart.repository`);
const { AuthStateStore, MemoryAuthStateStore } = require(`${build}/auth/storage/auth-state.store`);
const { configureViews } = require(`${build}/views.config`);
let app, api, db, jwt, directory, products, p, q, cookies;
const buyer = randomUUID(), other = randomUUID(), seller = randomUUID(), mixed = randomUUID();
const accounts = [
    { _id: buyer, firstName: 'Buyer', lastName: 'One', roles: ['buyer'] },
    { _id: other, firstName: 'Buyer', lastName: 'Two', roles: ['buyer'] },
    { _id: seller, firstName: 'Seller', lastName: 'One', roles: ['seller'] },
    { _id: mixed, firstName: 'Both', lastName: 'Roles', roles: ['buyer', 'seller'] },
];
const carts = new Map();
const as = (req, id = buyer) => req.set('Cookie', cookies[id]);
before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'checkout-http-')); process.env.MEDIA_STORAGE_DIR = directory;
    const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(UsersRepository).useValue({ findById: async id => accounts.find(user => user._id === id) })
        .overrideProvider(CartRepository).useValue({ get: async id => carts.get(id) ?? null })
        .overrideProvider(AuthStateStore).useValue(new MemoryAuthStateStore())
        .overrideProvider(getDataSourceToken()).useFactory({ factory: () => new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Products, ProductMedia, CheckoutSession, StockReservation], synchronize: true }).initialize() }).compile();
    app = module.createNestApplication({ logger: false }); await configureViews(app); await app.init(); await app.listen(0, '127.0.0.1');
    api = request(app.getHttpServer()); db = module.get(DataSource); jwt = module.get(JwtService); products = module.get(ProductsService);
    cookies = Object.fromEntries(await Promise.all(accounts.map(async user => [user._id, `nest_session=${await jwt.signAsync({ sub: user._id, roles: user.roles })}`])));
});
beforeEach(async () => {
    await db.getRepository(StockReservation).clear(); await db.getRepository(CheckoutSession).clear(); await db.getRepository(ProductMedia).clear(); await db.getRepository(Products).clear(); carts.clear();
    p = await products.createProduct({ name: 'Product A', description: 'From A', price: 1.25, stock: 2 }, seller);
    q = await products.createProduct({ name: 'Product B', description: 'From B', price: 2, stock: 2 }, mixed);
    for (const id of [buyer, other, mixed]) carts.set(id, { _id: id, items: { [p.id]: 1, [q.id]: 1 } });
});
after(async () => { await app?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
const quote = async id => (await as(api.get('/checkout/data'), id).expect(200)).body.quote;
const reserve = async id => as(api.post('/checkout/reservations'), id).send({ quoteHash: (await quote(id)).quoteHash }).expect(200);
test('buyer authorization protects the UI and every checkout operation', async () => {
    await api.get('/checkout').expect(401); await api.get('/checkout/data').expect(401);
    await as(api.get('/checkout'), seller).expect(403);
    const page = await as(api.get('/checkout')).expect(200).expect('Cache-Control', 'no-store');
    assert.match(page.text, /Reserve items for 15 minutes/); assert.match(page.text, /Buyer One/);
    assert.match((await as(api.get('/cart')).expect(200)).text, /href="\/checkout">Proceed to checkout/);
    await as(api.get('/checkout'), mixed).expect(200);
});
test('prices, buyer identity and line items cannot be supplied in reservation payloads', async () => {
    const review = await quote(buyer);
    for (const extra of [{ buyerId: other }, { subtotalCents: 1 }, { items: [] }, { event: 'PAYMENT_SUCCEEDED' }]) {
        await as(api.post('/checkout/reservations')).send({ quoteHash: review.quoteHash, ...extra }).expect(400);
    }
    await as(api.post('/checkout/reservations')).send({ quoteHash: 'invalid' }).expect(400);
    await as(api.post('/checkout/reservations')).set('Origin', 'https://other.example').send({ quoteHash: review.quoteHash }).expect(403);
    const result = await reserve(buyer);
    assert.equal(result.body.subtotalCents, 325); assert.equal(result.body.items.length, 2);
});
test('cookie and bearer sessions resume the same reservation, while another buyer cannot read or cancel it', async () => {
    const first = await reserve(buyer);
    const token = await jwt.signAsync({ sub: buyer, roles: ['buyer'] });
    const resumed = await api.get('/checkout/data').set('Authorization', `Bearer ${token}`).expect(200);
    assert.equal(resumed.body.checkout.id, first.body.id);
    await as(api.get(`/checkout/${first.body.id}`), other).expect(404);
    await as(api.delete(`/checkout/${first.body.id}`), other).send({ revision: 1 }).expect(404);
    await as(api.delete(`/checkout/${first.body.id}`)).send({ revision: 2 }).expect(409);
    await as(api.delete(`/checkout/${first.body.id}`)).set('Origin', 'https://other.example').send({ revision: 1 }).expect(403);
    const cancelled = await as(api.delete(`/checkout/${first.body.id}`)).send({ revision: 1 }).expect(200);
    assert.equal(cancelled.body.status, 'cancelled');
    await as(api.delete(`/checkout/${first.body.id}`)).send({ revision: 1 }).expect(200);
    assert.equal(carts.get(buyer).items[p.id], 1);
});
test('reviewed price changes produce 409 without reserving anything', async () => {
    const before = await quote(buyer);
    await products.patchProduct(p.id, { price: 3 }, seller);
    await as(api.post('/checkout/reservations')).send({ quoteHash: before.quoteHash }).expect(409);
    assert.equal(await db.getRepository(StockReservation).count(), 0);
    assert.equal((await quote(buyer)).subtotalCents, 500);
});
test('stock availability is reflected in shop and cart; cancel and expiry release it', async () => {
    const first = await reserve(buyer); await reserve(other);
    assert.equal((await api.get(`/products/${p.id}`).expect(200)).body.availableStock, 0);
    const page = await api.get('/shop').expect(200);
    assert.match(page.text, /Out of stock/);
    await as(api.delete(`/checkout/${first.body.id}`)).send({ revision: 1 }).expect(200);
    assert.equal((await api.get(`/products/${p.id}`).expect(200)).body.availableStock, 1);
    const active = (await as(api.get('/checkout/data'), other).expect(200)).body.checkout;
    await db.getRepository(CheckoutSession).update(active.id, { expiresAt: Date.now() - 1 });
    const expired = await as(api.get(`/checkout/${active.id}`), other).expect(200);
    assert.equal(expired.body.status, 'expired');
    assert.equal((await api.get(`/products/${p.id}`).expect(200)).body.availableStock, 2);
});
