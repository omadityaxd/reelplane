import { backoffDelay, sleep } from "./backoff.ts";
import { defaultTransport, type PartPutResult, type PartTransport } from "./transport.ts";

/** What the developer's server hands to the browser after `POST /v1/uploads`. */
export interface UploadSessionRef {
  videoId: string;
  token: string;
}

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  /** 0..1 */
  fraction: number;
}

export interface UploadVideoOptions {
  apiBaseUrl: string;
  file: Blob;
  session: UploadSessionRef;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  /** Parts uploaded in parallel. */
  concurrency?: number;
  /** Attempts per part before giving up (the whole upload can then be resumed). */
  maxAttempts?: number;
  transport?: PartTransport;
  fetch?: typeof fetch;
  /** Injected in tests to make backoff instant. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface UploadedVideo {
  id: string;
  status: string;
}

export type UploadErrorCode = "api_error" | "part_failed" | "aborted";

export class UploadError extends Error {
  override readonly name = "UploadError";
  constructor(
    readonly code: UploadErrorCode,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

interface SignedParts {
  partSize: number;
  partCount: number;
  receivedParts: { partNumber: number; size: number; etag: string }[];
  urls: { partNumber: number; size: number; url: string }[];
}

interface ApiEnvelope<T> {
  data?: T;
  error?: { code: string; message: string };
}

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_ATTEMPTS = 6;
const SIGN_BATCH = 100;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isSuccess(result: PartPutResult | null): result is { status: number; etag: string } {
  return result !== null && result.status >= 200 && result.status < 300 && result.etag !== null;
}

/** One upload attempt. A fresh instance per `uploadVideo` call; resuming = a new attempt. */
class MultipartUpload {
  private readonly etags = new Map<number, string>();
  private readonly urls = new Map<number, string>();
  private readonly inFlight = new Map<number, number>();
  private completedBytes = 0;
  private partSize = 0;
  private pending: number[] = [];

  private readonly transport: PartTransport;
  private readonly fetch: typeof fetch;
  private readonly wait: NonNullable<UploadVideoOptions["wait"]>;
  private readonly maxAttempts: number;

