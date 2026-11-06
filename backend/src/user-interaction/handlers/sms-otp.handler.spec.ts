import { SmsOtpHandler } from './sms-otp.handler';
import { smsConfig } from '../configs/sms.config';

describe('SMSpit OTP delivery', () => {
    let handler: SmsOtpHandler;
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        fetchMock = vi.fn().mockImplementation(async () => Response.json({ id: 'message-id' }, { status: 201 }));
        vi.stubGlobal('fetch', fetchMock);
        handler = new SmsOtpHandler({ provider: 'smspit', api: null,
            smspit: smsConfig({ SMSPIT_API_KEY: 'test-key' }).smspit });
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
    it('captures the supplied code with its project and API key, reusing the same payload on retries', async () => {
        for (let i = 0; i < 2; i++) await expect(handler.sendOtp('+4917612345678', '123456'))
            .resolves.toEqual({ message: 'Development SMS captured by SMSpit' });
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe('http://127.0.0.1:4300/api/messages');
        expect(options.headers).toEqual({ 'Content-Type': 'application/json', 'X-API-Key': 'test-key' });
        expect(JSON.parse(options.body)).toEqual({ to: '+4917612345678', from: 'NestShop', project: 'default',
            message: 'Your Nest Shop verification code is: 123456' });
        expect(fetchMock.mock.calls[1][1].body).toBe(options.body);
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.redirect).toBe('error');
    });
    it.each([400, 401, 403, 404])('treats HTTP %s as a permanent error without exposing response data', async status => {
        fetchMock.mockImplementation(async () => Response.json({ secret: 'private-api-response' }, { status }));
        await expect(handler.sendOtp('+4917612345678', '123456')).rejects.toMatchObject({ status: 400 });
        await expect(handler.sendOtp('+4917612345678', '123456')).rejects.not.toThrow('private-api-response');
    });
    it.each([408, 429, 500, 503])('allows queue retries for HTTP %s', async status => {
        fetchMock.mockImplementation(async () => Response.json({}, { status }));
        await expect(handler.sendOtp('+4917612345678', '123456')).rejects.toMatchObject({ status: 503 });
    });
    it('retries network failures and malformed acceptance responses', async () => {
        fetchMock.mockRejectedValueOnce(new Error('secret URL'));
        await expect(handler.sendOtp('+4917612345678', '123456')).rejects.toMatchObject({ status: 503 });
        fetchMock.mockResolvedValueOnce(Response.json({}));
        await expect(handler.sendOtp('+4917612345678', '123456')).rejects.toMatchObject({ status: 503 });
    });
    it('does not send invalid, expired, or production OTPs to the simulator', async () => {
        await expect(handler.sendOtp('017612345678', '123456')).rejects.toMatchObject({ status: 400 });
        await expect(handler.sendOtp('+4917612345678', 'invalid')).rejects.toMatchObject({ status: 400 });
        await handler.sendOtp('+4917612345678', '123456', { expiresAt: Date.now() - 1 });
        vi.stubEnv('NODE_ENV', 'production');
        await expect(handler.sendOtp('+4917612345678', '123456')).rejects.toMatchObject({ status: 400 });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
