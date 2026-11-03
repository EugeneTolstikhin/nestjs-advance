const { ProductMedia } = require('../dist/products/media/product-media.entity');
const { ProductMediaService } = require('../dist/products/media/product-media.service');
const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHmac } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createClient } = require('redis');
const { MongoClient } = require('mongodb');
const { Test } = require('@nestjs/testing');
const { DataSource } = require('typeorm');
const { getDataSourceToken } = require('@nestjs/typeorm');
const request = require('supertest');
const { AppModule } = require('../dist/app.module');
const { Products } = require('../dist/products/products.entity');
const { OtpFactory } = require('../dist/user-interaction/configs/otp.config');
const { AuthStateStore } = require('../dist/auth/storage/auth-state.store');
const { RedisAuthStateStore } = require('../dist/auth/storage/redis-auth-state.store');
const { configureViews } = require('../dist/views.config');

const redisUrl = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379';
const mongoUrl = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
for (const url of [redisUrl, mongoUrl]) assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname), 'Local test databases only');
const prefix = `nestjs-test:${randomUUID()}:`;
const previous = { JWT_SECRET: process.env.JWT_SECRET, MONGODB_URI: process.env.MONGODB_URI, MONGODB_DATABASE: process.env.MONGODB_DATABASE };
const redis = createClient({ url: redisUrl, socket: { connectTimeout: 2000, reconnectStrategy: false } });
redis.on('error', () => {});
const mongo = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 2000 });
let apps = [], database;
const codes = new Map();
let sends = 0;
let a, b;

async function instance() {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(AuthStateStore).useFactory({ factory: () => new RedisAuthStateStore(redisUrl, prefix) })
        .overrideProvider(getDataSourceToken()).useFactory({ factory: () => new DataSource({
            type: 'better-sqlite3', database: ':memory:', entities: [Products, ProductMedia], synchronize: true,
        }).initialize() })
        .overrideProvider(OtpFactory).useValue({ create: async () => ({ sendOtp: async (recipient, code) => {
            sends++; codes.set(recipient, code); return { message: 'Test delivery' };
        } }) }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    apps.push(app);
    await configureViews(app); await app.init();
    return { app, api: request(app.getHttpServer()), store: moduleRef.get(AuthStateStore) };
}

before(async () => {
    process.env.JWT_SECRET = 'test-only-secret-with-at-least-32-characters';
    process.env.MONGODB_URI = mongoUrl;
    process.env.MONGODB_DATABASE = `nestjs_test_${randomUUID().replaceAll('-', '')}`;
    await Promise.all([redis.connect(), mongo.connect()]);
    database = mongo.db(process.env.MONGODB_DATABASE);
    a = await instance(); b = await instance();
});
after(async () => {
    for (const app of apps) await app.close();
    if (database?.databaseName.startsWith('nestjs_test_')) await database.dropDatabase();
    await mongo.close();
    if (redis.isReady) {
        const keys = [];
        for await (const batch of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) keys.push(...batch);
        if (keys.length) await redis.del(keys);
    }
    if (redis.isOpen) redis.destroy();
    for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
});

test('registration and login challenges work across independent app instances and after an app restart', async () => {
    const pending = await a.api.post('/auth/register').send({ user: {
        email: 'shared@example.com', phone: '+4917612345678', password: 'Password1!', confirmPassword: 'Password1!',
        firstName: 'Shared', lastName: 'Buyer', dob: '2000-01-01', nationality: 'Germany', typeOfUser: 'buyer',
    } }).expect(202);
    const partial = await b.api.post('/auth/register/verify').send({ challengeId: pending.body.challengeId, channel: 'email', code: codes.get('shared@example.com') }).expect(200);
    assert.equal(partial.body.registered, false);
    assert.equal(await database.collection('users').countDocuments(), 0);
    await a.app.close(); apps = apps.filter(app => app !== a.app);
    a = await instance();
    const completed = await a.api.post('/auth/register/verify').send({ challengeId: pending.body.challengeId, channel: 'phone', code: codes.get('+4917612345678') }).expect(200);
    assert.equal(completed.body.registered, true);
    const user = await database.collection('users').findOne({ email: 'shared@example.com' });
    assert.ok(user.emailVerifiedAt instanceof Date);
    assert.ok(user.phoneVerifiedAt instanceof Date);
    assert.ok(user.createdAt instanceof Date);

    const challenge = await a.api.post('/auth/login/otp').send({ channel: 'email', contact: 'shared@example.com' }).expect(202);
    const count = sends;
    await b.api.post('/auth/login/otp').send({ channel: 'email', contact: 'shared@example.com' }).expect(429);
    assert.equal(sends, count);
    await a.app.close(); apps = apps.filter(app => app !== a.app);
    a = await instance();
    const body = { challengeId: challenge.body.challengeId, code: codes.get('shared@example.com') };
    const results = await Promise.all([a.api.post('/auth/login/otp/verify').send(body), b.api.post('/auth/login/otp/verify').send(body)]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 410]);
    const session = results.find(result => result.status === 200);
    await b.api.get('/shop').set('Cookie', session.headers['set-cookie'][0].split(';')[0]).expect(200).expect(/Shared Buyer/);
});

