import { MemoryAuthStateStore } from './storage/auth-state.store';
import 'reflect-metadata';
import { LoginService } from './login.service';
import { AuthService } from './auth.service';
import { UsersRepository } from './users.repository';
import { OtpFactory } from '../user-interaction/configs/otp.config';

describe('LoginService', () => {
    const originalSecret = process.env.JWT_SECRET;
    let service: LoginService;
    let user: Record<string, unknown>;
    let users: { findByContact: ReturnType<typeof vi.fn>; findById: ReturnType<typeof vi.fn> };
    let auth: { createSession: ReturnType<typeof vi.fn>; login: ReturnType<typeof vi.fn> };
    let send: ReturnType<typeof vi.fn>;
    let code: string;
    beforeEach(() => {
        process.env.JWT_SECRET = 'test-only-secret-with-at-least-32-characters';
        user = { _id: 'user-1', email: 'buyer@example.com', phone: '+4917612345678',
            emailVerifiedAt: new Date(), phoneVerifiedAt: new Date() };
        users = { findByContact: vi.fn().mockImplementation(async () => user), findById: vi.fn().mockImplementation(async () => user) };
        auth = { createSession: vi.fn().mockResolvedValue({ access_token: 'session' }), login: vi.fn().mockResolvedValue({ access_token: 'password-session' }) };
        send = vi.fn().mockImplementation(async (_contact: string, value: string) => { code = value; });
        service = new LoginService(auth as unknown as AuthService, users as unknown as UsersRepository,
            { create: vi.fn().mockResolvedValue({ sendOtp: send }) } as unknown as OtpFactory, new MemoryAuthStateStore());
    });
    afterEach(() => {
        vi.useRealTimers();
        if (originalSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = originalSecret;
    });

    it.each(['email', 'phone'] as const)('logs in using a verified %s code only once', async channel => {
        const contact = user[channel] as string;
        const pending = await service.start({ channel, contact });
        expect(send).toHaveBeenCalledWith(contact, expect.stringMatching(/^\d{6}$/));
        expect(JSON.stringify(pending)).not.toContain(code);
        expect(auth.createSession).not.toHaveBeenCalled();
        expect(await service.verify(pending.challengeId, code)).toEqual({ access_token: 'session' });
        await expect(service.verify(pending.challengeId, code)).rejects.toMatchObject({ status: 410 });
        expect(auth.createSession).toHaveBeenCalledTimes(1);
    });

    it('does not disclose or authenticate unknown or unverified contacts', async () => {
        users.findByContact.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...user, emailVerifiedAt: undefined });
        for (const contact of ['missing@example.com', 'buyer@example.com']) {
            const challenge = await service.start({ channel: 'email', contact });
            expect(challenge.message).toContain('If this contact');
            await expect(service.verify(challenge.challengeId, '123456')).rejects.toMatchObject({ status: 401 });
        }
        expect(send).not.toHaveBeenCalled();
        expect(auth.createSession).not.toHaveBeenCalled();
    });

    it('expires codes and limits incorrect guesses to five attempts', async () => {
        const challenge = await service.start({ channel: 'email', contact: 'buyer@example.com' });
        for (let i = 0; i < 5; i++) await expect(service.verify(challenge.challengeId, '000000')).rejects.toMatchObject({ status: 401 });
        await expect(service.verify(challenge.challengeId, code)).rejects.toMatchObject({ status: 429 });
        vi.useFakeTimers(); vi.setSystemTime(Date.now() + 5 * 60_000);
        await expect(service.verify(challenge.challengeId, code)).rejects.toMatchObject({ status: 410 });
    });

    it('enforces cooldown and replaces previous challenges when resending', async () => {
        const dto = { channel: 'email' as const, contact: 'buyer@example.com' };
        const first = await service.start(dto);
        const oldCode = code;
        await expect(service.start(dto)).rejects.toMatchObject({ status: 429 });
        vi.useFakeTimers(); vi.setSystemTime(Date.now() + 60_001);
        const second = await service.start(dto);
        await expect(service.verify(first.challengeId, oldCode)).rejects.toMatchObject({ status: 410 });
        await expect(service.verify(second.challengeId, code)).resolves.toEqual({ access_token: 'session' });
    });

    it('does not spend the contact quota on retries during cooldown and reports the wait time', async () => {
        vi.useFakeTimers();
        const dto = { channel: 'email' as const, contact: 'buyer@example.com' };
        await service.start(dto);
        for (let i = 0; i < 4; i++) {
            await expect(service.start(dto)).rejects.toMatchObject({ status: 429,
                response: expect.objectContaining({ retryAfterSeconds: 60, retryAt: expect.any(String) }) });
        }
        vi.setSystemTime(Date.now() + 60001);
        await expect(service.start(dto)).resolves.toHaveProperty('challengeId');
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('prevents concurrent reuse and checks that the contact still belongs to the user', async () => {
        const pending = await service.start({ channel: 'phone', contact: '+4917612345678' });
        const results = await Promise.allSettled([service.verify(pending.challengeId, code), service.verify(pending.challengeId, code)]);
        expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
        expect(auth.createSession).toHaveBeenCalledTimes(1);
        const next = await service.start({ channel: 'email', contact: 'buyer@example.com' });
        user.emailVerifiedAt = undefined;
        await expect(service.verify(next.challengeId, code)).rejects.toMatchObject({ status: 401 });
    });

    it('limits password attempts and validates channel-specific contact formats', async () => {
        const dto = { username: 'buyer@example.com', password: 'wrong' };
        for (let i = 0; i < 10; i++) await service.password(dto);
        await expect(service.password(dto)).rejects.toMatchObject({ status: 429 });
        await expect(service.start({ channel: 'phone', contact: 'buyer@example.com' })).rejects.toMatchObject({ status: 400 });
        await expect(service.start({ channel: 'email', contact: '+4917612345678' })).rejects.toMatchObject({ status: 400 });
    });
});
