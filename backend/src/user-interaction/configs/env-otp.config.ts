import { Injectable, OnModuleInit } from '@nestjs/common';
import { JsonOtpConfigSource, OtpConfigSource, type OtpConfig } from './otp.config';
import { emailConfig } from './email.config';
import { smsConfig } from './sms.config';

/** Environment-selected local transports, with the JSON provider source retained for future SMS adapters. */
@Injectable()
export class EnvironmentOtpConfigSource extends OtpConfigSource implements OnModuleInit {
    constructor(private readonly json: JsonOtpConfigSource) { super(); }
    onModuleInit() { emailConfig(); smsConfig(); }
    async load(): Promise<OtpConfig> {
        const config = await this.json.load();
        const email = emailConfig();
        const sms = smsConfig();
        return { phone: sms.provider === 'configured' ? config.phone : { provider: sms.provider, api: null, smspit: sms.smspit },
            email: { provider: email.provider, api: null, smtp: email.smtp } };
    }
}
