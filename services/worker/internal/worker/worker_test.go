package worker_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/omadityashukla/reelplane/services/worker/internal/media"
	"github.com/omadityashukla/reelplane/services/worker/internal/pipeline"
	"github.com/omadityashukla/reelplane/services/worker/internal/queue"
	"github.com/omadityashukla/reelplane/services/worker/internal/storage"
	"github.com/omadityashukla/reelplane/services/worker/internal/testdb"
	"github.com/omadityashukla/reelplane/services/worker/internal/worker"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

var fastOpts = worker.Options{
	HeartbeatInterval: 100 * time.Millisecond,
	PollInterval:      50 * time.Millisecond,
	ShutdownGrace:     300 * time.Millisecond,
}

func newQueue(db *testdb.DB, id string, lease time.Duration) *queue.Queue {
	return queue.New(db.Worker, id, lease, queue.Backoff{Base: time.Hour, Max: time.Hour, Random: func() float64 { return 1 }})
}

// runUntil runs the worker in the background until cond holds (or the test times out), then
// stops it and waits for it to return.
func runUntil(t *testing.T, w *worker.Worker, timeout time.Duration, cond func() bool) {
	t.Helper()
	stop, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- w.Run(stop) }()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			cancel()
			<-done
			t.Fatalf("condition not met within %s", timeout)
		}
		time.Sleep(25 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("worker returned %v", err)
	}
}

func jobState(t *testing.T, db *testdb.DB, jobID string) string {
	return testdb.Scalar[string](t, db, `select state from reelplane.jobs where id = $1`, jobID)
}

func requireFFmpeg(t *testing.T) {
	t.Helper()
	if os.Getenv("REELPLANE_SKIP_FFMPEG_TESTS") == "1" {
		t.Skip("REELPLANE_SKIP_FFMPEG_TESTS=1")
	}
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Fatal("ffmpeg not on PATH")
	}
}

func realPipeline(store storage.Store) *pipeline.Pipeline {
	return &pipeline.Pipeline{
		Store: store, FFmpeg: "ffmpeg", FFprobe: "ffprobe", Preset: "ultrafast",
		Limits: media.Limits{MaxDuration: time.Minute, MaxSide: 4096, MinSide: 64},
	}
}

func TestWorkerTranscodesAndPublishesAJob(t *testing.T) {
	requireFFmpeg(t)
	db := testdb.New(t, "reelplane_test_worker_e2e")
	store := storage.Dir{Root: t.TempDir()}
	seed := db.SeedJob(t, "", 5)

	clip := filepath.Join(t.TempDir(), "clip.mp4")
	if err := media.GenerateClip(context.Background(), "ffmpeg", clip, media.Clip{Width: 720, Height: 1280, Duration: 4 * time.Second, FPS: 30, Audio: true}); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(clip)
	if err := store.Put(context.Background(), seed.SourceKey, body, "video/mp4"); err != nil {
		t.Fatal(err)
	}
	// Leftovers of an earlier crashed attempt must be cleaned up once this one wins.
	stale := "media/" + seed.ProjectID + "/" + seed.VideoID + "/deadbeef0000-a1/240p/seg_000.m4s"
	_ = store.Put(context.Background(), stale, []byte("half-written"), "video/iso.segment")
	// The database recorded that dead attempt as garbage when it was reaped; the sweeper deletes it.
	if _, err := db.Owner.Exec(context.Background(), `insert into reelplane.storage_garbage (prefix, reason, not_before) values ($1, 'test', now())`,
		"media/"+seed.ProjectID+"/"+seed.VideoID+"/deadbeef0000-a1/"); err != nil {
		t.Fatal(err)
	}

	w := worker.New(newQueue(db, "e2e", 10*time.Second), realPipeline(store), store, fastOpts, quiet)
	runUntil(t, w, 90*time.Second, func() bool {
		return jobState(t, db, seed.JobID) == "succeeded" && testdb.Scalar[int](t, db, `select count(*)::int from reelplane.storage_garbage`) == 0
	})

	master := testdb.Scalar[string](t, db, `select master_playlist_key from reelplane.videos where id = $1`, seed.VideoID)
	status := testdb.Scalar[string](t, db, `select status from reelplane.videos where id = $1`, seed.VideoID)
	renditions := testdb.Scalar[int](t, db, `select count(*)::int from reelplane.renditions where video_id = $1`, seed.VideoID)
	speed := testdb.Scalar[float64](t, db, `select (metrics->>'speedRealtime')::float from reelplane.jobs where id = $1`, seed.JobID)
	if status != "ready" || renditions != 3 || speed <= 0 {
		t.Fatalf("status=%s renditions=%d speed=%.2f", status, renditions, speed)
	}
	keys, _ := store.List(context.Background(), "media/")
	var hasMaster, hasStale bool
	for _, key := range keys {
		hasMaster = hasMaster || key == master
		hasStale = hasStale || key == stale
	}
	if !hasMaster || hasStale {
		t.Fatalf("master uploaded=%v, stale attempt still present=%v", hasMaster, hasStale)
	}
}

