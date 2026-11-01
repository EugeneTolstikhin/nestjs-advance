import { Inject, Injectable, Optional } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OtpInterface } from '../interfaces/otp.interface';
import { LogOtpHandler } from '../handlers/log-otp.handler';
import { SmsOtpHandler } from '../handlers/sms-otp.handler';
import { EmailOtpHandler } from '../handlers/email-otp.handler';

export type OtpChannel = 'LOG' | 'phone' | 'email';

export interface OtpProviderSettings {
    provider: string;
    api: { url: string; keyEnv?: string } | null;
}

export interface OtpConfig {
    phone: OtpProviderSettings;
    email: OtpProviderSettings;
}

// Replace this provider with a database-backed implementation later.
export abstract class OtpConfigSource {
    abstract load(): Promise<OtpConfig>;
}

export const OTP_CONFIG_PATH = Symbol('OTP_CONFIG_PATH');

@Injectable()
export class JsonOtpConfigSource extends OtpConfigSource {
    constructor(
        @Optional()
        @Inject(OTP_CONFIG_PATH)
        private readonly filePath = join(__dirname, 'otp.config.json'),
    ) {
        super();
    }

    async load(): Promise<OtpConfig> {
        let contents: string;
        try {
            contents = await readFile(this.filePath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return { phone: { provider: 'LOG', api: null }, email: { provider: 'LOG', api: null } };
            }
            throw error;
        }
        let config: unknown;
        try {
            config = JSON.parse(contents);
        } catch {
            throw new Error('OTP configuration must contain valid JSON');
        }
        if (!this.isObject(config)) throw new Error('OTP configuration must be an object');
        return { phone: this.parseProvider(config.phone), email: this.parseProvider(config.email) };
    }

    private parseProvider(value: unknown): OtpProviderSettings {
        if (value === undefined || value === null) return { provider: 'LOG', api: null };
        if (!this.isObject(value)) throw new Error('OTP channel configuration must be an object');
        if (value.provider !== undefined && value.provider !== null && typeof value.provider !== 'string') {
            throw new Error('OTP provider must be a string');
        }
        const provider = typeof value.provider === 'string' ? value.provider.trim() || 'LOG' : 'LOG';
        if (value.api === undefined || value.api === null) return { provider, api: null };
        if (!this.isObject(value.api)) {
            throw new Error('OTP provider API must specify a URL');
        }
        if (value.api.url === undefined || value.api.url === null || value.api.url === '') return { provider, api: null };
        if (typeof value.api.url !== 'string') throw new Error('OTP provider API URL must be a string');
        let url: URL;
        try {
            url = new URL(value.api.url);
        } catch {
            throw new Error('OTP provider API URL is invalid');
        }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
            throw new Error('OTP provider API must use HTTP(S) without credentials in the URL');
        }
        if (value.api.keyEnv !== undefined &&
            (typeof value.api.keyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.api.keyEnv))) {
            throw new Error('OTP API keyEnv must be an environment variable name');
        }
        return { provider, api: { url: url.href, keyEnv: value.api.keyEnv as string | undefined } };
    }

    private isObject(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }
}

export abstract class OtpFactory {
    abstract create(channel?: OtpChannel): Promise<OtpInterface>;
}

@Injectable()
export class ConfiguredOtpFactory extends OtpFactory {
    constructor(private readonly source: OtpConfigSource) {
        super();
    }

    async create(channel: OtpChannel = 'LOG'): Promise<OtpInterface> {
        if (channel === 'LOG') return new LogOtpHandler();
        if (channel !== 'phone' && channel !== 'email') throw new Error('Unknown OTP channel');
        const settings = (await this.source.load())[channel];
        if (settings.provider.toUpperCase() === 'LOG' || !settings.api) return new LogOtpHandler();
        return channel === 'phone' ? new SmsOtpHandler(settings) : new EmailOtpHandler(settings);
    }
}
