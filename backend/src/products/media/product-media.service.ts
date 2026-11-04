import { BadRequestException, ForbiddenException, GoneException, HttpException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { Request, Response } from 'express';
import type { Server } from '@tus/server';
import { Products } from '../products.entity';
import { ProductMedia } from './product-media.entity';
import { mediaConfig } from './media.config';
import { UploadTicketDto } from './media.dto';
import { JobQueue, PermanentJobError, type JobContext } from '../../jobs/job-queue';

const execute = promisify(execFile);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

@Injectable()
export class ProductMediaService implements OnModuleInit, OnModuleDestroy {
    readonly config = mediaConfig();
    private server?: Promise<Server>;
    private readonly owners = new AsyncLocalStorage<string>();
    private readonly active = new Map<string, string>();
    private queue: Promise<unknown> = Promise.resolve();
    private timer?: ReturnType<typeof setInterval>;
    constructor(private readonly db: DataSource, private readonly jobs: JobQueue) {}
    private get repository() { return this.db.getRepository(ProductMedia); }
    async onModuleInit() {
        await this.jobs.register('media-processing', (data: { id: string }, context) => this.process(data.id, context));
        await this.recoverProcessing();
        this.timer = setInterval(() => { void this.cleanup().then(() => this.recoverProcessing()).catch(() => {}); }, 10 * 60_000);
        this.timer.unref();
    }
    onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
    exclusive<T>(work: () => Promise<T>): Promise<T> {
        const next = this.queue.then(work, work);
        this.queue = next.catch(() => {}); return next;
    }
    private raw(id: string) { return join(this.config.directory, 'uploads', id); }
    private image(id: string) { return join(this.config.directory, 'ready', `${id}.webp`); }
    private poster(id: string) { return join(this.config.directory, 'ready', `${id}.poster.jpg`); }
    private async directories() {
        await mkdir(join(this.config.directory, 'uploads'), { recursive: true });
        await mkdir(join(this.config.directory, 'ready'), { recursive: true });
    }
    settings() {
        const { maxFiles, maxVideos, imageBytes, videoBytes, productBytes, maxDuration, lifetime } = this.config;
        return { maxFiles, maxVideos, imageBytes, videoBytes, productBytes, maxDuration, lifetime,
            accept: 'image/jpeg,image/png,image/webp,video/mp4,video/webm', endpoint: '/media/uploads', ticketsPerHour: 30 };
    }
    publicItem(item: ProductMedia) {
        return { id: item.id, kind: item.kind, isVideo: item.kind === 'video', name: item.originalName,
            size: item.size, position: item.position, url: `/media/files/${item.id}`,
            poster: item.kind === 'video' ? `/media/files/${item.id}/poster` : undefined,
            width: item.width, height: item.height, duration: item.duration };
    }
    async decorate(products: Products[], manager = this.db.manager) {
        if (!products.length) return products;
        const items = await manager.find(ProductMedia, { where: { productId: In(products.map(p => p.id)), status: 'ready' }, order: { position: 'ASC' } });
        for (const product of products) product.media = items.filter(item => item.productId === product.id).map(item => this.publicItem(item));
        return products;
    }
    async ticket(dto: UploadTicketDto, ownerId: string) {
        await this.cleanup();
        return this.exclusive(async () => this.db.transaction(async manager => {
            const video = dto.type.startsWith('video/');
            if (dto.size > (video ? this.config.videoBytes : this.config.imageBytes)) throw new HttpException('File exceeds the allowed size', 413);
            const all = await manager.find(ProductMedia, { where: { status: In(['reserved', 'uploading', 'processing', 'ready', 'failed', 'deleted']) } });
            const drafts = all.filter(item => item.ownerId === ownerId && !item.productId);
            const reservation = dto.size + (video ? 1024 ** 2 : this.config.imageBytes);
            if (drafts.length >= this.config.maxFiles || drafts.reduce((sum, item) => sum + item.size, 0) + dto.size > this.config.draftBytes) {
                throw new HttpException('Too many pending uploads. Save or remove pending files first.', 429);
            }
            if (all.reduce((sum, item) => sum + item.reservedBytes, 0) + reservation > this.config.storageBytes) {
                throw new HttpException('Local media storage quota is full', 507);
            }
            const item = manager.create(ProductMedia, { id: randomUUID(), ownerId, productId: null, position: 0,
                originalName: dto.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255), kind: video ? 'video' : 'image',
                mimeType: dto.type, size: dto.size, reservedBytes: reservation, status: 'reserved', error: null,
                expiresAt: Date.now() + this.config.lifetime, width: 0, height: 0, duration: 0 });
            await manager.save(item);
            return { id: item.id, expiresAt: item.expiresAt, uploadUrl: `/media/uploads/${item.id}` };
        }));
    }
    async owned(id: string, ownerId: string) {
        if (!uuid.test(id)) throw new NotFoundException('Upload not found');
        const item = await this.repository.findOneBy({ id, ownerId });
        if (!item) throw new NotFoundException('Upload not found');
        if (item.status === 'deleted' || (item.expiresAt <= Date.now() && !item.productId)) throw new GoneException('Upload expired');
        return item;
    }
    async status(id: string, ownerId: string) {
        const item = await this.owned(id, ownerId);
        return { ...this.publicItem(item), status: item.status, error: item.error, expiresAt: item.expiresAt, attached: !!item.productId };
    }
    async discard(id: string, ownerId: string) {
        await this.exclusive(async () => {
            const item = await this.owned(id, ownerId);
            if (item.productId) throw new BadRequestException('Remove saved media in the product editor and save the product');
            // Do not unlink a stream while tus is writing. Deletion is deferred to cleanup.
            await this.repository.update({ id, ownerId }, { status: 'deleted', expiresAt: Date.now() });
        });
    }
    async attach(manager: EntityManager, productId: string, ids: string[], ownerId?: string) {
        if (ids.length > this.config.maxFiles || new Set(ids).size !== ids.length) throw new BadRequestException('Invalid media count or duplicate media IDs');
        const items = ids.length ? await manager.find(ProductMedia, { where: { id: In(ids) } }) : [];
        if (items.length !== ids.length) throw new BadRequestException('One or more media files are missing');
        for (const item of items) {
            if (item.status !== 'ready' || (item.productId && item.productId !== productId) ||
                (!item.productId && (item.ownerId !== ownerId || item.expiresAt <= Date.now()))) {
                throw new ForbiddenException('Media is not ready or does not belong to this product/upload session');
            }
        }
        if (items.filter(item => item.kind === 'video').length > this.config.maxVideos ||
            items.reduce((sum, item) => sum + item.size, 0) > this.config.productBytes) throw new BadRequestException('Product media limits exceeded');
        const old = await manager.find(ProductMedia, { where: { productId } });
        for (const item of old) if (!ids.includes(item.id)) await manager.update(ProductMedia, item.id, { productId: null, status: 'deleted', expiresAt: Date.now() });
        for (const [position, id] of ids.entries()) await manager.update(ProductMedia, id, { productId, position });
    }
    async detach(manager: EntityManager, productId: string) {
        await manager.update(ProductMedia, { productId }, { productId: null, status: 'deleted', expiresAt: Date.now() });
    }
    async cleanup() {
        return this.exclusive(async () => {
            const items = await this.repository.find();
            for (const item of items) {
                if (this.active.has(item.id)) continue;
                if (item.expiresAt > Date.now()) continue;
                if (!item.productId) {
                    await this.removeFiles(item.id);
                    await this.repository.delete(item.id);
                } else if (item.status === 'ready') {
                    // Finished tus resources expire, but published media remains available.
                    await rm(this.raw(item.id) + '.json', { force: true });
                    if (item.kind === 'image') {
                        await rm(this.raw(item.id), { force: true });
                        const size = await stat(this.image(item.id)).then(s => s.size).catch(() => 0);
                        await this.repository.update(item.id, { reservedBytes: size });
                    }
                }
            }
        });
    }
    private async removeFiles(id: string) {
        await Promise.all([this.raw(id), this.raw(id) + '.json', this.image(id), this.poster(id)].map(path => rm(path, { force: true })));
    }
    async file(id: string, ownerId?: string, poster = false) {
        if (!uuid.test(id)) throw new NotFoundException();
        const item = await this.repository.findOneBy({ id, status: 'ready' });
        if (!item || (!item.productId && (item.ownerId !== ownerId || item.expiresAt <= Date.now()))) throw new NotFoundException();
        if (poster && item.kind !== 'video') throw new NotFoundException();
        return { path: poster ? this.poster(id) : item.kind === 'image' ? this.image(id) : this.raw(id),
            type: poster ? 'image/jpeg' : item.kind === 'image' ? 'image/webp' : item.mimeType,
            published: !!item.productId };
    }
    async handle(request: Request, response: Response, ownerId: string) {
        if (request.method === 'POST' && (Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding'])) {
            throw new BadRequestException('Create the upload first, then PATCH the file bytes');
        }
        const server = await (this.server ??= this.createServer().catch(error => { this.server = undefined; throw error; }));
        const id = request.path.split('/').pop()!;
        if (request.method === 'PATCH') {
            if (this.active.has(id)) throw new HttpException('Upload already has an active request. Retry shortly.', 409);
            if (this.active.size >= 8 || [...this.active.values()].filter(owner => owner === ownerId).length >= 2) throw new HttpException('Too many active upload streams', 429);
            this.active.set(id, ownerId);
        }
        try { return await this.owners.run(ownerId, () => server.handle(request, response)); }
        finally { if (request.method === 'PATCH') this.active.delete(id); }
    }
    private async createServer(): Promise<Server> {
        await this.directories();
        const [{ Server }, { FileStore }] = await Promise.all([import('@tus/server'), import('@tus/file-store')]);
        return new Server({ path: '/media/uploads', relativeLocation: true, datastore: new FileStore({ directory: join(this.config.directory, 'uploads'), expirationPeriodInMilliseconds: this.config.lifetime }),
            maxSize: Math.max(this.config.videoBytes, this.config.imageBytes), allowedOrigins: [],
            namingFunction: (_request, metadata) => {
                const id = metadata?.ticket;
                if (!id || !uuid.test(id)) throw { status_code: 400, body: 'A valid upload ticket is required' };
                return id;
            },
            onIncomingRequest: async (request, id) => {
                if (!['POST', 'HEAD', 'PATCH', 'OPTIONS'].includes(request.method)) throw { status_code: 405, body: 'Method not allowed' };
                if (id) {
                    const item = await this.owned(id, this.owners.getStore()!);
                    if (item.status === 'failed' || item.expiresAt <= Date.now()) throw { status_code: 410, body: 'Upload expired or invalid' };
                    if (item.productId && request.method === 'PATCH') throw { status_code: 409, body: 'Published media cannot be modified' };
                    if (['processing', 'ready'].includes(item.status) && request.method === 'PATCH') {
                        throw { status_code: 409, body: 'Upload bytes are complete and immutable' };
                    }
                    if (request.method === 'HEAD' && item.status === 'processing') await this.scheduleProcessing(id, item.ownerId);
                    // Recover if a process stopped after the final bytes were stored
                    // but before the validation hook committed its ready state.
                    if (request.method === 'HEAD' && item.status === 'uploading' && !this.active.has(id) &&
                        await stat(this.raw(id)).then(s => s.size === item.size).catch(() => false)) {
                        await this.scheduleProcessing(id, item.ownerId);
                    }
                }
            },
            onUploadCreate: async (_request, upload) => {
                const item = await this.owned(upload.id, this.owners.getStore()!);
                if (upload.size !== item.size) throw { status_code: 400, body: 'Upload length must match the ticket' };
                const changed = await this.repository.update({ id: item.id, ownerId: item.ownerId, status: 'reserved' }, { status: 'uploading' });
                if (!changed.affected) throw { status_code: 409, body: 'Upload already started. Resume the existing upload URL.' };
                upload.creation_date = new Date(item.expiresAt - this.config.lifetime).toISOString();
                return { metadata: { ticket: item.id } };
            },
            onUploadFinish: async (_request, upload) => {
                await this.scheduleProcessing(upload.id, this.owners.getStore()!);
                return {};
            },
            onResponseError: (_request, error) => {
                if (error instanceof HttpException) return { status_code: error.getStatus(), body: error.message };
                return undefined;
            },
        });
    }
    private async scheduleProcessing(id: string, ownerId: string) {
        const item = await this.owned(id, ownerId);
        if (item.status === 'ready') return;
        if (!['uploading', 'processing'].includes(item.status)) throw new GoneException('Upload is no longer active');
        await this.repository.update({ id, status: 'uploading' }, { status: 'processing' });
        try { await this.jobs.add('media-processing', { id }, `media-${id}`); }
        catch (error) {
            if (error instanceof PermanentJobError) throw { status_code: 422, body: error.message };
            throw error;
        }
    }
    private async recoverProcessing() {
        // SQL is the durable source of pending work. Repair a crash between SQL and Redis.
        const items = await this.repository.find({ where: { status: In(['uploading', 'processing']) } });
        for (const item of items) {
            if (item.expiresAt <= Date.now() || this.active.has(item.id)) continue;
            if (await stat(this.raw(item.id)).then(s => s.size === item.size).catch(() => false)) {
                try { await this.scheduleProcessing(item.id, item.ownerId); }
                catch { /* Retried on the next reconciliation or client status request. */ }
            }
        }
    }
    async process(id: string, context: JobContext) {
        await this.exclusive(async () => {
            const item = await this.repository.findOneBy({ id });
            if (!item || item.status !== 'processing' || item.expiresAt <= Date.now()) return;
            try { await this.validate(item); }
            catch (error) {
                if (error instanceof BadRequestException) {
                    await this.repository.update(item.id, { status: 'failed', error: error.message });
                    await this.removeFiles(item.id);
                    await this.repository.update(item.id, { reservedBytes: 0 });
                    throw new PermanentJobError(error.message);
                }
                if (context.lastAttempt) await this.repository.update(item.id, { status: 'failed', error: 'Media processing failed. Remove the file and upload it again.' });
                throw error;
            }
        });
    }
    private async validate(item: ProductMedia) {
        const source = this.raw(item.id);
        if ((await stat(source)).size !== item.size) throw new BadRequestException('Incomplete upload');
        const file = await open(source, 'r');
        const prefix = Buffer.alloc(16);
        try { await file.read(prefix, 0, prefix.length, 0); } finally { await file.close(); }
        const signatures: Record<string, boolean> = {
            'image/jpeg': prefix.subarray(0, 3).equals(Buffer.from([255, 216, 255])),
            'image/png': prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
            'image/webp': prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'WEBP',
            'video/mp4': prefix.toString('ascii', 4, 8) === 'ftyp',
            'video/webm': prefix.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])),
        };
        if (!signatures[item.mimeType]) throw new BadRequestException('File contents do not match the declared media type');
        if (item.kind === 'image') {
            const image = sharp(source, { limitInputPixels: this.config.maxPixels, animated: false });
            const meta = await image.metadata().catch(error => {
                if ((error as Error).message.includes('pixel limit')) throw new BadRequestException('Photo exceeds the allowed pixel dimensions');
                throw error;
            });
            const expected = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }[item.mimeType];
            if (meta.format !== expected || (meta.pages ?? 1) > 1) throw new BadRequestException('File contents do not match a supported photo');
            const output = await image.rotate().resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(this.image(item.id));
            if (output.size > this.config.imageBytes) throw new BadRequestException('Processed image is too large');
            await this.repository.update(item.id, { status: 'ready', width: output.width, height: output.height, error: null,
                reservedBytes: item.size + output.size });
        } else {
            let probe: { streams: { codec_type: string; codec_name: string; width: number; height: number }[]; format: { format_name: string; duration: string } };
            try {
                const { stdout } = await execute(this.config.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', source], { timeout: 15000, maxBuffer: 1024 ** 2 });
                probe = JSON.parse(stdout);
            } catch { throw new BadRequestException('Video could not be validated. Check FFmpeg installation and file contents.'); }
            const video = probe.streams.find(s => s.codec_type === 'video');
            const duration = Number(probe.format.duration);
            const mp4 = item.mimeType === 'video/mp4';
            if (!video || !Number.isFinite(duration) || duration <= 0 || duration > this.config.maxDuration ||
                !Number.isFinite(video.width) || !Number.isFinite(video.height) || video.width <= 0 || video.height <= 0 ||
                Math.max(video.width, video.height) > 3840 || Math.min(video.width, video.height) > 2160 ||
                !(mp4 ? probe.format.format_name.includes('mp4') && video.codec_name === 'h264' : probe.format.format_name.includes('webm') && ['vp8', 'vp9', 'av1'].includes(video.codec_name)) ||
                probe.streams.some(s => s.codec_type === 'audio' && !(mp4 ? ['aac', 'mp3'] : ['opus', 'vorbis']).includes(s.codec_name))) {
                throw new BadRequestException(`Use MP4 (H.264) or WebM video, up to ${this.config.maxDuration} seconds and 4K dimensions.`);
            }
            await execute(this.config.ffmpeg, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', source, '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2', '-an', '-y', this.poster(item.id)], { timeout: 15000, maxBuffer: 1024 ** 2 });
            const posterSize = (await stat(this.poster(item.id))).size;
            if (posterSize > 1024 ** 2) throw new BadRequestException('Video poster is too large');
            await this.repository.update(item.id, { status: 'ready', width: video.width, height: video.height, duration, error: null, reservedBytes: item.size + posterSize });
        }
    }
}
