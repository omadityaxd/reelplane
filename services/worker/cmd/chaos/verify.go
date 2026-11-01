package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/omadityashukla/reelplane/services/worker/internal/storage"
	"github.com/omadityashukla/reelplane/services/worker/internal/testdb"
)

// Results is everything the run measured. Invariant fields must match expectations exactly.
type Results struct {
	Passed     bool           `json:"passed"`
	Violations []string       `json:"violations"`
	Config     map[string]any `json:"config"`
	Seed       uint64         `json:"seed"`
	Elapsed    time.Duration  `json:"elapsedNs"`

	Jobs                 int            `json:"jobs"`
	JobStates            map[string]int `json:"jobStates"`
	VideosReady          int            `json:"videosReady"`
	VideosWithDuplicates int            `json:"videosWithDuplicateJobs"`
	ExactlyOnce          int            `json:"videosCompletedExactlyOnce"`
	RenditionsOK         int            `json:"videosWithFullLadder"`
	PlaylistsComplete    int            `json:"videosWithCompletePlaylistsInStorage"`
	MissingObjects       int            `json:"referencedObjectsMissing"`
	OrphanObjects        int            `json:"orphanedObjectsFromLosingAttempts"`

	Kills                int         `json:"kills"`
	KillsMidJob          int         `json:"killsWhileHoldingAJob"`
	LeaseExpiries        int         `json:"jobsRequeuedAfterLeaseExpiry"`
	AttemptHistogram     map[int]int `json:"attemptHistogram"`
	ZombieRejections     int         `json:"zombieCompletionsRejected"`
	AbandonedOnLeaseLoss int         `json:"jobsAbandonedOnLeaseLoss"`
	MeanSpeedRealtime    float64     `json:"meanTranscodeSpeedRealtime"`
}

const expectedRenditions = 3 // 720x1280 source → 240p, 480p, 720p

func verify(ctx context.Context, owner *pgxpool.Pool, store storage.Store, seeds []testdb.Seeded, opts options) (*Results, error) {
	r := &Results{Jobs: len(seeds), JobStates: map[string]int{}, AttemptHistogram: map[int]int{}}
	if err := queryInto(ctx, owner, `select state, count(*)::int from reelplane.jobs group by state`, func(state string, n int) {
		r.JobStates[state] = n
	}); err != nil {
		return nil, err
	}
	if err := queryInto(ctx, owner, `select attempts, count(*)::int from reelplane.jobs group by attempts`, func(attempts, n int) {
		r.AttemptHistogram[attempts] = n
	}); err != nil {
		return nil, err
	}

	scalars := []struct {
		target *int
		sql    string
	}{
		{&r.VideosReady, `select count(*)::int from reelplane.videos where status = 'ready'`},
		{&r.VideosWithDuplicates, `select count(*)::int from (select video_id from reelplane.jobs group by video_id having count(*) > 1) d`},
		// "Finished exactly once": exactly one committed success and one ready event per video.
		{&r.ExactlyOnce, `
			select count(*)::int from reelplane.videos v
			 where v.status = 'ready'
			   and (select count(*) from reelplane.video_events e where e.video_id = v.id and e.type = 'job.succeeded') = 1
			   and (select count(*) from reelplane.video_events e where e.video_id = v.id and e.type = 'video.ready') = 1`},
		{&r.RenditionsOK, fmt.Sprintf(`
			select count(*)::int from reelplane.videos v
			 where (select count(*) from reelplane.renditions r where r.video_id = v.id) = %d`, expectedRenditions)},
		{&r.LeaseExpiries, `select count(*)::int from reelplane.video_events where type = 'job.queued' and data->>'error' like 'lease expired%'`},
	}
	for _, s := range scalars {
		if err := owner.QueryRow(ctx, s.sql).Scan(s.target); err != nil {
			return nil, fmt.Errorf("%s: %w", s.sql, err)
		}
	}
	if err := owner.QueryRow(ctx, `
		select coalesce(avg((metrics->>'speedRealtime')::float), 0) from reelplane.jobs where state = 'succeeded'`,
	).Scan(&r.MeanSpeedRealtime); err != nil {
		return nil, err
	}
	if err := verifyStorage(ctx, owner, store, seeds, opts, r); err != nil {
		return nil, err
	}
	return r, nil
}

