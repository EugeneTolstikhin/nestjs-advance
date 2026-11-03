import { LoggingMiddleware } from './logging.middleware';
import type { Request, Response } from 'express';

it('logs the original URL even when mounted middleware sees a shortened URL', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
        const next = vi.fn();
        new LoggingMiddleware().use({ method: 'GET', url: '/', originalUrl: '/media/files/abc?preview=1' } as Request, {} as Response, next);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('GET /media/files/abc?preview=1'));
        expect(next).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
});
