export interface PartPutResult {
  status: number;
  etag: string | null;
}

/**
 * Uploads one part's bytes to a presigned URL. `onBytes` reports bytes sent so far for this
 * part, so progress moves smoothly within an 8 MB part instead of jumping per part.
 */
export type PartTransport = (
  url: string,
  body: Blob,
  onBytes: (sent: number) => void,
  signal?: AbortSignal,
) => Promise<PartPutResult>;

/** Browser transport: XHR is the only web API that reports upload progress. */
/** A part upload that makes no progress for this long is treated as a network error. */
const STALL_TIMEOUT_MS = 30_000;

export const xhrTransport: PartTransport = (url, body, onBytes, signal) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stall: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => xhr.abort();
    const settle = () => {
      clearTimeout(stall);
      signal?.removeEventListener("abort", onAbort);
    };
    // A stalled connection fires no event at all: without this it would never retry.
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        settle();
        xhr.abort();
        reject(new TypeError("part upload stalled"));
      }, STALL_TIMEOUT_MS);
    };
    xhr.open("PUT", url);
    xhr.upload.onprogress = (event) => {
      armStall();
      onBytes(event.loaded);
    };
    xhr.onload = () => {
      settle();
      resolve({ status: xhr.status, etag: xhr.getResponseHeader("etag") });
    };
    xhr.onerror = () => {
      settle();
      reject(new TypeError("network error while uploading a part"));
    };
    xhr.onabort = () => {
      settle();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    armStall();
    xhr.send(body);
  });

/** Fallback for environments without XHR (Node, workers): progress per completed part. */
export const fetchTransport: PartTransport = async (url, body, onBytes, signal) => {
  const response = await fetch(url, { method: "PUT", body, signal: signal ?? null });
  if (response.ok) onBytes(body.size);
  return { status: response.status, etag: response.headers.get("etag") };
};

export function defaultTransport(): PartTransport {
  return typeof XMLHttpRequest === "undefined" ? fetchTransport : xhrTransport;
}
