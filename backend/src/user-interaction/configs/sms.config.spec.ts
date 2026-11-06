import { smsConfig } from './sms.config';

describe('SMS environment configuration', () => {
    it('defaults development to SMSpit and leaves tests/production using the configured provider source', () => {
        expect(smsConfig({ NODE_ENV: 'development' })).toEqual({ provider: 'smspit', smspit: {
            url: 'http://127.0.0.1:4300', from: 'NestShop', project: 'default', apiKey: undefined, timeoutMs: 10000,
        } });
        expect(smsConfig({ NODE_ENV: 'test' })).toEqual({ provider: 'configured' });
        expect(smsConfig({ NODE_ENV: 'production' })).toEqual({ provider: 'configured' });
        expect(smsConfig({ SMS_PROVIDER: 'LOG' })).toEqual({ provider: 'LOG' });
    });
    it('supports custom paths, project, API key, sender and timeout', () => {
        expect(smsConfig({ SMSPIT_URL: 'http://localhost:4300/sms/', SMSPIT_PROJECT: 'nest-shop',
            SMSPIT_API_KEY: 'test-key', SMS_FROM: 'MyShop', SMS_TIMEOUT_MS: '1500' }).smspit)
            .toMatchObject({ url: 'http://localhost:4300/sms', project: 'nest-shop', apiKey: 'test-key', from: 'MyShop', timeoutMs: 1500 });
    });
    it.each(['smspit', 'LOG'])('rejects production %s delivery', SMS_PROVIDER => {
        expect(() => smsConfig({ NODE_ENV: 'production', SMS_PROVIDER })).toThrow('Production requires');
    });
    it.each([
        { SMS_PROVIDER: 'bad' }, { SMSPIT_URL: 'invalid' }, { SMSPIT_URL: 'file:///tmp/sms' },
        { SMSPIT_URL: 'http://user:pass@localhost:4300' }, { SMSPIT_URL: 'http://localhost:4300?token=secret' },
        { SMSPIT_URL: 'http://localhost:4300#fragment' }, { SMSPIT_PROJECT: '../other' },
        { SMS_FROM: 'a\r\nb' }, { SMSPIT_API_KEY: 'a\nb' }, { SMS_TIMEOUT_MS: 'bad' }, { SMS_TIMEOUT_MS: '0' },
    ])('rejects malformed settings %j', settings => {
        expect(() => smsConfig(settings)).toThrow();
    });
});
