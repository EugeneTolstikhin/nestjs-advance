process.env.JOBS_DRIVER = 'inline';
process.env.JWT_SECRET = 'ownership-test-secret-at-least-32-characters';
const { before, after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
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
const { UsersRepository } = require(`${build}/auth/users.repository`);
const { AuthStateStore, MemoryAuthStateStore } = require(`${build}/auth/storage/auth-state.store`);
const { configureViews } = require(`${build}/views.config`);
let app, api, db, jwt, directory, products;
let a, b;
const sellerA = randomUUID(), sellerB = randomUUID(), buyerId = randomUUID(), adminId = randomUUID();
const accounts = [
    { _id: sellerA, firstName: 'Seller', lastName: 'A', roles: ['seller'] },
    { _id: sellerB, firstName: 'Seller', lastName: 'B', roles: ['seller'] },
    { _id: buyerId, firstName: 'Buyer', lastName: 'Test', roles: ['buyer'] },
    { _id: adminId, firstName: 'Admin', lastName: 'Test', roles: ['admin'] },
];
let cookies;
const as = (req, id = sellerA) => req.set('Cookie', cookies[id]);
before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'product-ownership-'));
    process.env.MEDIA_STORAGE_DIR = directory;
    const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(UsersRepository).useValue({ findById: async id => accounts.find(user => user._id === id) })
        .overrideProvider(AuthStateStore).useValue(new MemoryAuthStateStore())
        .overrideProvider(getDataSourceToken()).useFactory({ factory: () => new DataSource({
            type: 'better-sqlite3', database: ':memory:', entities: [Products, ProductMedia], synchronize: true,
        }).initialize() }).compile();
    app = module.createNestApplication({ logger: false });
    await configureViews(app); await app.init(); await app.listen(0, '127.0.0.1');
    api = request(app.getHttpServer()); db = module.get(DataSource); jwt = module.get(JwtService); products = module.get(ProductsService);
    cookies = Object.fromEntries(await Promise.all(accounts.map(async user => [user._id, `nest_session=${await jwt.signAsync({ sub: user._id, roles: user.roles })}`])));
});
beforeEach(async () => {
    await db.getRepository(ProductMedia).clear(); await db.getRepository(Products).clear();
    a = await products.createProduct({ name: 'Product A', description: 'From A', price: 1, stock: 5 }, sellerA);
    b = await products.createProduct({ name: 'Product B', description: 'From B', price: 2, stock: 5 }, sellerB);
});
after(async () => { await app?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
test('product reads are public and buyers can read listings from either seller', async () => {
    for (const product of [a, b]) {
        assert.equal((await api.get(`/products/${product.id}`).expect(200)).body.id, product.id);
        await as(api.get(`/products/${product.id}`), buyerId).expect(200);
    }
    await api.get('/products/not-a-uuid').expect(400);
});
test('my products uses the guarded identity for cookie and bearer requests and renders the navbar', async () => {
    assert.match((await as(api.get('/shop')).expect(200)).text, /href="\/my-shop">My products/);
    assert.doesNotMatch((await as(api.get('/shop'), buyerId).expect(200)).text, /href="\/my-shop"/);
    const mine = await as(api.get('/products/my')).expect(200);
    assert.deepEqual(mine.body.map(item => item.id), [a.id]);
    const token = await jwt.signAsync({ sub: sellerB, roles: ['seller'] });
    const other = await api.get('/products/my').set('Authorization', `Bearer ${token}`).expect(200);
    assert.deepEqual(other.body.map(item => item.id), [b.id]);
    const page = await as(api.get('/my-shop')).expect(200);
    assert.match(page.text, /Product A/); assert.doesNotMatch(page.text, /Product B/); assert.match(page.text, /Seller A/);
    const bearerPage = await api.get('/my-shop').set('Authorization', `Bearer ${token}`).expect(200);
    assert.match(bearerPage.text, /Product B/); assert.doesNotMatch(bearerPage.text, /Product A/);
    await api.get('/my-shop').expect(401); await as(api.get('/my-shop'), buyerId).expect(403);
});
test('a seller can render their editor but cannot render another seller editor', async () => {
    await as(api.get(`/shop/${a.id}/edit`)).expect(200);
    await as(api.get(`/shop/${b.id}/edit`)).expect(404);
    await as(api.get(`/shop/${a.id}/edit`), buyerId).expect(403);
});
test('creation derives ownership from authentication and rejects owner fields in the body', async () => {
    const body = { name: 'New product', description: 'Owned', price: 3, stock: 1 };
    await as(api.post('/products')).send({ ...body, sellerId: sellerB }).expect(400);
    const created = await as(api.post('/products')).send(body).expect(201);
    assert.equal(created.body.sellerId, sellerA);
    await assert.rejects(products.createProduct(body, undefined), error => error.getStatus() === 401);
});
test('a seller cannot update, replace media, restock or delete another seller product', async () => {
    await as(api.put(`/products/${b.id}`)).send({ name: 'Hijacked', description: 'No', price: 1 }).expect(404);
    await as(api.patch(`/products/${b.id}`)).send({ price: 0, mediaIds: [] }).expect(404);
    await as(api.post(`/products/${b.id}/restock`)).send({ quantity: 10 }).expect(404);
    await as(api.delete(`/products/${b.id}`)).expect(404);
    const original = await products.getProductById({ id: b.id });
    assert.equal(original.name, 'Product B'); assert.equal(original.stock, 5); assert.equal(original.price, 2);
});
test('owners can edit and restock; only administrators can delete across ownership', async () => {
    await as(api.patch(`/products/${a.id}`)).send({ price: 3 }).expect(200);
    await as(api.post(`/products/${a.id}/restock`)).send({ quantity: 2 }).expect(201);
    assert.equal((await products.getProductById({ id: a.id })).stock, 7);
    await as(api.delete(`/products/${b.id}`), buyerId).expect(403);
    await as(api.delete(`/products/${b.id}`), adminId).expect(200);
    await api.get(`/products/${b.id}`).expect(404);
    await as(api.delete(`/products/${a.id}`)).expect(200);
});
test('legacy unassigned products cannot be claimed by editing; admins can remove them', async () => {
    const old = await db.getRepository(Products).save({ name: 'Legacy product', description: 'Unassigned', price: 1, stock: 0, sellerId: null });
    await as(api.get(`/shop/${old.id}/edit`)).expect(404);
    await as(api.patch(`/products/${old.id}`)).send({ price: 2 }).expect(404);
    await as(api.delete(`/products/${old.id}`)).expect(404);
    await as(api.delete(`/products/${old.id}`), adminId).expect(200);
});
