const { before, beforeEach, afterEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const { join } = require('node:path');
const { MongoClient } = require('mongodb');
const { DataSource } = require('typeorm');
const { Test } = require('@nestjs/testing');
const { JwtService } = require('@nestjs/jwt');
const { getDataSourceToken } = require('@nestjs/typeorm');
const request = require('supertest');
const { AppModule } = require('../dist/app.module');
const { Products } = require('../dist/products/products.entity');
const { ProductMedia } = require('../dist/products/media/product-media.entity');
const { AuthStateStore, MemoryAuthStateStore } = require('../dist/auth/storage/auth-state.store');
const { configureViews } = require('../dist/views.config');

const uri = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(uri).hostname), 'Tests require local MongoDB');
const mongo = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
let app, api, db, database, directory, previous, jwt, buyer, otherBuyer, seller, mixed, admin, product, second;
const idA = randomUUID(), idB = randomUUID(), idS = randomUUID(), idM = randomUUID(), idAdmin = randomUUID();
const cookie = async (id, roles) => `nest_session=${await jwt.signAsync({ sub: id, roles, jti: randomUUID() })}`;
const as = (req, session = buyer) => req.set('Cookie', session);
const add = (id = product.id, session = buyer) => as(api.post(`/cart/items/${id}`), session).send({});

before(async () => { await mongo.connect(); });
beforeEach(async () => {
    const settings = { NODE_ENV: 'test', JOBS_DRIVER: 'inline', JWT_SECRET: 'test-only-secret-with-at-least-32-characters',
        MONGODB_URI: uri, MONGODB_DATABASE: `nestjs_cart_test_${randomUUID().replaceAll('-', '')}` };
    previous = Object.fromEntries([...Object.keys(settings), 'MEDIA_STORAGE_DIR'].map(key => [key, process.env[key]]));
    directory = await mkdtemp(join(os.tmpdir(), 'nestjs-cart-'));
    Object.assign(process.env, settings, { MEDIA_STORAGE_DIR: directory });
    database = mongo.db(settings.MONGODB_DATABASE);
    await database.collection('users').insertMany([
        [idA, ['buyer']], [idB, ['buyer']], [idS, ['seller']], [idM, ['buyer', 'seller']], [idAdmin, ['admin']],
    ].map(([_id, roles]) => ({ _id, roles, firstName: 'Cart', lastName: 'Test', email: `${_id}@example.test` })));
    await boot();
    buyer = await cookie(idA, ['buyer']); otherBuyer = await cookie(idB, ['buyer']); seller = await cookie(idS, ['seller']);
    mixed = await cookie(idM, ['buyer', 'seller']); admin = await cookie(idAdmin, ['admin']);
    [product, second] = await db.getRepository(Products).save([
        { name: 'Book', description: 'First product', price: 0.1 }, { name: 'Bag', description: 'Second product', price: 1.25 },
    ]);
});
async function boot() {
    const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(AuthStateStore).useFactory({ factory: () => new MemoryAuthStateStore() })
        .overrideProvider(getDataSourceToken()).useFactory({ factory: () => new DataSource({ type: 'better-sqlite3',
            database: join(directory, 'test.sqlite'), entities: [Products, ProductMedia], synchronize: true }).initialize() }).compile();
    app = module.createNestApplication({ logger: false }); await configureViews(app); await app.init();
    await app.listen(0, '127.0.0.1');
    api = request(app.getHttpServer()); db = module.get(DataSource); jwt = module.get(JwtService);
}
afterEach(async () => {
    await app?.close(); app = undefined;
    if (database?.databaseName.startsWith('nestjs_cart_test_')) await database.dropDatabase();
    await rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
});
after(async () => { await mongo.close(); });

void test('guests see an explanatory cart page and cannot read or mutate carts; buyer membership is enforced', async () => {
    const guest = await api.get('/cart').expect(200).expect('Cache-Control', 'no-store');
    assert.match(guest.text, /Guests cannot add items or view a shopping cart/);
    assert.match(guest.text, /aria-label="Shopping cart"/);
    await api.get('/cart/data').expect(401);
    await api.post(`/cart/items/${product.id}`).send({}).expect(401);
    await api.delete(`/cart/items/${product.id}`).expect(401);
    for (const session of [seller, admin]) {
        await as(api.get('/cart/data'), session).expect(403); await add(product.id, session).expect(403);
    }
    const restricted = await as(api.get('/cart'), seller).expect(200);
    assert.match(restricted.text, /A buyer profile is required/);
    const empty = await as(api.get('/cart')).expect(200);
    assert.match(empty.text, /Your shopping cart is empty/);
    await as(api.get('/cart/data'), mixed).expect(200);
    assert.equal(await database.collection('carts').countDocuments(), 0);
});

void test('independent sessions share one persisted account cart across logout and application restart', async () => {
    const deviceTwo = await cookie(idA, ['buyer']);
    assert.notEqual(deviceTwo, buyer);
    await add().expect(200); await add(product.id, deviceTwo).expect(200);
    const seen = await as(api.get('/cart/data'), deviceTwo).expect(200).expect('Cache-Control', 'no-store');
    assert.equal(seen.body.items[0].quantity, 2); assert.equal(seen.body.total, 0.2);
    assert.deepEqual((await as(api.get('/cart/data'), otherBuyer)).body.items, []);
    await as(api.post('/auth/logout')).send({}).expect(204);
    assert.equal(await database.collection('carts').countDocuments(), 1);
    await app.close(); app = undefined; await boot();
    const persisted = await as(api.get('/cart/data'), await cookie(idA, ['buyer'])).expect(200);
    assert.equal(persisted.body.items[0].quantity, 2);
    assert.deepEqual((await as(api.get('/cart/data'), otherBuyer)).body.items, []);
});

