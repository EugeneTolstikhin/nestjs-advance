# Product photos and videos

Sellers can select multiple files in the product editor, drag files into the upload
area, preview them, pause/retry individual uploads, remove them and reorder them
with drag-and-drop or **Move earlier/later** buttons. Two files upload at once.
Ready files are attached atomically when the product is saved. The first selected
item is the first buyer gallery slide. Products without uploaded media show a
placeholder. External image URLs are no longer accepted; upload files instead.
The old URL column is removed by local schema synchronization on the next start.

Buyers see an ordered photo/video carousel in `/shop`, with thumbnails, previous/
next controls and Left/Right/Home/End keyboard navigation. Videos have native
controls and poster images, never autoplay, and pause when their slide is hidden.
The video player's own keyboard shortcuts remain available. Single-file galleries
hide unnecessary navigation controls.

## Local setup

The Node dependencies are installed with `npm install`. Video validation and poster
creation use FFmpeg and ffprobe. These were installed locally with:

```sh
brew install ffmpeg
```

Restart the backend after installing dependencies. In local development TypeORM
creates the `product_media` table (`synchronize` is disabled in production, where
schema migrations must be applied). Files are stored outside `src` and `dist` in:

```text
backend/storage/product-media/uploads/   # tus bytes and resumable upload metadata
backend/storage/product-media/ready/     # normalized WebP photos and video posters
```

This directory is ignored by Git and survives builds/restarts. Back it up together
with `database.sqlite`; changing the storage directory without moving its contents
makes old file references unavailable. No storage directory is publicly mounted.
Files are served through the media controller only after readiness/access checks.

Media processing now uses BullMQ and requires Redis when running the application.
Workers start automatically with Nest. Upload bytes finish first; the editor shows
**Processing…** while validation/conversion/poster generation runs, then **Ready**
or an error. Only ready media can be attached. See [JOBS.md](./JOBS.md) for queue
configuration, retries, recovery and extension points.

## Default limits

| Limit | Default |
| --- | --- |
| Files per product | 10 |
| Videos per product | 3 |
| Original photo size | 10 MiB |
| Original video size | 100 MiB |
| Combined original bytes per product | 250 MiB |
| Video duration | 120 seconds |
| Video dimensions | At most 3840 on the longer side and 2160 on the shorter side |
| Photo decoded pixels | 40 million |
| Pending files per uploader | 10 |
| Pending original bytes per uploader | 500 MiB |
| Local media storage reservation quota | 2 GiB |
| New upload tickets per account | 30 per hour |
| Active byte streams | 2 per account, 8 per process |
| Unsaved upload lifetime | 24 hours |

Supported input: JPEG, PNG, WebP photos; MP4 with H.264 video and AAC/MP3 audio;
WebM with VP8/VP9/AV1 video and Opus/Vorbis audio. SVG, GIF, HEIC, MOV and
HEVC/H.265 are not accepted. Export unsupported phone videos as H.264 MP4 first.
Animated images are rejected. File signatures and actual decoded/probed contents
must match the declared type. Photos are rotated, resized inside 2560x2560 and
converted to WebP with metadata stripped. Videos are validated without transcoding,
and a JPEG poster is generated. Network input protocols are disallowed during
probing/poster processing. Processing has timeouts and is serialized per process.

File count/type/size checks run in the UI and again on the server. Product byte and
video-count checks run transactionally when attaching files; invalid media rolls
back the product write. Quotas reserve space before the upload, including allowance
for derived files, so the storage quota can reject an upload before its input-byte
sum reaches 2 GiB. Video delivery supports HTTP Range/206 for seeking.

Optional `.env` overrides (byte values use bytes, not MiB):

```dotenv
# Defaults shown; omit values you don't need to change.
MEDIA_STORAGE_DIR=./storage/product-media
MEDIA_MAX_FILES=10
MEDIA_MAX_VIDEOS=3
MEDIA_IMAGE_MAX_BYTES=10485760
MEDIA_VIDEO_MAX_BYTES=104857600
MEDIA_PRODUCT_MAX_BYTES=262144000
MEDIA_STORAGE_MAX_BYTES=2147483648
MEDIA_DRAFT_MAX_BYTES=524288000
MEDIA_VIDEO_MAX_SECONDS=120
MEDIA_IMAGE_MAX_PIXELS=40000000
MEDIA_UPLOAD_TTL_SECONDS=86400
# Use explicit paths if the app's PATH does not contain Homebrew binaries:
# FFPROBE_PATH=/opt/homebrew/bin/ffprobe
# FFMPEG_PATH=/opt/homebrew/bin/ffmpeg
```

