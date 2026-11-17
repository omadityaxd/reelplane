package storage

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/omadityaxd/reelplane/services/worker/internal/config"
)

// The same contract runs against the directory store and, with STORAGE_INTEGRATION=1, real S3.
func stores(t *testing.T) map[string]Store {
	t.Helper()
	all := map[string]Store{"dir": Dir{Root: t.TempDir()}}
	if os.Getenv("STORAGE_INTEGRATION") == "1" {
		cfg, err := config.Load()
		if err != nil {
			t.Fatal(err)
		}
		s3store, err := NewS3(cfg.Storage)
		if err != nil {
			t.Fatal(err)
		}
		all["s3"] = s3store
	}
	return all
}

func TestStoreContract(t *testing.T) {
	for name, store := range stores(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			prefix := fmt.Sprintf("test/go-%d", time.Now().UnixNano())

			local := t.TempDir()
			for _, rel := range []string{"master.m3u8", "240p/index.m3u8", "240p/seg_000.m4s", "poster.jpg"} {
				p := filepath.Join(local, filepath.FromSlash(rel))
				if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(p, []byte(rel), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			keys, err := store.UploadDir(ctx, local, prefix+"/attempt-1")
			if err != nil || len(keys) != 4 {
				t.Fatalf("upload = %v, %v", keys, err)
			}
			listed, err := store.List(ctx, prefix+"/")
			if err != nil || len(listed) != 4 {
				t.Fatalf("list = %v, %v", listed, err)
			}

			dst := filepath.Join(t.TempDir(), "out")
			if err := store.Download(ctx, prefix+"/attempt-1/240p/seg_000.m4s", dst, 0); err != nil {
				t.Fatal(err)
			}
			if body, _ := os.ReadFile(dst); string(body) != "240p/seg_000.m4s" {
				t.Fatalf("downloaded %q", body)
			}
			if err := store.Download(ctx, prefix+"/missing", dst, 0); !errors.Is(err, ErrNotFound) {
				t.Fatalf("missing key err = %v", err)
			}
			// "240p/seg_000.m4s" is 16 bytes: exactly the limit passes, one byte under fails.
			if err := store.Download(ctx, prefix+"/attempt-1/240p/seg_000.m4s", dst, 16); err != nil {
				t.Fatalf("download at the limit: %v", err)
			}
			if err := store.Download(ctx, prefix+"/attempt-1/240p/seg_000.m4s", dst, 15); !errors.Is(err, ErrTooLarge) {
				t.Fatalf("download over the limit err = %v, want ErrTooLarge", err)
			}

			if n, err := store.DeletePrefix(ctx, prefix+"/"); err != nil || n != 4 {
				t.Fatalf("delete = %d, %v", n, err)
			}
			if _, err := store.DeletePrefix(ctx, "/"); err == nil {
				t.Fatal("deleting an empty prefix must be refused")
			}
		})
	}
}

func TestContentTypes(t *testing.T) {
	for key, want := range map[string]string{
		"a/master.m3u8": "application/vnd.apple.mpegurl",
		"a/seg_001.m4s": "video/iso.segment",
		"a/init_0.mp4":  "video/mp4",
		"a/poster.jpg":  "image/jpeg",
	} {
		if got := ContentType(key); got != want {
			t.Errorf("ContentType(%s) = %s, want %s", key, got, want)
		}
	}
}
