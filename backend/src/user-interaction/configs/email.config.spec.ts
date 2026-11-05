import { emailConfig } from './email.config';

describe('email environment settings', () => {
    const production = { NODE_ENV: 'production', SMTP_HOST: 'smtp.provider.test', SMTP_FROM: 'Nest Shop <no-reply@shop.test>',
        SMTP_USER: 'provider-user', SMTP_PASS: 'provider-password' };
    it('uses unauthenticated local Mailpit in development and LOG in isolated tests', () => {
        expect(emailConfig({ NODE_ENV: 'development' })).toEqual({ provider: 'mailpit', smtp: {
            host: '127.0.0.1', port: 1025, secure: false, requireTLS: false, user: undefined,
            pass: undefined, from: 'Nest Shop <no-reply@nest-shop.test>', timeoutMs: 10000,
        } });
        expect(emailConfig({ NODE_ENV: 'test' })).toEqual({ provider: 'LOG' });
        expect(emailConfig({ EMAIL_PROVIDER: 'LOG' })).toEqual({ provider: 'LOG' });
    });
    it('supports authenticated production SMTP using STARTTLS or implicit TLS', () => {
        expect(emailConfig(production).smtp).toMatchObject({ host: 'smtp.provider.test', port: 587,
            requireTLS: true, secure: false, user: 'provider-user', pass: 'provider-password' });
        expect(emailConfig({ ...production, SMTP_PORT: '465' }).smtp).toMatchObject({ secure: true, requireTLS: false });
    });
    it.each(['mailpit', 'LOG'])('blocks production %s delivery', EMAIL_PROVIDER => {
        expect(() => emailConfig({ ...production, EMAIL_PROVIDER })).toThrow('Production requires');
    });
    it.each(['SMTP_HOST', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASS'])('requires production %s', key => {
        expect(() => emailConfig({ ...production, [key]: '' })).toThrow();
    });
    it.each([
        { EMAIL_PROVIDER: 'unknown' }, { SMTP_PORT: '0' }, { SMTP_PORT: '65536' }, { SMTP_PORT: 'bad' },
        { SMTP_SECURE: 'yes' }, { SMTP_REQUIRE_TLS: 'off' }, { SMTP_USER: 'user' },
        { SMTP_FROM: 'no-reply@shop.test\r\nBcc: other@shop.test' }, { SMTP_HOST: 'smtp://host.test' },
    ])('rejects malformed configuration %j', overrides => {
        expect(() => emailConfig({ NODE_ENV: 'development', ...overrides })).toThrow();
    });
    it('requires encrypted SMTP in production', () => {
        expect(() => emailConfig({ ...production, SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false' })).toThrow('must use TLS');
    });
});
