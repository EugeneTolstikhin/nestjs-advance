import { resolve } from 'node:path';

export function mediaConfig() {
    const number = (name: string, fallback: number) => {
        const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
        if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
        return value;
    };
    return {
        directory: resolve(process.env.MEDIA_STORAGE_DIR ?? resolve(__dirname, '../../../storage/product-media')),
        maxFiles: number('MEDIA_MAX_FILES', 10), maxVideos: number('MEDIA_MAX_VIDEOS', 3),
        imageBytes: number('MEDIA_IMAGE_MAX_BYTES', 10 * 1024 ** 2),
        videoBytes: number('MEDIA_VIDEO_MAX_BYTES', 100 * 1024 ** 2),
        productBytes: number('MEDIA_PRODUCT_MAX_BYTES', 250 * 1024 ** 2),
        storageBytes: number('MEDIA_STORAGE_MAX_BYTES', 2 * 1024 ** 3),
        draftBytes: number('MEDIA_DRAFT_MAX_BYTES', 500 * 1024 ** 2),
        maxDuration: number('MEDIA_VIDEO_MAX_SECONDS', 120),
        maxPixels: number('MEDIA_IMAGE_MAX_PIXELS', 40_000_000),
        lifetime: number('MEDIA_UPLOAD_TTL_SECONDS', 86400) * 1000,
        ffprobe: process.env.FFPROBE_PATH ?? 'ffprobe', ffmpeg: process.env.FFMPEG_PATH ?? 'ffmpeg',
    };
}
export const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'];
