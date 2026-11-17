package queue_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/omadityaxd/reelplane/services/worker/internal/queue"
	"github.com/omadityaxd/reelplane/services/worker/internal/testdb"
)

var noJitter = queue.Backoff{Base: time.Second, Max: time.Minute, Random: func() float64 { return 0 }}

func newQueue(db *testdb.DB, worker string, lease time.Duration) *queue.Queue {
	return queue.New(db.Worker, worker, lease, noJitter)
}

func claim(t *testing.T, q *queue.Queue) *queue.Job {
	t.Helper()
	job, err := q.Claim(context.Background())
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	return job
}

func result(prefix string) queue.Result {
	return queue.Result{
		Prefix: prefix, MasterKey: prefix + "/master.m3u8", PosterKey: prefix + "/poster.jpg",
		ThumbnailKeys: []string{prefix + "/thumb_1.jpg"}, Placeholder: "data:image/jpeg;base64,AA",
		DurationMs: 3000, Width: 720, Height: 1280,
		Renditions: []queue.Rendition{
			{Name: "240p", Width: 240, Height: 426, BitrateKbps: 400, Codecs: "avc1.42c015,mp4a.40.2", PlaylistKey: prefix + "/240p/index.m3u8"},
			{Name: "480p", Width: 480, Height: 854, BitrateKbps: 1000, Codecs: "avc1.4d401e,mp4a.40.2", PlaylistKey: prefix + "/480p/index.m3u8"},
		},
		Metrics: map[string]any{"speed": 4.2},
	}
}

// expireLease makes the job's lease look stale, as if its worker died 10 seconds ago.
func expireLease(t *testing.T, db *testdb.DB, jobID string) {
	t.Helper()
	if _, err := db.Owner.Exec(context.Background(),
		`update reelplane.jobs set lease_expires_at = now() - interval '10 seconds' where id = $1`, jobID); err != nil {
		t.Fatalf("expire lease: %v", err)
	}
}

func makeRunnable(t *testing.T, db *testdb.DB, jobID string) {
	t.Helper()
	if _, err := db.Owner.Exec(context.Background(),
		`update reelplane.jobs set run_after = now() where id = $1`, jobID); err != nil {
		t.Fatalf("make runnable: %v", err)
	}
}

