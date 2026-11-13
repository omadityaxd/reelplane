// Package config reads the worker's settings from environment variables. Storage variables
// use the same STORAGE_* names as the TypeScript API, so one .env configures both.
package config

import (
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// LocalDatabaseURL matches docker-compose.yml, so the worker runs with no configuration.
const LocalDatabaseURL = "postgres://reelplane:reelplane@localhost:54320/reelplane"

type Storage struct {
	Provider        string
	Endpoint        string
	Region          string
	Bucket          string
	AccessKeyID     string
	SecretAccessKey string
	ForcePathStyle  bool
}

type Config struct {
	DatabaseURL string
	Storage     Storage
	WorkerID    string

	LeaseDuration     time.Duration
	HeartbeatInterval time.Duration
	PollInterval      time.Duration
	ShutdownGrace     time.Duration
	GarbageDelay      time.Duration
	RetryBase         time.Duration
	RetryMax          time.Duration
	CleanupEvery      time.Duration
	DemoMaxAge        time.Duration
	// JobTimeout bounds one job end to end; the encode has its own, tighter deadline
	// (pipeline.EncodeDeadline).
	JobTimeout time.Duration

	// Webhook deliveries (see internal/webhooks).
	WebhookTimeout     time.Duration
	WebhookMaxAttempts int
	WebhookRetryBase   time.Duration
	WebhookRetryMax    time.Duration
	// WebhookAllowPrivate lets endpoints resolve to private/loopback addresses: for local
	// testing only (a receiver on localhost). Off by default, which blocks SSRF.
	WebhookAllowPrivate bool

	MaxDuration time.Duration
	Preset      string
	// FFmpegThreads is the CPU budget for one encode (0 = FFmpeg's default): FFMPEG_THREADS,
	// else see cpuBudget.
	FFmpegThreads int
	FFmpegPath    string
	FFprobePath   string
	TempDir       string
	LogFormat     string
}

type getenv func(string) string

// Load reads the configuration from the process environment.
func Load() (Config, error) { return load(os.Getenv) }

func load(env getenv) (Config, error) {
	var errs []error
	duration := func(key string, fallback time.Duration) time.Duration {
		raw := env(key)
		if raw == "" {
			return fallback
		}
		value, err := time.ParseDuration(raw)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Errorf("%s: expected a positive duration like 30s, got %q", key, raw))
			return fallback
		}
		return value
	}

	cfg := Config{
		DatabaseURL:       firstNonEmpty(env("DATABASE_URL"), LocalDatabaseURL),
		Storage:           loadStorage(env),
		WorkerID:          firstNonEmpty(env("WORKER_ID"), defaultWorkerID()),
		LeaseDuration:     duration("WORKER_LEASE_DURATION", 2*time.Minute),
		HeartbeatInterval: duration("WORKER_HEARTBEAT_INTERVAL", 20*time.Second),
		PollInterval:      duration("WORKER_POLL_INTERVAL", 2*time.Second),
		ShutdownGrace:     duration("WORKER_SHUTDOWN_GRACE", 20*time.Second),
		GarbageDelay:      duration("WORKER_GARBAGE_DELAY", 10*time.Minute),
		RetryBase:         duration("WORKER_RETRY_BASE", 10*time.Second),
		RetryMax:          duration("WORKER_RETRY_MAX", 10*time.Minute),
		CleanupEvery:      duration("WORKER_CLEANUP_INTERVAL", 10*time.Minute),
		DemoMaxAge:        duration("DEMO_VIDEO_MAX_AGE", 7*24*time.Hour),
		JobTimeout:        duration("WORKER_JOB_TIMEOUT", 45*time.Minute),
		WebhookTimeout:    duration("WEBHOOK_TIMEOUT", 10*time.Second),
		WebhookRetryBase:  duration("WEBHOOK_RETRY_BASE", 30*time.Second),
		WebhookRetryMax:   duration("WEBHOOK_RETRY_MAX", time.Hour),
		MaxDuration:       duration("MAX_VIDEO_DURATION", 60*time.Second),
		Preset:            firstNonEmpty(env("FFMPEG_PRESET"), "veryfast"),
		FFmpegPath:        firstNonEmpty(env("FFMPEG_PATH"), "ffmpeg"),
		FFprobePath:       firstNonEmpty(env("FFPROBE_PATH"), "ffprobe"),
		TempDir:           firstNonEmpty(env("WORKER_TEMP_DIR"), os.TempDir()),
		LogFormat:         firstNonEmpty(env("LOG_FORMAT"), "text"),
	}

	cfg.FFmpegThreads = cpuBudget(runtime.GOMAXPROCS(0), runtime.NumCPU())
	if raw := env("FFMPEG_THREADS"); raw != "" {
		threads, err := strconv.Atoi(raw)
		if err != nil || threads < 0 {
			errs = append(errs, fmt.Errorf("FFMPEG_THREADS: expected 0 (FFmpeg's default) or a positive integer, got %q", raw))
		} else {
			cfg.FFmpegThreads = threads
		}
	}

	cfg.WebhookMaxAttempts = 10
	if raw := env("WEBHOOK_MAX_ATTEMPTS"); raw != "" {
		attempts, err := strconv.Atoi(raw)
		if err != nil || attempts < 1 {
			errs = append(errs, fmt.Errorf("WEBHOOK_MAX_ATTEMPTS: expected a positive integer, got %q", raw))
		} else {
			cfg.WebhookMaxAttempts = attempts
		}
	}
	if raw := env("WEBHOOK_ALLOW_PRIVATE_URLS"); raw != "" {
		allow, err := strconv.ParseBool(raw)
		if err != nil {
			errs = append(errs, fmt.Errorf("WEBHOOK_ALLOW_PRIVATE_URLS: expected true or false, got %q", raw))
		}
		cfg.WebhookAllowPrivate = allow
	}

	// A heartbeat must land well inside the lease, or a healthy worker loses its job.
	if cfg.HeartbeatInterval*3 > cfg.LeaseDuration {
		errs = append(errs, fmt.Errorf(
			"WORKER_HEARTBEAT_INTERVAL (%s) must be at most a third of WORKER_LEASE_DURATION (%s)",
			cfg.HeartbeatInterval, cfg.LeaseDuration))
	}
	if !validPresets[cfg.Preset] {
		errs = append(errs, fmt.Errorf("FFMPEG_PRESET: unknown x264 preset %q", cfg.Preset))
	}
	return cfg, errors.Join(errs...)
}

