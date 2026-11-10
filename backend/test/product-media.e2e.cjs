const { CheckoutSession, StockReservation } = require(`${process.env.TEST_BUILD_DIR || '../dist'}/checkout/checkout-session.entity`);
const { before, beforeEach, afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile, stat, readdir, mkdir, writeFile } = require('node:fs/promises');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const request = require('supertest');
const { Test } = require('@nestjs/testing');
const { JwtService } = require('@nestjs/jwt');
const { DataSource } = require('typeorm');
const { getDataSourceToken } = require('@nestjs/typeorm');
const { AppModule } = require('../dist/app.module');
const { Products } = require('../dist/products/products.entity');
const { ProductMedia } = require('../dist/products/media/product-media.entity');
const { ProductMediaService } = require('../dist/products/media/product-media.service');
const { AuthStateStore, MemoryAuthStateStore } = require('../dist/auth/storage/auth-state.store');
const { configureViews } = require('../dist/views.config');
let app, api, db, directory, token, other, buyer, service, image, video, webm, longVideo, previous;
const auth = req => req.set('Authorization', `Bearer ${token}`);
const ticket = (name, type, bytes) => auth(api.post('/media/tickets')).send({ name, type, size: bytes.length }).expect(201);
const start = async t => auth(api.post('/media/uploads')).set('Tus-Resumable', '1.0.0').set('Upload-Length', String(t.size)).set('Upload-Metadata', `ticket ${Buffer.from(t.id).toString('base64')}`).expect(201);
const patch = (id, bytes, offset = 0) => auth(api.patch(`/media/uploads/${id}`)).set('Tus-Resumable', '1.0.0').set('Upload-Offset', String(offset)).set('Content-Type', 'application/offset+octet-stream').send(bytes);
async function upload(bytes, type = 'image/png', name = 'photo.png') {
    const response = await ticket(name, type, bytes); const id = response.body.id;
    await start({ id, size: bytes.length }); await patch(id, bytes).expect(204);
    return (await auth(api.get(`/media/tickets/${id}`)).expect(200)).body;
}
before(async () => {
    image = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#526b44' } }).png().toBuffer();
    const temp = await mkdtemp(join(tmpdir(), 'media-video-'));
    try {
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:d=0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(temp, 'video.mp4')]);
        video = await readFile(join(temp, 'video.mp4'));
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:d=0.4', '-c:v', 'libvpx-vp9', '-y', join(temp, 'video.webm')]);
        webm = await readFile(join(temp, 'video.webm'));
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(temp, 'long.mp4')]);
        longVideo = await readFile(join(temp, 'long.mp4'));
    } finally { await rm(temp, { recursive: true, force: true }); }
});
beforeEach(async () => {
    previous = Object.fromEntries(['JWT_SECRET', 'MEDIA_STORAGE_DIR', 'MEDIA_MAX_FILES', 'MEDIA_MAX_VIDEOS', 'MEDIA_IMAGE_MAX_BYTES', 'MEDIA_VIDEO_MAX_BYTES', 'MEDIA_PRODUCT_MAX_BYTES', 'MEDIA_STORAGE_MAX_BYTES', 'MEDIA_UPLOAD_TTL_SECONDS'].map(key => [key, process.env[key]]));
    directory = await mkdtemp(join(tmpdir(), 'nestjs-media-'));
    Object.assign(process.env, { JWT_SECRET: 'test-only-secret-with-at-least-32-characters', MEDIA_STORAGE_DIR: directory,
        MEDIA_MAX_FILES: '4', MEDIA_MAX_VIDEOS: '2', MEDIA_IMAGE_MAX_BYTES: '32768', MEDIA_VIDEO_MAX_BYTES: '65536',
        MEDIA_PRODUCT_MAX_BYTES: '131072', MEDIA_STORAGE_MAX_BYTES: '4194304', MEDIA_UPLOAD_TTL_SECONDS: '86400' });
    await boot();
});
async function boot() {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(AuthStateStore).useFactory({ factory: () => new MemoryAuthStateStore() })
        .overrideProvider(getDataSourceToken()).useFactory({ factory: () => new DataSource({ type: 'better-sqlite3', database: join(directory, 'test.sqlite'), entities: [Products, ProductMedia, CheckoutSession, StockReservation], synchronize: true }).initialize() }).compile();
    app = moduleRef.createNestApplication({ logger: false }); await configureViews(app); await app.init();
    db = moduleRef.get(DataSource); service = moduleRef.get(ProductMediaService); api = request(app.getHttpServer());
    const jwt = moduleRef.get(JwtService);
    token = await jwt.signAsync({ sub: 'seller-a', roles: ['seller'] });
    other = await jwt.signAsync({ sub: 'seller-b', roles: ['seller'] });
    buyer = await jwt.signAsync({ sub: 'buyer', roles: ['buyer'] });
}