func TestQueue(t *testing.T) {
	db := testdb.New(t, "reelplane_test_queue")
	ctx := context.Background()

	t.Run("concurrent workers never claim the same job", func(t *testing.T) {
		const jobs, workers = 60, 8
		project := db.SeedJob(t, "", 5).ProjectID
		for range jobs - 1 {
			db.SeedJob(t, project, 5)
		}
		var mu sync.Mutex
		claimedBy := map[string][]string{}
		var wg sync.WaitGroup
		for w := range workers {
			wg.Go(func() {
				q := newQueue(db, fmt.Sprintf("w%d", w), time.Minute)
				for {
					job, err := q.Claim(ctx)
					if err != nil {
						t.Errorf("claim: %v", err)
						return
					}
					if job == nil {
						return
					}
					mu.Lock()
					claimedBy[job.ID] = append(claimedBy[job.ID], q.WorkerID())
					mu.Unlock()
				}
			})
		}
		wg.Wait()
		if len(claimedBy) < jobs {
			t.Fatalf("claimed %d distinct jobs, want at least %d", len(claimedBy), jobs)
		}
		for id, owners := range claimedBy {
			if len(owners) != 1 {
				t.Errorf("job %s claimed %d times by %v", id, len(owners), owners)
			}
		}
	})

	t.Run("claiming moves the video to processing and records the attempt", func(t *testing.T) {
		seed := db.SeedJob(t, "", 5)
		q := newQueue(db, "w-claim", time.Minute)
		var job *queue.Job
		for job == nil || job.ID != seed.JobID { // earlier subtests may have left jobs behind
			job = claim(t, q)
			if job == nil {
				t.Fatal("seeded job was never claimed")
			}
		}
		if job.Attempt != 1 || job.SourceKey != seed.SourceKey {
			t.Fatalf("job = %+v", job)
		}
		if status := testdb.Scalar[string](t, db, `select status from reelplane.videos where id = $1`, seed.VideoID); status != "processing" {
			t.Fatalf("video status = %s", status)
		}
	})

	t.Run("a worker whose lease was reaped cannot complete the job (fencing)", func(t *testing.T) {
		db := testdb.New(t, "reelplane_test_queue_fence")
		seed := db.SeedJob(t, "", 5)
		zombie := newQueue(db, "zombie", time.Minute)
		healthy := newQueue(db, "healthy", time.Minute)

		first := claim(t, zombie)
		expireLease(t, db, first.ID)
		if n, err := healthy.ReapExpired(ctx); err != nil || n != 1 {
			t.Fatalf("reap = %d, %v", n, err)
		}
		second := claim(t, healthy)
		if second == nil || second.ID != seed.JobID || second.Attempt != 2 {
			t.Fatalf("second claim = %+v", second)
		}

		if _, err := zombie.Complete(ctx, first, result("media/zombie")); !errors.Is(err, queue.ErrLeaseLost) {
			t.Fatalf("zombie complete err = %v, want ErrLeaseLost", err)
		}
		if err := zombie.Heartbeat(ctx, first, 50); !errors.Is(err, queue.ErrLeaseLost) {
			t.Fatalf("zombie heartbeat err = %v, want ErrLeaseLost", err)
		}
		if published, err := healthy.Complete(ctx, second, result("media/healthy")); err != nil || !published {
			t.Fatalf("healthy complete = %v, %v", published, err)
		}

		prefix := testdb.Scalar[string](t, db, `select playback_prefix from reelplane.videos where id = $1`, seed.VideoID)
		readyEvents := testdb.Scalar[int](t, db, `select count(*)::int from reelplane.video_events where video_id = $1 and type = 'video.ready'`, seed.VideoID)
		renditions := testdb.Scalar[int](t, db, `select count(*)::int from reelplane.renditions where video_id = $1`, seed.VideoID)
		if prefix != "media/healthy" || readyEvents != 1 || renditions != 2 {
			t.Fatalf("prefix=%s readyEvents=%d renditions=%d", prefix, readyEvents, renditions)
		}
	})

	t.Run("heartbeats keep a lease alive past its original expiry", func(t *testing.T) {
		db := testdb.New(t, "reelplane_test_queue_heartbeat")
		db.SeedJob(t, "", 5)
		q := newQueue(db, "beater", 2*time.Second)
		job := claim(t, q)
		for range 3 {
			time.Sleep(time.Second)
			if err := q.Heartbeat(ctx, job, 40); err != nil {
				t.Fatalf("heartbeat: %v", err)
			}
		}
		if n, err := newQueue(db, "reaper", time.Minute).ReapExpired(ctx); err != nil || n != 0 {
			t.Fatalf("reaped %d (%v), want 0: the lease is being renewed", n, err)
		}
		if progress := testdb.Scalar[int16](t, db, `select progress from reelplane.jobs where id = $1`, job.ID); progress != 40 {
			t.Fatalf("progress = %d", progress)
		}
	})

	t.Run("transient failures retry with backoff, then dead-letter with the error kept", func(t *testing.T) {
		db := testdb.New(t, "reelplane_test_queue_retry")
		seed := db.SeedJob(t, "", 3)
		if _, err := db.Owner.Exec(ctx, `
			insert into reelplane.webhook_endpoints (project_id, url, secret) values ($1, 'https://hooks.test', 's')`,
			seed.ProjectID); err != nil {
			t.Fatal(err)
		}
		q := queue.New(db.Worker, "w", time.Minute, queue.Backoff{Base: time.Hour, Max: time.Hour, Random: func() float64 { return 1 }})

		for attempt := 1; attempt <= 3; attempt++ {
			job := claim(t, q)
			if job == nil || job.Attempt != attempt {
				t.Fatalf("attempt %d: claimed %+v", attempt, job)
			}
			outcome, err := q.Fail(ctx, job, fmt.Errorf("ffmpeg exited 1 (try %d)", attempt), false)
			if err != nil {
				t.Fatal(err)
			}
			if attempt < 3 {
				if !outcome.Retrying || outcome.RunAfter != time.Hour {
					t.Fatalf("attempt %d outcome = %+v", attempt, outcome)
				}
				if next := claim(t, q); next != nil {
					t.Fatalf("job ran again before its backoff elapsed")
				}
				makeRunnable(t, db, job.ID)
			} else if outcome.Retrying {
				t.Fatal("expected dead-letter after max attempts")
			}
		}

		state := testdb.Scalar[string](t, db, `select state from reelplane.jobs where id = $1`, seed.JobID)
		lastError := testdb.Scalar[string](t, db, `select last_error from reelplane.jobs where id = $1`, seed.JobID)
		videoStatus := testdb.Scalar[string](t, db, `select status from reelplane.videos where id = $1`, seed.VideoID)
		failedHooks := testdb.Scalar[int](t, db, `select count(*)::int from reelplane.webhook_deliveries where event_type = 'video.failed'`)
		if state != "dead" || lastError != "ffmpeg exited 1 (try 3)" || videoStatus != "failed" || failedHooks != 1 {
			t.Fatalf("state=%s error=%q video=%s hooks=%d", state, lastError, videoStatus, failedHooks)
		}
	})

	t.Run("permanent failures skip retries", func(t *testing.T) {
		db := testdb.New(t, "reelplane_test_queue_permanent")
		seed := db.SeedJob(t, "", 5)
		q := newQueue(db, "w", time.Minute)
		if _, err := q.Fail(ctx, claim(t, q), errors.New("not a video: no video stream"), true); err != nil {
			t.Fatal(err)
		}
		if state := testdb.Scalar[string](t, db, `select state from reelplane.jobs where id = $1`, seed.JobID); state != "dead" {
			t.Fatalf("state = %s", state)
		}
	})

	t.Run("releasing on shutdown hands the job back without spending an attempt", func(t *testing.T) {
		db := testdb.New(t, "reelplane_test_queue_release")
		seed := db.SeedJob(t, "", 5)
		q := newQueue(db, "w", time.Minute)
		if err := q.Release(ctx, claim(t, q)); err != nil {
			t.Fatal(err)
		}
		again := claim(t, newQueue(db, "w2", time.Minute))
		if again == nil || again.ID != seed.JobID || again.Attempt != 1 {
			t.Fatalf("after release: %+v", again)
		}
	})

	t.Run("an exhausted job whose worker died is dead-lettered by the reaper", func(t *testing.T) {
		db := testdb.New(t, "reelplane_test_queue_reap_dead")
		seed := db.SeedJob(t, "", 1)
		job := claim(t, newQueue(db, "crashy", time.Minute))
		expireLease(t, db, job.ID)
		if _, err := newQueue(db, "reaper", time.Minute).ReapExpired(ctx); err != nil {
			t.Fatal(err)
		}
		lastError := testdb.Scalar[string](t, db, `select last_error from reelplane.jobs where id = $1`, seed.JobID)
		if state := testdb.Scalar[string](t, db, `select state from reelplane.jobs where id = $1`, seed.JobID); state != "dead" || lastError != "lease expired: worker crashy stopped heartbeating" {
			t.Fatalf("state=%s error=%q", state, lastError)
		}
	})

	t.Run("jobs for deleted videos are cancelled instead of processed", func(t *testing.T) {
		db := testdb.New(t, "reelplane_test_queue_cancel")
		seed := db.SeedJob(t, "", 5)
		if _, err := db.Owner.Exec(ctx, `update reelplane.videos set status = 'deleted' where id = $1`, seed.VideoID); err != nil {
			t.Fatal(err)
		}
		if job := claim(t, newQueue(db, "w", time.Minute)); job != nil {
			t.Fatalf("claimed a job for a deleted video: %+v", job)
		}
		if state := testdb.Scalar[string](t, db, `select state from reelplane.jobs where id = $1`, seed.JobID); state != "cancelled" {
			t.Fatalf("state = %s", state)
		}
	})

	t.Run("the timeline records every step", func(t *testing.T) {
		db := testdb.New(t, "reelplane_test_queue_timeline")
		seed := db.SeedJob(t, "", 5)
		q := newQueue(db, "w", time.Minute)
		if _, err := q.Complete(ctx, claim(t, q), result("media/x")); err != nil {
			t.Fatal(err)
		}
		rows, err := db.Owner.Query(ctx, `select type from reelplane.video_events where video_id = $1 order by id`, seed.VideoID)
		if err != nil {
			t.Fatal(err)
		}
		var types []string
		for rows.Next() {
			var event string
			_ = rows.Scan(&event)
			types = append(types, event)
		}
		want := []string{"video.created", "video.queued", "job.queued", "job.running", "video.processing", "job.succeeded", "video.ready"}
		if fmt.Sprint(types) != fmt.Sprint(want) {
			t.Fatalf("timeline = %v\nwant       %v", types, want)
		}
	})
}

