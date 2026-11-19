package queue_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/omadityaxd/reelplane/services/worker/internal/queue"
	"github.com/omadityaxd/reelplane/services/worker/internal/testdb"
)

// originalQueued reports whether the video's originals folder is queued as storage garbage.
func originalQueued(t *testing.T, db *testdb.DB, seed testdb.Seeded) bool {
	t.Helper()
	return testdb.Scalar[int](t, db, `select count(*)::int from reelplane.storage_garbage where prefix = $1`,
		"originals/"+seed.ProjectID+"/"+seed.VideoID+"/") == 1
}

// claimSeeded claims jobs until it gets the seeded one (other subtests may leave jobs behind).
func claimSeeded(t *testing.T, q *queue.Queue, seed testdb.Seeded) *queue.Job {
	t.Helper()
	for {
		job := claim(t, q)
		if job == nil {
			t.Fatal("seeded job was never claimed")
		}
		if job.ID == seed.JobID {
			return job
		}
	}
}

func TestOriginalsAfterPublishing(t *testing.T) {
	ctx := context.Background()

	t.Run("a published upload's original is queued for deletion with the publish", func(t *testing.T) {
		db := testdb.New(t, "reelplane_test_originals_published")
		seed := db.SeedJob(t, "", 5)
		q := newQueue(db, "w", time.Minute)
		job := claimSeeded(t, q, seed)
		if prefix := queue.OriginalPrefix(job); prefix != "originals/"+seed.ProjectID+"/"+seed.VideoID+"/" {
			t.Fatalf("OriginalPrefix = %q", prefix)
		}
		if published, err := q.Complete(ctx, job, result("media/published")); err != nil || !published {
			t.Fatalf("complete = %v, %v", published, err)
		}
		if !originalQueued(t, db, seed) {
			t.Fatal("the published video's original was not queued for deletion")
		}
		// Swept after the usual grace period, like every other garbage prefix.
		if due := testdb.Scalar[bool](t, db, `select not_before > now() from reelplane.storage_garbage where prefix like 'originals/%'`); !due {
			t.Error("the original must wait for the garbage grace period")
		}
		var removed []string
		if _, err := q.SweepGarbage(ctx, func(_ context.Context, prefix string) error {
			removed = append(removed, prefix)
			return nil
		}); err != nil || len(removed) != 0 {
			t.Fatalf("swept %v before the grace period (err %v)", removed, err)
		}
	})

	t.Run("a showcase video's original is kept", func(t *testing.T) {
		db := testdb.New(t, "reelplane_test_originals_showcase")
		seed := db.SeedJob(t, "", 5)
		if _, err := db.Owner.Exec(ctx, `update reelplane.videos set is_showcase = true where id = $1`, seed.VideoID); err != nil {
			t.Fatal(err)
		}
		q := newQueue(db, "w", time.Minute)
		if published, err := q.Complete(ctx, claimSeeded(t, q, seed), result("media/showcase")); err != nil || !published {
			t.Fatalf("complete = %v, %v", published, err)
		}
		if originalQueued(t, db, seed) {
			t.Fatal("a showcase original was queued for deletion")
		}
		if n := testdb.Scalar[int](t, db, `select count(*)::int from reelplane.storage_garbage`); n != 0 {
			t.Fatalf("%d garbage rows after publishing a showcase video, want 0", n)
		}
	})

	t.Run("failed, reaped and fenced-off attempts never lose the original", func(t *testing.T) {
		db := testdb.New(t, "reelplane_test_originals_retry")
		seed := db.SeedJob(t, "", 5)
		zombie := newQueue(db, "zombie", time.Minute)
		healthy := newQueue(db, "healthy", time.Minute)

		// Attempt 1 fails transiently and is retried.
		first := claimSeeded(t, healthy, seed)
		if outcome, err := healthy.Fail(ctx, first, errors.New("disk full"), false); err != nil || !outcome.Retrying {
			t.Fatalf("fail = %+v, %v", outcome, err)
		}
		if originalQueued(t, db, seed) {
			t.Fatal("a failed attempt queued the original for deletion")
		}

		// Attempt 2's worker dies; the reaper hands the job back.
		makeRunnable(t, db, seed.JobID)
		second := claimSeeded(t, zombie, seed)
		expireLease(t, db, second.ID)
		if _, err := healthy.ReapExpired(ctx); err != nil {
			t.Fatal(err)
		}
		if originalQueued(t, db, seed) {
			t.Fatal("a reaped attempt queued the original for deletion")
		}

		// Attempt 3 is claimed; the dead attempt 2 wakes up and tries to publish: fenced off,
		// and its rolled-back transaction must not have queued anything either.
		makeRunnable(t, db, seed.JobID)
		third := claimSeeded(t, healthy, seed)
		if third.SourceKey != seed.SourceKey {
			t.Fatalf("retry reads %q, want the original %q", third.SourceKey, seed.SourceKey)
		}
		if _, err := zombie.Complete(ctx, second, result("media/zombie")); !errors.Is(err, queue.ErrLeaseLost) {
			t.Fatalf("zombie complete = %v, want ErrLeaseLost", err)
		}
		// A publish that fails part-way (two renditions with the same name) rolls back whole.
		broken := result("media/broken")
		broken.Renditions = append(broken.Renditions, broken.Renditions[0])
		if _, err := healthy.Complete(ctx, third, broken); err == nil {
			t.Fatal("a publish with duplicate renditions succeeded")
		}
		if originalQueued(t, db, seed) {
			t.Fatal("a fenced-off or rolled-back publish queued the original for deletion")
		}
		if status := testdb.Scalar[string](t, db, `select status from reelplane.videos where id = $1`, seed.VideoID); status != "processing" {
			t.Fatalf("video status = %s after a rolled-back publish", status)
		}

		// Only the attempt that actually publishes queues it.
		if published, err := healthy.Complete(ctx, third, result("media/healthy")); err != nil || !published {
			t.Fatalf("complete = %v, %v", published, err)
		}
		if !originalQueued(t, db, seed) {
			t.Fatal("the original was not queued once the video was published")
		}
	})

	t.Run("a dead-lettered job keeps its original", func(t *testing.T) {
		db := testdb.New(t, "reelplane_test_originals_dead")
		seed := db.SeedJob(t, "", 1)
		q := newQueue(db, "w", time.Minute)
		if outcome, err := q.Fail(ctx, claimSeeded(t, q, seed), errors.New("boom"), false); err != nil || outcome.Retrying {
			t.Fatalf("fail = %+v, %v", outcome, err)
		}
		if originalQueued(t, db, seed) {
			t.Fatal("a dead-lettered job's original was queued for deletion")
		}
	})
}
