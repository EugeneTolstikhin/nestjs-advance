import { NotImplementedException } from '@nestjs/common';
import type { OtpInterface } from '../interfaces/otp.interface';
import type { OtpProviderSettings } from '../configs/otp.config';

export class EmailOtpHandler implements OtpInterface {
    constructor(readonly settings: OtpProviderSettings) {}

    async sendOtp(_recipient?: string): Promise<{ message: string }> {
        throw new NotImplementedException('Email provider integration is not implemented');
    }
}
