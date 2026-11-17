package webhooks_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/omadityaxd/reelplane/services/worker/internal/queue"
	"github.com/omadityaxd/reelplane/services/worker/internal/testdb"
	"github.com/omadityaxd/reelplane/services/worker/internal/webhooks"
)

// The same vector is checked by packages/sdk-core/src/webhooks.test.ts, so the Go signer and
// the TypeScript verifier can't drift apart.
func TestSignMatchesSharedVector(t *testing.T) {
	got := webhooks.Sign("whsec_test", []byte(`{"id":"evt_1"}`), time.Unix(1700000000, 0))
	want := "t=1700000000,v1=c89214b5b5da833daed6f0b8c5bb6bd58cea9022bd80ccc78230f3942d632925"
	if got != want {
		t.Fatalf("Sign = %s, want %s", got, want)
	}
}

func TestClientRefusesPrivateAddresses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer server.Close()

	_, err := webhooks.NewClient(2*time.Second, false).Get(server.URL) // 127.0.0.1
	if !errors.Is(err, webhooks.ErrBlockedAddress) {
		t.Fatalf("loopback: err = %v, want ErrBlockedAddress", err)
	}
	for _, url := range []string{"http://169.254.169.254/latest/meta-data", "http://10.0.0.1/", "http://[::1]:1/"} {
		if _, err := webhooks.NewClient(time.Second, false).Get(url); !errors.Is(err, webhooks.ErrBlockedAddress) {
			t.Errorf("%s: err = %v, want ErrBlockedAddress", url, err)
		}
	}
	response, err := webhooks.NewClient(2*time.Second, true).Get(server.URL)
	if err != nil {
		t.Fatalf("allowPrivate: %v", err)
	}
	response.Body.Close()
}

func TestClientDoesNotFollowRedirects(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/", http.StatusFound)
	}))
	defer server.Close()
	response, err := webhooks.NewClient(2*time.Second, true).Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusFound {
		t.Fatalf("status = %d, want the 302 itself", response.StatusCode)
	}
}

type harness struct {
	db        *testdb.DB
	deliverer *webhooks.Deliverer
	video     testdb.Seeded
}

func newHarness(t *testing.T, name, url string, maxAttempts int) harness {
	t.Helper()
	db := testdb.New(t, name)
	seed := db.SeedJob(t, "", 3)
	if _, err := db.Owner.Exec(context.Background(), `
		insert into reelplane.webhook_endpoints (project_id, url, secret, events)
		values ($1, $2, 'whsec_test', '{video.ready,video.failed}'),
		       ($1, $2, 'whsec_other', '{video.deleted}')`, seed.ProjectID, url); err != nil {
		t.Fatal(err)
	}
	deliverer := webhooks.New(db.Worker, webhooks.Options{
		Client:       webhooks.NewClient(2*time.Second, true),
		Backoff:      queue.Backoff{Base: time.Hour, Max: time.Hour, Random: func() float64 { return 1 }},
		MaxAttempts:  maxAttempts,
		PollInterval: 10 * time.Millisecond,
		Lease:        time.Minute,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return harness{db: db, deliverer: deliverer, video: seed}
}

// fail marks the seeded video failed, which the database turns into a video.failed delivery.
func (h harness) fail(t *testing.T) {
	t.Helper()
	if _, err := h.db.Owner.Exec(context.Background(),
		`update reelplane.videos set status = 'failed', failure_reason = 'bad input' where id = $1`, h.video.VideoID); err != nil {
		t.Fatal(err)
	}
}

func TestDeliveryIsSignedAndRecorded(t *testing.T) {
	var got *http.Request
	var body []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, body = r, must(io.ReadAll(r.Body))
		_, _ = w.Write([]byte("thanks"))
	}))
	defer server.Close()
	h := newHarness(t, "reelplane_test_webhooks_ok", server.URL, 3)
	h.fail(t)

	// Only the endpoint subscribed to video.failed gets a delivery.
	if n := testdb.Scalar[int](t, h.db, `select count(*)::int from reelplane.webhook_deliveries`); n != 1 {
		t.Fatalf("deliveries = %d, want 1", n)
	}
	sent, err := h.deliverer.DeliverDue(context.Background())
	if err != nil || sent != 1 {
		t.Fatalf("DeliverDue = %d, %v", sent, err)
	}
	signature := got.Header.Get(webhooks.SignatureHeader)
	var at int64
	if _, err := fmt.Sscanf(signature, "t=%d,", &at); err != nil {
		t.Fatalf("signature header %q: %v", signature, err)
	}
	if want := webhooks.Sign("whsec_test", body, time.Unix(at, 0)); signature != want {
		t.Fatalf("signature %s does not verify (want %s)", signature, want)
	}
	if got.Header.Get("Reelplane-Event-Type") != "video.failed" || got.Header.Get("Reelplane-Event-Id") == "" {
		t.Fatalf("headers = %v", got.Header)
	}
	state := testdb.Scalar[string](t, h.db, `select state || ' ' || last_status_code || ' ' || last_response from reelplane.webhook_deliveries`)
	if state != "succeeded 200 thanks" {
		t.Fatalf("delivery = %q", state)
	}
	if again, _ := h.deliverer.DeliverDue(context.Background()); again != 0 {
		t.Fatalf("a delivered webhook was sent again")
	}
}

