// Command chaos proves the queue's guarantees under failure: it runs N transcode jobs on a
// fleet of real worker processes while repeatedly killing them (TerminateProcess / SIGKILL,
// no chance to clean up), then checks that every job finished exactly once, with no lost or
// duplicated videos, and that every published playlist is complete in storage.
//
//	go build -o bin/worker ./cmd/worker && go run ./cmd/chaos -jobs 40 -workers 3
package main

import (
	"context"
	"flag"
	"fmt"
	"math/rand/v2"
	"os"
	"os/signal"
	"path/filepath"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/omadityashukla/reelplane/services/worker/internal/config"
	"github.com/omadityashukla/reelplane/services/worker/internal/dbsetup"
	"github.com/omadityashukla/reelplane/services/worker/internal/media"
	"github.com/omadityashukla/reelplane/services/worker/internal/storage"
	"github.com/omadityashukla/reelplane/services/worker/internal/testdb"
)

type options struct {
	jobs, workers, maxAttempts int
	killMin, killMax           time.Duration
	lease, heartbeat           time.Duration
	clip                       time.Duration
	timeout                    time.Duration
	workerBin, outDir, report  string
	seed                       uint64
	preset                     string
}

func parseFlags() options {
	var o options
	flag.IntVar(&o.jobs, "jobs", 40, "number of transcode jobs")
	flag.IntVar(&o.workers, "workers", 3, "worker processes running at once")
	flag.IntVar(&o.maxAttempts, "max-attempts", 25, "max attempts per job before dead-lettering")
	flag.DurationVar(&o.killMin, "kill-min", 1500*time.Millisecond, "shortest gap between kills")
	flag.DurationVar(&o.killMax, "kill-max", 4*time.Second, "longest gap between kills")
	flag.DurationVar(&o.lease, "lease", 4*time.Second, "worker lease duration")
	flag.DurationVar(&o.heartbeat, "heartbeat", time.Second, "worker heartbeat interval")
	flag.DurationVar(&o.clip, "clip", 8*time.Second, "length of each source clip")
	flag.DurationVar(&o.timeout, "timeout", 15*time.Minute, "give up after this long")
	flag.StringVar(&o.workerBin, "worker", filepath.Join("bin", "worker"+exeSuffix()), "worker binary")
	flag.StringVar(&o.outDir, "out", filepath.Join(os.TempDir(), "reelplane-chaos"), "directory for worker logs")
	flag.StringVar(&o.report, "report", "", "write the results as JSON to this file")
	flag.Uint64Var(&o.seed, "seed", uint64(time.Now().UnixNano()), "random seed (to replay a run)")
	flag.StringVar(&o.preset, "preset", "veryfast", "x264 preset")
	flag.Parse()
	return o
}

func main() {
	opts := parseFlags()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	results, err := run(ctx, opts)
	if err != nil {
		fmt.Fprintln(os.Stderr, "chaos:", err)
		os.Exit(2)
	}
	printReport(results)
	if opts.report != "" {
		if err := writeReport(opts.report, results); err != nil {
			fmt.Fprintln(os.Stderr, "chaos: write report:", err)
		}
	}
	if !results.Passed {
		os.Exit(1)
	}
}

func run(ctx context.Context, opts options) (*Results, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(opts.workerBin); err != nil {
		return nil, fmt.Errorf("worker binary %s not found: build it with `go build -o %s ./cmd/worker`", opts.workerBin, opts.workerBin)
	}
	if err := os.MkdirAll(opts.outDir, 0o755); err != nil {
		return nil, err
	}

	dbURL, err := dbsetup.Recreate(ctx, cfg.DatabaseURL, "reelplane_chaos")
	if err != nil {
		return nil, err
	}
	owner, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		return nil, err
	}
	defer owner.Close()
	if err := dbsetup.Migrate(ctx, owner); err != nil {
		return nil, err
	}
	store, err := storage.NewS3(cfg.Storage)
	if err != nil {
		return nil, err
	}

	logf("seeding %d jobs with a %s clip…", opts.jobs, opts.clip)
	seeds, err := seed(ctx, owner, store, opts)
	if err != nil {
		return nil, err
	}

	rng := rand.New(rand.NewPCG(opts.seed, opts.seed^0x9e3779b97f4a7c15))
	fleet := newFleet(opts, dbURL)
	defer fleet.stopAll()
	started := time.Now()
	logf("starting %d workers (lease %s, heartbeat %s), killing one every %s–%s; seed %d",
		opts.workers, opts.lease, opts.heartbeat, opts.killMin, opts.killMax, opts.seed)
	if err := fleet.startAll(); err != nil {
		return nil, err
	}

	chaos := runChaos(ctx, owner, fleet, rng, opts, started)
	elapsed := time.Since(started)
	if chaos.err != nil {
		return nil, chaos.err
	}
	// Chaos is over: let the surviving workers sweep the garbage left by killed attempts.
	if err := awaitGarbageSwept(ctx, owner, time.Minute); err != nil {
		return nil, err
	}
	fleet.stopAll()

	logf("all jobs settled after %s; verifying…", elapsed.Round(time.Second))
	results, err := verify(ctx, owner, store, seeds, opts)
	if err != nil {
		return nil, err
	}
	results.Elapsed = elapsed
	results.Kills = chaos.kills
	results.KillsMidJob = chaos.killsMidJob
	results.Seed = opts.seed
	results.Config = opts.summary()
	results.ZombieRejections, results.AbandonedOnLeaseLoss = scanLogs(opts.outDir)
	results.evaluate()
	return results, nil
}

func seed(ctx context.Context, owner *pgxpool.Pool, store storage.Store, opts options) ([]testdb.Seeded, error) {
	clipPath := filepath.Join(opts.outDir, "source.mp4")
	clip := media.Clip{Width: 720, Height: 1280, Duration: opts.clip, FPS: 30, Audio: true}
	if err := media.GenerateClip(ctx, "ffmpeg", clipPath, clip); err != nil {
		return nil, err
	}
	body, err := os.ReadFile(clipPath)
	if err != nil {
		return nil, err
	}
	seeds := make([]testdb.Seeded, 0, opts.jobs)
	project := ""
	for range opts.jobs {
		s, err := testdb.SeedJob(ctx, owner, project, opts.maxAttempts)
		if err != nil {
			return nil, err
		}
		project = s.ProjectID
		if err := store.Put(ctx, s.SourceKey, body, "video/mp4"); err != nil {
			return nil, err
		}
		seeds = append(seeds, s)
	}
	return seeds, nil
}

func awaitGarbageSwept(ctx context.Context, owner *pgxpool.Pool, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		var left int
		if err := owner.QueryRow(ctx, `select count(*) from reelplane.storage_garbage`).Scan(&left); err != nil {
			return err
		}
		if left == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%d garbage prefixes still unswept after %s", left, timeout)
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func (o options) summary() map[string]any {
	return map[string]any{
		"jobs": o.jobs, "workers": o.workers, "maxAttempts": o.maxAttempts,
		"killEvery": fmt.Sprintf("%s-%s", o.killMin, o.killMax), "lease": o.lease.String(),
		"heartbeat": o.heartbeat.String(), "clip": o.clip.String(), "preset": o.preset,
	}
}

func logf(format string, args ...any) {
	fmt.Printf("[chaos %s] %s\n", time.Now().Format("15:04:05"), fmt.Sprintf(format, args...))
}
