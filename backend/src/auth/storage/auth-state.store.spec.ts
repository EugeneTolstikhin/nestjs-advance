import { MemoryAuthStateStore } from './auth-state.store';

describe('Auth state storage contract', () => {
    const secret = process.env.JWT_SECRET;
    let store: MemoryAuthStateStore;
    beforeEach(() => {
        process.env.JWT_SECRET = 'test-only-secret-with-at-least-32-characters';
        store = new MemoryAuthStateStore();
    });
    afterEach(() => {
        vi.useRealTimers();
        if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
    });
    it('atomically limits concurrent requests without resetting the window on rejection', async () => {
        vi.useFakeTimers();
        const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => store.limit('contact', 5, 60000)));
        expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(5);
        expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(15);
        vi.setSystemTime(Date.now() + 60001);
        await expect(store.limit('contact', 5, 60000)).resolves.toBeUndefined();
    });
    it('expires state, preserves TTL when updating it, and isolates data from callers', async () => {
        vi.useFakeTimers();
        const input = { attempts: 0 };
        await store.put('challenge', input, Date.now() + 60000);
        input.attempts = 999;
        expect(await store.get('challenge')).toEqual({ attempts: 0 });
        vi.setSystemTime(Date.now() + 30000);
        await store.update<{ attempts: number }, void>('challenge', value => {
            value!.attempts++;
            return { value, expiresAt: 0, result: undefined };
        });
        expect(await store.get('challenge')).toEqual({ attempts: 1 });
        vi.setSystemTime(Date.now() + 30001);
        expect(await store.get('challenge')).toBeNull();
    });
    it('allows only one concurrent consumer to delete a challenge', async () => {
        await store.put('challenge', { digest: 'hashed' }, Date.now() + 60000);
        const consume = () => store.update('challenge', value => ({ value: null, expiresAt: 0, result: value !== null }));
        expect((await Promise.all([consume(), consume()])).sort()).toEqual([false, true]);
    });

    it('reports the original window expiry on rejected requests', async () => {
        vi.useFakeTimers();
        await store.limit('retry', 1, 60000);
        vi.setSystemTime(Date.now() + 15000);
        await expect(store.limit('retry', 1, 60000)).rejects.toMatchObject({ status: 429,
            response: expect.objectContaining({ retryAfterSeconds: 45 }) });
        vi.setSystemTime(Date.now() + 10000);
        await expect(store.limit('retry', 1, 60000)).rejects.toMatchObject({ status: 429,
            response: expect.objectContaining({ retryAfterSeconds: 35 }) });
    });
});
