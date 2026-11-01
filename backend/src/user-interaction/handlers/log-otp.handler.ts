import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type { OtpInterface } from '../interfaces/otp.interface';

export class LogOtpHandler implements OtpInterface {
    private readonly logger = new Logger(LogOtpHandler.name);

    async sendOtp(_recipient?: string): Promise<{ message: string }> {
        if (process.env.NODE_ENV === 'production') {
            throw new ServiceUnavailableException('LOG OTP delivery is available only in development');
        }
        const otp = randomInt(100000, 1000000);
        this.logger.log(`[DEV OTP] Verification code: ${otp}`);
        return { message: 'Development OTP written to the server log' };
    }
}
