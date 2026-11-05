import { Injectable, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { JobQueue, PermanentJobError, type JobContext } from '../jobs/job-queue';
import { AuthStateStore } from '../auth/storage/auth-state.store';
import { ConfiguredOtpFactory, OtpFactory, type OtpChannel } from './configs/otp.config';
import { LogOtpHandler } from './handlers/log-otp.handler';
import type { OtpDeliveryOptions, OtpInterface } from './interfaces/otp.interface';

interface OtpJob { channel: OtpChannel; recipient?: string; code: string; expiresAt: number; validity?: OtpDeliveryOptions['validity'] }

@Injectable()
export class QueuedOtpFactory extends OtpFactory implements OnModuleInit {
    constructor(private readonly direct: ConfiguredOtpFactory, private readonly jobs: JobQueue,
        private readonly state: AuthStateStore) { super(); }
    async onModuleInit() {
        await this.jobs.register('otp-delivery', (data, context) => this.deliver(data, context));
    }
    async create(channel: OtpChannel = 'LOG'): Promise<OtpInterface> {
        const sender = await this.direct.create(channel);
        const delivery = sender instanceof LogOtpHandler ? 'LOG' : channel;
        if (delivery === 'LOG' && process.env.NODE_ENV === 'production') {
            throw new ServiceUnavailableException('Configure an OTP provider for production');
        }
        return { delivery, sendOtp: async (recipient, suppliedCode, options) => {
            const code = suppliedCode ?? String(randomInt(100000, 1000000));
            const payload: OtpJob = { channel, recipient, code,
                expiresAt: options?.expiresAt ?? Date.now() + 5 * 60_000, validity: options?.validity };
            await this.jobs.add('otp-delivery', { encrypted: this.encrypt(payload) }, randomUUID());
            return { message: 'OTP delivery queued' };
        } };
    }
    private key() {
        const secret = process.env.JWT_SECRET;
        if (!secret || secret.length < 32) throw new Error('JWT_SECRET is required for encrypted OTP jobs');
        return createHash('sha256').update(`otp-job-encryption:${secret}`).digest();
    }
    private encrypt(payload: OtpJob) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
        const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    }
    async deliver(data: { encrypted: string }, context: JobContext) {
        let payload: OtpJob;
        try {
            const bytes = Buffer.from(data.encrypted, 'base64');
            const decipher = createDecipheriv('aes-256-gcm', this.key(), bytes.subarray(0, 12));
            decipher.setAuthTag(bytes.subarray(12, 28));
            payload = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
        } catch { throw new PermanentJobError('OTP job could not be decrypted'); }
        if (payload.expiresAt <= Date.now()) return;
        const check = payload.validity;
        if (check) {
            const challenge = await this.state.get<{ digest?: string; attempts?: number; contacts?: Record<string, { digest: string; verified: boolean; attempts: number }> }>(check.key);
            const contact = check.channel ? challenge?.contacts?.[check.channel] : challenge;
            if (!contact || contact.digest !== check.digest || (contact.attempts ?? 0) >= 5 || ('verified' in contact && contact.verified)) return;
            if (check.currentKey && await this.state.get<string>(check.currentKey) !== check.challengeId) return;
        }
        const sender = await this.direct.create(payload.channel);
        try { await sender.sendOtp(payload.recipient, payload.code, { idempotencyKey: context.id, expiresAt: payload.expiresAt }); }
        catch (error) {
            // Misconfigured adapters / invalid requests cannot succeed by retrying.
            const status = (error as { getStatus?: () => number })?.getStatus?.();
            if ((status && status >= 400 && status < 500 && ![408, 429].includes(status)) || status === 501) {
                throw new PermanentJobError('OTP provider rejected delivery');
            }
            throw error;
        }
    }
}