test('wrong OTP attempts and password limits are shared across instances', async () => {
    const challenge = await a.api.post('/auth/login/otp').send({ channel: 'phone', contact: '+4917612345678' }).expect(202);
    const body = { challengeId: challenge.body.challengeId, code: '000000' };
    const attempts = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).api.post('/auth/login/otp/verify').send(body)));
    assert.equal(attempts.filter(result => result.status === 401).length, 5);
    assert.equal(attempts.filter(result => result.status === 429).length, 3);
    await b.api.post('/auth/login/otp/verify').send({ ...body, code: codes.get('+4917612345678') }).expect(429);
    for (let i = 0; i < 10; i++) await (i % 2 ? a : b).api.post('/auth/login').send({ user: { username: 'shared@example.com', password: 'wrong' } }).expect(401);
    await b.api.post('/auth/login').send({ user: { username: 'shared@example.com', password: 'Password1!' } }).expect(429);
});

test('Redis counters are atomic, TTLs expire, and key names contain no raw identifiers', async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).store.limit('parallel@example.com', 5)));
    assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 5);
    assert.equal(outcomes.filter(value => value.status === 'rejected' && value.reason.status === 429).length, 15);
    await a.store.put('short-lived', { test: true }, Date.now() + 100);
    assert.deepEqual(await b.store.get('short-lived'), { test: true });
    await delay(150);
    assert.equal(await b.store.get('short-lived'), null);
    for await (const keys of redis.scanIterator({ MATCH: `${prefix}*` })) {
        for (const key of keys) { assert.equal(key.includes('@'), false); assert.match(key.slice(prefix.length), /^[a-f0-9]{64}$/); }
    }
});

test('Redis failure rejects authentication state operations without a memory fallback', async () => {
    const unavailable = new RedisAuthStateStore('redis://127.0.0.1:1', prefix);
    try {
        await assert.rejects(unavailable.limit('outage', 5), error => error.status === 503 && !error.message.includes('127.0.0.1'));
    } finally { await unavailable.onModuleDestroy(); }
});

test('the standalone delivery demo cannot bypass shared OTP quotas', async () => {
    const contact = 'demo@example.com';
    await a.api.post('/user-interaction').send({ recipient: contact }).expect(201);
    const count = sends;
    await b.api.post('/user-interaction').send({ recipient: contact }).expect(429);
    assert.equal(sends, count);
    const exhausted = 'exhausted@example.com';
    for (let i = 0; i < 5; i++) await a.store.limit(`otp:contact:${exhausted}`, 5);
    await b.api.post('/user-interaction').send({ recipient: exhausted }).expect(429);
    assert.equal(sends, count);
    await b.api.post('/user-interaction').set('Origin', 'https://untrusted.example').send({ recipient: 'other@example.com' }).expect(403);
    await b.api.post('/user-interaction').type('form').send({ recipient: 'other@example.com' }).expect(415);
});

test('a single-role registration already pending in Redis finishes in the new account format', async () => {
    const id = 'd'.repeat(64);
    const expiresAt = Date.now() + 5 * 60000;
    await a.store.put(`registration:${id}`, {
        id, expiresAt, saving: false,
        user: { _id: 'legacy-pending', email: 'pending@example.com', passwordHash: 'already-hashed',
            firstName: 'Pending', lastName: 'Buyer', dob: '2000-01-01', nationality: 'Germany',
            typeOfUser: 'buyer', profile: { deliveryAddress: 'Saved pending address' },
            createdAt: new Date(), updatedAt: new Date() },
        contacts: { email: { recipient: 'pending@example.com', verified: false, attempts: 0,
            sending: false, lastSentAt: Date.now(), expiresAt, delivery: 'LOG',
            digest: createHmac('sha256', process.env.JWT_SECRET).update(`${id}:email:123456`).digest('hex') } },
    }, expiresAt);
    const completed = await b.api.post('/auth/register/verify').send({ challengeId: id, channel: 'email', code: '123456' }).expect(200);
    assert.deepEqual(completed.body.user.roles, ['buyer']);
    const stored = await database.collection('users').findOne({ _id: 'legacy-pending' });
    assert.deepEqual(stored.roles, ['buyer']);
    assert.deepEqual(stored.buyerProfile, { deliveryAddress: 'Saved pending address' });
    assert.equal(stored.typeOfUser, undefined);
    assert.equal(stored.profile, undefined);
});
