import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type { OtpInterface } from '../interfaces/otp.interface';

export class LogOtpHandler implements OtpInterface {
    private readonly logger = new Logger(LogOtpHandler.name);

    async sendOtp(recipient?: string, code?: string): Promise<{ message: string }> {
        if (process.env.NODE_ENV === 'production') {
            throw new ServiceUnavailableException('LOG OTP delivery is available only in development');
        }
        const otp = code ?? String(randomInt(100000, 1000000));
        const destination = recipient
            ? recipient.includes('@') ? `Email (${recipient.slice(0, 1)}***${recipient.slice(recipient.indexOf('@'))})`
                : `Phone (***${recipient.slice(-2)})`
            : 'Verification';
        this.logger.log(`[DEV OTP] ${destination} code: ${otp}`);
        return { message: 'Development OTP written to the server log' };
    }
}