void test('simultaneous first additions and different-item changes do not lose cross-device updates', async () => {
    await Promise.all(Array.from({ length: 20 }, () => add().expect(200)));
    await Promise.all(Array.from({ length: 10 }, () => add(second.id).expect(200)));
    const cart = (await as(api.get('/cart/data')).expect(200)).body;
    assert.equal(cart.items.find(item => item.productId === product.id).quantity, 20);
    assert.equal(cart.items.find(item => item.productId === second.id).quantity, 10);
    assert.equal(cart.itemCount, 30); assert.equal(cart.total, 14.5);
    assert.equal(await database.collection('carts').countDocuments({ _id: idA }), 1);
});

void test('quantity changes remove the last unit, and removals are isolated and idempotent', async () => {
    await add().expect(200); await add(product.id, otherBuyer).expect(200);
    const increased = await as(api.patch(`/cart/items/${product.id}`)).send({ delta: 1 }).expect(200);
    assert.equal(increased.body.items[0].quantity, 2);
    await as(api.patch(`/cart/items/${product.id}`)).send({ delta: -1 }).expect(200);
    const removed = await as(api.patch(`/cart/items/${product.id}`)).send({ delta: -1 }).expect(200);
    assert.deepEqual(removed.body.items, []); assert.equal(removed.body.total, 0);
    await as(api.delete(`/cart/items/${product.id}`)).expect(200);
    assert.equal((await as(api.get('/cart/data'), otherBuyer)).body.items[0].quantity, 1);
    assert.match((await as(api.get('/cart'))).text, /Your shopping cart is empty/);
});

void test('current prices are authoritative and deleted products remain removable without charging their price', async () => {
    await add().expect(200); await add().expect(200); await add().expect(200);
    assert.equal((await as(api.get('/cart/data'))).body.total, 0.3);
    const name = '<img src=x onerror=alert(1)>';
    await db.getRepository(Products).update(product.id, { name, price: 2.35 });
    const cart = (await as(api.get('/cart/data')).expect(200)).body;
    assert.equal(cart.total, 7.05); assert.equal(cart.items[0].unitPrice, 2.35);
    const page = await as(api.get('/cart')).expect(200);
    assert.match(page.text, /&lt;img/); assert.doesNotMatch(page.text, /<img src=x/);
    await db.getRepository(Products).delete(product.id);
    const unavailable = (await as(api.get('/cart/data')).expect(200)).body;
    assert.equal(unavailable.items[0].available, false); assert.equal(unavailable.unavailableCount, 1); assert.equal(unavailable.total, 0);
    await add().expect(404);
    assert.deepEqual((await as(api.delete(`/cart/items/${product.id}`)).expect(200)).body.items, []);
});

void test('invalid IDs, deltas, spoofed owners/prices and cross-origin mutations are rejected', async () => {
    await as(api.post('/cart/items/not-a-uuid')).send({}).expect(400);
    await add(randomUUID()).expect(404);
    await as(api.post(`/cart/items/${product.id}`)).send({ userId: idB, price: 0, quantity: 99 }).expect(400);
    for (const delta of [0, 2, '1', null]) await as(api.patch(`/cart/items/${product.id}`)).send({ delta }).expect(400);
    await add().set('Origin', 'https://other.example').expect(403);
    await as(api.delete(`/cart/items/${product.id}`)).set('Origin', 'https://other.example').expect(403);
    await as(api.post(`/cart/items/${product.id}`)).type('form').send({}).expect(415);
    const expired = await jwt.signAsync({ sub: idA, roles: ['buyer'] }, { expiresIn: -1 });
    await api.get('/cart/data').set('Authorization', `Bearer ${expired}`).expect(401);
    await api.get('/cart/data').set('Authorization', `Bearer ${await jwt.signAsync({ sub: idA, roles: ['buyer'] })}`).expect(200);
    assert.equal(await database.collection('carts').countDocuments(), 0);
});

void test('quantity and distinct-product limits hold atomically under competing requests', async () => {
    await add().expect(200);
    await database.collection('carts').updateOne({ _id: idA }, { $set: { [`items.${product.id}`]: 98 } });
    const outcomes = await Promise.all([add(), add(), add()]);
    assert.deepEqual(outcomes.map(response => response.status).sort((a, b) => a - b), [200, 409, 409]);
    assert.equal((await as(api.get('/cart/data'))).body.items[0].quantity, 99);
    const items = { [product.id]: 1, ...Object.fromEntries(Array.from({ length: 99 }, () => [randomUUID(), 1])) };
    await database.collection('carts').updateOne({ _id: idA }, { $set: { items } });
    await add(second.id).expect(409); await add().expect(200);
    const bounded = (await as(api.get('/cart/data'))).body;
    assert.equal(bounded.items.length, 100); assert.equal(bounded.items.find(item => item.productId === product.id).quantity, 2);
});
