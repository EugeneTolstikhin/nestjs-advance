import { BadRequestException, GoneException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { isEmail } from 'class-validator';
import { AuthDto, LoginOtpDto } from './auth.dto';
import { AuthService } from './auth.service';
import { UsersRepository } from './users.repository';
import { OtpFactory } from '../user-interaction/configs/otp.config';
import { AuthStateStore } from './storage/auth-state.store';

interface LoginChallenge {
    userId?: string;
    contact: string;
    channel: 'email' | 'phone';
    digest: string;
    expiresAt: number;
    attempts: number;
}

@Injectable()
export class LoginService {
    constructor(private readonly auth: AuthService, private readonly users: UsersRepository,
        private readonly factory: OtpFactory, private readonly state: AuthStateStore) {}

    async password(dto: AuthDto, requester = 'local') {
        await this.state.limit(`login:password-ip:${requester}`, 20);
        await this.state.limit(`login:password-contact:${dto.username.trim().toLowerCase()}`, 10);
        return this.auth.login(dto);
    }

    async start(dto: LoginOtpDto, requester = 'local') {
        const contact = dto.contact.trim();
        if (dto.channel === 'email' ? !isEmail(contact) : !/^\+[1-9]\d{1,14}$/.test(contact)) {
            throw new BadRequestException('Enter a valid email or an international phone number');
        }
        const normalized = dto.channel === 'email' ? contact.toLowerCase() : contact;
        await this.state.limit(`login:otp-ip:${requester}`, 10);
        // Cooldown retries must not consume another message from the contact quota.
        await this.state.limit(`otp:cooldown:${normalized}`, 1, 60_000);
        await this.state.limit(`otp:contact:${normalized}`, 5);
        await this.state.limit('login:starts', 1000, 5 * 60_000);
        const id = randomBytes(32).toString('hex');
        const expiresAt = Date.now() + 5 * 60_000;
        const user = await this.users.findByContact(normalized);
        const verified = user && (dto.channel === 'email' ? user.emailVerifiedAt : user.phoneVerifiedAt);
        const code = String(randomInt(100000, 1000000));
        // Unknown/unverified contacts receive the same response, but cannot authenticate.
        await this.state.put<LoginChallenge>(`login:challenge:${id}`, {
            userId: verified ? user._id : undefined, contact: normalized, channel: dto.channel,
            digest: this.digest(id, code), expiresAt, attempts: 0,
        }, expiresAt);
        // Shared contact pointer invalidates previous codes without scanning Redis.
        await this.state.put(`login:current:${normalized}`, id, expiresAt);
        if (verified) {
            try {
                const sender = await this.factory.create(dto.channel);
                await sender.sendOtp(normalized, code, { expiresAt, validity: {
                    key: `login:challenge:${id}`, digest: this.digest(id, code),
                    currentKey: `login:current:${normalized}`, challengeId: id,
                } });
            } catch (error) {
                await this.state.remove(`login:challenge:${id}`);
                throw error;
            }
        }
        return { challengeId: id, expiresAt: new Date(expiresAt).toISOString(),
            resendAt: new Date(Date.now() + 60_000).toISOString(),
            message: 'If this contact belongs to a verified account, a login code has been queued for delivery.' };
    }

    async verify(id: string, code: string) {
        const result = await this.state.update<LoginChallenge, { error?: number; challenge?: LoginChallenge }>(
            `login:challenge:${id}`, challenge => {
                if (!challenge) return { value: null, expiresAt: 0, result: { error: 410 } };
                if (challenge.attempts >= 5) return { value: challenge, expiresAt: challenge.expiresAt, result: { error: 429 } };
                challenge.attempts++;
                const matches = timingSafeEqual(Buffer.from(challenge.digest, 'hex'), Buffer.from(this.digest(id, code), 'hex'));
                if (!/^\d{6}$/.test(code) || !matches || !challenge.userId) {
                    return { value: challenge, expiresAt: challenge.expiresAt, result: { error: 401 } };
                }
                // Atomic deletion prevents reuse across application instances.
                return { value: null, expiresAt: 0, result: { challenge } };
            });
        if (result.error === 410) throw new GoneException('Login code expired or was used. Request a new code.');
        if (result.error === 429) throw new HttpException('Too many attempts. Request a new code.', 429);
        if (!result.challenge) throw new UnauthorizedException('Invalid login code');
        const challenge = result.challenge;
        if (await this.state.get<string>(`login:current:${challenge.contact}`) !== id) {
            throw new GoneException('Login code was replaced. Use the latest code.');
        }
        const user = await this.users.findById(challenge.userId!);
        if (!user || user[challenge.channel] !== challenge.contact ||
            !(challenge.channel === 'email' ? user.emailVerifiedAt : user.phoneVerifiedAt)) {
            throw new UnauthorizedException('Invalid login code');
        }
        return this.auth.createSession(user);
    }

    private digest(id: string, code: string) {
        const secret = process.env.JWT_SECRET;
        if (!secret || secret.length < 32) throw new Error('JWT_SECRET is required for OTP login');
        return createHmac('sha256', secret).update(`login:${id}:${code}`).digest('hex');
    }

}
