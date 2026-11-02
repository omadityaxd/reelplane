package webhooks

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/omadityashukla/reelplane/services/worker/internal/queue"
)

const (
	// batchSize bounds the deliveries claimed per poll (and sent in parallel).
	batchSize = 8
	// maxResponseLog is how much of a receiver's response body the delivery log keeps.
	maxResponseLog = 1024
	userAgent      = "Reelplane-Webhooks/1"
)

// Options configures a Deliverer.
type Options struct {
	Client       *http.Client
	Backoff      queue.Backoff
	MaxAttempts  int
	PollInterval time.Duration
	// Lease is how long a claimed delivery is hidden from other workers. A worker that dies
	// mid-send leaves it to be retried after the lease: delivery is at-least-once, and
	// receivers dedupe on the event id.
	Lease time.Duration
	Now   func() time.Time
}

// Deliverer sends due webhook deliveries. Several workers can run one each: deliveries are
// claimed with FOR UPDATE SKIP LOCKED, like jobs.
type Deliverer struct {
	pool *pgxpool.Pool
	opts Options
	log  *slog.Logger
}

func New(pool *pgxpool.Pool, opts Options, log *slog.Logger) *Deliverer {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Deliverer{pool: pool, opts: opts, log: log}
}

// Run delivers until stop is cancelled.
func (d *Deliverer) Run(stop context.Context) {
	for stop.Err() == nil {
		sent, err := d.DeliverDue(stop)
		if err != nil && stop.Err() == nil {
			d.log.Error("webhook delivery", "err", err)
		}
		if sent == 0 || err != nil {
			select {
			case <-stop.Done():
			case <-time.After(d.opts.PollInterval):
			}
		}
	}
}

type delivery struct {
	id        string
	attempt   int
	eventID   string
	eventType string
	payload   []byte
	url       string
	secret    string
}

type outcome struct {
	status   int
	duration time.Duration
	response string
	err      error
}

// DeliverDue claims up to one batch of due deliveries, sends them, and records each result.
// It returns how many it attempted.
func (d *Deliverer) DeliverDue(ctx context.Context) (int, error) {
	due, err := d.claim(ctx)
	if err != nil || len(due) == 0 {
		return 0, err
	}
	var wg sync.WaitGroup
	errs := make([]error, len(due))
	for i, item := range due {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = d.record(ctx, item, d.send(ctx, item))
		}()
	}
	wg.Wait()
	return len(due), errors.Join(errs...)
}

// claim takes due deliveries of enabled endpoints (a disabled endpoint's deliveries wait until
// it is enabled again) and pushes their next attempt out by the lease.
func (d *Deliverer) claim(ctx context.Context) ([]delivery, error) {
	rows, err := d.pool.Query(ctx, `
		update reelplane.webhook_deliveries w
		   set attempts = w.attempts + 1,
		       next_attempt_at = now() + make_interval(secs => $2),
		       last_attempt_at = now()
		  from reelplane.webhook_endpoints e
		 where e.id = w.endpoint_id
		   and w.id in (
		         select w2.id from reelplane.webhook_deliveries w2
		           join reelplane.webhook_endpoints e2 on e2.id = w2.endpoint_id and e2.enabled
		          where w2.state = 'pending' and w2.next_attempt_at <= now()
		          order by w2.next_attempt_at
		          limit $1
		            for update of w2 skip locked)
		returning w.id, w.attempts, w.event_id, w.event_type, w.payload::text, e.url, e.secret`,
		batchSize, d.opts.Lease.Seconds())
	if err != nil {
		return nil, fmt.Errorf("claim webhook deliveries: %w", err)
	}
	defer rows.Close()
	var due []delivery
	for rows.Next() {
		var item delivery
		var payload string
		if err := rows.Scan(&item.id, &item.attempt, &item.eventID, &item.eventType, &payload, &item.url, &item.secret); err != nil {
			return nil, fmt.Errorf("scan webhook delivery: %w", err)
		}
		item.payload = []byte(payload)
		due = append(due, item)
	}
	return due, rows.Err()
}

func (d *Deliverer) send(ctx context.Context, item delivery) outcome {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, item.url, bytes.NewReader(item.payload))
	if err != nil {
		return outcome{err: fmt.Errorf("invalid endpoint URL: %w", err)}
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", userAgent)
	request.Header.Set("Reelplane-Event-Id", item.eventID)
	request.Header.Set("Reelplane-Event-Type", item.eventType)
	request.Header.Set(SignatureHeader, Sign(item.secret, item.payload, d.opts.Now()))

	started := time.Now()
	response, err := d.opts.Client.Do(request)
	if err != nil {
		return outcome{duration: time.Since(started), err: err}
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, maxResponseLog))
	result := outcome{status: response.StatusCode, duration: time.Since(started), response: validUTF8(body)}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		result.err = fmt.Errorf("endpoint answered %d", response.StatusCode)
	}
	return result
}

// record stores the attempt: delivered, retried after a backoff, or dead after MaxAttempts.
func (d *Deliverer) record(ctx context.Context, item delivery, result outcome) error {
	var status any
	if result.status != 0 {
		status = result.status
	}
	durationMs := result.duration.Milliseconds()
	if result.err == nil {
		_, err := d.pool.Exec(ctx, `
			update reelplane.webhook_deliveries
			   set state = 'succeeded', delivered_at = now(), last_status_code = $2,
			       last_duration_ms = $3, last_response = $4, last_error = null
			 where id = $1`, item.id, status, durationMs, result.response)
		if err != nil {
			return fmt.Errorf("record webhook success: %w", err)
		}
		d.log.Info("webhook delivered", "delivery", item.id, "event", item.eventType, "status", result.status, "ms", durationMs)
		return nil
	}

	state, retryIn := "pending", d.opts.Backoff.Delay(item.attempt)
	if item.attempt >= d.opts.MaxAttempts {
		state, retryIn = "dead", 0
	}
	_, err := d.pool.Exec(ctx, `
		update reelplane.webhook_deliveries
		   set state = $2, next_attempt_at = now() + make_interval(secs => $3),
		       last_status_code = $4, last_duration_ms = $5, last_response = $6, last_error = $7
		 where id = $1`,
		item.id, state, retryIn.Seconds(), status, durationMs, nullIfEmpty(result.response), truncate(result.err.Error()))
	if err != nil {
		return fmt.Errorf("record webhook failure: %w", err)
	}
	d.log.Warn("webhook failed", "delivery", item.id, "event", item.eventType, "attempt", item.attempt,
		"state", state, "retry_in", retryIn.Round(time.Second), "err", result.err)
	return nil
}

func validUTF8(body []byte) string {
	return string(bytes.ToValidUTF8(body, []byte("�")))
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

const maxErrorLength = 500

func truncate(message string) string {
	if len(message) <= maxErrorLength {
		return message
	}
	cut := maxErrorLength
	for cut > 0 && !utf8.RuneStart(message[cut]) {
		cut--
	}
	return message[:cut]
}
