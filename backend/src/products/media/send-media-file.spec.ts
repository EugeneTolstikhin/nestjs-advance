import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { sendMediaFile } from './send-media-file';

describe('Media response disconnect handling', () => {
    let request: Request;
    let response: Response;
    let sendFile: ReturnType<typeof vi.fn>;
    let callback: (error?: Error) => void;
    const error = (code: string, syscall?: string) => Object.assign(new Error(code), { code, syscall });
    beforeEach(() => {
        // A completed incoming GET is not evidence that the response was cancelled.
        request = { aborted: false, destroyed: true } as Request;
        sendFile = vi.fn((_path, _options, done) => { callback = done; });
        response = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false,
            socket: { destroyed: false }, sendFile, end: vi.fn(), write: vi.fn() }) as unknown as Response;
    });
    it('serves successful files with Range support and removes its listener', async () => {
        const transfer = sendMediaFile(request, response, '/tmp/media'); callback();
        await expect(transfer).resolves.toBeUndefined();
        expect(sendFile).toHaveBeenCalledWith('/tmp/media', { cacheControl: false, acceptRanges: true }, expect.any(Function));
        expect(response.listenerCount('close')).toBe(0);
    });
    it.each(['ECONNABORTED', 'ECONNRESET', 'EPIPE'])('quietly finishes %s after a premature response close', async code => {
        const transfer = sendMediaFile(request, response, '/tmp/media');
        response.emit('close'); callback(error(code, code === 'EPIPE' ? 'write' : undefined));
        await expect(transfer).resolves.toBeUndefined();
        expect(response.end).not.toHaveBeenCalled(); expect(response.write).not.toHaveBeenCalled();
        expect(response.listenerCount('close')).toBe(0);
    });
    it('allows the socket close to arrive after the EPIPE callback', async () => {
        const transfer = sendMediaFile(request, response, '/tmp/media'); callback(error('EPIPE', 'write'));
        process.nextTick(() => response.emit('close'));
        await expect(transfer).resolves.toBeUndefined();
    });
    it('does not start a transfer on an already closed socket', async () => {
        Object.defineProperty(response.socket, 'destroyed', { value: true });
        await expect(sendMediaFile(request, response, '/tmp/media')).resolves.toBeUndefined();
        expect(sendFile).not.toHaveBeenCalled();
    });
    it.each(['ECONNABORTED', 'ECONNRESET', 'EPIPE'])('reports %s when the connection is still open', async code => {
        const failure = error(code, code === 'EPIPE' ? 'write' : undefined);
        const transfer = sendMediaFile(request, response, '/tmp/media'); callback(failure);
        await expect(transfer).rejects.toBe(failure);
        expect(response.listenerCount('close')).toBe(0);
    });
    it.each(['ENOENT', 'EACCES', 'EIO'])('preserves genuine %s errors, even if a disconnect also happened', async code => {
        const failure = error(code, 'read');
        const transfer = sendMediaFile(request, response, '/tmp/media'); response.emit('close'); callback(failure);
        await expect(transfer).rejects.toBe(failure);
    });
    it('preserves synchronous sendFile errors and removes its listener', async () => {
        const failure = new Error('Invalid transfer setup'); sendFile.mockImplementation(() => { throw failure; });
        await expect(sendMediaFile(request, response, '/tmp/media')).rejects.toBe(failure);
        expect(response.listenerCount('close')).toBe(0);
    });
});
