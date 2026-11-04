// Package worker runs the claim → process → publish loop with heartbeats, lease fencing and
// graceful shutdown.
package worker

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"strings"
	"sync/atomic"
	"time"

	"github.com/omadityashukla/reelplane/services/worker/internal/media"
	"github.com/omadityashukla/reelplane/services/worker/internal/queue"
	"github.com/omadityashukla/reelplane/services/worker/internal/storage"
)

var (
	errShutdown  = errors.New("worker shutting down")
	errLeaseLost = errors.New("lease lost to another worker")
)

// dbTimeout bounds every queue call made outside the job's own context (complete, fail,
// release), so a hung database cannot block shutdown forever.
const dbTimeout = 15 * time.Second

// Processor is the pipeline seen by the worker (an interface so tests can fake slow or
// failing processing).
type Processor interface {
	Run(ctx context.Context, job *queue.Job, progress func(int)) (queue.Result, error)
}

type Options struct {
	HeartbeatInterval time.Duration
	PollInterval      time.Duration
	ShutdownGrace     time.Duration
	ReapInterval      time.Duration
	// CleanupEvery is how often the fleet runs the cleanup job (0 = never); DemoMaxAge is
	// how long demo uploads live.
	CleanupEvery time.Duration
	DemoMaxAge   time.Duration
}

type Worker struct {
	queue     *queue.Queue
	processor Processor
	store     storage.Store
	opts      Options
	log       *slog.Logger
}

func New(q *queue.Queue, processor Processor, store storage.Store, opts Options, log *slog.Logger) *Worker {
	if opts.ReapInterval == 0 {
		opts.ReapInterval = opts.HeartbeatInterval
	}
	return &Worker{queue: q, processor: processor, store: store, opts: opts, log: log}
}

// Run processes jobs until stop is cancelled (SIGTERM). The job in progress then gets
// ShutdownGrace to finish; if it does not, it is released back to the queue.
func (w *Worker) Run(stop context.Context) error {
	w.log.Info("worker started", "worker", w.queue.WorkerID())
	lastReap := time.Time{}
	idle := 0
	for stop.Err() == nil {
		if time.Since(lastReap) >= w.opts.ReapInterval {
			w.housekeeping(stop)
			lastReap = time.Now()
		}

		job, err := w.queue.Claim(stop)
		if err != nil {
			if stop.Err() != nil {
				break
			}
			w.log.Warn("claim failed", "error", err)
			idle++
			sleep(stop, w.pollDelay(idle))
			continue
		}
		if job == nil {
			idle++
			sleep(stop, w.pollDelay(idle))
			continue
		}
		idle = 0
		w.handle(stop, job)
	}
	w.log.Info("worker stopped", "worker", w.queue.WorkerID())
	return nil
}

// pollDelay backs off while idle (up to 5x the poll interval) with jitter, so an idle fleet
// does not hit Postgres in lockstep.
func (w *Worker) pollDelay(idle int) time.Duration {
	base := w.opts.PollInterval * time.Duration(min(idle, 5))
	return base/2 + time.Duration(rand.Int64N(int64(base/2)+1))
}

func (w *Worker) handle(stop context.Context, job *queue.Job) {
	log := w.log.With("job", job.ID, "video", job.VideoID, "attempt", job.Attempt)
	log.Info("processing job")
	jobCtx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)

	var progress atomic.Int32
	go w.heartbeat(jobCtx, cancel, job, &progress, log)
	go w.watchShutdown(stop, jobCtx, cancel)

	result, err := w.processor.Run(jobCtx, job, func(p int) { progress.Store(int32(p)) })
	cause := context.Cause(jobCtx)
	switch {
	case err == nil:
		w.publish(job, result, log)
	case errors.Is(cause, errLeaseLost):
		log.Warn("abandoned job: lease lost, another worker owns it now")
		w.discard(queue.AttemptPrefix(job), log)
	case errors.Is(cause, errShutdown):
		w.release(job, log)
	default:
		w.fail(job, err, log)
	}
}

func (w *Worker) heartbeat(ctx context.Context, cancel context.CancelCauseFunc, job *queue.Job, progress *atomic.Int32, log *slog.Logger) {
	ticker := time.NewTicker(w.opts.HeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			beat, done := context.WithTimeout(ctx, w.opts.HeartbeatInterval)
			err := w.queue.Heartbeat(beat, job, int(progress.Load()))
			done()
			if errors.Is(err, queue.ErrLeaseLost) {
				cancel(errLeaseLost)
				return
			}
			if err != nil && ctx.Err() == nil {
				// Transient (DB blip): keep trying. If the lease lapses meanwhile, fencing
				// makes our eventual Complete fail instead of double-publishing.
				log.Warn("heartbeat failed", "error", err)
			}
		}
	}
}

