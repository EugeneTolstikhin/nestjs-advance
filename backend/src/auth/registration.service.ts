import { BadRequestException, ConflictException, GoneException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { isEmail } from 'class-validator';
import * as bcrypt from 'bcrypt';
import { RegisterDto, TypeOfUser } from './auth.dto';
import { UsersRepository, StoredUser } from './users.repository';
import { OtpFactory } from '../user-interaction/configs/otp.config';
import { LogOtpHandler } from '../user-interaction/handlers/log-otp.handler';

type ContactChannel = 'email' | 'phone';
interface ContactChallenge {
    recipient: string;
    digest: string;
    verified: boolean;
    attempts: number;
    expiresAt: number;
    lastSentAt: number;
    sending: boolean;
    delivery: 'LOG' | ContactChannel;
}
interface PendingRegistration {
    id: string;
    user: StoredUser;
    contacts: Partial<Record<ContactChannel, ContactChallenge>>;
    expiresAt: number;
    saving: boolean;
}

@Injectable()
export class RegistrationService {
    private readonly pending = new Map<string, PendingRegistration>();
    private readonly rates = new Map<string, { count: number; expiresAt: number }>();
    private readonly challengeLifetime = 10 * 60_000;
    private readonly codeLifetime = 5 * 60_000;
    private readonly resendCooldown = 60_000;

    constructor(private readonly users: UsersRepository, private readonly otpFactory: OtpFactory) {}

    async start(dto: RegisterDto, requester = 'local') {
        this.cleanup();
        this.rateLimit(`ip:${requester}`, 10);
        if (this.pending.size >= 1000) throw new HttpException('Too many pending registrations', 429);
        if (![TypeOfUser.Buyer, TypeOfUser.Seller].includes(dto.typeOfUser)) {
            throw new BadRequestException('Only buyers and sellers can register');
        }
        if (dto.password !== dto.confirmPassword) throw new BadRequestException('Passwords do not match');
        if (typeof dto.password !== 'string' || Buffer.byteLength(dto.password, 'utf8') > 72) {
            throw new BadRequestException('Password must not exceed 72 bytes');
        }
        const email = (dto.email ?? dto.username)?.trim().toLowerCase() || undefined;
        const phone = dto.phone?.trim() || undefined;
        if (!email && !phone) throw new BadRequestException('Provide at least one email address or phone number');
        if (email && !isEmail(email)) throw new BadRequestException('Invalid email address');
        if (phone && !/^\+[1-9]\d{1,14}$/.test(phone)) throw new BadRequestException('Phone must use E.164 format');
        if (dto.email && dto.username && dto.email.trim().toLowerCase() !== dto.username.trim().toLowerCase()) {
            throw new BadRequestException('Email and username must match when both are supplied');
        }
        if ((dto.typeOfUser === TypeOfUser.Buyer && dto.sellerProfile) ||
            (dto.typeOfUser === TypeOfUser.Seller && dto.buyerProfile)) {
            throw new BadRequestException('Profile fields must match the selected user type');
        }
        if (Date.parse(dto.dob) > Date.now()) throw new BadRequestException('Date of birth cannot be in the future');
        if (await this.users.contactExists(email, phone)) throw new ConflictException('Email or phone is already registered');
        const now = Date.now();
        const user: StoredUser = {
            _id: randomUUID(), passwordHash: await bcrypt.hash(dto.password, 10),
            firstName: dto.firstName.trim(), lastName: dto.lastName.trim(),
            dob: dto.dob, nationality: dto.nationality, typeOfUser: dto.typeOfUser,
            profile: dto.typeOfUser === TypeOfUser.Buyer
                ? { ...(dto.buyerProfile ?? {}) } : { ...(dto.sellerProfile ?? {}) },
            createdAt: new Date(now), updatedAt: new Date(now),
        };
        if (email) user.email = email;
        if (phone) user.phone = phone;
        if (dto.pob) user.pob = dto.pob;
        const pending: PendingRegistration = {
            id: randomBytes(32).toString('hex'), user, contacts: {},
            expiresAt: now + this.challengeLifetime, saving: false,
        };
        // Passwords and confirmation values are never retained in pending state.
        this.pending.set(pending.id, pending);
        try {
            for (const channel of ['email', 'phone'] as const) {
                const recipient = user[channel];
                if (!recipient) continue;
                this.rateLimit(`contact:${recipient}`, 5);
                const contact: ContactChallenge = {
                    recipient, digest: '', verified: false, attempts: 0,
                    expiresAt: 0, lastSentAt: 0, sending: false, delivery: channel,
                };
                pending.contacts[channel] = contact;
                await this.deliver(pending, channel, contact);
            }
            return this.status(pending);
        } catch (error) {
            this.pending.delete(pending.id);
            throw error;
        }
    }

    async verify(id: string, channel: ContactChannel, code: string): Promise<
        { registered: false; challenge: ReturnType<RegistrationService['status']> } |
        { registered: true; user: StoredUser }
    > {
        const pending = this.getPending(id);
        if (pending.saving) throw new ConflictException('Registration is already being completed');
        const contact = pending.contacts[channel];
        if (!contact) throw new BadRequestException('This contact is not part of the registration');
        if (contact.sending) throw new ConflictException('A new code is being sent');
        if (!contact.verified) {
            if (contact.attempts >= 5) throw new HttpException('Too many attempts. Start registration again.', 429);
            if (contact.expiresAt <= Date.now()) throw new GoneException('Code expired. Request a new code.');
            contact.attempts++;
            const expected = Buffer.from(contact.digest, 'hex');
            const supplied = Buffer.from(this.digest(id, channel, code), 'hex');
            if (!/^\d{6}$/.test(code) || !timingSafeEqual(expected, supplied)) {
                throw new UnauthorizedException('Invalid verification code');
            }
            contact.verified = true;
            contact.digest = '';
        }
        if (!Object.values(pending.contacts).every(value => value.verified)) {
            return { registered: false, challenge: this.status(pending) };
        }
        pending.saving = true;
        try {
            const now = new Date();
            if (pending.contacts.email) pending.user.emailVerifiedAt = now;
            if (pending.contacts.phone) pending.user.phoneVerifiedAt = now;
            pending.user.createdAt = now;
            pending.user.updatedAt = now;
            // No user document is written before every supplied contact is verified.
            const user = await this.users.insertVerified(pending.user);
            this.pending.delete(id);
            return { registered: true, user };
        } catch (error) {
            if (error instanceof ConflictException) this.pending.delete(id);
            throw error;
        } finally {
            pending.saving = false;
        }
    }

    async resend(id: string, channel: ContactChannel) {
        const pending = this.getPending(id);
        const contact = pending.contacts[channel];
        if (!contact) throw new BadRequestException('This contact is not part of the registration');
        if (pending.saving || contact.sending) throw new ConflictException('Registration request is already in progress');
        if (contact.verified) throw new BadRequestException('Contact is already verified');
        if (contact.attempts >= 5) throw new HttpException('Too many attempts. Start registration again.', 429);
        if (Date.now() - contact.lastSentAt < this.resendCooldown) {
            throw new HttpException('Wait 60 seconds before requesting another code', 429);
        }
        this.rateLimit(`contact:${contact.recipient}`, 5);
        await this.deliver(pending, channel, contact);
        return this.status(pending);
    }

    private async deliver(pending: PendingRegistration, channel: ContactChannel, contact: ContactChallenge) {
        contact.sending = true;
        try {
            const sender = await this.otpFactory.create(channel);
            let code: string;
            do { code = String(randomInt(100000, 1000000)); }
            while (this.digest(pending.id, channel, code) === contact.digest);
            await sender.sendOtp(contact.recipient, code);
            contact.digest = this.digest(pending.id, channel, code);
            contact.delivery = sender instanceof LogOtpHandler ? 'LOG' : channel;
            contact.lastSentAt = Date.now();
            contact.expiresAt = Math.min(pending.expiresAt, Date.now() + this.codeLifetime);
        } finally {
            contact.sending = false;
        }
    }

    private digest(id: string, channel: string, code: string) {
        const secret = process.env.JWT_SECRET;
        if (!secret || secret.length < 32) throw new Error('JWT_SECRET is required for OTP verification');
        return createHmac('sha256', secret).update(`${id}:${channel}:${code}`).digest('hex');
    }

    private getPending(id: string) {
        const pending = this.pending.get(id);
        if (!pending || pending.expiresAt <= Date.now()) {
            this.pending.delete(id);
            throw new GoneException('Registration expired or was completed. Start again.');
        }
        return pending;
    }

    private status(pending: PendingRegistration) {
        return {
            challengeId: pending.id,
            expiresAt: new Date(pending.expiresAt).toISOString(),
            contacts: Object.entries(pending.contacts).map(([channel, contact]) => ({
                channel,
                destination: channel === 'email'
                    ? `${contact.recipient.slice(0, 1)}***${contact.recipient.slice(contact.recipient.indexOf('@'))}`
                    : `***${contact.recipient.slice(-2)}`,
                verified: contact.verified,
                delivery: contact.delivery,
                resendAt: new Date(contact.lastSentAt + this.resendCooldown).toISOString(),
            })),
        };
    }

    private rateLimit(key: string, maximum: number) {
        const now = Date.now();
        let limit = this.rates.get(key);
        if (!limit || limit.expiresAt <= now) {
            limit = { count: 0, expiresAt: now + 15 * 60_000 };
            this.rates.set(key, limit);
        }
        if (limit.count >= maximum) throw new HttpException('Too many code requests. Try again later.', 429);
        limit.count++;
    }

    private cleanup() {
        const now = Date.now();
        for (const [id, pending] of this.pending) if (pending.expiresAt <= now && !pending.saving) this.pending.delete(id);
        for (const [key, limit] of this.rates) if (limit.expiresAt <= now) this.rates.delete(key);
    }
}