// verifyStorage checks that each published playlist is complete (every init segment and media
// segment it references exists) and counts objects left by losing attempts.
func verifyStorage(ctx context.Context, owner *pgxpool.Pool, store storage.Store, seeds []testdb.Seeded, opts options, r *Results) error {
	tmp := filepath.Join(opts.outDir, "verify")
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return err
	}
	for _, s := range seeds {
		var prefix, master *string
		if err := owner.QueryRow(ctx, `select playback_prefix, master_playlist_key from reelplane.videos where id = $1`, s.VideoID).Scan(&prefix, &master); err != nil {
			return err
		}
		keys, err := store.List(ctx, fmt.Sprintf("media/%s/%s/", s.ProjectID, s.VideoID))
		if err != nil {
			return err
		}
		present := map[string]bool{}
		for _, key := range keys {
			present[key] = true
			if prefix == nil || !strings.HasPrefix(key, *prefix+"/") {
				r.OrphanObjects++
			}
		}
		if master == nil || !present[*master] {
			continue
		}
		missing, err := missingReferences(ctx, store, *master, present, tmp)
		if err != nil {
			return err
		}
		r.MissingObjects += missing
		if missing == 0 {
			r.PlaylistsComplete++
		}
	}
	return nil
}

func missingReferences(ctx context.Context, store storage.Store, masterKey string, present map[string]bool, tmp string) (int, error) {
	variants, err := playlistURIs(ctx, store, masterKey, tmp)
	if err != nil {
		return 0, err
	}
	missing := 0
	for _, variant := range variants {
		if !present[variant] {
			missing++
			continue
		}
		segments, err := playlistURIs(ctx, store, variant, tmp)
		if err != nil {
			return 0, err
		}
		for _, segment := range segments {
			if !present[segment] {
				missing++
			}
		}
	}
	return missing, nil
}

// playlistURIs downloads a playlist and returns the keys of everything it references
// (variant playlists, EXT-X-MAP init segments, media segments).
func playlistURIs(ctx context.Context, store storage.Store, key, tmp string) ([]string, error) {
	local := filepath.Join(tmp, strings.NewReplacer("/", "_").Replace(key))
	if err := store.Download(ctx, key, local); err != nil {
		return nil, err
	}
	file, err := os.Open(local)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	base := path.Dir(key)
	var uris []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		switch {
		case strings.HasPrefix(line, "#EXT-X-MAP:"):
			if _, after, ok := strings.Cut(line, `URI="`); ok {
				uri, _, _ := strings.Cut(after, `"`)
				uris = append(uris, path.Join(base, uri))
			}
		case line != "" && !strings.HasPrefix(line, "#"):
			uris = append(uris, path.Join(base, line))
		}
	}
	return uris, scanner.Err()
}

// scanLogs counts what the workers reported about lost leases.
func scanLogs(dir string) (zombieRejections, abandoned int) {
	files, _ := filepath.Glob(filepath.Join(dir, "chaos-*.log"))
	for _, file := range files {
		body, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		text := string(body)
		zombieRejections += strings.Count(text, "the lease was lost first")
		abandoned += strings.Count(text, "abandoned job: lease lost")
	}
	return
}

func queryInto[K comparable](ctx context.Context, pool *pgxpool.Pool, sql string, put func(K, int)) error {
	rows, err := pool.Query(ctx, sql)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var key K
		var n int
		if err := rows.Scan(&key, &n); err != nil {
			return err
		}
		put(key, n)
	}
	return rows.Err()
}

// evaluate turns the measurements into pass/fail against the invariants.
func (r *Results) evaluate() {
	check := func(ok bool, format string, args ...any) {
		if !ok {
			r.Violations = append(r.Violations, fmt.Sprintf(format, args...))
		}
	}
	check(r.JobStates["succeeded"] == r.Jobs, "%d of %d jobs succeeded (states: %v)", r.JobStates["succeeded"], r.Jobs, r.JobStates)
	check(r.VideosReady == r.Jobs, "%d of %d videos ready: videos were lost", r.VideosReady, r.Jobs)
	check(r.VideosWithDuplicates == 0, "%d videos have more than one job: duplicates", r.VideosWithDuplicates)
	check(r.ExactlyOnce == r.Jobs, "%d of %d videos completed exactly once", r.ExactlyOnce, r.Jobs)
	check(r.RenditionsOK == r.Jobs, "%d of %d videos have exactly %d renditions", r.RenditionsOK, r.Jobs, expectedRenditions)
	check(r.PlaylistsComplete == r.Jobs && r.MissingObjects == 0, "%d playlists incomplete, %d referenced objects missing", r.Jobs-r.PlaylistsComplete, r.MissingObjects)
	check(r.OrphanObjects == 0, "%d objects from losing attempts were never cleaned up", r.OrphanObjects)
	r.Passed = len(r.Violations) == 0
}
