// Package queue implements the transcode job queue on Postgres.
//
// Delivery is at-least-once: a job whose worker dies is handed to another worker when its
// lease expires. Results are exactly-once: every write after the claim is fenced on
// (state = 'running' AND lease_owner = me), so a worker that lost its lease can never
// complete, fail or release a job that someone else now owns.
package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrLeaseLost means another worker owns the job now (our lease expired and was reaped).
var ErrLeaseLost = errors.New("queue: lease lost")

const maxErrorLength = 2000

// Job is a claimed transcode job together with what the worker needs from its video.
type Job struct {
	ID          string
	VideoID     string
	ProjectID   string
	Attempt     int
	MaxAttempts int
	SourceKey   string
	ContentType string
	SizeBytes   int64
}

// Rendition is one rung of the published HLS ladder.
type Rendition struct {
	Name        string
	Width       int
	Height      int
	BitrateKbps int
	FPS         float64
	Codecs      string
	PlaylistKey string
}

// Result is what a successful transcode publishes. Prefix is the attempt's unique storage
// prefix; committing it to the video row is the atomic "publish".
type Result struct {
	Prefix        string
	MasterKey     string
	PosterKey     string
	ThumbnailKeys []string
	Placeholder   string
	DurationMs    int
	Width         int
	Height        int
	Renditions    []Rendition
	Metrics       map[string]any
}

// Backoff computes the delay before retry number `attempt` (1-based): exponential with full
// jitter, so jobs that failed together (an outage) do not all retry at the same instant.
type Backoff struct {
	Base   time.Duration
	Max    time.Duration
	Random func() float64
}

func (b Backoff) Delay(attempt int) time.Duration {
	ceiling := float64(b.Max)
	if exp := float64(b.Base) * math.Pow(2, float64(attempt-1)); exp < ceiling {
		ceiling = exp
	}
	random := b.Random
	if random == nil {
		random = rand.Float64
	}
	return time.Duration(random() * ceiling)
}

type Queue struct {
	pool     *pgxpool.Pool
	workerID string
	lease    time.Duration
	backoff  Backoff
	// garbageDelay is how long a dead attempt's prefix waits before it is swept.
	garbageDelay time.Duration
}

// DefaultGarbageDelay comfortably exceeds the time a paused worker needs to notice (at its next
// heartbeat) that it lost its lease and stop uploading.
const DefaultGarbageDelay = 10 * time.Minute

func New(pool *pgxpool.Pool, workerID string, lease time.Duration, backoff Backoff) *Queue {
	return &Queue{pool: pool, workerID: workerID, lease: lease, backoff: backoff, garbageDelay: DefaultGarbageDelay}
}

// SetGarbageDelay overrides DefaultGarbageDelay (the chaos test uses seconds).
func (q *Queue) SetGarbageDelay(d time.Duration) { q.garbageDelay = d }

// AttemptPrefix is unique per job attempt. Outputs are written there and only become visible
// when the video row is pointed at it, so a crashed or zombie attempt can never be seen
// half-written and can never overwrite the attempt that wins.
func AttemptPrefix(job *Job) string {
	return fmt.Sprintf("%s%s-a%d", VideoMediaPrefix(job), strings.ReplaceAll(job.ID, "-", "")[:12], job.Attempt)
}

// VideoMediaPrefix holds every attempt's outputs for one video.
func VideoMediaPrefix(job *Job) string {
	return fmt.Sprintf("media/%s/%s/", job.ProjectID, job.VideoID)
}

// recordGarbage marks an attempt's outputs for deletion, inside the transaction that made
// them garbage: the cleanup is recorded if and only if the state change commits.
func (q *Queue) recordGarbage(ctx context.Context, tx pgx.Tx, prefix, reason string) error {
	_, err := tx.Exec(ctx, `
		insert into reelplane.storage_garbage (prefix, reason, not_before)
		values ($1, $2, now() + make_interval(secs => $3))
		on conflict (prefix) do nothing`,
		strings.TrimSuffix(prefix, "/")+"/", reason, seconds(q.garbageDelay))
	if err != nil {
		return fmt.Errorf("record garbage %s: %w", prefix, err)
	}
	return nil
}

// WorkerID identifies this queue's owner in leases and audit events.
func (q *Queue) WorkerID() string { return q.workerID }

// OpenPool connects as the login role and drops to the RLS-scoped `reelplane_worker` role on
// every connection, so worker code can never read API keys or bypass policies.
func OpenPool(ctx context.Context, databaseURL string, maxConns int32) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	cfg.MaxConns = maxConns
	cfg.ConnConfig.RuntimeParams["application_name"] = "reelplane-worker"
	cfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, err := conn.Exec(ctx, "set role reelplane_worker")
		return err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect to postgres: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect to postgres: %w", err)
	}
	return pool, nil
}

