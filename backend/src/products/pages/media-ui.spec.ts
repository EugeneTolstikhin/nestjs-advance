import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const uploaderScript = readFileSync('src/public/media-uploader.js', 'utf8');
const carouselScript = readFileSync('src/public/product-carousel.js', 'utf8');
const id = 'ded54f80-10bc-4dd6-a213-66e3e1b6dc42';

describe('Bulk media UI and buyer carousel', () => {
    let window: Window;
    let fetchMock: ReturnType<typeof vi.fn>;
    let manager: any;
    let uploads: any[];
    let finishAutomatically: boolean;
    let previous: any[];
    const config = { endpoint: '/media/uploads', maxFiles: 3, maxVideos: 1, imageBytes: 1024 ** 2, videoBytes: 2 * 1024 ** 2,
        productBytes: 3 * 1024 ** 2, maxDuration: 120, accept: 'image/jpeg,image/png,image/webp,video/mp4,video/webm' };
    const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    beforeEach(() => {
        window = new Window({ url: 'http://localhost:3000', settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
        window.document.body.innerHTML = '<section id="media"></section>';
        uploads = []; previous = []; finishAutomatically = true;
        window.URL.createObjectURL = vi.fn().mockReturnValue('blob:preview'); window.URL.revokeObjectURL = vi.fn();
        const FakeUpload = class {
            options: any; url?: string;
            constructor(_file: any, options: any) { this.options = options; uploads.push(this); }
            async findPreviousUploads() { return previous; }
            resumeFromPreviousUpload(record: any) { this.url = record.uploadUrl; }
            async abort() {}
            start() {
                this.url ??= `http://localhost:3000/media/uploads/${this.options.metadata.ticket}`;
                this.options.onUploadUrlAvailable?.();
                this.options.onProgress?.(50);
                if (finishAutomatically) queueMicrotask(() => this.options.onSuccess());
            }
        };
        (window as any).tus = { Upload: FakeUpload };
        let count = 0;
        fetchMock = vi.fn().mockImplementation(async (path: string, options: any) => {
            if (path === '/media/config') return response(config);
            if (path === '/media/tickets') return response({ id: `ded54f80-10bc-4dd6-a213-${String(++count).padStart(12, '0')}` });
            if (options?.method === 'DELETE') return { ok: true, status: 204 };
            return response({ status: 'ready', url: '/media/files/ready', attached: false });
        });
        window.fetch = fetchMock; window.eval(uploaderScript);
    });
    afterEach(() => { window.dispatchEvent(new window.Event('pagehide')); window.happyDOM.abort(); window.close(); vi.restoreAllMocks(); });
    async function create(initial: any[] = []) { manager = await (window as any).ProductMediaUploader.create(window.document.getElementById('media'), initial); return manager; }
    function photo(name = 'photo.png', size = 20) { return new window.File([new Uint8Array(size)], name, { type: 'image/png' }); }

    it('uploads a bulk selection and preserves its order when uploads complete', async () => {
        await create(); manager.add([photo('first.png'), photo('second.png')]);
        await vi.waitFor(() => expect(manager.items.every((item: any) => item.state === 'ready')).toBe(true));
        expect(manager.ids()).toHaveLength(2);
        expect(uploads).toHaveLength(2);
        expect(manager.items.map((item: any) => item.name)).toEqual(['first.png', 'second.png']);
        expect(uploads[0].options.chunkSize).toBe(5 * 1024 ** 2);
        expect(uploads[0].options.metadata.ticket).toBe(manager.ids()[0]);
        manager.items[1].earlier.click();
        expect(manager.items.map((item: any) => item.name)).toEqual(['second.png', 'first.png']);
    });
    it('enforces file types, individual sizes and product counts before allocating tickets', async () => {
        await create();
        manager.add([new window.File(['x'], 'script.svg', { type: 'image/svg+xml' })]);
        expect(manager.items).toHaveLength(0);
        manager.add([photo('large.png', config.imageBytes + 1)]); expect(manager.items).toHaveLength(0);
        manager.add([photo('1.png'), photo('2.png'), photo('3.png'), photo('4.png')]); expect(manager.items).toHaveLength(0);
        expect(fetchMock.mock.calls.filter(([path]) => path === '/media/tickets')).toHaveLength(0);
    });
    it('pauses and resumes the same ticket and blocks saving pending media', async () => {
        finishAutomatically = false; await create(); manager.add([photo()]);
        await vi.waitFor(() => expect(uploads[0]?.url).toBeDefined());
        const item = manager.items[0], firstId = item.id;
        expect(() => manager.ids()).toThrow('pending uploads');
        await manager.pauseOrRetry(item);
        await vi.waitFor(() => expect(manager.active).toBe(0));
        expect(item.state).toBe('paused');
        finishAutomatically = true; await manager.pauseOrRetry(item);
        await vi.waitFor(() => expect(item.state).toBe('ready'));
        expect(item.id).toBe(firstId);
        expect(fetchMock.mock.calls.filter(([path]) => path === '/media/tickets')).toHaveLength(1);
    });
    it('reuses a previous interrupted tus URL after reselecting the file', async () => {
        previous = [{ uploadUrl: `http://localhost:3000/media/uploads/${id}` }];
        let reads = 0;
        fetchMock.mockImplementation(async (path: string) => path === '/media/config' ? response(config)
            : response({ status: ++reads === 1 ? 'uploading' : 'ready', url: '/media/files/ready', attached: false }));
        await create(); manager.add([photo()]);
        await vi.waitFor(() => expect(manager.items[0]?.state).toBe('ready'));
        expect(manager.ids()).toEqual([id]);
        expect(fetchMock.mock.calls.some(([path]) => path === '/media/tickets')).toBe(false);
    });
    it('removes new uploads through the server, but defers existing gallery removals until product save', async () => {
        await create([{ id, kind: 'image', name: 'saved.png', size: 20, url: '/media/files/saved' }]);
        await manager.remove(manager.items[0]);
        expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
        manager.add([photo()]); await vi.waitFor(() => expect(manager.items[0]?.state).toBe('ready'));
        const uploaded = manager.items[0].id; await manager.remove(manager.items[0]);
        expect(fetchMock.mock.calls.some(([path, options]) => path === `/media/tickets/${uploaded}` && options?.method === 'DELETE')).toBe(true);
        expect(manager.ids()).toEqual([]);
    });
    it('waits for background processing before allowing the product to be saved', async () => {
        let ready = false;
        fetchMock.mockImplementation(async (path: string) => {
            if (path === '/media/config') return response(config);
            if (path === '/media/tickets') return response({ id });
            return response({ status: ready ? 'ready' : 'processing', url: '/media/files/ready', attached: false });
        });
        await create(); manager.add([photo()]);
        await vi.waitFor(() => expect(manager.items[0]?.state).toBe('processing'));
        expect(manager.items[0].label.textContent).toContain('Processing');
        expect(() => manager.ids()).toThrow('pending uploads');
        expect(manager.items[0].retry.hidden).toBe(true);
        ready = true;
        await vi.waitFor(() => expect(manager.items[0]?.state).toBe('ready'), { timeout: 2000 });
        expect(manager.ids()).toEqual([id]);
    });
    it('can remove a file while its background processing is pending', async () => {
        fetchMock.mockImplementation(async (path: string, options: any) => {
            if (path === '/media/config') return response(config);
            if (path === '/media/tickets') return response({ id });
            if (options?.method === 'DELETE') return response({}, 204);
            return response({ status: 'processing', attached: false });
        });
        await create(); manager.add([photo()]);
        await vi.waitFor(() => expect(manager.items[0]?.state).toBe('processing'));
        await manager.remove(manager.items[0]);
        expect(manager.items).toHaveLength(0);
        expect(manager.ids()).toEqual([]);
    });
    it('shows both photos and videos in a keyboard-controlled carousel and pauses hidden video', () => {
        window.document.body.innerHTML = `<div data-carousel tabindex="0"><div class="carousel-slide"><img alt="Photo"></div><div class="carousel-slide" hidden><video controls></video></div><div class="carousel-navigation" hidden><button data-carousel-prev>Previous</button><span data-carousel-count></span><button data-carousel-next>Next</button></div><div class="carousel-thumbnails" hidden><button data-carousel-thumb>Photo</button><button data-carousel-thumb>Video</button></div></div>`;
        const video = window.document.querySelector('video')!;
        const pause = vi.spyOn(video, 'pause').mockImplementation(() => {});
        window.eval(carouselScript);
        const carousel = window.document.querySelector('[data-carousel]')!;
        const slides = window.document.querySelectorAll('.carousel-slide');
        window.document.querySelector('[data-carousel-next]')!.click();
        expect(slides[0].hidden).toBe(true); expect(slides[1].hidden).toBe(false);
        expect(window.document.querySelector('[data-carousel-count]')!.textContent).toBe('2 / 2');
        const count = pause.mock.calls.length;
        video.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        expect(slides[1].hidden).toBe(false);
        carousel.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        expect(slides[0].hidden).toBe(false); expect(pause.mock.calls.length).toBeGreaterThan(count);
        expect(video.hasAttribute('autoplay')).toBe(false);
    });
});
