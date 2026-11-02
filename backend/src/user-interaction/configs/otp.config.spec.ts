import { BadRequestException, Logger, NotImplementedException, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfiguredOtpFactory, JsonOtpConfigSource, OtpFactory } from './otp.config';
import { LogOtpHandler } from '../handlers/log-otp.handler';
import { SmsOtpHandler } from '../handlers/sms-otp.handler';
import { EmailOtpHandler } from '../handlers/email-otp.handler';
import { UserInteractionModule } from '../user-interaction.module';
import { UserInteractionService } from '../user-interaction.service';

describe('OTP configuration and factory', () => {
    let directory: string;
    let path: string;
    const originalNodeEnv = process.env.NODE_ENV;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'nestjs-otp-'));
        path = join(directory, 'config.json');
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
        await rm(directory, { recursive: true, force: true });
    });

    it('defaults missing files and omitted channels to LOG', async () => {
        const factory = new ConfiguredOtpFactory(new JsonOtpConfigSource(path));
        expect(await factory.create()).toBeInstanceOf(LogOtpHandler);
        expect(await factory.create('LOG')).toBeInstanceOf(LogOtpHandler);
        expect(await factory.create('phone')).toBeInstanceOf(LogOtpHandler);
        expect(await factory.create('email')).toBeInstanceOf(LogOtpHandler);
        await writeFile(path, JSON.stringify({ phone: { provider: 'LOG' } }));
        expect(await factory.create('email')).toBeInstanceOf(LogOtpHandler);
    });

    it('selects phone and email handlers using independent provider/API settings', async () => {
        await writeFile(path, JSON.stringify({
            phone: { provider: 'seven', api: { url: 'https://example.com/sms', keyEnv: 'SEVEN_API_KEY' } },
            email: { provider: 'brevo', api: { url: 'https://example.com/email', keyEnv: 'BREVO_API_KEY' } },
        }));
        const factory = new ConfiguredOtpFactory(new JsonOtpConfigSource(path));
        const phone = await factory.create('phone');
        const email = await factory.create('email');
        expect(phone).toBeInstanceOf(SmsOtpHandler);
        expect(email).toBeInstanceOf(EmailOtpHandler);
        expect((phone as SmsOtpHandler).settings.provider).toBe('seven');
        expect((email as EmailOtpHandler).settings.api?.keyEnv).toBe('BREVO_API_KEY');
        // These are extension points, not pretend successful provider integrations.
        await expect(phone.sendOtp('+4917612345678')).rejects.toBeInstanceOf(NotImplementedException);
        await expect(email.sendOtp('test@example.com')).rejects.toBeInstanceOf(NotImplementedException);
    });

    it('reloads configuration so provider changes do not require replacing the factory', async () => {
        const factory = new ConfiguredOtpFactory(new JsonOtpConfigSource(path));
        expect(await factory.create('phone')).toBeInstanceOf(LogOtpHandler);
        await writeFile(path, JSON.stringify({ phone: { provider: 'seven', api: { url: 'https://example.com' } } }));
        expect(await factory.create('phone')).toBeInstanceOf(SmsOtpHandler);
        expect(await factory.create()).toBeInstanceOf(LogOtpHandler);
    });

    it('falls back independently when a recipient channel has no provider or API', async () => {
        const source = new JsonOtpConfigSource(path);
        const factory = new ConfiguredOtpFactory(source);
        await writeFile(path, JSON.stringify({
            phone: { provider: 'seven', api: { url: 'https://example.com/sms' } }, email: null,
        }));
        expect(await factory.create('phone')).toBeInstanceOf(SmsOtpHandler);
        expect(await factory.create('email')).toBeInstanceOf(LogOtpHandler);
        expect(await factory.create()).toBeInstanceOf(LogOtpHandler);
        await writeFile(path, JSON.stringify({ phone: { api: { url: 'https://example.com/sms' } } }));
        expect(await factory.create('phone')).toBeInstanceOf(LogOtpHandler);
    });

    it.each([
        [undefined, 'LOG', undefined],
        [' +4917612345678 ', 'phone', '+4917612345678'],
        [' person@example.com ', 'email', 'person@example.com'],
    ])('automatically routes recipient %s to %s', async (recipient, channel, normalized) => {
        const sendOtp = vi.fn().mockResolvedValue({ message: 'test' });
        const create = vi.fn().mockResolvedValue({ sendOtp });
        const service = new UserInteractionService({ create });
        await service.sendOtp(recipient);
        expect(create).toHaveBeenCalledWith(channel);
        expect(sendOtp).toHaveBeenCalledWith(normalized);
    });

    it('rejects invalid recipients without selecting a sender', async () => {
        const create = vi.fn();
        const service = new UserInteractionService({ create });
        for (const recipient of ['', 'invalid', 'person@', '017612345678']) {
            await expect(service.sendOtp(recipient)).rejects.toBeInstanceOf(BadRequestException);
        }
        expect(create).not.toHaveBeenCalled();
    });

    it('rejects malformed config but falls back to LOG for missing provider APIs', async () => {
        const source = new JsonOtpConfigSource(path);
        await writeFile(path, '{');
        await expect(source.load()).rejects.toThrow('valid JSON');
        for (const contents of [[], { phone: 'invalid' }, { phone: { provider: 123 } },
            { phone: { provider: 'seven', api: { url: 'file:///tmp/secrets' } } }]) {
            await writeFile(path, JSON.stringify(contents));
            await expect(source.load()).rejects.toThrow();
        }
        await writeFile(path, JSON.stringify({ phone: { provider: 'seven' } }));
        expect(await new ConfiguredOtpFactory(source).create('phone')).toBeInstanceOf(LogOtpHandler);
    });

    it('logs a six-digit code in development without returning it', async () => {
        process.env.NODE_ENV = 'development';
        const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
        const result = await new LogOtpHandler().sendOtp();
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[DEV OTP\] Verification code: \d{6}$/));
        expect(result).toEqual({ message: 'Development OTP written to the server log' });
        expect(JSON.stringify(result)).not.toMatch(/\d{6}/);
    });

    it('does not expose OTPs in production logs', async () => {
        process.env.NODE_ENV = 'production';
        const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
        await expect(new LogOtpHandler().sendOtp()).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(log).not.toHaveBeenCalled();
    });

    it('delivers the exact supplied registration code instead of generating a different one', async () => {
        process.env.NODE_ENV = 'development';
        const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
        await new LogOtpHandler().sendOtp('person@example.com', '123456');
        expect(log).toHaveBeenCalledWith('[DEV OTP] Email (p***@example.com) code: 123456');
    });

    it('resolves the abstract factory through Nest and uses LOG for the existing endpoint', async () => {
        process.env.NODE_ENV = 'development';
        vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
        const moduleRef = await Test.createTestingModule({ imports: [UserInteractionModule] }).compile();
        try {
            expect(await moduleRef.get(OtpFactory).create()).toBeInstanceOf(LogOtpHandler);
            await expect(moduleRef.get(UserInteractionService).sendOtp())
                .resolves.toEqual({ message: 'Development OTP written to the server log' });
        } finally {
            await moduleRef.close();
        }
    });
});
