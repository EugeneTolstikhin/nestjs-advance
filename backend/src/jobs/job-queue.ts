import { Global, Injectable, Logger, Module, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { Queue, Worker, UnrecoverableError, type ConnectionOptions } from 'bullmq';

export type JobName = 'otp-delivery' | 'media-processing' | 'payment-processing';
export interface JobPayloads {
    'otp-delivery': { encrypted: string };
    'media-processing': { id: string };
    'payment-processing': { checkoutId: string };
}
export interface JobContext { id: string; lastAttempt: boolean }
export type JobHandler<K extends JobName = JobName> = (data: JobPayloads[K], context: JobContext) => Promise<void>;
export class PermanentJobError extends Error {}

/** Producers depend on this boundary; handlers contain domain work, not Redis code. */
export abstract class JobQueue {
    abstract register<K extends JobName>(name: K, handler: JobHandler<K>): Promise<void>;
    abstract add<K extends JobName>(name: K, data: JobPayloads[K], id: string): Promise<void>;
}

/** Explicit test adapter. The application defaults to BullMQ, never silently falls back. */
export class InlineJobQueue extends JobQueue {
    private readonly handlers = new Map<JobName, JobHandler<any>>();
    async register<K extends JobName>(name: K, handler: JobHandler<K>) { this.handlers.set(name, handler); }
    async add<K extends JobName>(name: K, data: JobPayloads[K], id: string) {
        const handler = this.handlers.get(name);
        if (!handler) throw new Error(`No handler for ${name}`);
        await handler(data, { id, lastAttempt: true });
    }
}

@Injectable()
export class BullJobQueue extends JobQueue implements OnModuleDestroy {
    private readonly logger = new Logger(BullJobQueue.name);
    private readonly queues = new Map<JobName, Queue>();
    private readonly workers: Worker[] = [];
    private closed = false;
    private readonly prefix = process.env.JOBS_REDIS_PREFIX ?? 'nestjs-advance:jobs';
    private connection(worker = false): ConnectionOptions {
        const url = new URL(process.env.JOBS_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
        if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('JOBS_REDIS_URL must use redis:// or rediss://');
        return { host: url.hostname, port: Number(url.port || 6379),
            username: url.username ? decodeURIComponent(url.username) : undefined,
            password: url.password ? decodeURIComponent(url.password) : undefined,
            db: Number(url.pathname.slice(1) || 0), tls: url.protocol === 'rediss:' ? {} : undefined,
            connectTimeout: 2000, maxRetriesPerRequest: worker ? null : 1,
            commandTimeout: worker ? undefined : 2000,
            enableOfflineQueue: worker, retryStrategy: times => Math.min(times * 200, 2000) };
    }
    private async ready(resource: { waitUntilReady(): Promise<unknown> }) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([resource.waitUntilReady(), new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Redis connection timed out')), 5000);
            })]);
        } finally { if (timer) clearTimeout(timer); }
    }
    private queue(name: JobName) {
        let queue = this.queues.get(name);
        if (!queue) {
            queue = new Queue(name, { connection: this.connection(), prefix: this.prefix,
                defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 },
                    removeOnComplete: true, removeOnFail: { age: 86400, count: 500 } } });
            queue.on('error', () => this.logger.error(`Queue ${name} Redis connection unavailable`));
            this.queues.set(name, queue);
        }
        return queue;
    }
    async register<K extends JobName>(name: K, handler: JobHandler<K>) {
        try { await this.startWorker(name, handler); }
        catch {
            await this.onModuleDestroy();
            throw new ServiceUnavailableException('Background jobs are unavailable. Check Redis.');
        }
    }
    private async startWorker<K extends JobName>(name: K, handler: JobHandler<K>) {
        const queue = this.queue(name);
        // Fail startup promptly if Redis cannot be reached; workers reconnect after startup.
        await this.ready(queue);
        const worker = new Worker(name, async job => {
            try { await handler(job.data, { id: job.id!, lastAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) }); }
            catch (error) {
                if (error instanceof PermanentJobError) throw new UnrecoverableError(error.message);
                // Provider errors can contain destinations, secrets or request bodies.
                throw new Error(`${name} job failed`);
            }
        }, { connection: this.connection(true), prefix: this.prefix, concurrency: name === 'otp-delivery' ? 4 : 1 });
        worker.on('error', () => this.logger.error(`Worker ${name} Redis connection unavailable`));
        worker.on('failed', job => this.logger.warn(`${name} job ${job?.id ?? 'unknown'} failed (attempt ${job?.attemptsMade ?? 0})`));
        this.workers.push(worker);
        await this.ready(worker);
    }
    async add<K extends JobName>(name: K, data: JobPayloads[K], id: string) {
        try {
            if (this.closed) throw new Error('Job queue is closed');
            const queue = this.queue(name);
            // Media reconciliation can recover a job which exhausted its attempts.
            const existing = await queue.getJob(id);
            if (existing && await existing.getState() === 'failed') await existing.retry();
            else await queue.add(name, data, { jobId: id });
        } catch { throw new ServiceUnavailableException('Background jobs are unavailable. Check Redis.'); }
    }
    async onModuleDestroy() {
        this.closed = true;
        await Promise.all(this.workers.map(worker => worker.close()));
        await Promise.all([...this.queues.values()].map(queue => queue.close()));
    }
}

@Global()
@Module({
    providers: [{ provide: JobQueue, useFactory: () => {
        const driver = process.env.JOBS_DRIVER ?? 'bullmq';
        if (driver === 'inline' && process.env.NODE_ENV !== 'production') return new InlineJobQueue();
        if (driver !== 'bullmq') throw new Error('JOBS_DRIVER must be bullmq (or inline for tests/development)');
        return new BullJobQueue();
    } }],
    exports: [JobQueue],
})
export class JobsModule {}