func seconds(d time.Duration) float64 { return d.Seconds() }

func truncate(message string) string {
	if len(message) <= maxErrorLength {
		return message
	}
	return message[:maxErrorLength]
}

// Claim takes the next runnable job, or returns (nil, nil) when there is none.
// SKIP LOCKED lets any number of workers claim concurrently without ever getting the same row
// and without waiting on each other.
func (q *Queue) Claim(ctx context.Context) (*Job, error) {
	for {
		job, retry, err := q.claimOnce(ctx)
		if err != nil || !retry {
			return job, err
		}
		// The claimed job's video was deleted meanwhile: it was cancelled, look again.
	}
}

func (q *Queue) claimOnce(ctx context.Context) (job *Job, retry bool, err error) {
	err = pgx.BeginFunc(ctx, q.pool, func(tx pgx.Tx) error {
		var j Job
		row := tx.QueryRow(ctx, `
			with next as (
			  select id from reelplane.jobs
			   where state = 'queued' and run_after <= now()
			   order by run_after, created_at
			   limit 1
			   for update skip locked
			)
			update reelplane.jobs j
			   set state = 'running', attempts = j.attempts + 1, lease_owner = $1,
			       lease_expires_at = now() + make_interval(secs => $2), heartbeat_at = now(),
			       started_at = coalesce(j.started_at, now()), progress = 0
			  from next
			 where j.id = next.id
			returning j.id, j.video_id, j.project_id, j.attempts, j.max_attempts`,
			q.workerID, seconds(q.lease))
		if err := row.Scan(&j.ID, &j.VideoID, &j.ProjectID, &j.Attempt, &j.MaxAttempts); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			return fmt.Errorf("claim job: %w", err)
		}

		var status string
		if err := tx.QueryRow(ctx, `
			select status, source_key, content_type, size_bytes
			  from reelplane.videos where id = $1 for update`, j.VideoID,
		).Scan(&status, &j.SourceKey, &j.ContentType, &j.SizeBytes); err != nil {
			return fmt.Errorf("load video %s: %w", j.VideoID, err)
		}
		switch status {
		case "queued":
			if _, err := tx.Exec(ctx,
				`update reelplane.videos set status = 'processing' where id = $1`, j.VideoID); err != nil {
				return fmt.Errorf("mark video processing: %w", err)
			}
		case "processing":
			// A retry after a crash: the video is already processing.
		default:
			if _, err := tx.Exec(ctx, `
				update reelplane.jobs set state = 'cancelled', lease_owner = null, lease_expires_at = null,
				       finished_at = now(), last_error = $2
				 where id = $1`, j.ID, "video is "+status); err != nil {
				return fmt.Errorf("cancel job: %w", err)
			}
			retry = true
			return nil
		}
		job = &j
		return nil
	})
	if err != nil || retry {
		return nil, retry, err
	}
	return job, false, nil
}

