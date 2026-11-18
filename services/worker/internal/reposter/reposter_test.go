package reposter_test

import (
	"context"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/omadityaxd/reelplane/services/worker/internal/reposter"
	"github.com/omadityaxd/reelplane/services/worker/internal/storage"
	"github.com/omadityaxd/reelplane/services/worker/internal/testdb"
)

// A published video whose poster came from its black opening gets a poster from the picture,
// under a new key, with the row switched to it and the old file gone; nothing else is touched.
func TestRunRegeneratesPostersWithoutRetranscoding(t *testing.T) {
	if os.Getenv("REELPLANE_SKIP_FFMPEG_TESTS") == "1" {
		t.Skip("REELPLANE_SKIP_FFMPEG_TESTS=1")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	db := testdb.New(t, "reelplane_test_reposter")
	store := storage.Dir{Root: t.TempDir()}

	// The original: 3 s of black, then 3 s of picture.
	clip := filepath.Join(t.TempDir(), "source.mp4")
	gen := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-nostdin", "-y", "-v", "error",
		"-f", "lavfi", "-i", "color=black:size=360x640:rate=25:duration=3",
		"-f", "lavfi", "-i", "testsrc2=size=360x640:rate=25:duration=3",
		"-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]",
		"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", clip)
	if out, err := gen.CombinedOutput(); err != nil {
		t.Fatalf("generate clip: %v: %s", err, out)
	}
	raw, err := os.ReadFile(clip)
	if err != nil {
		t.Fatal(err)
	}

	seeded := db.SeedJob(t, "", 3)
	attempt := "media/" + seeded.ProjectID + "/" + seeded.VideoID + "/abc-c1"
	oldPoster := attempt + "/poster.jpg"
	for key, body := range map[string][]byte{
		seeded.SourceKey:           raw,
		oldPoster:                  []byte("black poster"),
		attempt + "/master.m3u8":   []byte("#EXTM3U"),
		attempt + "/720p/seg0.m4s": []byte("segment"),
	} {
		if err := store.Put(ctx, key, body, ""); err != nil {
			t.Fatal(err)
		}
	}
	for _, status := range []string{"processing", "ready"} {
		if _, err := db.Owner.Exec(ctx, `update reelplane.videos set status = $2, size_bytes = $3,
			poster_key = $4, placeholder = 'data:old', master_playlist_key = $5 where id = $1`,
			seeded.VideoID, status, len(raw), oldPoster, attempt+"/master.m3u8"); err != nil {
			t.Fatal(err)
		}
	}

	opts := reposter.Options{FFmpeg: "ffmpeg", FFprobe: "ffprobe", TempDir: t.TempDir(),
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))}

	dry, err := reposter.Run(ctx, db.Worker, store, reposter.Options{FFmpeg: opts.FFmpeg,
		FFprobe: opts.FFprobe, TempDir: opts.TempDir, Log: opts.Log, DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(dry) != 1 || dry[0].Changed || dry[0].AtMillis < 3000 {
		t.Fatalf("dry run = %+v, want one unchanged result from the picture (>= 3000 ms)", dry)
	}
	if got := testdb.Scalar[string](t, db, `select poster_key from reelplane.videos where id = $1`, seeded.VideoID); got != oldPoster {
		t.Fatalf("the dry run changed poster_key to %s", got)
	}

	results, err := reposter.Run(ctx, db.Worker, store, opts)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || !results[0].Changed {
		t.Fatalf("results = %+v", results)
	}
	newPoster := results[0].NewKey
	if !strings.HasPrefix(newPoster, attempt+"/poster-") || newPoster == oldPoster {
		t.Errorf("new poster key %s", newPoster)
	}
	var key, placeholder, status string
	if err := db.Owner.QueryRow(ctx, `select poster_key, placeholder, status from reelplane.videos
		where id = $1`, seeded.VideoID).Scan(&key, &placeholder, &status); err != nil {
		t.Fatal(err)
	}
	if key != newPoster || status != "ready" || !strings.HasPrefix(placeholder, "data:image/jpeg;base64,") {
		t.Errorf("row = %s %s %.30s", key, status, placeholder)
	}
	keys, err := store.List(ctx, attempt+"/")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{attempt + "/720p/seg0.m4s", attempt + "/master.m3u8", newPoster}
	if strings.Join(keys, ",") != strings.Join(want, ",") {
		t.Errorf("files under the attempt = %v, want %v (old poster gone, renditions untouched)", keys, want)
	}

	// Run again: the same frame is chosen, so nothing changes.
	again, err := reposter.Run(ctx, db.Worker, store, opts)
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != 1 || again[0].Changed {
		t.Errorf("second run = %+v, want no change", again)
	}
}
