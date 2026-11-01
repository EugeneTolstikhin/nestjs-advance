import { NotImplementedException } from '@nestjs/common';
import type { OtpInterface } from '../interfaces/otp.interface';
import type { OtpProviderSettings } from '../configs/otp.config';

export class SmsOtpHandler implements OtpInterface {
    constructor(readonly settings: OtpProviderSettings) {}

    async sendOtp(_recipient?: string): Promise<{ message: string }> {
        // Add the selected provider's adapter here; APIs have different payloads/auth.
        throw new NotImplementedException('SMS provider integration is not implemented');
    }
}
