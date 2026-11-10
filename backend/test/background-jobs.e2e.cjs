const { CheckoutSession, StockReservation } = require(`${process.env.TEST_BUILD_DIR || '../dist'}/checkout/checkout-session.entity`);
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Queue } = require('bullmq');
const { BullJobQueue } = require('../dist/jobs/job-queue');
const { QueuedOtpFactory } = require('../dist/user-interaction/queued-otp.factory');
const { AuthStateStore, MemoryAuthStateStore } = require('../dist/auth/storage/auth-state.store');
const { Test } = require('@nestjs/testing');
const { DataSource } = require('typeorm');
const { getDataSourceToken } = require('@nestjs/typeorm');
const { JwtService } = require('@nestjs/jwt');
const request = require('supertest');
const sharp = require('sharp');
const { AppModule } = require('../dist/app.module');
const { ProductMedia } = require('../dist/products/media/product-media.entity');
const { Products } = require('../dist/products/products.entity');

let jobs, queues, app, directory, previous;
const redisUrl = new URL(process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(redisUrl.hostname), 'Tests require local Redis');
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379),
    db: Number(redisUrl.pathname.slice(1) || 0), password: redisUrl.password || undefined };
async function until(check) {
    const end = Date.now() + 8000;
    while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Background job timed out');
}
function queue(name) {
    const instance = new Queue(name, { connection, prefix: process.env.JOBS_REDIS_PREFIX });
    queues.push(instance); return instance;
}
beforeEach(async () => {
    const keys = ['JOBS_DRIVER', 'JOBS_REDIS_URL', 'JOBS_REDIS_PREFIX', 'JWT_SECRET', 'MEDIA_STORAGE_DIR'];
    previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    directory = await mkdtemp(join(tmpdir(), 'nestjs-jobs-'));
    Object.assign(process.env, { JOBS_DRIVER: 'bullmq', JOBS_REDIS_URL: redisUrl.href,
        JOBS_REDIS_PREFIX: `test-jobs-${randomUUID()}`, JWT_SECRET: 'test-only-secret-with-at-least-32-characters', MEDIA_STORAGE_DIR: directory });
    queues = []; jobs = new BullJobQueue();
});
afterEach(async () => {
    await app?.close(); app = undefined;
    await jobs.onModuleDestroy();
    for (const q of queues) { await q.obliterate({ force: true }); await q.close(); }
    await rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
});

void test('unavailable Redis fails startup and enqueue promptly without a synchronous fallback', async () => {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    process.env.JOBS_REDIS_URL = `redis://127.0.0.1:${port}`;
    const started = Date.now();
    await assert.rejects(jobs.register('media-processing', async () => {}), error => error.getStatus() === 503);
    assert.ok(Date.now() - started < 6500);
    await assert.rejects(jobs.add('media-processing', { id: randomUUID() }, randomUUID()), error => error.getStatus() === 503);
});

void test('OTP jobs survive worker restart, encrypt destinations/codes, and retry the same delivery identity', async () => {
    const q = queue('otp-delivery'); await q.pause();
    const state = new MemoryAuthStateStore();
    const calls = [];
    const direct = { create: async () => ({ sendOtp: async (...args) => {
        calls.push(args); if (calls.length === 1) throw new Error('Temporary provider failure');
    } }) };
    let factory = new QueuedOtpFactory(direct, jobs, state);
    await factory.onModuleInit();
    await state.put('registration:test', { contacts: { email: { digest: 'digest', verified: false, attempts: 0 } } }, Date.now() + 60000);
    await (await factory.create('email')).sendOtp('person@example.com', '123456', {
        expiresAt: Date.now() + 60000, validity: { key: 'registration:test', channel: 'email', digest: 'digest' } });
    const waiting = await q.getJobs(['paused', 'waiting']);
    assert.equal(waiting.length, 1);
    assert.doesNotMatch(JSON.stringify(waiting[0].data), /person@example|123456|digest/);
    assert.equal(calls.length, 0);
    await jobs.onModuleDestroy();
    jobs = new BullJobQueue(); factory = new QueuedOtpFactory(direct, jobs, state);
    await factory.onModuleInit(); await q.resume();
    await until(async () => calls.length === 2 && await q.getActiveCount() === 0);
    assert.equal(calls[0][0], 'person@example.com'); assert.equal(calls[0][1], '123456');
    assert.deepEqual(calls[0], calls[1]);
    assert.ok(calls[0][2].idempotencyKey);
});

