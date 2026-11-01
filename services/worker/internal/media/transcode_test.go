package media

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// requireFFmpeg fails (not skips) when FFmpeg is missing, unless explicitly opted out: a
// silently skipped transcoding suite would hide the most important tests.
func requireFFmpeg(t *testing.T) {
	t.Helper()
	if os.Getenv("REELPLANE_SKIP_FFMPEG_TESTS") == "1" {
		t.Skip("REELPLANE_SKIP_FFMPEG_TESTS=1")
	}
	for _, bin := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Fatalf("%s not on PATH (install FFmpeg, or set REELPLANE_SKIP_FFMPEG_TESTS=1)", bin)
		}
	}
}

func probeDims(t *testing.T, path string) string {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0",
		"-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", path, err)
	}
	// A multi-variant HLS input lists the same stream once per program: take the first.
	first, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	return strings.TrimSpace(first)
}

func transcodeClip(t *testing.T, clip Clip) (Probe, string, Images) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	dir := t.TempDir()
	src := filepath.Join(dir, "source.mp4")
	if err := GenerateClip(ctx, "ffmpeg", src, clip); err != nil {
		t.Fatal(err)
	}
	probe, err := ProbeFile(ctx, "ffprobe", src)
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "out")
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	var last float64
	plan := EncodePlan{Input: src, OutDir: out, Rungs: PlanLadder(probe.Width, probe.Height),
		FPS: TargetFPS(probe.FrameRate), HasAudio: probe.HasAudio, Preset: "ultrafast"}
	if err := Transcode(ctx, "ffmpeg", plan, probe.Duration, func(p float64) { last = p }); err != nil {
		t.Fatal(err)
	}
	if last < 0.9 {
		t.Errorf("progress ended at %.2f", last)
	}
	images, err := GenerateImages(ctx, "ffmpeg", src, out, probe)
	if err != nil {
		t.Fatal(err)
	}
	return probe, out, images
}

func TestTranscodeVerticalClipToHLSLadder(t *testing.T) {
	requireFFmpeg(t)
	_, out, images := transcodeClip(t, Clip{Width: 720, Height: 1280, Duration: 5 * time.Second, FPS: 30, Audio: true})

	master, err := os.ReadFile(filepath.Join(out, "master.m3u8"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"RESOLUTION=240x426", "RESOLUTION=480x854", "RESOLUTION=720x1280", "mp4a.40.2", "240p/index.m3u8"} {
		if !strings.Contains(string(master), want) {
			t.Errorf("master playlist missing %q:\n%s", want, master)
		}
	}
	// Check the rendition itself: measured BANDWIDTH values can contain "1080" by chance.
	if strings.Contains(string(master), "1080p/index.m3u8") || strings.Contains(string(master), "x1920") {
		t.Error("a 720p source must not get a 1080p rendition (no upscaling)")
	}

	playlist, err := os.ReadFile(filepath.Join(out, "480p", "index.m3u8"))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(playlist), "#EXTINF:2.0"); got != 2 {
		t.Errorf("want two full 2s segments in a 5s clip, got %d:\n%s", got, playlist)
	}
	if !strings.Contains(string(playlist), "#EXT-X-MAP:URI=") {
		t.Error("fMP4 playlist must reference an init segment")
	}
	if dims := probeDims(t, filepath.Join(out, "240p", "index.m3u8")); dims != "240x426" {
		t.Errorf("240p rendition is %s", dims)
	}
	if len(images.Thumbnails) != 3 || !strings.HasPrefix(images.Placeholder, "data:image/jpeg;base64,") {
		t.Errorf("images = %+v", images)
	}
	if len(images.Placeholder) > 2000 {
		t.Errorf("placeholder is %d bytes; it must stay tiny to inline in API responses", len(images.Placeholder))
	}
	if dims := probeDims(t, filepath.Join(out, images.Poster)); dims != "720x1280" {
		t.Errorf("poster is %s", dims)
	}
}

func TestTranscodeRespectsPhoneRotation(t *testing.T) {
	requireFFmpeg(t)
	// Coded as landscape with a 90° display matrix: how phones store portrait video.
	probe, out, images := transcodeClip(t, Clip{Width: 640, Height: 360, Duration: 3 * time.Second, FPS: 30, Audio: true, Rotation: 90})
	if probe.Width != 360 || probe.Height != 640 {
		t.Fatalf("probe display size = %dx%d, want 360x640", probe.Width, probe.Height)
	}
	if dims := probeDims(t, filepath.Join(out, "240p", "index.m3u8")); dims != "240x426" {
		t.Errorf("rotated source produced a %s rendition; want portrait 240x426", dims)
	}
	if dims := probeDims(t, filepath.Join(out, images.Poster)); dims != "360x640" {
		t.Errorf("poster is %s; want portrait 360x640", dims)
	}
}

func TestTranscodeSilentHorizontalClip(t *testing.T) {
	requireFFmpeg(t)
	probe, out, _ := transcodeClip(t, Clip{Width: 854, Height: 480, Duration: 3 * time.Second, FPS: 25})
	if probe.HasAudio {
		t.Fatal("generated clip should be silent")
	}
	master, _ := os.ReadFile(filepath.Join(out, "master.m3u8"))
	if strings.Contains(string(master), "mp4a") || !strings.Contains(string(master), "RESOLUTION=854x480") {
		t.Errorf("master:\n%s", master)
	}
}

func TestProbeRejectsANonVideoFile(t *testing.T) {
	requireFFmpeg(t)
	path := filepath.Join(t.TempDir(), "photo.mp4")
	if err := os.WriteFile(path, []byte("\x89PNG\r\n\x1a\nnot really a video"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ProbeFile(context.Background(), "ffprobe", path); !IsInvalidInput(err) {
		t.Fatalf("err = %v, want InvalidInputError", err)
	}
}

func TestCancellingTheContextStopsFFmpeg(t *testing.T) {
	requireFFmpeg(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "long.mp4")
	if err := GenerateClip(context.Background(), "ffmpeg", src, Clip{Width: 1080, Height: 1920, Duration: 20 * time.Second, FPS: 30, Audio: true}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	plan := EncodePlan{Input: src, OutDir: dir, Rungs: PlanLadder(1080, 1920), FPS: 30, HasAudio: true, Preset: "medium"}
	started := time.Now()
	go func() { time.Sleep(500 * time.Millisecond); cancel() }()
	err := Transcode(ctx, "ffmpeg", plan, 20*time.Second, nil)
	if err == nil || ctx.Err() == nil {
		t.Fatalf("expected cancellation, got %v", err)
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Errorf("cancellation took %s", elapsed)
	}
}
