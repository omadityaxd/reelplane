package queue_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/omadityaxd/reelplane/services/worker/internal/queue"
	"github.com/omadityaxd/reelplane/services/worker/internal/testdb"
)

// Regression: a graceful release kept the attempt number, so the next claim reused the released
// attempt's storage prefix, which the release had just queued as garbage. The sweeper then
// deleted the files of the video that next claim published.
func TestReleaseNeverRecyclesAPublishedPrefix(t *testing.T) {
	ctx := context.Background()
	db := testdb.New(t, "reelplane_test_release_prefix")
	seed := db.SeedJob(t, "", 3)
	q := newQueue(db, "same-worker-id", time.Minute)

	first := claim(t, q)
	if err := q.Release(ctx, first); err != nil {
		t.Fatal(err)
	}
	second := claim(t, q)
	if second == nil {
		t.Fatal("released job was not claimable again")
	}
	if second.Attempt != first.Attempt {
		t.Errorf("a release must not count as an attempt: %d then %d", first.Attempt, second.Attempt)
	}
	if queue.AttemptPrefix(second) == queue.AttemptPrefix(first) {
		t.Fatalf("the new claim reused the released prefix %s", queue.AttemptPrefix(first))
	}

	// The released claim is fenced out, even under the same worker id.
	if _, err := q.Complete(ctx, first, result(queue.AttemptPrefix(first))); !errors.Is(err, queue.ErrLeaseLost) {
		t.Fatalf("stale claim completed: err = %v", err)
	}
	if err := q.Heartbeat(ctx, first, 50); !errors.Is(err, queue.ErrLeaseLost) {
		t.Fatalf("stale claim heartbeat: err = %v", err)
	}

	published := queue.AttemptPrefix(second)
	if ok, err := q.Complete(ctx, second, result(published)); err != nil || !ok {
		t.Fatalf("Complete = %v, %v", ok, err)
	}
	// Even if garbage for the published prefix were recorded somehow, the sweeper drops it.
	if _, err := db.Owner.Exec(ctx, `insert into reelplane.storage_garbage (prefix, reason, not_before)
		values ($1 || '/', 'test', now() - interval '1 hour') on conflict do nothing`, published); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Owner.Exec(ctx, `update reelplane.storage_garbage set not_before = now() - interval '1 hour'`); err != nil {
		t.Fatal(err)
	}
	var deleted []string
	if _, err := q.SweepGarbage(ctx, func(_ context.Context, prefix string) error {
		deleted = append(deleted, prefix)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, prefix := range deleted {
		if prefix == published+"/" {
			t.Fatalf("the sweeper deleted the published prefix %s", prefix)
		}
	}
	// The released attempt's outputs, and the original now that the video is published.
	want := map[string]bool{queue.AttemptPrefix(first) + "/": true, queue.OriginalPrefix(second): true}
	if len(deleted) != len(want) || !want[deleted[0]] || !want[deleted[1]] {
		t.Errorf("swept %v, want only the released attempt's prefix and the original", deleted)
	}
	status := testdb.Scalar[string](t, db, `select status from reelplane.videos where id = $1`, seed.VideoID)
	if status != "ready" {
		t.Errorf("video status = %s", status)
	}
}
