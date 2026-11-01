package config

import (
	"strings"
	"testing"
	"time"
)

func envOf(values map[string]string) getenv {
	return func(key string) string { return values[key] }
}

func TestDefaultsTargetTheLocalStack(t *testing.T) {
	cfg, err := load(envOf(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.DatabaseURL != LocalDatabaseURL {
		t.Errorf("database = %q", cfg.DatabaseURL)
	}
	if cfg.Storage.Provider != "local" || !cfg.Storage.ForcePathStyle {
		t.Errorf("storage = %+v", cfg.Storage)
	}
	if cfg.LeaseDuration != 2*time.Minute || cfg.Preset != "veryfast" {
		t.Errorf("lease=%s preset=%s", cfg.LeaseDuration, cfg.Preset)
	}
}

func TestStorageSwitchesPurelyByEnv(t *testing.T) {
	cfg, err := load(envOf(map[string]string{
		"STORAGE_PROVIDER":          "b2",
		"STORAGE_ENDPOINT":          "https://s3.us-west-004.backblazeb2.com/",
		"STORAGE_REGION":            "us-west-004",
		"STORAGE_BUCKET":            "demo",
		"STORAGE_ACCESS_KEY_ID":     "id",
		"STORAGE_SECRET_ACCESS_KEY": "secret",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Storage.Endpoint != "https://s3.us-west-004.backblazeb2.com" || cfg.Storage.ForcePathStyle {
		t.Errorf("storage = %+v", cfg.Storage)
	}
}

func TestRejectsAHeartbeatThatCannotKeepTheLease(t *testing.T) {
	_, err := load(envOf(map[string]string{
		"WORKER_LEASE_DURATION":     "30s",
		"WORKER_HEARTBEAT_INTERVAL": "20s",
	}))
	if err == nil || !strings.Contains(err.Error(), "at most a third") {
		t.Fatalf("expected heartbeat/lease error, got %v", err)
	}
}

func TestRejectsMalformedValues(t *testing.T) {
	_, err := load(envOf(map[string]string{"WORKER_POLL_INTERVAL": "soon", "FFMPEG_PRESET": "turbo"}))
	if err == nil || !strings.Contains(err.Error(), "WORKER_POLL_INTERVAL") || !strings.Contains(err.Error(), "FFMPEG_PRESET") {
		t.Fatalf("expected both errors, got %v", err)
	}
}