// cpuBudget caps FFmpeg's threads only when this process may use fewer CPUs than it can see:
// a container CPU quota (GOMAXPROCS follows it since Go 1.25; NumCPU doesn't). Measured with
// the 11 showcase clips (docs/BENCHMARKS.md): on 2 vCPUs the cap made the run 4.3x faster;
// with no limit on 24 threads, FFmpeg's default was 14% faster than the cap, so it stays.
func cpuBudget(usable, visible int) int {
	if usable < visible {
		return usable
	}
	return 0
}

var validPresets = map[string]bool{
	"ultrafast": true, "superfast": true, "veryfast": true, "faster": true, "fast": true,
	"medium": true, "slow": true, "slower": true, "veryslow": true,
}

// loadStorage mirrors packages/storage/src/config.ts: with no STORAGE_* set at all, it
// targets the local RustFS container.
func loadStorage(env getenv) Storage {
	if env("STORAGE_PROVIDER") == "" && env("STORAGE_ENDPOINT") == "" {
		return Storage{
			Provider:        "local",
			Endpoint:        "http://localhost:9000",
			Region:          "us-east-1",
			Bucket:          "reelplane",
			AccessKeyID:     "reelplane",
			SecretAccessKey: "reelplane-dev-secret",
			ForcePathStyle:  true,
		}
	}
	provider := firstNonEmpty(env("STORAGE_PROVIDER"), "s3")
	pathStyle, err := strconv.ParseBool(env("STORAGE_FORCE_PATH_STYLE"))
	if err != nil {
		pathStyle = provider == "local" || provider == "supabase"
	}
	return Storage{
		Provider:        provider,
		Endpoint:        strings.TrimRight(env("STORAGE_ENDPOINT"), "/"),
		Region:          env("STORAGE_REGION"),
		Bucket:          env("STORAGE_BUCKET"),
		AccessKeyID:     env("STORAGE_ACCESS_KEY_ID"),
		SecretAccessKey: env("STORAGE_SECRET_ACCESS_KEY"),
		ForcePathStyle:  pathStyle,
	}
}

func defaultWorkerID() string {
	host, err := os.Hostname()
	if err != nil {
		host = "worker"
	}
	// A random suffix: in Docker the hostname survives restarts and the PID is often 1, so
	// hostname-pid alone would give a restarted worker its old identity.
	var suffix [3]byte
	_, _ = rand.Read(suffix[:])
	return fmt.Sprintf("%s-%d-%x", host, os.Getpid(), suffix)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