// Heartbeat extends the lease and records progress. ErrLeaseLost means stop working: the job
// was reaped and may already be running elsewhere.
func (q *Queue) Heartbeat(ctx context.Context, job *Job, progress int) error {
	tag, err := q.pool.Exec(ctx, `
		update reelplane.jobs
		   set lease_expires_at = now() + make_interval(secs => $3), heartbeat_at = now(),
		       progress = greatest(progress, $4)
		 where id = $1 and state = 'running' and lease_owner = $2`,
		job.ID, q.workerID, seconds(q.lease), min(max(progress, 0), 99))
	if err != nil {
		return fmt.Errorf("heartbeat: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrLeaseLost
	}
	return nil
}

// fence locks the job row and verifies we still hold its lease, inside the caller's tx.
func (q *Queue) fence(ctx context.Context, tx pgx.Tx, job *Job) error {
	var state string
	var owner *string
	err := tx.QueryRow(ctx,
		`select state, lease_owner from reelplane.jobs where id = $1 for update`, job.ID,
	).Scan(&state, &owner)
	if err != nil {
		return fmt.Errorf("lock job: %w", err)
	}
	if state != "running" || owner == nil || *owner != q.workerID {
		return ErrLeaseLost
	}
	return nil
}

// Complete publishes a successful transcode: job succeeded, renditions replaced, video ready
// and pointing at result.Prefix (which queues the video.ready webhook), all in one transaction.
// It returns published=false if the video was deleted while it was being processed.
func (q *Queue) Complete(ctx context.Context, job *Job, result Result) (published bool, err error) {
	metrics, err := json.Marshal(result.Metrics)
	if err != nil {
		return false, fmt.Errorf("encode metrics: %w", err)
	}
	// pgx sends a nil slice as SQL NULL, which the NOT NULL column rejects.
	thumbnails := result.ThumbnailKeys
	if thumbnails == nil {
		thumbnails = []string{}
	}
	err = pgx.BeginFunc(ctx, q.pool, func(tx pgx.Tx) error {
		if err := q.fence(ctx, tx, job); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			update reelplane.jobs
			   set state = 'succeeded', lease_owner = null, lease_expires_at = null, progress = 100,
			       finished_at = now(), last_error = null, metrics = $2
			 where id = $1`, job.ID, metrics); err != nil {
			return fmt.Errorf("mark job succeeded: %w", err)
		}
		tag, err := tx.Exec(ctx, `
			update reelplane.videos
			   set status = 'ready', duration_ms = $2, width = $3, height = $4, playback_prefix = $5,
			       master_playlist_key = $6, poster_key = $7, thumbnail_keys = $8, placeholder = $9,
			       failure_reason = null, ready_at = now()
			 where id = $1 and status = 'processing'`,
			job.VideoID, result.DurationMs, result.Width, result.Height, result.Prefix,
			result.MasterKey, result.PosterKey, thumbnails, result.Placeholder)
		if err != nil {
			return fmt.Errorf("mark video ready: %w", err)
		}
		if tag.RowsAffected() == 0 {
			// Deleted mid-processing: the job is done, and its outputs are garbage.
			return q.recordGarbage(ctx, tx, result.Prefix, "video deleted during processing")
		}
		published = true
		// The video.ready webhook is queued by the database (trigger videos_webhooks).
		return replaceRenditions(ctx, tx, job, result.Renditions)
	})
	return published, err
}

func replaceRenditions(ctx context.Context, tx pgx.Tx, job *Job, renditions []Rendition) error {
	if _, err := tx.Exec(ctx, `delete from reelplane.renditions where video_id = $1`, job.VideoID); err != nil {
		return fmt.Errorf("clear renditions: %w", err)
	}
	for _, r := range renditions {
		if _, err := tx.Exec(ctx, `
			insert into reelplane.renditions
			  (video_id, project_id, name, width, height, bitrate_kbps, fps, codecs, playlist_key)
			values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			job.VideoID, job.ProjectID, r.Name, r.Width, r.Height, r.BitrateKbps, nullableFPS(r.FPS), r.Codecs, r.PlaylistKey,
		); err != nil {
			return fmt.Errorf("insert rendition %s: %w", r.Name, err)
		}
	}
	return nil
}

// Outcome reports what Fail did with the job.
type Outcome struct {
	Retrying bool
	RunAfter time.Duration
}

// Fail records a failed attempt. Transient failures are retried with backoff until
// max_attempts; permanent ones (invalid input) and exhausted jobs go to the dead letter state
// with the error kept for debugging.
func (q *Queue) Fail(ctx context.Context, job *Job, cause error, permanent bool) (Outcome, error) {
	var outcome Outcome
	err := pgx.BeginFunc(ctx, q.pool, func(tx pgx.Tx) error {
		if err := q.fence(ctx, tx, job); err != nil {
			return err
		}
		var err error
		outcome, err = q.failLocked(ctx, tx, job, job.Attempt, job.MaxAttempts, truncate(cause.Error()), permanent)
		return err
	})
	return outcome, err
}

func (q *Queue) failLocked(ctx context.Context, tx pgx.Tx, job *Job, attempt, maxAttempts int, message string, permanent bool) (Outcome, error) {
	if err := q.recordGarbage(ctx, tx, AttemptPrefix(job), "attempt failed: "+message); err != nil {
		return Outcome{}, err
	}
	if !permanent && attempt < maxAttempts {
		delay := q.backoff.Delay(attempt)
		if _, err := tx.Exec(ctx, `
			update reelplane.jobs
			   set state = 'queued', run_after = now() + make_interval(secs => $2),
			       lease_owner = null, lease_expires_at = null, last_error = $3
			 where id = $1`, job.ID, seconds(delay), message); err != nil {
			return Outcome{}, fmt.Errorf("requeue job: %w", err)
		}
		if _, err := tx.Exec(ctx,
			`update reelplane.videos set status = 'queued' where id = $1 and status = 'processing'`,
			job.VideoID); err != nil {
			return Outcome{}, fmt.Errorf("requeue video: %w", err)
		}
		return Outcome{Retrying: true, RunAfter: delay}, nil
	}

	if _, err := tx.Exec(ctx, `
		update reelplane.jobs
		   set state = 'dead', lease_owner = null, lease_expires_at = null, last_error = $2,
		       finished_at = now()
		 where id = $1`, job.ID, message); err != nil {
		return Outcome{}, fmt.Errorf("dead-letter job: %w", err)
	}
	// The video.failed webhook is queued by the database (trigger videos_webhooks).
	if _, err := tx.Exec(ctx, `
		update reelplane.videos set status = 'failed', failure_reason = $2
		 where id = $1 and status in ('queued', 'processing')`, job.VideoID, message); err != nil {
		return Outcome{}, fmt.Errorf("fail video: %w", err)
	}
	return Outcome{}, nil
}

// Release hands a job back without counting the attempt (graceful shutdown).
func (q *Queue) Release(ctx context.Context, job *Job) error {
	return pgx.BeginFunc(ctx, q.pool, func(tx pgx.Tx) error {
		if err := q.fence(ctx, tx, job); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			update reelplane.jobs
			   set state = 'queued', attempts = attempts - 1, run_after = now(), progress = 0,
			       lease_owner = null, lease_expires_at = null
			 where id = $1`, job.ID); err != nil {
			return fmt.Errorf("release job: %w", err)
		}
		if err := q.recordGarbage(ctx, tx, AttemptPrefix(job), "attempt released on shutdown"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`update reelplane.videos set status = 'queued' where id = $1 and status = 'processing'`, job.VideoID)
		return err
	})
}

// ReapExpired returns jobs whose worker stopped heartbeating (crashed, killed, partitioned) to
// the queue, or dead-letters them if they are out of attempts. Any worker may run it; SKIP
// LOCKED keeps concurrent reapers from blocking each other.
func (q *Queue) ReapExpired(ctx context.Context) (int, error) {
	reaped := 0
	err := pgx.BeginFunc(ctx, q.pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			select id, video_id, project_id, attempts, max_attempts, lease_owner
			  from reelplane.jobs
			 where state = 'running' and lease_expires_at < now()
			 order by lease_expires_at
			 limit 50
			 for update skip locked`)
		if err != nil {
			return fmt.Errorf("find expired leases: %w", err)
		}
		type expired struct {
			job   Job
			owner string
		}
		var found []expired
		for rows.Next() {
			var e expired
			if err := rows.Scan(&e.job.ID, &e.job.VideoID, &e.job.ProjectID, &e.job.Attempt, &e.job.MaxAttempts, &e.owner); err != nil {
				rows.Close()
				return fmt.Errorf("scan expired lease: %w", err)
			}
			found = append(found, e)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("find expired leases: %w", err)
		}
		for _, e := range found {
			message := fmt.Sprintf("lease expired: worker %s stopped heartbeating", e.owner)
			if _, err := q.failLocked(ctx, tx, &e.job, e.job.Attempt, e.job.MaxAttempts, message, false); err != nil {
				return err
			}
			reaped++
		}
		return nil
	})
	return reaped, err
}