void test('expired, replaced and consumed OTP challenges are skipped without contacting the provider', async () => {
    const q = queue('otp-delivery'); await q.pause();
    const state = new MemoryAuthStateStore(); let calls = 0;
    const factory = new QueuedOtpFactory({ create: async () => ({ sendOtp: async () => { calls++; } }) }, jobs, state);
    await factory.onModuleInit(); const sender = await factory.create('phone');
    await sender.sendOtp('+4917612345678', '123456', { expiresAt: Date.now() - 1 });
    await sender.sendOtp('+4917612345678', '123456', { expiresAt: Date.now() + 60000, validity: { key: 'missing', digest: 'old' } });
    await state.put('challenge', { digest: 'new', attempts: 0 }, Date.now() + 60000);
    await sender.sendOtp('+4917612345678', '123456', { expiresAt: Date.now() + 60000, validity: { key: 'challenge', digest: 'old' } });
    await state.put('login', { digest: 'same', attempts: 0 }, Date.now() + 60000);
    await state.put('current', 'new-id', Date.now() + 60000);
    await sender.sendOtp('+4917612345678', '123456', { expiresAt: Date.now() + 60000,
        validity: { key: 'login', digest: 'same', currentKey: 'current', challengeId: 'old-id' } });
    await q.resume();
    await until(async () => await q.getWaitingCount() === 0 && await q.getActiveCount() === 0);
    assert.equal(calls, 0);
});

void test('media upload completes before processing, stays private, recovers after restart, and publishes only ready files', async () => {
    const q = queue('media-processing'); await q.pause();
    const otp = queue('otp-delivery');
    async function boot() {
        const module = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(AuthStateStore).useFactory({ factory: () => new MemoryAuthStateStore() })
            .overrideProvider(getDataSourceToken()).useFactory({ factory: () => new DataSource({
                type: 'better-sqlite3', database: join(directory, 'test.sqlite'), entities: [Products, ProductMedia, CheckoutSession, StockReservation], synchronize: true }).initialize() }).compile();
        app = module.createNestApplication({ logger: false }); await app.init();
        return { api: request(app.getHttpServer()), token: await module.get(JwtService).signAsync({ sub: 'seller', roles: ['seller'] }) };
    }
    let { api, token } = await boot();
    const auth = req => req.set('Authorization', `Bearer ${token}`);
    const image = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#526b44' } }).png().toBuffer();
    async function upload(bytes, name) {
        const id = (await auth(api.post('/media/tickets')).send({ name, type: 'image/png', size: bytes.length }).expect(201)).body.id;
        await auth(api.post('/media/uploads')).set('Tus-Resumable', '1.0.0').set('Upload-Length', String(bytes.length))
            .set('Upload-Metadata', `ticket ${Buffer.from(id).toString('base64')}`).expect(201);
        await auth(api.patch(`/media/uploads/${id}`)).set('Tus-Resumable', '1.0.0').set('Upload-Offset', '0')
            .set('Content-Type', 'application/offset+octet-stream').send(bytes).expect(204);
        return id;
    }
    const id = await upload(image, 'photo.png');
    assert.equal((await auth(api.get(`/media/tickets/${id}`))).body.status, 'processing');
    await api.get(`/media/files/${id}`).expect(404);
    await auth(api.post('/products')).send({ name: 'Not ready', description: 'Test', price: 1, mediaIds: [id] }).expect(403);
    const removed = await upload(image, 'removed.png');
    await auth(api.delete(`/media/tickets/${removed}`)).expect(204);
    await app.close(); app = undefined;
    // Simulate a crash/lost enqueue: SQLite still records a complete processing upload.
    await (await q.getJob(`media-${id}`)).remove();
    ({ api, token } = await boot());
    await q.resume();
    await until(async () => (await auth(api.get(`/media/tickets/${id}`))).body.status === 'ready');
    await auth(api.get(`/media/files/${id}`)).expect(200).expect('Content-Type', /image\/webp/);
    await api.get(`/media/files/${id}`).expect(404);
    await auth(api.post('/products')).send({ name: 'Ready', description: 'Test', price: 1, mediaIds: [id] }).expect(201);
    await api.get(`/media/files/${id}`).expect(200);
    await api.get(`/media/files/${removed}`).expect(404);
    // Invalid bytes are accepted by tus, then rejected asynchronously by the worker.
    const bad = await upload(Buffer.from('this is not a PNG'), 'invalid.png');
    await until(async () => (await auth(api.get(`/media/tickets/${bad}`))).body.status === 'failed');
    await api.get(`/media/files/${bad}`).expect(404);
    const failed = await q.getJobs(['failed']); assert.equal(failed.length, 1);
    assert.equal(failed[0].attemptsMade, 1);
    assert.equal(await otp.getFailedCount(), 0);
});
