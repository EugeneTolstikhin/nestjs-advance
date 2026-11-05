const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const { join } = require('node:path');
const { Queue } = require('bullmq');
const { Test } = require('@nestjs/testing');
const { UserInteractionModule } = require('../dist/user-interaction/user-interaction.module');
const { OtpFactory } = require('../dist/user-interaction/configs/otp.config');
const { AuthStateStore, MemoryAuthStateStore } = require('../dist/auth/storage/auth-state.store');
const { RegistrationService } = require('../dist/auth/registration.service');
const { LoginService } = require('../dist/auth/login.service');
const { Nationality } = require('../dist/auth/auth.dto');

async function freePort() {
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
async function until(read) {
    const expiresAt = Date.now() + 10000;
    while (Date.now() < expiresAt) {
        const value = await read(); if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Mailpit integration timed out');
}

void test('registration and login OTPs travel through real BullMQ and SMTP into an isolated Mailpit inbox', async () => {
    const redis = new URL(process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379');
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(redis.hostname), 'Tests require local Redis');
    const smtpPort = await freePort(), webPort = await freePort(), popPort = await freePort();
    const directory = await mkdtemp(join(os.tmpdir(), 'nestjs-mailpit-'));
    const settings = { NODE_ENV: 'development', EMAIL_PROVIDER: 'mailpit', SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(smtpPort), SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false',
        SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: 'Nest Shop <no-reply@nest-shop.test>',
        JOBS_DRIVER: 'bullmq', JOBS_REDIS_URL: redis.href, JOBS_REDIS_PREFIX: `test-email-${randomUUID()}`,
        JWT_SECRET: 'test-only-secret-with-at-least-32-characters' };
    const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
    Object.assign(process.env, settings);
    let module, inspection;
    const mailpit = spawn(process.env.TEST_MAILPIT_BINARY || 'mailpit', [
        '--listen', `127.0.0.1:${webPort}`, '--smtp', `127.0.0.1:${smtpPort}`, '--pop3', `127.0.0.1:${popPort}`,
        '--database', join(directory, 'mailpit.sqlite'), '--disable-version-check', '--quiet',
    ], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'pipe'] });
    let startupError, output = '';
    mailpit.once('error', error => { startupError = error; });
    mailpit.stderr.on('data', chunk => { output += chunk.toString(); });
    const api = async path => {
        const response = await fetch(`http://127.0.0.1:${webPort}${path}`, { signal: AbortSignal.timeout(2000) });
        assert.equal(response.ok, true); return response.json();
    };
    try {
        await until(async () => {
            if (startupError || mailpit.exitCode !== null) throw new Error(`Cannot start isolated Mailpit: ${startupError?.message || output}`);
            try { return await api('/api/v1/messages'); } catch { return false; }
        });
        module = await Test.createTestingModule({ imports: [UserInteractionModule] })
            .overrideProvider(AuthStateStore).useClass(MemoryAuthStateStore).compile();
        await module.init();
        const factory = module.get(OtpFactory), state = module.get(AuthStateStore);
        let stored;
        const users = { contactExists: async () => false,
            insertVerified: async user => { stored = user; return user; },
            findByContact: async contact => stored?.email === contact ? stored : null,
            findById: async id => stored?._id === id ? stored : null };
        const registration = new RegistrationService(users, factory, state);
        const email = `buyer-${randomUUID()}@example.test`;
        const challenge = await registration.start({ email, password: 'Password1!', confirmPassword: 'Password1!',
            firstName: 'Email', lastName: 'Test', dob: '2000-01-01', nationality: Nationality.Germany,
            typeOfUser: 'buyer', buyerProfile: {} });
        assert.equal(stored, undefined);
        assert.equal(challenge.contacts[0].delivery, 'email');
        const first = await until(async () => {
            const inbox = await api('/api/v1/messages'); return inbox.messages?.[0];
        });
        const message = await api(`/api/v1/message/${first.ID}`);
        assert.equal(message.To[0].Address, email);
        assert.equal(message.Subject, 'Your Nest Shop verification code');
        const code = message.Text.match(/code is: (\d{6})/)?.[1];
        assert.ok(code); assert.ok(message.HTML.includes(code));
        assert.equal((await registration.verify(challenge.challengeId, 'email', code)).registered, true);
        assert.ok(stored.emailVerifiedAt);
        const login = new LoginService({ createSession: async () => ({ access_token: 'test-session' }) }, users, factory, state);
        const loginChallenge = await login.start({ channel: 'email', contact: email });
        const second = await until(async () => {
            const inbox = await api('/api/v1/messages'); return inbox.messages?.find(item => item.ID !== first.ID);
        });
        const loginMessage = await api(`/api/v1/message/${second.ID}`);
        const loginCode = loginMessage.Text.match(/code is: (\d{6})/)?.[1]; assert.ok(loginCode);
        assert.deepEqual(await login.verify(loginChallenge.challengeId, loginCode), { access_token: 'test-session' });
        await assert.rejects(login.verify(loginChallenge.challengeId, loginCode), error => error.getStatus() === 410);
        inspection = new Queue('otp-delivery', { prefix: settings.JOBS_REDIS_PREFIX,
            connection: { host: redis.hostname, port: Number(redis.port || 6379), db: Number(redis.pathname.slice(1) || 0),
                username: redis.username || undefined, password: redis.password || undefined } });
        await until(async () => await inspection.getActiveCount() === 0);
        assert.equal(await inspection.getFailedCount(), 0);
    } finally {
        await module?.close();
        if (inspection) { await inspection.obliterate({ force: true }); await inspection.close(); }
        if (mailpit.exitCode === null && !startupError) {
            const exit = once(mailpit, 'exit'); mailpit.kill('SIGTERM'); await exit;
        }
        await rm(directory, { recursive: true, force: true });
        for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
});