// garbageBatch bounds how many prefixes one sweep deletes (and how long its row locks live).
const garbageBatch = 20

// SweepGarbage deletes due garbage prefixes with `remove` (storage DeletePrefix). Rows are
// claimed with SKIP LOCKED so workers sweep in parallel; a failed deletion is retried later
// with backoff instead of being forgotten.
func (q *Queue) SweepGarbage(ctx context.Context, remove func(context.Context, string) error) (int, error) {
	swept := 0
	err := pgx.BeginFunc(ctx, q.pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			select prefix, attempts from reelplane.storage_garbage
			 where not_before <= now()
			 order by not_before
			 limit $1
			 for update skip locked`, garbageBatch)
		if err != nil {
			return fmt.Errorf("find garbage: %w", err)
		}
		type item struct {
			prefix   string
			attempts int
		}
		var due []item
		for rows.Next() {
			var it item
			if err := rows.Scan(&it.prefix, &it.attempts); err != nil {
				rows.Close()
				return err
			}
			due = append(due, it)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, it := range due {
			if removeErr := remove(ctx, it.prefix); removeErr != nil {
				retryIn := min(time.Hour, time.Minute*time.Duration(1<<min(it.attempts, 6)))
				if _, err := tx.Exec(ctx, `
					update reelplane.storage_garbage
					   set attempts = attempts + 1, last_error = $2, not_before = now() + make_interval(secs => $3)
					 where prefix = $1`, it.prefix, truncate(removeErr.Error()), seconds(retryIn)); err != nil {
					return err
				}
				continue
			}
			if _, err := tx.Exec(ctx, `delete from reelplane.storage_garbage where prefix = $1`, it.prefix); err != nil {
				return err
			}
			swept++
		}
		return nil
	})
	return swept, err
}

// nullableFPS stores an unknown (zero) frame rate as NULL rather than violating the check.
func nullableFPS(fps float64) any {
	if fps <= 0 {
		return nil
	}
	return fps
}