Values must be positive integers. The DTO caps a media-ID list at 100 entries;
configure `MEDIA_MAX_FILES` at or below that bound. User-provided names never become
filesystem paths; stored files use server-generated UUIDs.

## Resuming and cleanup

Uploads use the official tus server/file store and tus-js-client. The browser sends
5 MiB chunks and stores upload fingerprints/URLs (not JWTs or file contents) in
local browser storage. After refreshing/reopening the editor, **reselect the same
local file** to resume an interrupted upload or recover a completed, unsaved file.
Browsers still require access to the original file. Unsaved ordering/selection is
not automatically restored without reselection. Fingerprints are removed after
product save or explicit file removal.

Every tus request checks the session/Bearer token, seller role, same-origin policy,
upload ownership and expiry. A 15-minute session may expire during a long upload:
log in in another tab, then choose Retry / resume. Progress is retained while the
upload remains unexpired. Application restarts preserve upload offsets in local
files and metadata in SQLite. Validation recovery handles a complete byte stream
left by an interrupted finalization.

Unattached media is private to its uploader. Finished files become public only
when attached to a saved product. Existing shared-catalog permissions remain:
sellers can edit any catalog product, including reordering/removing its saved
media. A seller cannot attach another seller's unpublished upload or media already
attached to another product. Removing an existing item from the editor is deferred
until product save; canceling preserves the old gallery. Deleting a product removes
its media as well. Removing a new upload cancels transmission and marks it for
cleanup. The cleanup pass runs every ten minutes and before allocating new tickets;
active streams are skipped, and unsaved expired uploads are removed. Files marked
deleted are inaccessible immediately, even before physical cleanup completes.

The local media module currently targets **one Node process on one machine**.
Its BullMQ jobs are Redis-backed, but file-operation locks, byte-stream admission
control, and tus locks are process-local. Before
running multiple upload workers, use shared file storage, a shared tus locker and
coordinated quota/concurrency management. Redis-backed auth/rate limits do not by
themselves make a local filesystem upload service distributed.

## API

- `GET /media/config`: supported formats and public upload limits.
- `POST /media/tickets`: seller-only JSON `{ "name": "photo.png", "type": "image/png", "size": 12345 }`.
- `POST /media/uploads`: tus creation with `Upload-Metadata: ticket <base64-ticket-id>` and the exact `Upload-Length`.
- `HEAD /media/uploads/:id`: retrieve the current offset.
- `PATCH /media/uploads/:id`: tus binary bytes (`application/offset+octet-stream`).
- `GET /media/tickets/:id`: uploader-only validation/status information.
- `DELETE /media/tickets/:id`: cancel/discard an unattached upload (cleanup is deferred).
- `GET /media/files/:id`: ready published file, or an authenticated uploader's private preview.
- `GET /media/files/:id/poster`: generated video poster, with the same access rules.

Tus HEAD/PATCH requests require `Tus-Resumable: 1.0.0`; PATCH requires the correct
`Upload-Offset`. Raw GET/DELETE through tus are disabled; use the controlled file
and discard endpoints instead. The JSON-only guard remains on product/auth APIs;
the dedicated upload guard permits tus binary traffic while preserving origin checks.

Product create/update/patch accepts optional `mediaIds: ["uuid", "uuid"]` in display
order. Omit `mediaIds` to preserve the gallery, or send `[]` to clear it. IDs never go
in the product body as an `id` field. Product JSON responses include an ordered
`media` array with URLs, kind, size, dimensions, duration and video poster links.

## Tests

```sh
npm test
npm run test:media
npm run test:jobs
```

The media integration suite uses temporary local directories and SQLite files. It
uploads real generated PNG/MP4/WebM data, resumes after a partial transfer and app
restart, exercises the official tus client, checks private/public access and HTTP
Range streaming, and verifies invalid content, ownership, expiry and quotas. It
uses the explicit inline job adapter and requires FFmpeg but no MongoDB/Redis
connection. `test:jobs` additionally exercises real BullMQ workers with local Redis.
Existing auth suites retain their
own isolated test databases. The browser DOM tests cover bulk selection, ordering,
pause/resume, removal, pending-save protection and mixed-media carousel navigation.
