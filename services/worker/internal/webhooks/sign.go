// Package webhooks delivers the outbox rows in reelplane.webhook_deliveries: signed with HMAC,
// retried with backoff, dead-lettered after a maximum number of attempts.
package webhooks

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"time"
)

// SignatureHeader carries `t=<unix seconds>,v1=<hex HMAC-SHA256>`. The MAC covers
// "<t>.<body>", so a captured request can't be replayed later with a fresh timestamp, and
// receivers reject timestamps older than a few minutes (see verifyWebhook in sdk-core).
const SignatureHeader = "Reelplane-Signature"

// Sign returns the SignatureHeader value for body sent at time at.
func Sign(secret string, body []byte, at time.Time) string {
	t := strconv.FormatInt(at.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(t))
	mac.Write([]byte("."))
	mac.Write(body)
	return "t=" + t + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}
