interface UploadEntry {
  id?: string;
  file?: File;
  name: string;
  kind: 'image' | 'video';
  type?: string;
  size: number;
  state: 'queued' | 'uploading' | 'paused' | 'processing' | 'ready' | 'failed';
  uploaded: number;
  url?: string;
  poster?: string | null;
  existing?: boolean;
  localUrl?: string | null;
  upload?: InstanceType<typeof tus.Upload>;
  uploadUrl?: string | null;
  pendingStatus?: MediaStatus | null;
  settle?: (() => void) | null;
  work?: Promise<void>;
  removing?: boolean;
  running?: boolean;
  invalid?: boolean;
  error?: string;
}
interface UploadItem extends UploadEntry {
  key: string;
  card: HTMLLIElement;
  preview: HTMLImageElement | HTMLVideoElement;
  label: HTMLParagraphElement;
  progress: HTMLProgressElement;
  earlier: HTMLButtonElement;
  later: HTMLButtonElement;
  retry: HTMLButtonElement;
  remove: HTMLButtonElement;
}
class MediaUploader {
  readonly input: HTMLInputElement;
  readonly notice: HTMLParagraphElement;
  readonly list: HTMLOListElement;
  readonly items: UploadItem[] = [];
  private active = 0;
  private locked = false;
  private stopped = false;
  private sequence = 0;
  private dragged: UploadItem | null = null;
  private node = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = '',
    cls = '',
  ): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (cls) element.className = cls;
    return element;
  };
  static async create(root: HTMLElement, initial: SavedMedia[] = []) {
    const response = await fetch('/media/config', {
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('Unable to load upload limits');
    return new this(root, await response.json(), initial);
  }
  constructor(
    readonly root: HTMLElement,
    readonly config: MediaConfig,
    initial: SavedMedia[],
  ) {
    const node = this.node;
    root.append(node('h2', 'Photos and videos'));
    root.append(
      node(
        'p',
        `Up to ${config.maxFiles} files (${config.maxVideos} videos), ${this.mb(config.imageBytes)} per photo, ${this.mb(config.videoBytes)} per video, ${this.mb(config.productBytes)} total. Videos: up to ${config.maxDuration} seconds. JPEG, PNG, WebP, MP4 (H.264), WebM.`,
        'auth-note',
      ),
    );
    root.append(
      node(
        'p',
        'Choose multiple files or drop them here. Drag to reorder, or use Move earlier/later. Uploads can be paused and resumed. The first item is shown first in the buyer gallery.',
        'auth-note',
      ),
    );
    root.append(
      node(
        'p',
        `New uploads: ${config.ticketsPerHour ?? 30} files per hour. Resuming does not use another upload ticket. Unsaved uploads expire after ${Math.ceil((config.lifetime ?? 86400000) / 3600000)} hours.`,
        'auth-note',
      ),
    );
    const label = node('label', 'Add photos and videos', 'upload-label');
    this.input = node('input');
    this.input.type = 'file';
    this.input.multiple = true;
    this.input.accept = config.accept;
    label.append(this.input);
    root.append(label);
    this.notice = node('p', '', 'form-status');
    this.notice.setAttribute('role', 'status');
    this.notice.setAttribute('aria-live', 'polite');
    root.append(this.notice);
    this.list = node('ol', '', 'media-upload-list');
    root.append(this.list);
    this.input.addEventListener('change', () => {
      this.add([...(this.input.files ?? [])]);
      this.input.value = '';
    });
    root.addEventListener('dragover', (event) => {
      event.preventDefault();
    });
    root.addEventListener('drop', (event) => {
      event.preventDefault();
      if (event.dataTransfer!.files.length)
        this.add([...event.dataTransfer!.files]);
    });
    for (const media of initial)
      this.insert({
        ...media,
        existing: true,
        state: 'ready',
        uploaded: media.size,
      });
    this.refresh();
    window.addEventListener('pagehide', () => {
      this.stopped = true;
      for (const item of this.items) {
        item.settle?.();
        void item.upload?.abort(false).catch(() => {});
        if (item.localUrl) URL.revokeObjectURL(item.localUrl);
      }
    });
  }
  mb(bytes: number) {
    return `${Math.round(bytes / 1024 ** 2)} MiB`;
  }
  message(text: string, error = false) {
    this.notice.textContent = text;
    this.notice.classList.toggle('form-error', error);
  }
  ids() {
    if (this.items.some((item) => item.state !== 'ready'))
      throw new Error(
        'Finish, retry or remove pending uploads before saving the product.',
      );
    return this.items.map((item) => item.id!);
  }
  async forget(item: UploadItem) {
    if (!item.upload?.options.urlStorage) return;
    for (const previous of await item.upload.findPreviousUploads()) {
      if (previous.uploadUrl?.endsWith(`/${item.id}`))
        await item.upload.options.urlStorage.removeUpload(
          previous.urlStorageKey,
        );
    }
  }
  async markSaved() {
    await Promise.all(this.items.map((item) => this.forget(item))).catch(
      () => {},
    );
  }
  setLocked(value: boolean) {
    this.locked = value;
    this.input.disabled = value;
    this.items.forEach((item) => this.update(item));
  }
  add(files: File[]) {
    if (this.locked || !files.length) return;
    const additions: UploadEntry[] = [];
    for (const file of files) {
      if (
        this.items.some(
          (item) =>
            item.file &&
            item.file.name === file.name &&
            item.file.size === file.size &&
            item.file.lastModified === file.lastModified,
        )
      )
        continue;
      const fallback = (
        {
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          png: 'image/png',
          webp: 'image/webp',
          mp4: 'video/mp4',
          webm: 'video/webm',
        } as Record<string, string>
      )[file.name.split('.').pop()!.toLowerCase()];
      const type = file.type || fallback || '';
      if (!this.config.accept.split(',').includes(type)) {
        this.message(
          `Unsupported file: ${file.name}. Use JPEG, PNG, WebP, MP4 or WebM.`,
          true,
        );
        return;
      }
      const kind = type.startsWith('video/') ? 'video' : 'image';
      if (
        !file.size ||
        file.size >
          (kind === 'video' ? this.config.videoBytes : this.config.imageBytes)
      ) {
        this.message(`File is empty or too large: ${file.name}`, true);
        return;
      }
      additions.push({
        file,
        kind,
        type,
        name: file.name,
        size: file.size,
        state: 'queued',
        uploaded: 0,
      });
    }
    const combined = [...this.items, ...additions];
    if (
      combined.length > this.config.maxFiles ||
      combined.filter((item) => item.kind === 'video').length >
        this.config.maxVideos ||
      combined.reduce((sum, item) => sum + item.size, 0) >
        this.config.productBytes
    ) {
      this.message(
        'This selection exceeds the product file count, video count or total size limit.',
        true,
      );
      return;
    }
    additions.forEach((item) => {
      item.localUrl = URL.createObjectURL(item.file!);
      item.url = item.localUrl;
      this.insert(item);
    });
    this.message(
      'Files added. They will be attached when you save the product.',
    );
    this.refresh();
    this.pump();
  }
  insert(entry: UploadEntry) {
    // DOM controls are assigned before this item is exposed to event handlers.
    const item = entry as UploadItem;
    item.key = String(++this.sequence);
    const card = this.node('li', '', 'media-upload-item');
    card.tabIndex = -1;
    card.draggable = true;
    item.card = card;
    const preview = this.node(
      item.kind === 'video' ? 'video' : 'img',
      '',
      'media-preview',
    );
    if (preview instanceof HTMLVideoElement) {
      preview.controls = true;
      preview.preload = 'metadata';
      preview.playsInline = true;
      if (item.poster) preview.poster = item.poster;
    } else (preview as HTMLImageElement).alt = item.name;
    preview.src = item.url ?? '';
    item.preview = preview;
    const title = this.node('strong', item.name);
    const state = this.node('p');
    state.setAttribute('aria-live', 'polite');
    item.label = state;
    const progress = this.node('progress');
    progress.max = 100;
    progress.value = item.state === 'ready' ? 100 : 0;
    progress.setAttribute('aria-label', `Upload progress for ${item.name}`);
    item.progress = progress;
    const buttons = this.node('div', '', 'product-actions');
    const button = (text: string, action: () => void) => {
      const b = this.node('button', text, 'nav-button nav-button-secondary');
      b.type = 'button';
      b.addEventListener('click', action);
      buttons.append(b);
      return b;
    };
    item.earlier = button('Move earlier', () => this.move(item, -1));
    item.later = button('Move later', () => this.move(item, 1));
    item.retry = button('Pause', () => this.pauseOrRetry(item));
    item.remove = button('Remove', () => this.remove(item));
    for (const [control, action] of [
      [item.earlier, 'Move earlier'],
      [item.later, 'Move later'],
      [item.remove, 'Remove'],
    ] as const)
      control.setAttribute('aria-label', `${action}: ${item.name}`);
    card.append(preview, title, state, progress, buttons);
    card.addEventListener('dragstart', (event) => {
      if (this.locked) {
        event.preventDefault();
        return;
      }
      this.dragged = item;
      event.dataTransfer?.setData('text/plain', item.key);
    });
    card.addEventListener('drop', (event) => {
      if (!this.dragged || this.locked || event.dataTransfer!.files.length)
        return;
      event.preventDefault();
      event.stopPropagation();
      const from = this.items.indexOf(this.dragged),
        to = this.items.indexOf(item);
      this.items.splice(from, 1);
      this.items.splice(to, 0, this.dragged);
      this.dragged = null;
      this.refresh();
      item.card.focus();
    });
    card.addEventListener('dragend', () => {
      this.dragged = null;
    });
    this.items.push(item);
  }
  refresh() {
    this.list.replaceChildren(...this.items.map((item) => item.card));
    this.items.forEach((item) => this.update(item));
  }
  update(item: UploadItem) {
    const index = this.items.indexOf(item);
    item.card.draggable = !this.locked;
    item.earlier.disabled = this.locked || index === 0;
    item.later.disabled = this.locked || index === this.items.length - 1;
    item.remove.disabled = this.locked || !!item.removing;
    item.retry.disabled = this.locked || !!item.removing;
    item.retry.hidden =
      ['ready', 'processing'].includes(item.state) || !!item.invalid;
    item.retry.textContent =
      item.state === 'uploading'
        ? 'Pause'
        : item.state === 'queued'
          ? 'Pause'
          : 'Retry / resume';
    item.retry.setAttribute(
      'aria-label',
      `${item.retry.textContent}: ${item.name}`,
    );
    const percent = item.size
      ? Math.min(100, Math.round((item.uploaded / item.size) * 100))
      : 0;
    item.progress.value = item.state === 'ready' ? 100 : percent;
    item.label.textContent = `${index + 1}. ${item.state === 'ready' ? 'Ready' : item.state === 'processing' ? 'Processing…' : item.state === 'uploading' && percent === 100 ? 'Upload complete…' : `${item.state} (${percent}%)`}${item.error ? ` — ${item.error}` : ''}`;
  }
  move(item: UploadItem, direction: number) {
    if (this.locked) return;
    const from = this.items.indexOf(item),
      to = from + direction;
    if (to < 0 || to >= this.items.length) return;
    [this.items[from], this.items[to]] = [this.items[to], this.items[from]];
    this.refresh();
    item.card.focus();
    this.message(`${item.name} moved to position ${to + 1}.`);
  }
  async pauseOrRetry(item: UploadItem) {
    if (this.locked) return;
    if (['queued', 'uploading'].includes(item.state)) {
      item.state = 'paused';
      await item.upload?.abort(false);
      item.settle?.();
      this.update(item);
    } else {
      item.error = '';
      item.state = 'queued';
      this.update(item);
      this.pump();
    }
  }
  async remove(item: UploadItem) {
    if (this.locked || item.removing) return;
    item.removing = true;
    this.update(item);
    try {
      item.state = 'paused';
      await item.upload?.abort(false);
      item.settle?.();
      await item.work;
      if (item.id && !item.existing) {
        const response = await fetch(`/media/tickets/${item.id}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        });
        if (!response.ok && ![404, 410].includes(response.status))
          throw new Error(
            'Unable to remove upload. Log in again if your session expired, then retry.',
          );
      }
      await this.forget(item).catch(() => {});
      this.items.splice(this.items.indexOf(item), 1);
      if (item.preview instanceof HTMLVideoElement) item.preview.pause();
      if (item.localUrl) URL.revokeObjectURL(item.localUrl);
      this.refresh();
      this.input.focus();
      this.message(
        'File removed from this product selection. Save the product to apply changes.',
      );
    } catch (cause) {
      const error =
        cause instanceof Error
          ? cause
          : new Error(
              typeof cause === 'object' && cause !== null && 'message' in cause
                ? String(cause.message)
                : 'Unexpected error',
            );
      item.error = error.message;
    } finally {
      item.removing = false;
      if (this.items.includes(item)) this.update(item);
      this.pump();
    }
  }
  pump() {
    if (this.stopped) return;
    for (const item of this.items) {
      if (this.active >= 2) return;
      if (item.state !== 'queued' || item.removing || item.running) continue;
      item.state = 'uploading';
      item.running = true;
      this.active++;
      this.update(item);
      item.work = this.run(item)
        .catch((error) => {
          if (['uploading', 'processing'].includes(item.state)) {
            item.state = 'failed';
            item.error = error.message;
          }
        })
        .finally(() => {
          this.active--;
          item.running = false;
          item.settle = null;
          if (this.items.includes(item)) this.update(item);
          this.pump();
        });
    }
  }
  async json<T = MediaStatus>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
    });
    const body = await response.json();
    if (response.status === 401)
      throw new Error(
        'Session expired. Log in in another tab, then retry / resume.',
      );
    if (!response.ok)
      throw new Error(
        Array.isArray(body.message)
          ? body.message.join(' · ')
          : body.message || 'Upload request failed',
      );
    return body;
  }
  async run(item: UploadItem) {
    if (item.id) {
      const status = await this.json(`/media/tickets/${item.id}`);
      if (['ready', 'processing', 'failed'].includes(status.status)) {
        await this.waitUntilReady(item, status);
        return;
      }
    }
    const options: ConstructorParameters<typeof tus.Upload>[1] = {
      endpoint: this.config.endpoint,
      chunkSize: 5 * 1024 ** 2,
      retryDelays: [0, 1000, 3000, 5000],
      removeFingerprintOnSuccess: false,
      metadata: {},
      onBeforeRequest: (request) => {
        const xhr = request.getUnderlyingObject();
        if ('withCredentials' in xhr) xhr.withCredentials = true;
      },
      onShouldRetry: (error) =>
        ![400, 401, 403, 404, 410, 413, 415, 422].includes(
          error.originalResponse?.getStatus() ?? 0,
        ),
    };
    const upload = new tus.Upload(item.file!, options);
    item.upload = upload;
    if (!item.id) {
      const previous = await upload.findPreviousUploads();
      if (item.state !== 'uploading') return;
      for (const record of previous) {
        let url;
        try {
          url = new URL(record.uploadUrl!, window.location.href);
        } catch {
          continue;
        }
        if (
          url.origin !== window.location.origin ||
          !/^\/media\/uploads\/[a-f0-9-]{36}$/.test(url.pathname)
        )
          continue;
        try {
          const id = url.pathname.split('/').pop();
          const status = await this.json(`/media/tickets/${id}`);
          if (
            !['reserved', 'uploading', 'processing', 'ready'].includes(
              status.status,
            ) ||
            status.attached
          )
            continue;
          item.id = id;
          item.uploadUrl = record.uploadUrl;
          if (item.state !== 'uploading') return;
          if (status.status === 'ready') {
            this.ready(item, status);
            return;
          }
          if (status.status === 'processing') {
            item.pendingStatus = status;
            break;
          }
          upload.resumeFromPreviousUpload(record);
          break;
        } catch {
          /* Expired/other-account uploads must not be reused. */
        }
      }
    }
    if (item.pendingStatus) {
      await this.waitUntilReady(item, item.pendingStatus);
      item.pendingStatus = null;
      return;
    }
    if (!item.id) {
      const ticket = await this.json<{ id: string }>('/media/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: item.name,
          type: item.type,
          size: item.size,
        }),
      });
      item.id = ticket.id;
    }
    upload.options.metadata = { ticket: item.id! };
    if (item.uploadUrl) upload.url = item.uploadUrl;
    if (item.state !== 'uploading') return;
    await new Promise<void>((resolve, reject) => {
      item.settle = resolve;
      upload.options.onProgress = (uploaded) => {
        item.uploaded = uploaded;
        this.update(item);
      };
      upload.options.onUploadUrlAvailable = () => {
        item.uploadUrl = upload.url;
      };
      upload.options.onError = async (error) => {
        const code =
          'originalResponse' in error
            ? error.originalResponse?.getStatus()
            : undefined;
        if (code === 422 || code === 410) {
          try {
            const status = await this.json(`/media/tickets/${item.id}`);
            if (status.status === 'failed') {
              item.invalid = true;
              reject(
                new Error(
                  status.error || 'Invalid file. Remove it and choose another.',
                ),
              );
              return;
            }
          } catch {}
        }
        reject(
          new Error(
            code === 401
              ? 'Session expired. Log in in another tab, then retry / resume.'
              : `Upload failed${code ? ` (${code})` : ''}. Retry / resume or remove this file.`,
          ),
        );
      };
      upload.options.onSuccess = async () => {
        try {
          const status = await this.json(`/media/tickets/${item.id}`);
          if (item.state !== 'uploading') {
            resolve();
            return;
          }
          await this.waitUntilReady(item, status);
          resolve();
        } catch (cause) {
          const error =
            cause instanceof Error
              ? cause
              : new Error(
                  typeof cause === 'object' &&
                    cause !== null &&
                    'message' in cause
                    ? String(cause.message)
                    : 'Unexpected error',
                );
          reject(error);
        }
      };
      upload.start();
    });
  }
  async waitUntilReady(item: UploadItem, status: MediaStatus) {
    if (!['uploading', 'processing'].includes(item.state)) return;
    item.state = 'processing';
    this.update(item);
    while (!this.stopped && item.state === 'processing') {
      if (status.status === 'ready') {
        this.ready(item, status);
        return;
      }
      if (status.status === 'failed') {
        item.invalid = true;
        throw new Error(
          status.error ||
            'Media processing failed. Remove the file and choose another.',
        );
      }
      if (!['processing', 'uploading'].includes(status.status))
        throw new Error(
          'Media processing could not be started. Retry or remove the file.',
        );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        item.settle = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      if (this.stopped || item.state !== 'processing') return;
      status = await this.json(`/media/tickets/${item.id}`);
    }
  }
  ready(item: UploadItem, status: MediaStatus) {
    item.state = 'ready';
    item.error = '';
    item.uploaded = item.size;
    item.url = status.url;
    item.preview.src = status.url;
    if (status.poster && item.preview instanceof HTMLVideoElement)
      item.preview.poster = status.poster;
    if (item.localUrl) {
      URL.revokeObjectURL(item.localUrl);
      item.localUrl = null;
    }
    this.update(item);
    this.message('Upload validated and ready. Save the product to publish it.');
  }
}
globalThis.ProductMediaUploader = MediaUploader;
