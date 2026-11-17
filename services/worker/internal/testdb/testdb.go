// Package testdb creates throwaway Postgres databases from the real migrations in
// packages/db/migrations, so worker tests exercise the same schema, RLS and triggers as prod.
package testdb

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/omadityaxd/reelplane/services/worker/internal/config"
	"github.com/omadityaxd/reelplane/services/worker/internal/dbsetup"
	"github.com/omadityaxd/reelplane/services/worker/internal/queue"
)

// DB is a migrated test database: Owner bypasses RLS (for seeding and assertions), Worker is
// the same pool type the worker uses in production.
type DB struct {
	URL    string
	Owner  *pgxpool.Pool
	Worker *pgxpool.Pool
}

// New recreates database `name` (must start with reelplane_test_) and applies all migrations.
func New(t *testing.T, name string) *DB {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	base := os.Getenv("DATABASE_URL")
	if base == "" {
		base = config.LocalDatabaseURL
	}
	dbURL, err := dbsetup.Recreate(ctx, base, name)
	if err != nil {
		t.Fatalf("tests need Postgres: %v", err)
	}
	owner, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect to %s: %v", name, err)
	}
	t.Cleanup(owner.Close)
	if err := dbsetup.Migrate(ctx, owner); err != nil {
		t.Fatal(err)
	}
	worker, err := queue.OpenPool(ctx, dbURL, 8)
	if err != nil {
		t.Fatalf("open worker pool: %v", err)
	}
	t.Cleanup(worker.Close)
	return &DB{URL: dbURL, Owner: owner, Worker: worker}
}

// Seeded is a project with one queued video and its transcode job.
type Seeded struct {
	ProjectID string
	VideoID   string
	JobID     string
	SourceKey string
}

// SeedJob inserts a project (if projectID is empty), a queued video and its job, as the API
// would after a completed upload.
func (db *DB) SeedJob(t *testing.T, projectID string, maxAttempts int) Seeded {
	t.Helper()
	s, err := SeedJob(context.Background(), db.Owner, projectID, maxAttempts)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// seedSizeBytes is the declared upload size: the worker refuses to download more than this.
const seedSizeBytes = 100 << 20

// SeedJob is the non-test form, shared with the chaos run.
func SeedJob(ctx context.Context, owner *pgxpool.Pool, projectID string, maxAttempts int) (Seeded, error) {
	if projectID == "" {
		if err := owner.QueryRow(ctx, `
			insert into reelplane.projects (name, owner_id) values ('worker-test', gen_random_uuid())
			returning id`).Scan(&projectID); err != nil {
			return Seeded{}, fmt.Errorf("seed project: %w", err)
		}
	}
	s := Seeded{ProjectID: projectID}
	if err := owner.QueryRow(ctx, `
		insert into reelplane.videos (project_id, status, content_type, size_bytes, source_key)
		values ($1, 'uploading', 'video/mp4', $2, 'pending') returning id`, projectID, seedSizeBytes).Scan(&s.VideoID); err != nil {
		return Seeded{}, fmt.Errorf("seed video: %w", err)
	}
	s.SourceKey = fmt.Sprintf("originals/%s/%s/source", projectID, s.VideoID)
	if _, err := owner.Exec(ctx, `
		update reelplane.videos set status = 'queued', source_key = $2 where id = $1`, s.VideoID, s.SourceKey); err != nil {
		return Seeded{}, fmt.Errorf("queue video: %w", err)
	}
	if err := owner.QueryRow(ctx, `
		insert into reelplane.jobs (video_id, project_id, max_attempts) values ($1, $2, $3) returning id`,
		s.VideoID, projectID, maxAttempts).Scan(&s.JobID); err != nil {
		return Seeded{}, fmt.Errorf("seed job: %w", err)
	}
	return s, nil
}

// Scalar runs a single-value query as the owner (for assertions).
func Scalar[T any](t *testing.T, db *DB, sql string, args ...any) T {
	t.Helper()
	var value T
	if err := db.Owner.QueryRow(context.Background(), sql, args...).Scan(&value); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return value
}
