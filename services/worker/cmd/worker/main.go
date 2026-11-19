// Command worker is the Reelplane transcoding worker: it claims jobs from Postgres, runs
// FFmpeg and publishes HLS to object storage. Configuration: see internal/config.
//
// `worker reposter [-dry-run]` instead regenerates the posters of published showcase videos
// from their kept originals (internal/reposter), without re-transcoding, and exits.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/omadityaxd/reelplane/services/worker/internal/config"
	"github.com/omadityaxd/reelplane/services/worker/internal/media"
	"github.com/omadityaxd/reelplane/services/worker/internal/pipeline"
	"github.com/omadityaxd/reelplane/services/worker/internal/queue"
	"github.com/omadityaxd/reelplane/services/worker/internal/reposter"
	"github.com/omadityaxd/reelplane/services/worker/internal/storage"
	"github.com/omadityaxd/reelplane/services/worker/internal/webhooks"
	"github.com/omadityaxd/reelplane/services/worker/internal/worker"
)

const (
	maxSourceSide = 4096
	minSourceSide = 64
)

func main() {
	runCommand := run
	if len(os.Args) > 1 && os.Args[1] == "reposter" {
		runCommand = func() error { return runReposter(os.Args[2:]) }
	}
	if err := runCommand(); err != nil {
		fmt.Fprintln(os.Stderr, "worker:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}
	log := newLogger(cfg.LogFormat)

	// SIGTERM (docker stop, Kubernetes, HF Spaces) and Ctrl-C both trigger graceful shutdown.
	stop, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	connect, done := context.WithTimeout(stop, 30*time.Second)
	defer done()
	pool, err := queue.OpenPool(connect, cfg.DatabaseURL, 8) // jobs + up to 8 webhook sends
	if err != nil {
		return err
	}
	defer pool.Close()

	store, err := storage.NewS3(cfg.Storage)
	if err != nil {
		return err
	}
	backoff := queue.Backoff{Base: cfg.RetryBase, Max: cfg.RetryMax}
	q := queue.New(pool, cfg.WorkerID, cfg.LeaseDuration, backoff)
	q.SetGarbageDelay(cfg.GarbageDelay)
	p := &pipeline.Pipeline{
		Store: store, FFmpeg: cfg.FFmpegPath, FFprobe: cfg.FFprobePath, Preset: cfg.Preset,
		Threads: cfg.FFmpegThreads,
		Limits:  media.Limits{MaxDuration: cfg.MaxDuration, MaxSide: maxSourceSide, MinSide: minSourceSide},
		TempDir: cfg.TempDir, JobTimeout: cfg.JobTimeout,
	}
	w := worker.New(q, p, store, worker.Options{
		HeartbeatInterval: cfg.HeartbeatInterval,
		PollInterval:      cfg.PollInterval,
		ShutdownGrace:     cfg.ShutdownGrace,
		CleanupEvery:      cfg.CleanupEvery,
		DemoMaxAge:        cfg.DemoMaxAge,
	}, log)
	hooks := webhooks.New(pool, webhooks.Options{
		Client:       webhooks.NewClient(cfg.WebhookTimeout, cfg.WebhookAllowPrivate),
		Backoff:      queue.Backoff{Base: cfg.WebhookRetryBase, Max: cfg.WebhookRetryMax},
		MaxAttempts:  cfg.WebhookMaxAttempts,
		PollInterval: cfg.PollInterval,
		Lease:        3 * cfg.WebhookTimeout,
	}, log)
	log.Info("configuration", "storage", cfg.Storage.Provider, "lease", cfg.LeaseDuration,
		"heartbeat", cfg.HeartbeatInterval, "preset", cfg.Preset, "ffmpeg_threads", cfg.FFmpegThreads,
		"webhook_private_urls", cfg.WebhookAllowPrivate)

	var delivering sync.WaitGroup
	delivering.Go(func() { hooks.Run(stop) })
	defer delivering.Wait()
	return w.Run(stop)
}

func newLogger(format string) *slog.Logger {
	if format == "json" {
		return slog.New(slog.NewJSONHandler(os.Stdout, nil))
	}
	return slog.New(slog.NewTextHandler(os.Stdout, nil))
}

func runReposter(args []string) error {
	flags := flag.NewFlagSet("reposter", flag.ContinueOnError)
	dryRun := flags.Bool("dry-run", false, "choose and report the new poster frames, change nothing")
	if err := flags.Parse(args); err != nil {
		return err
	}
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}
	log := newLogger(cfg.LogFormat)
	stop, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	pool, err := queue.OpenPool(stop, cfg.DatabaseURL, 1)
	if err != nil {
		return err
	}
	defer pool.Close()
	store, err := storage.NewS3(cfg.Storage)
	if err != nil {
		return err
	}
	results, err := reposter.Run(stop, pool, store, reposter.Options{
		FFmpeg: cfg.FFmpegPath, FFprobe: cfg.FFprobePath, TempDir: cfg.TempDir, DryRun: *dryRun, Log: log,
	})
	changed := 0
	for _, result := range results {
		if result.Changed {
			changed++
		}
	}
	log.Info("reposter done", "videos", len(results), "changed", changed, "dry_run", *dryRun)
	return err
}