func TestFailedDeliveriesRetryThenDeadLetter(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer server.Close()
	h := newHarness(t, "reelplane_test_webhooks_retry", server.URL, 2)
	h.fail(t)
	ctx := context.Background()

	if sent, _ := h.deliverer.DeliverDue(ctx); sent != 1 {
		t.Fatalf("first attempt not sent")
	}
	row := testdb.Scalar[string](t, h.db, `
		select state || ' ' || attempts || ' ' || last_status_code || ' ' || (next_attempt_at > now() + interval '59 minutes')
		  from reelplane.webhook_deliveries`)
	if row != "pending 1 500 true" {
		t.Fatalf("after 1st failure: %q (want pending, retried after the 1 h backoff)", row)
	}
	if sent, _ := h.deliverer.DeliverDue(ctx); sent != 0 {
		t.Fatalf("retried before its backoff elapsed")
	}
	if _, err := h.db.Owner.Exec(ctx, `update reelplane.webhook_deliveries set next_attempt_at = now()`); err != nil {
		t.Fatal(err)
	}
	if sent, _ := h.deliverer.DeliverDue(ctx); sent != 1 {
		t.Fatalf("second attempt not sent")
	}
	if state := testdb.Scalar[string](t, h.db, `select state from reelplane.webhook_deliveries`); state != "dead" || calls.Load() != 2 {
		t.Fatalf("state = %s after %d calls, want dead after 2", state, calls.Load())
	}
}

func TestDisabledEndpointsWait(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer server.Close()
	h := newHarness(t, "reelplane_test_webhooks_disabled", server.URL, 3)
	ctx := context.Background()
	if _, err := h.db.Owner.Exec(ctx, `update reelplane.webhook_endpoints set enabled = false`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Owner.Exec(ctx, `
		insert into reelplane.webhook_deliveries (endpoint_id, project_id, event_type, payload)
		select id, project_id, 'webhook.test', '{}' from reelplane.webhook_endpoints limit 1`); err != nil {
		t.Fatal(err)
	}
	if sent, _ := h.deliverer.DeliverDue(ctx); sent != 0 {
		t.Fatalf("delivered to a disabled endpoint")
	}
	if _, err := h.db.Owner.Exec(ctx, `update reelplane.webhook_endpoints set enabled = true`); err != nil {
		t.Fatal(err)
	}
	if sent, _ := h.deliverer.DeliverDue(ctx); sent != 1 {
		t.Fatalf("not delivered after re-enabling")
	}
}

func must[T any](value T, err error) T {
	if err != nil {
		panic(err)
	}
	return value
}
