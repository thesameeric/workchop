import { tooLarge, type UploadedFile } from '../../../shared/uploads';

export interface UploadOptions {
  /** The name to store it under (default: the File's own name). */
  name?: string;
  /** Called as the file goes out, with the share sent so far (0..1). */
  onProgress?: (fraction: number) => void;
  /** Aborting cancels the upload; the promise then rejects with an AbortError. */
  signal?: AbortSignal;
}

/** Busy answers (429/503) are retried this many times when the server asks for a short wait. */
const ATTEMPTS = 3;
const MAX_RETRY_WAIT_S = 10;

const aborted = () => new DOMException('The upload was cancelled.', 'AbortError');

interface Answer {
  status: number;
  body: unknown;
  retryAfter: number;
}

/** One POST with XHR, which (unlike fetch) reports upload progress. */
function send(url: string, file: Blob, headers: Record<string, string>, { onProgress, signal }: UploadOptions): Promise<Answer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    const xhr = new XMLHttpRequest();
    const cancel = () => xhr.abort();
    xhr.open('POST', url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.response, retryAfter: Number(xhr.getResponseHeader('Retry-After')) });
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
    xhr.onabort = () => reject(aborted());
    xhr.onloadend = () => signal?.removeEventListener('abort', cancel);
    signal?.addEventListener('abort', cancel, { once: true });
    xhr.send(file);
  });
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(aborted());
      },
      { once: true },
    );
  });
}

/**
 * Uploads `file` to `url` with the given headers and returns the server's answer. Throws an Error
 * whose message can be shown as is ("File too large (max 10 MB)", the server's reason…).
 */
export async function postFile(url: string, file: Blob, headers: Record<string, string>, opts: UploadOptions & { maxBytes?: number }): Promise<UploadedFile> {
  const { maxBytes } = opts;
  if (maxBytes && file.size > maxBytes) throw new Error(tooLarge(maxBytes));
  for (let attempt = 1; ; attempt++) {
    const res = await send(url, file, { ...headers, 'Content-Type': file.type || 'application/octet-stream' }, opts);
    if (res.status === 201 || res.status === 200) {
      opts.onProgress?.(1);
      return res.body as UploadedFile;
    }
    // Busy (too many uploads at once): wait as long as the server asks, if that's not long.
    if ((res.status === 429 || res.status === 503) && attempt < ATTEMPTS && res.retryAfter > 0 && res.retryAfter <= MAX_RETRY_WAIT_S) {
      // The refused body went out: it starts again from nothing.
      opts.onProgress?.(0);
      await wait(res.retryAfter * 1000, opts.signal);
      continue;
    }
    // The server's reason, e.g. for a 413 when the office's storage is full. A 413 without one comes
    // from a proxy in front of it.
    const error = (res.body as { error?: unknown } | null)?.error;
    if (typeof error === 'string' && error) throw new Error(error);
    throw new Error(res.status === 413 ? tooLarge(maxBytes) : `Upload failed (${res.status})`);
  }
}
