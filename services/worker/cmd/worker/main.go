// Command worker is the Reelplane transcoding worker: it claims jobs from Postgres, runs
// FFmpeg and publishes HLS to object storage. Configuration: see internal/config.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/omadityashukla/reelplane/services/worker/internal/config"
	"github.com/omadityashukla/reelplane/services/worker/internal/media"
	"github.com/omadityashukla/reelplane/services/worker/internal/pipeline"
	"github.com/omadityashukla/reelplane/services/worker/internal/queue"
	"github.com/omadityashukla/reelplane/services/worker/internal/storage"
	"github.com/omadityashukla/reelplane/services/worker/internal/webhooks"
	"github.com/omadityashukla/reelplane/services/worker/internal/worker"
)

const (
	maxSourceSide = 4096
	minSourceSide = 64
)

func main() {
	if err := run(); err != nil {
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
		Limits:  media.Limits{MaxDuration: cfg.MaxDuration, MaxSide: maxSourceSide, MinSide: minSourceSide},
		TempDir: cfg.TempDir,
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
		"heartbeat", cfg.HeartbeatInterval, "preset", cfg.Preset,
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