func TestWorkerDeadLettersAnInvalidSourceWithoutRetrying(t *testing.T) {
	requireFFmpeg(t)
	db := testdb.New(t, "reelplane_test_worker_invalid")
	store := storage.Dir{Root: t.TempDir()}
	seed := db.SeedJob(t, "", 5)
	_ = store.Put(context.Background(), seed.SourceKey, []byte("\x89PNG\r\n\x1a\nthis is a photo"), "video/mp4")

	w := worker.New(newQueue(db, "w", 10*time.Second), realPipeline(store), store, fastOpts, quiet)
	runUntil(t, w, 30*time.Second, func() bool { return jobState(t, db, seed.JobID) == "dead" })

	attempts := testdb.Scalar[int](t, db, `select attempts from reelplane.jobs where id = $1`, seed.JobID)
	reason := testdb.Scalar[string](t, db, `select failure_reason from reelplane.videos where id = $1`, seed.VideoID)
	if attempts != 1 || !strings.Contains(reason, "invalid video") {
		t.Fatalf("attempts=%d reason=%q", attempts, reason)
	}
}

// blockingProcessor runs until its context is cancelled, like a long FFmpeg encode.
type blockingProcessor struct{ started atomic.Bool }

func (p *blockingProcessor) Run(ctx context.Context, _ *queue.Job, progress func(int)) (queue.Result, error) {
	p.started.Store(true)
	progress(10)
	<-ctx.Done()
	return queue.Result{}, ctx.Err()
}

func TestGracefulShutdownReleasesAnUnfinishedJob(t *testing.T) {
	db := testdb.New(t, "reelplane_test_worker_shutdown")
	seed := db.SeedJob(t, "", 5)
	processor := &blockingProcessor{}
	w := worker.New(newQueue(db, "w", 10*time.Second), processor, storage.Dir{Root: t.TempDir()}, fastOpts, quiet)

	runUntil(t, w, 10*time.Second, processor.started.Load) // stop as soon as work begins

	if state := jobState(t, db, seed.JobID); state != "queued" {
		t.Fatalf("state = %s, want queued (released)", state)
	}
	attempts := testdb.Scalar[int](t, db, `select attempts from reelplane.jobs where id = $1`, seed.JobID)
	video := testdb.Scalar[string](t, db, `select status from reelplane.videos where id = $1`, seed.VideoID)
	if attempts != 0 || video != "queued" {
		t.Fatalf("attempts=%d video=%s; a shutdown must not spend an attempt", attempts, video)
	}
}

// slowProcessor finishes after a delay, regardless of shutdown (within the grace period).
type slowProcessor struct{ delay time.Duration }

func (p slowProcessor) Run(ctx context.Context, job *queue.Job, _ func(int)) (queue.Result, error) {
	select {
	case <-time.After(p.delay):
		prefix := queue.AttemptPrefix(job)
		return queue.Result{Prefix: prefix, MasterKey: prefix + "/master.m3u8", DurationMs: 1000, Width: 720, Height: 1280}, nil
	case <-ctx.Done():
		return queue.Result{}, ctx.Err()
	}
}

