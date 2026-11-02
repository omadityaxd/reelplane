/**
 * Verifies a Reelplane webhook on your server (Node 20+, Deno, Bun, edge runtimes: WebCrypto).
 *
 *   const event = await verifyWebhook({
 *     payload: await request.text(),           // the raw body, before any JSON parsing
 *     signature: request.headers.get("Reelplane-Signature"),
 *     secret: process.env.REELPLANE_WEBHOOK_SECRET,
 *   });
 *
 * The header is `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. Requests older
 * than `toleranceSeconds` are rejected, so a captured request can't be replayed later.
 * Deliveries are at-least-once: dedupe on `event.id`.
 */
export interface WebhookEvent<T = unknown> {
  id: string;
  type: string;
  createdAt: string;
  projectId: string;
  data: T;
}

export interface VerifyWebhookOptions {
  payload: string;
  signature: string | null | undefined;
  secret: string;
  /** Maximum age of a delivery, in seconds (default 300). */
  toleranceSeconds?: number;
  /** Current time in ms (tests). */
  now?: number;
}

export class WebhookVerificationError extends Error {
  override readonly name = "WebhookVerificationError";
}

const DEFAULT_TOLERANCE_SECONDS = 300;

export async function verifyWebhook<T = unknown>(
  options: VerifyWebhookOptions,
): Promise<WebhookEvent<T>> {
  const parts = new Map(
    (options.signature ?? "").split(",").map((part) => {
      const at = part.indexOf("=");
      return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as const;
    }),
  );
  const timestamp = Number(parts.get("t"));
  const received = parts.get("v1");
  if (!Number.isInteger(timestamp) || !received || !/^[0-9a-f]{64}$/.test(received)) {
    throw new WebhookVerificationError("Missing or malformed Reelplane-Signature header.");
  }
  const age = (options.now ?? Date.now()) / 1000 - timestamp;
  if (Math.abs(age) > (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) {
    throw new WebhookVerificationError("Webhook timestamp is outside the allowed tolerance.");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(options.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  // subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    hexToBytes(received),
    encoder.encode(`${timestamp}.${options.payload}`),
  );
  if (!valid) throw new WebhookVerificationError("Webhook signature does not match.");
  return JSON.parse(options.payload) as WebhookEvent<T>;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
