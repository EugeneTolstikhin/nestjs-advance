import { BadRequestException, NotImplementedException, ServiceUnavailableException } from '@nestjs/common';
import type { OtpDeliveryOptions, OtpInterface } from '../interfaces/otp.interface';
import type { OtpProviderSettings } from '../configs/otp.config';

export class SmsOtpHandler implements OtpInterface {
    constructor(readonly settings: OtpProviderSettings) {}

    async sendOtp(recipient?: string, code?: string, options?: OtpDeliveryOptions): Promise<{ message: string }> {
        const smspit = this.settings.smspit;
        if (!smspit) throw new NotImplementedException('The selected production SMS provider adapter is not implemented');
        if (process.env.NODE_ENV === 'production') throw new BadRequestException('SMSpit is available only for development');
        if (!recipient || !/^\+[1-9]\d{1,14}$/.test(recipient) || !code || !/^\d{6}$/.test(code)) {
            throw new BadRequestException('SMS delivery requires an E.164 phone number and six-digit code');
        }
        if (options?.expiresAt && options.expiresAt <= Date.now()) return { message: 'Expired OTP skipped' };
        try {
            const response = await fetch(`${smspit.url}/api/messages`, {
                method: 'POST', headers: { 'Content-Type': 'application/json',
                    ...(smspit.apiKey ? { 'X-API-Key': smspit.apiKey } : {}) },
                body: JSON.stringify({ to: recipient, from: smspit.from, project: smspit.project,
                    message: `Your Nest Shop verification code is: ${code}` }),
                signal: AbortSignal.timeout(smspit.timeoutMs), redirect: 'error',
            });
            if (!response.ok) {
                await response.body?.cancel();
                if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
                    throw new BadRequestException('SMSpit rejected SMS delivery. Check its project and API key.');
                }
                throw new ServiceUnavailableException('SMSpit is temporarily unavailable');
            }
            const result = await response.json() as { id?: unknown };
            if (typeof result.id !== 'string' || !result.id) throw new ServiceUnavailableException('SMSpit returned an invalid response');
            return { message: 'Development SMS captured by SMSpit' };
        } catch (error) {
            if (error instanceof BadRequestException) throw error;
            // Do not persist API responses containing OTPs, phone numbers or credentials in job errors.
            throw new ServiceUnavailableException('SMSpit SMS delivery is temporarily unavailable');
        }
    }
}