  constructor(private readonly options: UploadVideoOptions) {
    this.transport = options.transport ?? defaultTransport();
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.wait = options.wait ?? sleep;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async run(): Promise<UploadedVideo> {
    await this.start();
    await this.uploadPending(this.options.concurrency ?? DEFAULT_CONCURRENCY);
    const parts = [...this.etags.entries()]
      .sort(([a], [b]) => a - b)
      .map(([partNumber, etag]) => ({ partNumber, etag }));
    return this.withRetries(() => this.post<UploadedVideo>("complete", { parts }));
  }

  /** Asks the server what storage already holds; that is where a resumed upload starts. */
  private async start(): Promise<void> {
    const first = await this.withRetries(() => this.post<SignedParts>("parts", {}));
    this.partSize = first.partSize;
    for (const part of first.receivedParts) {
      this.etags.set(part.partNumber, part.etag);
      this.completedBytes += part.size;
    }
    for (const entry of first.urls) this.urls.set(entry.partNumber, entry.url);
    this.pending = Array.from({ length: first.partCount }, (_, i) => i + 1).filter(
      (n) => !this.etags.has(n),
    );
    this.report();
  }

  /**
   * A small worker pool keeps `concurrency` parts in flight. After the first permanent
   * failure, workers stop taking new parts but let in-flight ones finish: storage keeps those
   * bytes for the resume, and nothing keeps uploading after this call has returned.
   */
  private async uploadPending(concurrency: number): Promise<void> {
    const queue = [...this.pending];
    let failure: unknown = null;
    const worker = async () => {
      for (let next = queue.shift(); next !== undefined && failure === null; next = queue.shift()) {
        try {
          await this.uploadPart(next);
        } catch (error) {
          failure ??= error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    if (failure !== null) throw failure;
  }

  private async uploadPart(partNumber: number): Promise<void> {
    const start = (partNumber - 1) * this.partSize;
    const body = this.options.file.slice(
      start,
      Math.min(start + this.partSize, this.options.file.size),
    );
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.putOnce(partNumber, body);
      // Move this part's bytes from "in flight" to "completed" (or drop them) in one
      // synchronous step: other parts settle in between awaits, and splitting the two updates
      // across an await made progress dip backwards.
      this.inFlight.delete(partNumber);
      if (isSuccess(result)) {
        this.etags.set(partNumber, result.etag);
        this.completedBytes += body.size;
        this.report();
        return;
      }
      this.report(); // a failed attempt's bytes are dropped: progress honestly steps back
      if (result?.status === 403) {
        this.urls.delete(partNumber); // expired signature: re-sign on the next attempt
      } else if (result && !isRetryableStatus(result.status)) {
        throw new UploadError(
          "part_failed",
          `Part ${partNumber} was rejected (HTTP ${result.status}).`,
          result.status,
        );
      }
      if (attempt + 1 >= this.maxAttempts) {
        throw new UploadError(
          "part_failed",
          `Part ${partNumber} failed after ${this.maxAttempts} attempts.`,
          result?.status,
        );
      }
      await this.wait(backoffDelay(attempt), this.options.signal);
    }
  }

  /** One PUT of one part. Network errors come back as `null` so the caller can retry. */
  private async putOnce(partNumber: number, body: Blob): Promise<PartPutResult | null> {
    const { signal } = this.options;
    this.throwIfAborted();
    if (!this.urls.has(partNumber)) await this.refreshUrls(partNumber);
    const url = this.urls.get(partNumber);
    if (!url) throw new UploadError("part_failed", `No upload URL for part ${partNumber}.`);
    try {
      return await this.transport(url, body, (sent) => this.trackBytes(partNumber, sent), signal);
    } catch (error) {
      this.throwIfAborted(error);
      return null;
    }
  }

  /** Signs a fresh batch of URLs starting at `from` (expired or not yet signed). */
  private async refreshUrls(from: number): Promise<void> {
    const batch = this.pending.filter((n) => n >= from && !this.etags.has(n)).slice(0, SIGN_BATCH);
    const signed = await this.withRetries(() =>
      this.post<SignedParts>("parts", { partNumbers: batch }),
    );
    for (const entry of signed.urls) this.urls.set(entry.partNumber, entry.url);
  }

  private trackBytes(partNumber: number, sent: number): void {
    this.inFlight.set(partNumber, sent);
    this.report();
  }

  /** Progress = bytes already stored + bytes in flight for each active part. */
  private report(): void {
    const { onProgress, file } = this.options;
    if (!onProgress) return;
    let uploaded = this.completedBytes;
    for (const sent of this.inFlight.values()) uploaded += sent;
    uploaded = Math.min(uploaded, file.size);
    onProgress({
      uploadedBytes: uploaded,
      totalBytes: file.size,
      fraction: file.size ? uploaded / file.size : 1,
    });
  }

  private throwIfAborted(cause?: unknown): void {
    if (this.options.signal?.aborted) {
      throw new UploadError("aborted", "Upload was cancelled.", undefined, { cause });
    }
  }

  /** Retries an API call on network errors and retryable statuses. */
  private async withRetries<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        this.throwIfAborted(error);
        const retryable =
          !(error instanceof UploadError) ||
          (error.status !== undefined && isRetryableStatus(error.status));
        if (!retryable || attempt + 1 >= this.maxAttempts) throw error;
        await this.wait(backoffDelay(attempt), this.options.signal);
      }
    }
  }

  /** JSON call to an upload endpoint, authenticated with the upload token. */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const { apiBaseUrl, session, signal } = this.options;
    const response = await this.fetch(
      `${apiBaseUrl.replace(/\/+$/, "")}/v1/uploads/${session.videoId}/${path}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ?? null,
      },
    );
    const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<T>;
    if (!response.ok || payload.data === undefined) {
      throw new UploadError(
        "api_error",
        payload.error?.message ?? `Upload API returned HTTP ${response.status}`,
        response.status,
      );
    }
    return payload.data;
  }
}

/**
 * Uploads a file straight to storage in parts, then completes the upload.
 *
 * Resumable: if it fails (network loss, tab closed, part retries exhausted), call it again
 * with the same `session` and `file`. The server reports the parts storage already holds and
 * only the missing ones are sent. Progress counts those already-stored bytes immediately.
 */
export function uploadVideo(options: UploadVideoOptions): Promise<UploadedVideo> {
  return new MultipartUpload(options).run();
}
