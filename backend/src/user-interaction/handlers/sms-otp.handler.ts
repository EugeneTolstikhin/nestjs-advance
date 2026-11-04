import { NotImplementedException } from '@nestjs/common';
import type { OtpDeliveryOptions, OtpInterface } from '../interfaces/otp.interface';
import type { OtpProviderSettings } from '../configs/otp.config';

export class SmsOtpHandler implements OtpInterface {
    constructor(readonly settings: OtpProviderSettings) {}

    async sendOtp(_recipient?: string, _code?: string, _options?: OtpDeliveryOptions): Promise<{ message: string }> {
        // Add the selected provider's adapter here; APIs have different payloads/auth.
        // Reuse _code and pass _options.idempotencyKey to the provider on retries.
        throw new NotImplementedException('SMS provider integration is not implemented');
    }
}
