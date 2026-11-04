import { NotImplementedException } from '@nestjs/common';
import type { OtpDeliveryOptions, OtpInterface } from '../interfaces/otp.interface';
import type { OtpProviderSettings } from '../configs/otp.config';

export class EmailOtpHandler implements OtpInterface {
    constructor(readonly settings: OtpProviderSettings) {}

    async sendOtp(_recipient?: string, _code?: string, _options?: OtpDeliveryOptions): Promise<{ message: string }> {
        // Reuse _code and pass _options.idempotencyKey to the provider on retries.
        throw new NotImplementedException('Email provider integration is not implemented');
    }
}