func TestBackoffDelay(t *testing.T) {
	b := queue.Backoff{Base: 10 * time.Second, Max: 5 * time.Minute, Random: func() float64 { return 1 }}
	for attempt, want := range map[int]time.Duration{1: 10 * time.Second, 2: 20 * time.Second, 4: 80 * time.Second, 10: 5 * time.Minute} {
		if got := b.Delay(attempt); got != want {
			t.Errorf("Delay(%d) = %s, want %s", attempt, got, want)
		}
	}
	b.Random = func() float64 { return 0.5 }
	if got := b.Delay(2); got != 10*time.Second {
		t.Errorf("jittered Delay(2) = %s, want 10s", got)
	}
}

func TestStorageGarbage(t *testing.T) {
	db := testdb.New(t, "reelplane_test_queue_garbage")
	ctx := context.Background()
	seed := db.SeedJob(t, "", 5)

	crashed := newQueue(db, "crashed", time.Minute)
	crashed.SetGarbageDelay(0)
	job := claim(t, crashed)
	expireLease(t, db, job.ID)
	if _, err := crashed.ReapExpired(ctx); err != nil {
		t.Fatal(err)
	}
	want := queue.AttemptPrefix(job) + "/"
	if got := testdb.Scalar[string](t, db, `select prefix from reelplane.storage_garbage`); got != want {
		t.Fatalf("garbage prefix = %q, want %q (recorded in the reap transaction)", got, want)
	}

	// A failed deletion is rescheduled, not forgotten.
	failing := func(context.Context, string) error { return errors.New("storage unavailable") }
	if n, err := crashed.SweepGarbage(ctx, failing); err != nil || n != 0 {
		t.Fatalf("failing sweep = %d, %v", n, err)
	}
	if attempts := testdb.Scalar[int](t, db, `select attempts from reelplane.storage_garbage`); attempts != 1 {
		t.Fatalf("attempts = %d", attempts)
	}
	if n, _ := crashed.SweepGarbage(ctx, func(context.Context, string) error { return nil }); n != 0 {
		t.Fatal("a rescheduled prefix must wait for its retry time")
	}

	if _, err := db.Owner.Exec(ctx, `update reelplane.storage_garbage set not_before = now()`); err != nil {
		t.Fatal(err)
	}
	var removed []string
	n, err := crashed.SweepGarbage(ctx, func(_ context.Context, prefix string) error {
		removed = append(removed, prefix)
		return nil
	})
	if err != nil || n != 1 || len(removed) != 1 || removed[0] != want {
		t.Fatalf("sweep = %d, %v, removed %v", n, err, removed)
	}
	if left := testdb.Scalar[int](t, db, `select count(*)::int from reelplane.storage_garbage where prefix like $1`, "media/"+seed.ProjectID+"%"); left != 0 {
		t.Fatalf("%d garbage rows left", left)
	}
}