func TestGracefulShutdownLetsAJobFinishWithinTheGracePeriod(t *testing.T) {
	db := testdb.New(t, "reelplane_test_worker_grace")
	seed := db.SeedJob(t, "", 5)
	opts := fastOpts
	opts.ShutdownGrace = 3 * time.Second
	w := worker.New(newQueue(db, "w", 10*time.Second), slowProcessor{delay: 500 * time.Millisecond}, storage.Dir{Root: t.TempDir()}, opts, quiet)

	stop, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- w.Run(stop) }()
	for jobState(t, db, seed.JobID) != "running" {
		time.Sleep(10 * time.Millisecond)
	}
	cancel() // SIGTERM arrives mid-job
	<-done
	if state := jobState(t, db, seed.JobID); state != "succeeded" {
		t.Fatalf("state = %s, want succeeded", state)
	}
}

func TestAWorkerThatLosesItsLeaseStopsAndDoesNotPublish(t *testing.T) {
	db := testdb.New(t, "reelplane_test_worker_lease")
	seed := db.SeedJob(t, "", 5)
	processor := &blockingProcessor{}
	w := worker.New(newQueue(db, "victim", 10*time.Second), processor, storage.Dir{Root: t.TempDir()}, fastOpts, quiet)

	stop, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- w.Run(stop) }()
	for !processor.started.Load() {
		time.Sleep(10 * time.Millisecond)
	}
	// Simulate the reaper handing the job to another worker while this one is paused
	// (GC pause, network partition): the next heartbeat must notice and abort the work.
	if _, err := db.Owner.Exec(context.Background(),
		`update reelplane.jobs set lease_owner = 'thief', attempts = attempts + 1 where id = $1`, seed.JobID); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for processor.started.Load() && time.Now().Before(deadline) {
		// The processor returns once its context is cancelled; wait for the worker to idle.
		if testdb.Scalar[int](t, db, `select count(*)::int from reelplane.video_events where video_id = $1 and type like 'job.%'`, seed.VideoID) > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(4 * fastOpts.HeartbeatInterval)
	cancel()
	<-done

	owner := testdb.Scalar[string](t, db, `select lease_owner from reelplane.jobs where id = $1`, seed.JobID)
	if state := jobState(t, db, seed.JobID); state != "running" || owner != "thief" {
		t.Fatalf("state=%s owner=%s: the victim must not touch a job it no longer owns", state, owner)
	}
}

// flakyProcessor fails once with a transient error, then succeeds.
type flakyProcessor struct{ calls atomic.Int32 }

func (p *flakyProcessor) Run(ctx context.Context, job *queue.Job, progress func(int)) (queue.Result, error) {
	if p.calls.Add(1) == 1 {
		return queue.Result{}, errors.New("storage timeout")
	}
	return slowProcessor{}.Run(ctx, job, progress)
}

func TestTransientFailuresAreRetriedWithBackoff(t *testing.T) {
	db := testdb.New(t, "reelplane_test_worker_retry")
	seed := db.SeedJob(t, "", 5)
	w := worker.New(newQueue(db, "w", 10*time.Second), &flakyProcessor{}, storage.Dir{Root: t.TempDir()}, fastOpts, quiet)

	runUntil(t, w, 10*time.Second, func() bool {
		return testdb.Scalar[string](t, db, `select coalesce(last_error, '') from reelplane.jobs where id = $1`, seed.JobID) != ""
	})
	runAfter := testdb.Scalar[time.Time](t, db, `select run_after from reelplane.jobs where id = $1`, seed.JobID)
	if state := jobState(t, db, seed.JobID); state != "queued" || time.Until(runAfter) < 50*time.Minute {
		t.Fatalf("state=%s retry in %s; want queued with a 1h backoff", state, time.Until(runAfter).Round(time.Minute))
	}
}

