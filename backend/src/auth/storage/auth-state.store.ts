import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';

export interface StateChange<T, R> {
    value: T | null;
    expiresAt: number;
    result: R;
}

// Callbacks must be synchronous and have no side effects: a competing writer may
// cause a retry. External delivery/database work happens after a state transition.
export abstract class AuthStateStore {
    abstract update<T, R>(key: string, change: (value: T | null) => StateChange<T, R>): Promise<R>;

    async get<T>(key: string): Promise<T | null> {
        return this.update<T, T | null>(key, value => ({ value, expiresAt: 0, result: value }));
    }

    async put<T>(key: string, value: T, expiresAt: number) {
        await this.update<T, void>(key, () => ({ value, expiresAt, result: undefined }));
    }

    async remove(key: string) {
        await this.update<unknown, void>(key, () => ({ value: null, expiresAt: 0, result: undefined }));
    }

    async limit(key: string, maximum: number, lifetime = 15 * 60_000) {
        const outcome = await this.update<{ count: number; until: number }, { allowed: boolean; until: number }>(`rate:${key}`, value => {
            const now = Date.now();
            const rate = value ?? { count: 0, until: now + lifetime };
            const allowed = rate.count < maximum;
            if (allowed) rate.count++;
            return { value: rate, expiresAt: rate.until, result: { allowed, until: rate.until } };
        });
        if (!outcome.allowed) {
            const retryAfterSeconds = Math.max(1, Math.ceil((outcome.until - Date.now()) / 1000));
            throw new HttpException({ statusCode: 429,
                message: `Too many requests. Try again in ${retryAfterSeconds} seconds.`,
                retryAfterSeconds, retryAt: new Date(outcome.until).toISOString(),
            }, 429);
        }
    }

    protected key(key: string) {
        const secret = process.env.JWT_SECRET;
        if (!secret || secret.length < 32) throw new Error('JWT_SECRET is required for auth state storage');
        // No email, phone, IP or challenge token is exposed in Redis key names.
        return createHmac('sha256', secret).update(key).digest('hex');
    }
}

interface Envelope<T> { value: T; expiresAt: number; revision: string }

export abstract class CasAuthStateStore extends AuthStateStore {
    protected abstract read(key: string): Promise<string | null>;
    protected abstract compareAndSet(key: string, previous: string | null, next: string | null, ttl: number): Promise<boolean>;

    async update<T, R>(key: string, change: (value: T | null) => StateChange<T, R>): Promise<R> {
        const storageKey = this.key(key);
        for (let attempt = 0; attempt < 30; attempt++) {
            const previous = await this.read(storageKey);
            const envelope: Envelope<T> | null = previous ? JSON.parse(previous) : null;
            const current = envelope && envelope.expiresAt > Date.now() ? envelope : null;
            const result = change(current?.value ?? null);
            const expiresAt = result.expiresAt || current?.expiresAt || 0;
            const ttl = Math.max(0, expiresAt - Date.now());
            const next = result.value !== null && ttl > 0
                ? JSON.stringify({ value: result.value, expiresAt, revision: randomUUID() }) : null;
            if (await this.compareAndSet(storageKey, previous, next, ttl)) return result.result;
        }
        throw new ServiceUnavailableException('Authentication storage is busy. Try again.');
    }
}

export class MemoryAuthStateStore extends CasAuthStateStore {
    private readonly entries = new Map<string, { payload: string; expiresAt: number }>();

    protected async read(key: string) {
        const entry = this.entries.get(key);
        if (entry && entry.expiresAt > Date.now()) return entry.payload;
        this.entries.delete(key);
        return null;
    }

    protected async compareAndSet(key: string, previous: string | null, next: string | null, ttl: number) {
        const entry = this.entries.get(key);
        const actual = entry && entry.expiresAt > Date.now() ? entry.payload : null;
        if (actual !== previous) return false;
        if (next === null) this.entries.delete(key);
        else {
            if (!this.entries.has(key) && this.entries.size >= 20000) {
                for (const [id, item] of this.entries) if (item.expiresAt <= Date.now()) this.entries.delete(id);
                if (this.entries.size >= 20000) throw new ServiceUnavailableException('Authentication storage is full');
            }
            this.entries.set(key, { payload: next, expiresAt: Date.now() + ttl });
        }
        return true;
    }
}
