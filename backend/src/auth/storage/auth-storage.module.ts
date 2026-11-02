import { Module } from '@nestjs/common';
import { AuthStateStore, MemoryAuthStateStore } from './auth-state.store';
import { RedisAuthStateStore } from './redis-auth-state.store';

@Module({
    providers: [{ provide: AuthStateStore, useFactory: () => {
        const driver = process.env.AUTH_STORAGE ?? 'memory';
        if (driver === 'memory') return new MemoryAuthStateStore();
        if (driver !== 'redis') throw new Error('AUTH_STORAGE must be memory or redis');
        const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
        const prefix = process.env.REDIS_KEY_PREFIX ?? 'nestjs-advance:auth:';
        if (!prefix.trim()) throw new Error('REDIS_KEY_PREFIX must not be empty');
        return new RedisAuthStateStore(url, prefix);
    } }],
    exports: [AuthStateStore],
})
export class AuthStorageModule {}
