import { BadRequestException, NotImplementedException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isEmail } from 'class-validator';
import nodemailer from 'nodemailer';
import type { OtpDeliveryOptions, OtpInterface } from '../interfaces/otp.interface';
import type { OtpProviderSettings } from '../configs/otp.config';

export class EmailOtpHandler implements OtpInterface {
    constructor(readonly settings: OtpProviderSettings) {}

    async sendOtp(recipient?: string, code?: string, options?: OtpDeliveryOptions): Promise<{ message: string }> {
        const smtp = this.settings.smtp;
        if (!smtp) throw new NotImplementedException('Configure SMTP email delivery in the environment');
        if (!recipient || !isEmail(recipient) || !code || !/^\d{6}$/.test(code)) {
            throw new BadRequestException('Email delivery requires a valid recipient and six-digit code');
        }
        const transport = nodemailer.createTransport({
            host: smtp.host, port: smtp.port, secure: smtp.secure, requireTLS: smtp.requireTLS,
            auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
            connectionTimeout: smtp.timeoutMs, greetingTimeout: smtp.timeoutMs,
            socketTimeout: smtp.timeoutMs, dnsTimeout: smtp.timeoutMs,
            logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
        });
        const identity = options?.idempotencyKey ? createHash('sha256').update(options.idempotencyKey).digest('hex') : undefined;
        const senderAddress = smtp.from.match(/<([^<>]+)>$/)?.[1] ?? smtp.from;
        try {
            if (options?.expiresAt && options.expiresAt <= Date.now()) return { message: 'Expired OTP skipped' };
            const result = await transport.sendMail({
                from: smtp.from, to: recipient, subject: 'Your Nest Shop verification code',
                messageId: identity ? `<otp-${identity}@${senderAddress.slice(senderAddress.lastIndexOf('@') + 1)}>` : undefined,
                text: `Your Nest Shop verification code is: ${code}\n\nUse it to complete your request before it expires. If you did not request this code, ignore this email.`,
                html: `<p>Your Nest Shop verification code is:</p><p><strong style="font-size:24px;letter-spacing:4px">${code}</strong></p><p>Use it to complete your request before it expires. If you did not request this code, ignore this email.</p>`,
            });
            if (!result.accepted.length) throw new BadRequestException('SMTP provider rejected the recipient');
            return { message: 'OTP email accepted by SMTP server' };
        } catch (error) {
            const failure = error as { code?: string; responseCode?: number };
            if (error instanceof BadRequestException || failure.code === 'EAUTH' || (failure.responseCode ?? 0) >= 500) {
                throw new BadRequestException('SMTP provider rejected email delivery. Check the sender, recipient and credentials.');
            }
            // Sanitized errors prevent SMTP credentials and destinations entering job failure logs.
            throw new ServiceUnavailableException('SMTP email delivery is temporarily unavailable');
        } finally { transport.close(); }
    }
}
