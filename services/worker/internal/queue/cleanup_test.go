package queue_test

import (
	"context"
	"testing"
	"time"

	"github.com/omadityashukla/reelplane/services/worker/internal/queue"
	"github.com/omadityashukla/reelplane/services/worker/internal/testdb"
)

func TestCleanup(t *testing.T) {
	ctx := context.Background()
	db := testdb.New(t, "reelplane_test_cleanup")
	q := queue.New(db.Worker, "w", time.Minute, queue.Backoff{Base: time.Second, Max: time.Second})

	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Owner.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	video := func(project, status string, showcase bool, age time.Duration) string {
		t.Helper()
		var id string
		if err := db.Owner.QueryRow(ctx, `
			insert into reelplane.videos (project_id, content_type, size_bytes, source_key, status,
			                              is_showcase, created_at, upload_id, upload_expires_at)
			values ($1, 'video/mp4', 1, 'originals/x/y/source', 'uploading', $2, now() - make_interval(secs => $3),
			        'mp-1', now() - make_interval(secs => $3) + interval '24 hours')
			returning id`, project, showcase, age.Seconds()).Scan(&id); err != nil {
			t.Fatal(err)
		}
		for _, next := range map[string][]string{"ready": {"queued", "processing", "ready"}, "uploading": nil}[status] {
			exec(`update reelplane.videos set status = $2 where id = $1`, id, next)
		}
		return id
	}
	project := func(demo bool) string {
		var id string
		if err := db.Owner.QueryRow(ctx, `insert into reelplane.projects (name, owner_id, is_demo)
			values ('p', gen_random_uuid(), $1) returning id`, demo).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	status := func(id string) string {
		return testdb.Scalar[string](t, db, `select status from reelplane.videos where id = $1`, id)
	}

	demo, customer := project(true), project(false)
	week := 7 * 24 * time.Hour
	oldDemo := video(demo, "ready", false, week+time.Hour)
	oldShowcase := video(demo, "ready", true, week+time.Hour)
	newDemo := video(demo, "ready", false, week-time.Hour)
	oldCustomer := video(customer, "ready", false, 30*24*time.Hour)
	abandoned := video(customer, "uploading", false, 26*time.Hour) // session expired 2 h ago
	inProgress := video(customer, "uploading", false, time.Hour)
	exec(`insert into reelplane.idempotency_keys (project_id, key, operation, request_hash, created_at)
	      values ($1, 'old', 'op', 'h', now() - interval '25 hours'), ($1, 'new', 'op', 'h', now())`, customer)

	report, err := q.RunCleanup(ctx, 10*time.Minute, week)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Ran || report.DemoVideosDeleted != 1 || report.AbandonedUploadsDeleted != 1 || report.IdempotencyKeysDeleted != 1 {
		t.Fatalf("report = %+v", report)
	}
	if len(report.Aborts) != 1 || report.Aborts[0].UploadID != "mp-1" {
		t.Fatalf("aborts = %+v, want the abandoned upload", report.Aborts)
	}
	for id, want := range map[string]string{
		oldDemo: "deleted", oldShowcase: "ready", newDemo: "ready", oldCustomer: "ready",
		abandoned: "deleted", inProgress: "uploading",
	} {
		if got := status(id); got != want {
			t.Errorf("video %s: status %s, want %s", id, got, want)
		}
	}
	garbage := testdb.Scalar[int](t, db, `select count(*)::int from reelplane.storage_garbage where prefix like '%' || $1 || '/'`, oldDemo)
	if garbage != 2 {
		t.Errorf("expired demo video: %d garbage prefixes, want media + originals", garbage)
	}

	// At most once per interval, however many workers call it.
	again, err := q.RunCleanup(ctx, 10*time.Minute, week)
	if err != nil || again.Ran {
		t.Fatalf("second run = %+v, %v; want skipped", again, err)
	}
}
