const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Queue } = require('bullmq');
const { Test } = require('@nestjs/testing');
const { UserInteractionModule } = require('../dist/user-interaction/user-interaction.module');
const { OtpFactory } = require('../dist/user-interaction/configs/otp.config');
const { AuthStateStore, MemoryAuthStateStore } = require('../dist/auth/storage/auth-state.store');
const { RegistrationService } = require('../dist/auth/registration.service');
const { LoginService } = require('../dist/auth/login.service');
const { Nationality } = require('../dist/auth/auth.dto');

async function until(read) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const value = await read(); if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('SMSpit delivery timed out');
}

void test('phone registration and login deliver their OTPs through BullMQ into an isolated SMSpit project', async () => {
    const redis = new URL(process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379');
    const smspit = new URL(process.env.TEST_SMSPIT_URL || 'http://127.0.0.1:4300');
    const ui = new URL(process.env.TEST_SMSPIT_UI_URL || 'http://127.0.0.1:4301');
    for (const url of [redis, smspit, ui]) assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Tests require local services');
    const project = `test-${randomUUID()}`;
    const settings = { NODE_ENV: 'development', EMAIL_PROVIDER: 'LOG', SMS_PROVIDER: 'smspit',
        SMSPIT_URL: smspit.href, SMSPIT_PROJECT: project, SMSPIT_API_KEY: process.env.TEST_SMSPIT_API_KEY || '',
        SMS_FROM: 'NestShop', SMS_TIMEOUT_MS: '2000', JOBS_DRIVER: 'bullmq', JOBS_REDIS_URL: redis.href,
        JOBS_REDIS_PREFIX: `test-sms-${randomUUID()}`, JWT_SECRET: 'test-only-secret-with-at-least-32-characters' };
    const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
    Object.assign(process.env, settings);
    const headers = { 'Content-Type': 'application/json', ...(settings.SMSPIT_API_KEY ? { 'X-API-Key': settings.SMSPIT_API_KEY } : {}) };
    const api = (path, options = {}) => fetch(new URL(path, smspit), { ...options, headers, signal: AbortSignal.timeout(2000) });
    let module, inspection, created = false;
    try {
        const page = await fetch(ui, { signal: AbortSignal.timeout(2000) });
        assert.equal(page.ok, true); assert.match(page.headers.get('content-type'), /text\/html/);
        assert.match(await page.text(), /<script/);
        inspection = new Queue('otp-delivery', { prefix: settings.JOBS_REDIS_PREFIX,
            connection: { host: redis.hostname, port: Number(redis.port || 6379), db: Number(redis.pathname.slice(1) || 0),
                username: redis.username || undefined, password: redis.password || undefined } });
        const response = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: project }) });
        assert.equal(response.status, 201); await response.body?.cancel(); created = true;
        module = await Test.createTestingModule({ imports: [UserInteractionModule] })
            .overrideProvider(AuthStateStore).useClass(MemoryAuthStateStore).compile();
        await module.init();
        const factory = module.get(OtpFactory), state = module.get(AuthStateStore);
        let stored;
        const users = { contactExists: async () => false,
            insertVerified: async user => { stored = user; return user; },
            findByContact: async contact => stored?.phone === contact ? stored : null,
            findById: async id => stored?._id === id ? stored : null };
        const registration = new RegistrationService(users, factory, state);
        const phone = '+4917612345678';
        const challenge = await registration.start({ phone, password: 'Password1!', confirmPassword: 'Password1!',
            firstName: 'SMS', lastName: 'Test', dob: '2000-01-01', nationality: Nationality.Germany,
            typeOfUser: 'buyer', buyerProfile: {} });
        assert.equal(stored, undefined);
        assert.equal(challenge.contacts[0].delivery, 'phone');
        async function latest(to, previousId) {
            // Do not rely on "latest": the simulator's SQLite timestamps can tie within a second.
            const response = await api(`/api/messages?${new URLSearchParams({ phoneNumber: to, project })}`);
            assert.equal(response.ok, true);
            const body = await response.json();
            const messages = Array.isArray(body) ? body : body.messages ?? body.data;
            assert.ok(Array.isArray(messages), 'Expected an SMSpit message list');
            return messages.find(message => message.id !== previousId);
        }
        const first = await until(() => latest(phone));
        assert.equal(first.to, phone); assert.equal(first.from, 'NestShop'); assert.equal(first.project, project);
        const code = first.message.match(/code is: (\d{6})/)?.[1]; assert.ok(code);
        assert.ok(first.detected_otps.includes(code));
        assert.equal((await registration.verify(challenge.challengeId, 'phone', code)).registered, true);
        assert.ok(stored.phoneVerifiedAt);
        const login = new LoginService({ createSession: async () => ({ access_token: 'test-session' }) }, users, factory, state);
        const loginChallenge = await login.start({ channel: 'phone', contact: phone });
        const second = await until(() => latest(phone, first.id));
        const loginCode = second.message.match(/code is: (\d{6})/)?.[1]; assert.ok(loginCode);
        assert.deepEqual(await login.verify(loginChallenge.challengeId, loginCode), { access_token: 'test-session' });
        await assert.rejects(login.verify(loginChallenge.challengeId, loginCode), error => error.getStatus() === 410);
        const unknown = '+4917612345679';
        const fake = await login.start({ channel: 'phone', contact: unknown });
        await assert.rejects(login.verify(fake.challengeId, '123456'), error => error.getStatus() === 401);
        assert.equal(await latest(unknown), undefined);
        await until(async () => await inspection.getActiveCount() === 0);
        assert.equal(await inspection.getFailedCount(), 0);
    } finally {
        await module?.close();
        if (inspection) { await inspection.obliterate({ force: true }); await inspection.close(); }
        if (created) {
            // Delete only this run's project, never the development inbox or other projects.
            const response = await api(`/api/projects/${project}`, { method: 'DELETE' });
            assert.equal(response.ok, true); await response.body?.cancel();
        }
        for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
});
