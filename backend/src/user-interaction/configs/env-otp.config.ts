import { Injectable, OnModuleInit } from '@nestjs/common';
import { JsonOtpConfigSource, OtpConfigSource, type OtpConfig } from './otp.config';
import { emailConfig } from './email.config';

/** Phone settings remain in the dummy JSON; email transport comes from the environment. */
@Injectable()
export class EnvironmentOtpConfigSource extends OtpConfigSource implements OnModuleInit {
    constructor(private readonly json: JsonOtpConfigSource) { super(); }
    onModuleInit() { emailConfig(); }
    async load(): Promise<OtpConfig> {
        const config = await this.json.load();
        const email = emailConfig();
        return { ...config, email: { provider: email.provider, api: null, smtp: email.smtp } };
    }
}
