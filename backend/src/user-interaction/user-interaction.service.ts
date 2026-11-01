import { BadRequestException, Injectable } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { OtpFactory } from './configs/otp.config';
import type { OtpChannel } from './configs/otp.config';

@Injectable()
export class UserInteractionService {
    constructor(private readonly otpFactory: OtpFactory) {}

    async sendOtp(recipient?: string) {
        let channel: OtpChannel = 'LOG';
        let normalizedRecipient: string | undefined;
        if (recipient !== undefined) {
            if (typeof recipient !== 'string') throw new BadRequestException('Recipient must be a string');
            normalizedRecipient = recipient.trim();
            if (isEmail(normalizedRecipient)) {
                channel = 'email';
            } else if (/^\+[1-9]\d{1,14}$/.test(normalizedRecipient)) {
                channel = 'phone';
            } else {
                throw new BadRequestException('Recipient must be an email address or a phone number in E.164 format');
            }
        }
        const handler = await this.otpFactory.create(channel);
        return handler.sendOtp(normalizedRecipient);
    }
}