afterEach(async () => {
    await app?.close(); await rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
});

test('tus upload resumes at its stored offset, keeps drafts private, and publishes an ordered photo/video gallery', async () => {
    const t = (await ticket('photo.png', 'image/png', image)).body;
    const created = await start({ id: t.id, size: image.length }); assert.match(created.headers.location, new RegExp(t.id));
    const half = Math.floor(image.length / 2);
    await patch(t.id, image.subarray(0, half)).expect(204);
    const head = await auth(api.head(`/media/uploads/${t.id}`)).set('Tus-Resumable', '1.0.0').expect(200);
    assert.equal(Number(head.headers['upload-offset']), half);
    await patch(t.id, image.subarray(half), 0).expect(409);
    await patch(t.id, image.subarray(half), half).expect(204);
    const photo = (await auth(api.get(`/media/tickets/${t.id}`)).expect(200)).body;
    assert.equal(photo.status, 'ready');
    await api.get(photo.url).expect(404);
    await auth(api.get(photo.url)).expect(200).expect('Content-Type', /image\/webp/).expect('Cache-Control', 'private, no-store');
    const movie = await upload(video, 'video/mp4', 'clip.mp4');
    assert.equal(movie.kind, 'video'); assert.ok(movie.duration > 0);
    const product = await auth(api.post('/products')).send({ name: 'Gallery product', description: 'Test', price: 10, mediaIds: [movie.id, photo.id] }).expect(201);
    const id = product.body.id;
    assert.deepEqual(product.body.media.map(m => m.id), [movie.id, photo.id]);
    await api.get(movie.url).expect(200).expect('Content-Type', /video\/mp4/).expect('Accept-Ranges', 'bytes');
    const range = await api.get(movie.url).set('Range', 'bytes=0-9').expect(206);
    assert.equal(Number(range.headers['content-length']), 10);
    await api.get(movie.poster).expect(200).expect('Content-Type', /image\/jpeg/);
    const shop = await api.get('/shop').expect(200);
    assert.match(shop.text, /data-carousel/); assert.match(shop.text, /<video/); assert.match(shop.text, /product-carousel.js/);
    await auth(api.patch(`/products/${id}`)).send({ mediaIds: [photo.id, movie.id] }).expect(200);
    assert.deepEqual((await api.get(`/products/${id}`)).body.media.map(m => m.id), [photo.id, movie.id]);
    await auth(api.delete(`/products/${id}`)).expect(200);
    await api.get(photo.url).expect(404); await api.get(movie.url).expect(404);
    await assert.rejects(stat(join(directory, 'ready', `${photo.id}.webp`)));
    assert.deepEqual(await readdir(join(directory, 'uploads')), []);
});

test('cancelled media downloads do not log application errors or attempt another response', async () => {
    const product = (await auth(api.post('/products')).send({ name: 'Cancellation test', description: 'Test', price: 1 }).expect(201)).body;
    const id = randomUUID();
    const bytes = Buffer.alloc(16 * 1024 * 1024, 1);
    // A previously validated, published file: this test exercises transport cancellation only.
    await mkdir(join(directory, 'uploads'), { recursive: true });
    await writeFile(join(directory, 'uploads', id), bytes);
    await db.getRepository(ProductMedia).save({ id, ownerId: 'seller-a', productId: product.id,
        position: 0, originalName: 'clip.mp4', kind: 'video', mimeType: 'video/mp4',
        size: bytes.length, reservedBytes: bytes.length, status: 'ready', error: null,
        expiresAt: Date.now() + 86400000, width: 32, height: 32, duration: 1 });
    const errors = [];
    app.useLogger({ log() {}, warn() {}, error(...args) { errors.push(args); } });
    await app.listen(0, '127.0.0.1');
    const server = app.getHttpServer();
    const path = `/media/files/${id}`;
    let endedAfterClose = 0;
    const serverClosed = new Promise(resolve => {
        server.once('request', (_req, res) => {
            let closed = false;
            const end = res.end;
            res.end = function (...args) { if (closed) endedAfterClose++; return end.apply(this, args); };
            res.once('close', () => { closed = true; resolve(res.writableFinished); });
        });
    });
    await new Promise((resolve, reject) => {
        const client = http.get(`http://127.0.0.1:${server.address().port}${path}`, res => {
            res.once('data', () => { client.destroy(); resolve(); });
            res.on('error', () => {});
        });
        client.setTimeout(3000, () => { client.destroy(); reject(new Error('Download timed out')); });
        client.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    });
    assert.equal(await serverClosed, false);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(errors, []);
    assert.equal(endedAfterClose, 0);
    await api.get(path).set('Range', 'bytes=0-15').expect(206).expect('Content-Length', '16');
});

