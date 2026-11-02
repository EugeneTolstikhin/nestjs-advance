import { BadRequestException, GoneException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { isEmail } from 'class-validator';
import { AuthDto, LoginOtpDto } from './auth.dto';
import { AuthService } from './auth.service';
import { UsersRepository } from './users.repository';
import { OtpFactory } from '../user-interaction/configs/otp.config';

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
    private readonly challenges = new Map<string, LoginChallenge>();
    private readonly rates = new Map<string, { count: number; expiresAt: number }>();

    constructor(private readonly auth: AuthService, private readonly users: UsersRepository,
        private readonly factory: OtpFactory) {}

    password(dto: AuthDto, requester = 'local') {
        this.cleanup();
        this.limit(`password-ip:${requester}`, 20);
        this.limit(`password-contact:${dto.username.trim().toLowerCase()}`, 10);
        return this.auth.login(dto);
    }

    async start(dto: LoginOtpDto, requester = 'local') {
        this.cleanup();
        const contact = dto.contact.trim();
        if (dto.channel === 'email' ? !isEmail(contact) : !/^\+[1-9]\d{1,14}$/.test(contact)) {
            throw new BadRequestException('Enter a valid email or an international phone number');
        }
        const normalized = dto.channel === 'email' ? contact.toLowerCase() : contact;
        this.limit(`otp-ip:${requester}`, 10);
        this.limit(`otp-contact:${normalized}`, 5);
        this.limit(`otp-cooldown:${normalized}`, 1, 60_000);
        if (this.challenges.size >= 1000) throw new HttpException('Too many login requests. Try again later.', 429);
        const id = randomBytes(32).toString('hex');
        const expiresAt = Date.now() + 5 * 60_000;
        const user = await this.users.findByContact(normalized);
        const verified = user && (dto.channel === 'email' ? user.emailVerifiedAt : user.phoneVerifiedAt);
        const code = String(randomInt(100000, 1000000));
        // Unknown/unverified contacts receive the same response, but cannot authenticate.
        if (verified) {
            const sender = await this.factory.create(dto.channel);
            await sender.sendOtp(normalized, code);
        }
        // A new request supersedes previous challenges for this contact.
        for (const [key, challenge] of this.challenges) {
            if (challenge.contact === normalized) this.challenges.delete(key);
        }
        this.challenges.set(id, {
            userId: verified ? user._id : undefined, contact: normalized, channel: dto.channel,
            digest: this.digest(id, code), expiresAt, attempts: 0,
        });
        return { challengeId: id, expiresAt: new Date(expiresAt).toISOString(),
            resendAt: new Date(Date.now() + 60_000).toISOString(),
            message: 'If this contact belongs to a verified account, a login code has been sent.' };
    }

    async verify(id: string, code: string) {
        const challenge = this.challenges.get(id);
        if (!challenge || challenge.expiresAt <= Date.now()) {
            this.challenges.delete(id);
            throw new GoneException('Login code expired or was used. Request a new code.');
        }
        if (challenge.attempts >= 5) throw new HttpException('Too many attempts. Request a new code.', 429);
        challenge.attempts++;
        const matches = timingSafeEqual(Buffer.from(challenge.digest, 'hex'), Buffer.from(this.digest(id, code), 'hex'));
        if (!/^\d{6}$/.test(code) || !matches || !challenge.userId) {
            throw new UnauthorizedException('Invalid login code');
        }
        // Consume before awaiting the database so concurrent requests cannot reuse it.
        this.challenges.delete(id);
        const user = await this.users.findById(challenge.userId);
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

    private limit(key: string, maximum: number, lifetime = 15 * 60_000) {
        let rate = this.rates.get(key);
        if (!rate || rate.expiresAt <= Date.now()) {
            if (this.rates.size >= 10000) throw new HttpException('Too many login requests. Try again later.', 429);
            rate = { count: 0, expiresAt: Date.now() + lifetime };
            this.rates.set(key, rate);
        }
        if (rate.count >= maximum) throw new HttpException('Too many login requests. Try again later.', 429);
        rate.count++;
    }

    private cleanup() {
        const now = Date.now();
        for (const [key, challenge] of this.challenges) if (challenge.expiresAt <= now) this.challenges.delete(key);
        for (const [key, rate] of this.rates) if (rate.expiresAt <= now) this.rates.delete(key);
    }
}