func (w *Worker) watchShutdown(stop, jobCtx context.Context, cancel context.CancelCauseFunc) {
	select {
	case <-jobCtx.Done():
		return
	case <-stop.Done():
	}
	timer := time.NewTimer(w.opts.ShutdownGrace)
	defer timer.Stop()
	select {
	case <-jobCtx.Done():
	case <-timer.C:
		cancel(errShutdown)
	}
}

func (w *Worker) publish(job *queue.Job, result queue.Result, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), dbTimeout)
	defer cancel()
	published, err := w.queue.Complete(ctx, job, result)
	switch {
	case errors.Is(err, queue.ErrLeaseLost):
		log.Warn("finished, but the lease was lost first: discarding this attempt's output")
		w.discard(result.Prefix, log)
		return
	case err != nil:
		// Unknown commit state: leave outputs in place. Either the lease expires and another
		// attempt wins (and cleans up this prefix), or the commit did land.
		log.Error("could not publish result", "error", err)
		return
	case !published:
		log.Info("video was deleted during processing; discarding output")
		w.discard(result.Prefix, log)
		return
	}
	// Earlier attempts' leftovers were recorded in storage_garbage when those attempts were
	// reaped or failed; the sweeper deletes them even if this worker dies right now.
	log.Info("published", "prefix", result.Prefix, "metrics", result.Metrics)
}

// housekeeping requeues jobs of dead workers, runs the cleanup job and sweeps storage garbage.
func (w *Worker) housekeeping(stop context.Context) {
	if err := w.queue.Seen(stop); err != nil && stop.Err() == nil {
		w.log.Warn("recording presence failed", "error", err)
	}
	if n, err := w.queue.ReapExpired(stop); err != nil && stop.Err() == nil {
		w.log.Warn("reaping expired leases failed", "error", err)
	} else if n > 0 {
		w.log.Info("requeued jobs from dead workers", "count", n)
	}
	if w.opts.CleanupEvery > 0 {
		w.cleanup(stop)
	}
	remove := func(ctx context.Context, prefix string) error {
		_, err := w.store.DeletePrefix(ctx, prefix)
		return err
	}
	if n, err := w.queue.SweepGarbage(stop, remove); err != nil && stop.Err() == nil {
		w.log.Warn("sweeping storage garbage failed", "error", err)
	} else if n > 0 {
		w.log.Info("swept storage garbage", "prefixes", n)
	}
}

// cleanup expires demo uploads and abandoned upload sessions (their files are swept as garbage
// right after) and aborts the abandoned sessions' multipart uploads.
func (w *Worker) cleanup(stop context.Context) {
	report, err := w.queue.RunCleanup(stop, w.opts.CleanupEvery, w.opts.DemoMaxAge)
	if err != nil {
		if stop.Err() == nil {
			w.log.Warn("cleanup failed", "error", err)
		}
		return
	}
	if !report.Ran {
		return
	}
	for _, upload := range report.Aborts {
		if err := w.store.AbortMultipart(stop, upload.Key, upload.UploadID); err != nil {
			w.log.Warn("aborting an abandoned upload failed", "key", upload.Key, "error", err)
		}
	}
	w.log.Info("cleanup", "demo_videos_deleted", report.DemoVideosDeleted,
		"abandoned_uploads_deleted", report.AbandonedUploadsDeleted,
		"idempotency_keys_deleted", report.IdempotencyKeysDeleted,
		"rate_limit_windows_deleted", report.RateLimitWindowsDeleted)
}

func (w *Worker) discard(prefix string, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), dbTimeout)
	defer cancel()
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	if n, err := w.store.DeletePrefix(ctx, prefix); err != nil {
		log.Warn("cleanup failed", "prefix", prefix, "error", err)
	} else if n > 0 {
		log.Info("cleaned up attempt output", "prefix", prefix, "objects", n)
	}
}

func (w *Worker) release(job *queue.Job, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), dbTimeout)
	defer cancel()
	if err := w.queue.Release(ctx, job); err != nil {
		log.Warn("release on shutdown failed; the lease will expire instead", "error", err)
		return
	}
	log.Info("released job back to the queue for another worker")
	w.discard(queue.AttemptPrefix(job), log)
}

func (w *Worker) fail(job *queue.Job, cause error, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), dbTimeout)
	defer cancel()
	permanent := media.IsInvalidInput(cause)
	outcome, err := w.queue.Fail(ctx, job, cause, permanent)
	if err != nil {
		log.Error("recording failure failed; the lease will expire instead", "error", err, "cause", cause)
		return
	}
	if outcome.Retrying {
		log.Warn("job failed, will retry", "error", cause, "retryIn", outcome.RunAfter.Round(time.Second))
	} else {
		log.Error("job failed permanently", "error", cause, "permanent", permanent)
	}
	w.discard(queue.AttemptPrefix(job), log)
}

func sleep(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}