test('uploads require seller authentication and ownership on every resume/status request', async () => {
    await api.post('/media/tickets').send({ name: 'x.png', type: 'image/png', size: image.length }).expect(401);
    await api.post('/media/tickets').set('Authorization', `Bearer ${buyer}`).send({ name: 'x.png', type: 'image/png', size: image.length }).expect(403);
    const t = (await ticket('photo.png', 'image/png', image)).body;
    await start({ id: t.id, size: image.length });
    await api.head(`/media/uploads/${t.id}`).set('Tus-Resumable', '1.0.0').expect(401);
    await api.head(`/media/uploads/${t.id}`).set('Authorization', `Bearer ${other}`).set('Tus-Resumable', '1.0.0').expect(404);
    await api.get(`/media/tickets/${t.id}`).set('Authorization', `Bearer ${other}`).expect(404);
    await api.get(`/media/uploads/${t.id}`).set('Authorization', `Bearer ${token}`).expect(405);
    await auth(api.patch(`/media/uploads/${t.id}`)).set('Origin', 'https://untrusted.example').set('Tus-Resumable', '1.0.0').set('Upload-Offset', '0').set('Content-Type', 'application/offset+octet-stream').send(image).expect(403);
    await patch(t.id, image).expect(204);
    await api.post('/products').set('Authorization', `Bearer ${other}`).send({ name: 'Stolen', description: 'x', price: 1, mediaIds: [t.id] }).expect(403);
    assert.equal(await db.getRepository(Products).count(), 0);
});

test('invalid content, oversized files, unready media and duplicate IDs are rejected', async () => {
    await auth(api.post('/media/tickets')).send({ name: 'large.png', type: 'image/png', size: 32769 }).expect(413);
    await auth(api.post('/media/tickets')).send({ name: 'script.svg', type: 'image/svg+xml', size: 20 }).expect(400);
    const fake = Buffer.from('<html>not an image</html>');
    const t = (await ticket('fake.png', 'image/png', fake)).body;
    await start({ id: t.id, size: fake.length }); await patch(t.id, fake).expect(422);
    const state = (await auth(api.get(`/media/tickets/${t.id}`))).body; assert.equal(state.status, 'failed');
    await auth(api.get(`/media/files/${t.id}`)).expect(404);
    const pending = (await ticket('pending.png', 'image/png', image)).body;
    await auth(api.post('/products')).send({ name: 'Not ready', description: 'x', price: 1, mediaIds: [pending.id] }).expect(403);
    const photo = await upload(image);
    await auth(api.post('/products')).send({ name: 'Duplicates', description: 'x', price: 1, mediaIds: [photo.id, photo.id] }).expect(400);
    assert.equal(await db.getRepository(Products).count(), 0);
});

test('pending upload quotas and expired upload cleanup are enforced', async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await ticket(`${i}.png`, 'image/png', image)).body.id);
    await auth(api.post('/media/tickets')).send({ name: 'too-many.png', type: 'image/png', size: image.length }).expect(429);
    await db.getRepository(ProductMedia).update(ids[0], { expiresAt: Date.now() - 1 });
    await auth(api.get(`/media/tickets/${ids[0]}`)).expect(410);
    await service.cleanup();
    assert.equal(await db.getRepository(ProductMedia).findOneBy({ id: ids[0] }), null);
    await ticket('replacement.png', 'image/png', image);
});

test('removing the legacy image URL column preserves products and their uploaded galleries', async () => {
    const photo = await upload(image);
    const product = (await auth(api.post('/products')).send({ name: 'Existing product', description: 'Keep this', price: 10, mediaIds: [photo.id] }).expect(201)).body;
    await db.query('ALTER TABLE products ADD COLUMN imageUrl TEXT');
    await db.query('UPDATE products SET imageUrl = ? WHERE id = ?', ['https://example.com/old.jpg', product.id]);
    await db.synchronize();
    const columns = await db.query('PRAGMA table_info(products)');
    assert.equal(columns.some(column => column.name === 'imageUrl'), false);
    const restored = (await api.get(`/products/${product.id}`).expect(200)).body;
    assert.equal(restored.name, 'Existing product');
    assert.deepEqual(restored.media.map(item => item.id), [photo.id]);
    assert.equal('imageUrl' in restored, false);
    await api.get(photo.url).expect(200);
});

