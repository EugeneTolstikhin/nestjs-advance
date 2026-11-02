import { MemoryAuthStateStore } from './storage/auth-state.store';
import { ConflictException, ValidationPipe } from '@nestjs/common';
import { RegistrationService } from './registration.service';
import { UsersRepository } from './users.repository';
import { OtpFactory } from '../user-interaction/configs/otp.config';
import { Nationality, RegisterDto, TypeOfUser } from './auth.dto';

describe('RegistrationService', () => {
    const originalSecret = process.env.JWT_SECRET;
    let codes: Map<string, string>;
    let users: { contactExists: ReturnType<typeof vi.fn>; insertVerified: ReturnType<typeof vi.fn> };
    let service: RegistrationService;
    const buyer = (): RegisterDto => ({
        email: 'buyer@example.com', password: 'Password1!', confirmPassword: 'Password1!',
        firstName: 'Buyer', lastName: 'Test', dob: '2000-01-01',
        nationality: Nationality.Germany, typeOfUser: TypeOfUser.Buyer,
        buyerProfile: { deliveryAddress: 'Test address' },
    });
    const statusCode = (status: number) => expect.objectContaining({ status });

    beforeEach(() => {
        process.env.JWT_SECRET = 'test-only-secret-with-at-least-32-characters';
        codes = new Map();
        users = { contactExists: vi.fn().mockResolvedValue(false), insertVerified: vi.fn().mockImplementation(async user => user) };
        const factory = { create: vi.fn().mockResolvedValue({
            sendOtp: vi.fn().mockImplementation(async (recipient: string, code: string) => {
                codes.set(recipient, code); return { message: 'Test delivery' };
            }),
        }) };
        service = new RegistrationService(users as unknown as UsersRepository, factory as OtpFactory, new MemoryAuthStateStore());
    });

    afterEach(() => {
        vi.useRealTimers();
        if (originalSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = originalSecret;
    });

    it('does not save a user until the emailed code is verified and never stores plaintext passwords', async () => {
        const challenge = await service.start(buyer());
        expect(users.insertVerified).not.toHaveBeenCalled();
        expect(JSON.stringify(challenge)).not.toContain(codes.get('buyer@example.com'));
        const result = await service.verify(challenge.challengeId, 'email', codes.get('buyer@example.com')!);
        expect(result.registered).toBe(true);
        expect(users.insertVerified).toHaveBeenCalledTimes(1);
        const saved = users.insertVerified.mock.calls[0][0];
        expect(saved).toMatchObject({ email: 'buyer@example.com', emailVerifiedAt: expect.any(Date), profile: buyer().buyerProfile });
        expect(saved.passwordHash).toMatch(/^\$2/);
        expect(saved.password).toBeUndefined();
        expect(saved.confirmPassword).toBeUndefined();
        await expect(service.verify(challenge.challengeId, 'email', codes.get('buyer@example.com')!)).rejects.toMatchObject(statusCode(410));
    });

    it('requires both supplied contacts, with independent codes, before saving', async () => {
        const challenge = await service.start({ ...buyer(), phone: '+4917612345678' });
        const partial = await service.verify(challenge.challengeId, 'email', codes.get('buyer@example.com')!);
        expect(partial.registered).toBe(false);
        expect(users.insertVerified).not.toHaveBeenCalled();
        await service.verify(challenge.challengeId, 'phone', codes.get('+4917612345678')!);
        expect(users.insertVerified.mock.calls[0][0]).toMatchObject({
            emailVerifiedAt: expect.any(Date), phoneVerifiedAt: expect.any(Date),
        });
    });

    it('supports phone-only sellers and stores only the selected profile', async () => {
        const input = { ...buyer(), email: undefined, phone: '+4917612345678',
            typeOfUser: TypeOfUser.Seller as const, buyerProfile: undefined,
            sellerProfile: { companyName: 'Test shop', vatNumber: 'TEST-123' } };
        const challenge = await service.start(input);
        expect(challenge.contacts.map(contact => contact.channel)).toEqual(['phone']);
        await service.verify(challenge.challengeId, 'phone', codes.get(input.phone)!);
        expect(users.insertVerified.mock.calls[0][0]).toMatchObject({ profile: input.sellerProfile });
        expect(users.insertVerified.mock.calls[0][0].email).toBeUndefined();
    });

    it('rejects missing contacts, mismatched passwords, admin roles and cross-role profiles', async () => {
        await expect(service.start({ ...buyer(), email: undefined })).rejects.toMatchObject(statusCode(400));
        await expect(service.start({ ...buyer(), confirmPassword: 'Different1!' })).rejects.toMatchObject(statusCode(400));
        await expect(service.start({ ...buyer(), typeOfUser: TypeOfUser.Admin } as unknown as RegisterDto)).rejects.toMatchObject(statusCode(400));
        await expect(service.start({ ...buyer(), sellerProfile: { companyName: 'Not allowed' } })).rejects.toMatchObject(statusCode(400));
        expect(users.insertVerified).not.toHaveBeenCalled();
    });

    it('limits failed verification attempts even if the correct code is later supplied', async () => {
        const challenge = await service.start(buyer());
        for (let i = 0; i < 5; i++) {
            await expect(service.verify(challenge.challengeId, 'email', '000000')).rejects.toMatchObject(statusCode(401));
        }
        await expect(service.verify(challenge.challengeId, 'email', codes.get('buyer@example.com')!)).rejects.toMatchObject(statusCode(429));
        expect(users.insertVerified).not.toHaveBeenCalled();
    });

    it('enforces resend cooldowns, invalidates old codes and expires pending registration', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const challenge = await service.start(buyer());
        const old = codes.get('buyer@example.com')!;
        await expect(service.resend(challenge.challengeId, 'email')).rejects.toMatchObject(statusCode(429));
        vi.setSystemTime(Date.now() + 61_000);
        await service.resend(challenge.challengeId, 'email');
        expect(codes.get('buyer@example.com')).not.toBe(old);
        await expect(service.verify(challenge.challengeId, 'email', old)).rejects.toMatchObject(statusCode(401));
        vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
        await expect(service.verify(challenge.challengeId, 'email', codes.get('buyer@example.com')!)).rejects.toMatchObject(statusCode(410));
        await service.resend(challenge.challengeId, 'email');
        vi.setSystemTime(Date.now() + 10 * 60_000);
        await expect(service.verify(challenge.challengeId, 'email', codes.get('buyer@example.com')!)).rejects.toMatchObject(statusCode(410));
    });

    it('does not allow a phone code to verify an email contact from another challenge', async () => {
        const challenge = await service.start(buyer());
        await expect(service.verify(challenge.challengeId, 'phone', '123456')).rejects.toMatchObject(statusCode(400));
        const second = await service.start({ ...buyer(), email: 'other@example.com' });
        await expect(service.verify(second.challengeId, 'email', codes.get('buyer@example.com')!)).rejects.toMatchObject(statusCode(401));
    });

    it('consumes duplicate registrations after the database enforces uniqueness', async () => {
        const challenge = await service.start(buyer());
        users.insertVerified.mockRejectedValue(new ConflictException('Already registered'));
        await expect(service.verify(challenge.challengeId, 'email', codes.get('buyer@example.com')!)).rejects.toMatchObject(statusCode(409));
        await expect(service.verify(challenge.challengeId, 'email', codes.get('buyer@example.com')!)).rejects.toMatchObject(statusCode(410));
    });

    it('serializes simultaneous completion requests so a challenge inserts only once', async () => {
        const challenge = await service.start(buyer());
        let release!: () => void;
        users.insertVerified.mockImplementationOnce(user => new Promise(resolve => {
            release = () => resolve(user);
        }));
        const first = service.verify(challenge.challengeId, 'email', codes.get('buyer@example.com')!);
        await expect(service.verify(challenge.challengeId, 'email', codes.get('buyer@example.com')!))
            .rejects.toMatchObject(statusCode(409));
        release();
        expect((await first).registered).toBe(true);
        expect(users.insertVerified).toHaveBeenCalledTimes(1);
    });

    it('validates nested profiles and rejects privilege fields in registration requests', async () => {
        const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true });
        await expect(pipe.transform(buyer(), { type: 'body', metatype: RegisterDto })).resolves.toMatchObject({ email: buyer().email });
        for (const body of [
            { ...buyer(), typeOfUser: 'admin' }, { ...buyer(), emailVerifiedAt: new Date() },
            { ...buyer(), buyerProfile: { permissions: ['admin'] } },
        ]) {
            await expect(pipe.transform(body, { type: 'body', metatype: RegisterDto })).rejects.toMatchObject(statusCode(400));
        }
    });
});
