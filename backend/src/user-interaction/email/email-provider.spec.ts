import { Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { emailConfig } from '../configs/email.config';
import { EmailProviderFactory } from './email-provider';
import { EmailOtpHandler } from '../handlers/email-otp.handler';

vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));

describe('Shared email provider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it('sends PDF attachments through the same SMTP adapter with stable identifiers and closes the transport', async () => {
    const sendMail = vi
      .fn()
      .mockResolvedValue({ accepted: ['buyer@example.test'] });
    const close = vi.fn();
    vi.mocked(nodemailer.createTransport).mockReturnValue({
      sendMail,
      close,
    } as any);
    const smtp = emailConfig({ NODE_ENV: 'development' }).smtp!;
    const adapter = new EmailProviderFactory().create(smtp);
    const attachment = {
      filename: 'invoice.pdf',
      content: Buffer.from('%PDF-demo'),
      contentType: 'application/pdf',
    };
    const message = {
      id: 'confirmation-event',
      to: 'buyer@example.test',
      subject: 'Order confirmed',
      text: 'Confirmed',
      html: '<p>Confirmed</p>',
      attachments: [attachment],
    };
    await adapter.send(message);
    await adapter.send(message);
    expect(sendMail.mock.calls[0][0]).toMatchObject({
      attachments: [attachment],
      messageId: '<confirmation-event@nest-shop.invalid>',
    });
    expect(sendMail.mock.calls[1][0].messageId).toBe(
      sendMail.mock.calls[0][0].messageId,
    );
    expect(close).toHaveBeenCalledTimes(2);
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    );
  });
  it('keeps OTP content and expiry outside the provider', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const handler = new EmailOtpHandler(
      { provider: 'test', api: null },
      { send },
    );
    await handler.sendOtp('buyer@example.test', '012345', {
      idempotencyKey: 'otp-job',
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'buyer@example.test',
        subject: 'Your Nest Shop verification code',
        text: expect.stringContaining('012345'),
        id: expect.stringMatching(/^otp-[a-f0-9]{64}$/),
      }),
    );
    await handler.sendOtp('buyer@example.test', '012345', {
      expiresAt: Date.now() - 1,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('LOG delivery logs only an effect identifier, never the recipient, OTP or attachment content', async () => {
    vi.stubEnv('EMAIL_PROVIDER', 'LOG');
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    await new EmailProviderFactory()
      .create()
      .send({
        id: 'event-123',
        to: 'private@example.test',
        subject: 'Secret',
        text: '012345',
        html: '<p>012345</p>',
      });
    expect(log).toHaveBeenCalledWith(
      'Development email handled by LOG adapter: event-123',
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      'private@example.test',
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('012345');
  });
});