test('the official tus client resumes an interrupted local upload without creating a second ticket', async () => {
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    const t = (await ticket('resume.png', 'image/png', image)).body;
    await start({ id: t.id, size: image.length });
    const half = Math.floor(image.length / 2);
    await patch(t.id, image.subarray(0, half)).expect(204);
    const { Upload } = require('tus-js-client');
    await new Promise((resolve, reject) => {
        const uploader = new Upload(image, { endpoint: `${base}/media/uploads`, uploadUrl: `${base}/media/uploads/${t.id}`,
            headers: { Authorization: `Bearer ${token}` }, metadata: { ticket: t.id },
            chunkSize: 64, retryDelays: [], onSuccess: resolve, onError: reject });
        uploader.start();
    });
    assert.equal((await auth(api.get(`/media/tickets/${t.id}`))).body.status, 'ready');
    assert.equal(await db.getRepository(ProductMedia).count(), 1);
});


test('upload offsets and staged media survive an application restart', async () => {
    const t = (await ticket('restart.png', 'image/png', image)).body;
    await start({ id: t.id, size: image.length });
    const half = Math.floor(image.length / 2); await patch(t.id, image.subarray(0, half)).expect(204);
    await app.close(); await boot();
    const head = await auth(api.head(`/media/uploads/${t.id}`)).set('Tus-Resumable', '1.0.0').expect(200);
    assert.equal(Number(head.headers['upload-offset']), half);
    await patch(t.id, image.subarray(half), half).expect(204);
    assert.equal((await auth(api.get(`/media/tickets/${t.id}`))).body.status, 'ready');
});

test('WebM is supported and video duration and image dimensions are validated', async () => {
    const clip = await upload(webm, 'video/webm', 'clip.webm'); assert.equal(clip.status, 'ready');
    service.config.maxDuration = 1;
    const t = (await ticket('long.mp4', 'video/mp4', longVideo)).body;
    await start({ id: t.id, size: longVideo.length }); await patch(t.id, longVideo).expect(422);
    assert.match((await auth(api.get(`/media/tickets/${t.id}`))).body.error, /up to 1 seconds/);
    service.config.maxPixels = 100;
    const photo = (await ticket('dimensions.png', 'image/png', image)).body;
    await start({ id: photo.id, size: image.length }); await patch(photo.id, image).expect(422);
});

test('server-side storage, product byte and video-count limits cannot be bypassed', async () => {
    service.config.storageBytes = 1;
    await auth(api.post('/media/tickets')).send({ name: 'no-space.png', type: 'image/png', size: image.length }).expect(507);
    assert.equal(await db.getRepository(ProductMedia).count(), 0);
    service.config.storageBytes = 4 * 1024 ** 2;
    const one = await upload(image), two = await upload(image);
    service.config.productBytes = image.length + 1;
    await auth(api.post('/products')).send({ name: 'Too large', description: 'x', price: 1, mediaIds: [one.id, two.id] }).expect(400);
    service.config.productBytes = 131072; service.config.maxVideos = 1;
    const first = await upload(video, 'video/mp4', 'one.mp4'), second = await upload(video, 'video/mp4', 'two.mp4');
    await auth(api.post('/products')).send({ name: 'Too many videos', description: 'x', price: 1, mediaIds: [first.id, second.id] }).expect(400);
    assert.equal(await db.getRepository(Products).count(), 0);
});

test('the actual browser tus bundle and uploader send bulk files using the browser session cookie', async () => {
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    const { Window } = require('happy-dom');
    const window = new Window({ url: base + '/shop/new', settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
    try {
        window.document.cookie = `nest_session=${token}; Path=/`;
        window.URL.createObjectURL = () => 'blob:preview'; window.URL.revokeObjectURL = () => {};
        window.document.body.innerHTML = '<section id="uploads"></section>';
        window.eval(await readFile('node_modules/tus-js-client/dist/tus.min.js', 'utf8'));
        window.eval(await readFile('dist/public/media-uploader.js', 'utf8'));
        const uploader = await window.ProductMediaUploader.create(window.document.getElementById('uploads'));
        uploader.add([new window.File([image], 'browser.png', { type: 'image/png' }), new window.File([webm], 'browser.webm', { type: 'video/webm' })]);
        const deadline = Date.now() + 10000;
        while (uploader.items.some(item => item.state !== 'ready') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        assert.deepEqual(Array.from(uploader.items, item => item.state), ['ready', 'ready'], uploader.items.map(item => item.error).join('; '));
        uploader.move(uploader.items[1], -1);
        const result = await auth(api.post('/products')).send({ name: 'Browser gallery', description: 'Bulk media', price: 1, mediaIds: uploader.ids() }).expect(201);
        assert.deepEqual(result.body.media.map(item => item.kind), ['video', 'image']);
        await uploader.markSaved();
        assert.equal(window.localStorage.length, 0);
    } finally {
        window.dispatchEvent(new window.Event('pagehide')); await window.happyDOM.abort(); window.close();
    }
});
process.env.JOBS_DRIVER ??= 'inline';
