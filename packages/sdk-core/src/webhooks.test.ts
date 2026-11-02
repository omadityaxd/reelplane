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

  it("rejects a replay outside the tolerance", async () => {
    await expect(verifyWebhook({ payload, signature, secret, now: now + 301_000 })).rejects.toThrow(
      "tolerance",
    );
    await expect(
      verifyWebhook({ payload, signature, secret, now: now + 301_000, toleranceSeconds: 600 }),
    ).resolves.toBeTruthy();
  });
});
