import { BadRequestException, NotImplementedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import hbs from 'hbs';
import { isEmail } from 'class-validator';
import type { EmailProvider } from '../email/email-provider';
import type {
  OtpDeliveryOptions,
  OtpInterface,
} from '../interfaces/otp.interface';
import type { OtpProviderSettings } from '../configs/otp.config';

// Compile once on first delivery. Handlebars escapes dynamic text by default.
let emailTemplate: ReturnType<typeof hbs.handlebars.compile> | undefined;
function renderEmail(code: string): string {
  emailTemplate ??= hbs.handlebars.compile(
    readFileSync(join(__dirname, '../../views/emails/otp.hbs'), 'utf8'),
  );
  return emailTemplate({ code });
}

export class EmailOtpHandler implements OtpInterface {
  constructor(
    readonly settings: OtpProviderSettings,
    private readonly email: EmailProvider | undefined,
  ) {}

  async sendOtp(
    recipient?: string,
    code?: string,
    options?: OtpDeliveryOptions,
  ): Promise<{ message: string }> {
    if (!this.email)
      throw new NotImplementedException(
        'Configure SMTP email delivery in the environment',
      );
    if (!recipient || !isEmail(recipient) || !code || !/^\d{6}$/.test(code)) {
      throw new BadRequestException(
        'Email delivery requires a valid recipient and six-digit code',
      );
    }
    if (options?.expiresAt && options.expiresAt <= Date.now())
      return { message: 'Expired OTP skipped' };
    const identity = options?.idempotencyKey
      ? createHash('sha256').update(options.idempotencyKey).digest('hex')
      : undefined;
    await this.email.send({
      id: identity ? `otp-${identity}` : undefined,
      to: recipient,
      subject: 'Your Nest Shop verification code',
      text: `Your Nest Shop verification code is: ${code}\n\nUse it to complete your request before it expires. If you did not request this code, ignore this email.`,
      html: renderEmail(code),
    });
    return { message: 'OTP email accepted by SMTP server' };
  }
}
