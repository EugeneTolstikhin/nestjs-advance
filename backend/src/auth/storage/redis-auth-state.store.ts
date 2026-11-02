import { OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { createClient } from 'redis';
import { CasAuthStateStore } from './auth-state.store';

const COMPARE_AND_SET = `
local current = redis.call('GET', KEYS[1])
local expected = ARGV[1]
if (current or '') ~= expected then return 0 end
if ARGV[2] == '' then
    redis.call('DEL', KEYS[1])
else
    redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
end
return 1
`;

export class RedisAuthStateStore extends CasAuthStateStore implements OnModuleDestroy {
    private readonly client;
    private connecting?: Promise<unknown>;

    constructor(url: string, private readonly prefix = 'nestjs-advance:auth:') {
        super();
        this.client = createClient({ url, disableOfflineQueue: true,
            socket: { connectTimeout: 2000, reconnectStrategy: false } });
        // Errors are translated into a sanitized 503 below, never logged with a URL/credentials.
        this.client.on('error', () => {});
    }

    private async connection() {
        try {
            if (!this.client.isReady) {
                if (!this.connecting) this.connecting = this.client.connect().finally(() => { this.connecting = undefined; });
                await this.connecting;
            }
            return this.client.withCommandOptions({ timeout: 2000 });
        } catch { throw new ServiceUnavailableException('Authentication storage is unavailable. Check Redis.'); }
    }

    protected async read(key: string) {
        try { return await (await this.connection()).get(this.prefix + key); }
        catch { throw new ServiceUnavailableException('Authentication storage is unavailable. Check Redis.'); }
    }

    protected async compareAndSet(key: string, previous: string | null, next: string | null, ttl: number) {
        try {
            const result = await (await this.connection()).eval(COMPARE_AND_SET, {
                keys: [this.prefix + key], arguments: [previous ?? '', next ?? '', String(Math.max(1, Math.ceil(ttl)))],
            });
            return result === 1;
        } catch { throw new ServiceUnavailableException('Authentication storage is unavailable. Check Redis.'); }
    }

    async onModuleDestroy() {
        if (this.client.isOpen) this.client.destroy();
    }
}