// seedClip seeds a job whose source is a real 2-second clip.
func seedClip(t *testing.T, db *testdb.DB, store storage.Store) testdb.Seeded {
	t.Helper()
	seed := db.SeedJob(t, "", 5)
	clip := filepath.Join(t.TempDir(), "clip.mp4")
	if err := media.GenerateClip(context.Background(), "ffmpeg", clip, media.Clip{Width: 360, Height: 640, Duration: 2 * time.Second, FPS: 30}); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(clip)
	if err := store.Put(context.Background(), seed.SourceKey, body, "video/mp4"); err != nil {
		t.Fatal(err)
	}
	return seed
}

func TestASourceLargerThanDeclaredIsRefusedWithoutRetrying(t *testing.T) {
	requireFFmpeg(t)
	db := testdb.New(t, "reelplane_test_worker_oversize")
	store := storage.Dir{Root: t.TempDir()}
	seed := seedClip(t, db, store)
	// The upload declared 100 bytes; storage holds the whole clip.
	if _, err := db.Owner.Exec(context.Background(), `update reelplane.videos set size_bytes = 100 where id = $1`, seed.VideoID); err != nil {
		t.Fatal(err)
	}

	w := worker.New(newQueue(db, "w", 10*time.Second), realPipeline(store), store, fastOpts, quiet)
	runUntil(t, w, 30*time.Second, func() bool { return jobState(t, db, seed.JobID) == "dead" })

	attempts := testdb.Scalar[int](t, db, `select attempts from reelplane.jobs where id = $1`, seed.JobID)
	reason := testdb.Scalar[string](t, db, `select failure_reason from reelplane.videos where id = $1`, seed.VideoID)
	if attempts != 1 || !strings.Contains(reason, "larger than the declared 100 bytes") {
		t.Fatalf("attempts=%d reason=%q", attempts, reason)
	}
}

func TestAnEncodePastItsDeadlineIsStoppedAndRetried(t *testing.T) {
	requireFFmpeg(t)
	db := testdb.New(t, "reelplane_test_worker_deadline")
	store := storage.Dir{Root: t.TempDir()}
	seed := seedClip(t, db, store)
	p := realPipeline(store)
	p.EncodeDeadline = func(time.Duration) time.Duration { return 50 * time.Millisecond }

	w := worker.New(newQueue(db, "w", 10*time.Second), p, store, fastOpts, quiet)
	runUntil(t, w, 30*time.Second, func() bool {
		return testdb.Scalar[string](t, db, `select coalesce(last_error, '') from reelplane.jobs where id = $1`, seed.JobID) != ""
	})

	lastError := testdb.Scalar[string](t, db, `select last_error from reelplane.jobs where id = $1`, seed.JobID)
	if state := jobState(t, db, seed.JobID); state != "queued" || !strings.Contains(lastError, "encoding took longer than 50ms") {
		t.Fatalf("state=%s last_error=%q; want a retryable deadline failure", state, lastError)
	}
}

// stalledStore never finishes a download, like a storage connection that hangs.
type stalledStore struct{ storage.Dir }

func (stalledStore) Download(ctx context.Context, _, _ string, _ int64) error {
	<-ctx.Done()
	return ctx.Err()
}

func TestAJobPastItsTimeoutIsStoppedAndRetried(t *testing.T) {
	db := testdb.New(t, "reelplane_test_worker_job_timeout")
	seed := db.SeedJob(t, "", 5)
	store := stalledStore{storage.Dir{Root: t.TempDir()}}
	p := realPipeline(store)
	p.JobTimeout = 200 * time.Millisecond

	w := worker.New(newQueue(db, "w", 10*time.Second), p, store, fastOpts, quiet)
	runUntil(t, w, 10*time.Second, func() bool {
		return testdb.Scalar[string](t, db, `select coalesce(last_error, '') from reelplane.jobs where id = $1`, seed.JobID) != ""
	})

	lastError := testdb.Scalar[string](t, db, `select last_error from reelplane.jobs where id = $1`, seed.JobID)
	if state := jobState(t, db, seed.JobID); state != "queued" || !strings.Contains(lastError, "job took longer than 200ms") {
		t.Fatalf("state=%s last_error=%q; want a retryable timeout", state, lastError)
	}
}
