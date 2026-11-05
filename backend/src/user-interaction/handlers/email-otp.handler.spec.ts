import nodemailer from 'nodemailer';
import { EmailOtpHandler } from './email-otp.handler';
import { emailConfig } from '../configs/email.config';

vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));

describe('SMTP OTP delivery', () => {
    let sendMail: ReturnType<typeof vi.fn>;
    let close: ReturnType<typeof vi.fn>;
    let handler: EmailOtpHandler;
    beforeEach(() => {
        sendMail = vi.fn().mockResolvedValue({ accepted: ['person@example.test'] }); close = vi.fn();
        vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail, close } as any);
        const config = emailConfig({ NODE_ENV: 'development' });
        handler = new EmailOtpHandler({ provider: config.provider, smtp: config.smtp, api: null });
    });
    afterEach(() => { vi.clearAllMocks(); });
    it('sends the supplied code as text and HTML with stable retry Message-ID and bounded timeouts', async () => {
        for (let i = 0; i < 2; i++) {
            const result = await handler.sendOtp('person@example.test', '123456', { idempotencyKey: 'same-job' });
            expect(result.message).not.toContain('123456');
        }
        const [first] = sendMail.mock.calls[0]; const [second] = sendMail.mock.calls[1];
        expect(first).toMatchObject({ to: 'person@example.test', subject: 'Your Nest Shop verification code' });
        expect(first.text).toContain('123456'); expect(first.html).toContain('123456');
        expect(first.messageId).toEqual(second.messageId);
        expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({
            host: '127.0.0.1', port: 1025, auth: undefined, socketTimeout: 10000, logger: false, debug: false,
        }));
        expect(close).toHaveBeenCalledTimes(2);
    });
    it.each([{ code: 'EAUTH' }, { responseCode: 550 }])('treats permanent SMTP rejections as nonretryable without exposing provider data', async details => {
        sendMail.mockRejectedValue(Object.assign(new Error('private credentials and recipient'), details));
        await expect(handler.sendOtp('person@example.test', '123456')).rejects.toMatchObject({ status: 400 });
        await expect(handler.sendOtp('person@example.test', '123456')).rejects.not.toThrow('private credentials');
        expect(close).toHaveBeenCalled();
    });
    it.each([{ code: 'ECONNREFUSED' }, { responseCode: 451 }])('allows queue retries for temporary SMTP failures', async details => {
        sendMail.mockRejectedValue(Object.assign(new Error('temporary'), details));
        await expect(handler.sendOtp('person@example.test', '123456')).rejects.toMatchObject({ status: 503 });
        expect(close).toHaveBeenCalled();
    });
    it('rejects invalid input and skips expired codes', async () => {
        await expect(handler.sendOtp('invalid', '123456')).rejects.toMatchObject({ status: 400 });
        await expect(handler.sendOtp('person@example.test', '<bad>')).rejects.toMatchObject({ status: 400 });
        await handler.sendOtp('person@example.test', '123456', { expiresAt: Date.now() - 1 });
        expect(sendMail).not.toHaveBeenCalled();
    });
});
