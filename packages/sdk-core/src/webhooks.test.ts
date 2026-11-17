import { describe, expect, it } from "vitest";
import { verifyWebhook, WebhookVerificationError } from "./webhooks.ts";

// Same vector as services/worker/internal/webhooks/webhooks_test.go (the Go signer).
const payload = '{"id":"evt_1"}';
const secret = "whsec_test";
const signature =
  "t=1700000000,v1=c89214b5b5da833daed6f0b8c5bb6bd58cea9022bd80ccc78230f3942d632925";
const now = 1700000000_000;

describe("verifyWebhook", () => {
  it("accepts the worker's signature and returns the event", async () => {
    await expect(verifyWebhook({ payload, signature, secret, now })).resolves.toEqual({
      id: "evt_1",
    });
  });

  it("rejects a tampered body, a wrong secret and a malformed header", async () => {
    const cases = [
      { payload: '{"id":"evt_2"}', signature, secret },
      { payload, signature, secret: "whsec_other" },
      { payload, signature: "v1=abc", secret },
      { payload, signature: null, secret },
    ];
    for (const options of cases) {
      await expect(verifyWebhook({ ...options, now })).rejects.toBeInstanceOf(
        WebhookVerificationError,
      );
    }
  });

  it("refuses to verify with an empty or missing secret (a forgery signed with '')", async () => {
    const t = 1700000000;
    const forged = `t=${t},v1=${await hmacHex("", `${t}.${payload}`)}`;
    for (const empty of ["", undefined as unknown as string]) {
      await expect(
        verifyWebhook({ payload, signature: forged, secret: empty, now }),
      ).rejects.toThrow(new WebhookVerificationError("No webhook secret configured."));
    }
  });

  it("accepts any matching v1 signature (several are sent while a secret is rotated)", async () => {
    const [t, v1] = signature.split(",");
    expect(`v1=${await hmacHex(secret, `1700000000.${payload}`)}`).toBe(v1); // the helper is right
    const other = await hmacHex("whsec_old", `1700000000.${payload}`);
    for (const header of [`${t},v1=${other},${v1}`, `${t},${v1},v1=${other}`]) {
      await expect(verifyWebhook({ payload, signature: header, secret, now })).resolves.toEqual({
        id: "evt_1",
      });
    }
    await expect(
      verifyWebhook({ payload, signature: `${t},v1=${other}`, secret, now }),
    ).rejects.toThrow("does not match");
  });

  it("rejects a replay outside the tolerance", async () => {
    await expect(verifyWebhook({ payload, signature, secret, now: now + 301_000 })).rejects.toThrow(
      "tolerance",
    );
    await expect(
      verifyWebhook({ payload, signature, secret, now: now + 301_000, toleranceSeconds: 600 }),
    ).resolves.toBeTruthy();
  });
});

/** HMAC-SHA256 as hex. A hand-rolled HMAC: WebCrypto refuses the empty key a forger would use. */
async function hmacHex(key: string, message: string): Promise<string> {
  const block = new Uint8Array(64);
  block.set(new TextEncoder().encode(key)); // keys here are shorter than the block
  const pad = (byte: number) => block.map((b) => b ^ byte);
  const sha = async (...parts: Uint8Array[]) => {
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
    }
    return new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
  };
  const inner = await sha(pad(0x36), new TextEncoder().encode(message));
  const mac = await sha(pad(0x5c), inner);
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}
