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
	rate := OutputRate(probe)
	rungs := PlanLadder(probe.Width, probe.Height, rate.FPS)
	plan := EncodePlan{Input: src, OutDir: out, Rungs: rungs, Rate: rate, HDR: probe.IsHDR(),
		HasAudio: probe.HasAudio, Preset: "ultrafast"}
	if err := Transcode(ctx, "ffmpeg", plan, probe.Duration, func(p float64) { last = p }); err != nil {
		t.Fatal(err)
	}
	if last < 0.9 {
		t.Errorf("progress ended at %.2f", last)
	}
	if _, err := WriteMasters(out, rungs, rate); err != nil {
		t.Fatal(err)
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
	plan := EncodePlan{Input: src, OutDir: dir, Rungs: PlanLadder(1080, 1920, 30), Rate: Rate{"30/1", 30}, HasAudio: true, Preset: "medium"}
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

func probeField(t *testing.T, path, entries string) string {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0",
		"-show_entries", entries, "-of", "default=nw=1:nk=1", path).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", path, err)
	}
	first, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	return strings.TrimSpace(first)
}

func firstVariant(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	variants, err := ParseMaster(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	return variants[0].Name
}

func TestSixtyFpsStaysSixtyAt720pAnd1080p(t *testing.T) {
	requireFFmpeg(t)
	probe, out, _ := transcodeClip(t, Clip{Width: 1080, Height: 1920, Duration: 3 * time.Second, FPS: 60, Audio: true})
	if rate := OutputRate(probe); rate.FPS != 60 {
		t.Fatalf("output rate = %s", rate.Expr)
	}
	for _, rung := range []string{"240p", "480p", "720p", "1080p"} {
		if fps := probeField(t, filepath.Join(out, rung, "index.m3u8"), "stream=r_frame_rate"); fps != "60/1" {
			t.Errorf("%s rendition is %s fps, want 60/1", rung, fps)
		}
	}
	master, _ := os.ReadFile(filepath.Join(out, MasterPlaylist))
	if !strings.Contains(string(master), "FRAME-RATE=60.000") || !strings.Contains(string(master), "RESOLUTION=1080x1920") {
		t.Errorf("master:\n%s", master)
	}
	if got := firstVariant(t, filepath.Join(out, MasterPlaylist)); got != "720p" {
		t.Errorf("master starts on %s, want 720p", got)
	}
	if got := firstVariant(t, filepath.Join(out, LowStartPlaylist)); got != "240p" {
		t.Errorf("low-start master starts on %s, want 240p", got)
	}
}

func TestHDRSourceIsToneMappedToSDR(t *testing.T) {
	requireFFmpeg(t)
	probe, out, images := transcodeClip(t, Clip{Width: 720, Height: 1280, Duration: 3 * time.Second, FPS: 30, HLG: true})
	if !probe.IsHDR() || probe.ColorTransfer != "arib-std-b67" {
		t.Fatalf("probe should see HLG: %+v", probe)
	}
	rendition := filepath.Join(out, "720p", "index.m3u8")
	if trc := probeField(t, rendition, "stream=color_transfer"); trc != "bt709" {
		t.Errorf("rendition transfer = %q, want bt709", trc)
	}
	if pix := probeField(t, rendition, "stream=pix_fmt"); pix != "yuv420p" {
		t.Errorf("rendition pix_fmt = %q, want 8-bit yuv420p", pix)
	}
	if images.Placeholder == "" {
		t.Error("stills must still be generated for HDR sources")
	}
}

// A phone video's location, device and other container metadata must not reach the published
// renditions, which anyone watching the feed downloads.
func TestTranscodeDropsSourceMetadata(t *testing.T) {
	requireFFmpeg(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	dir := t.TempDir()
	src := filepath.Join(dir, "source.mov")
	gen := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-nostdin", "-y", "-v", "error",
		"-f", "lavfi", "-i", "testsrc2=size=360x640:rate=25:duration=2",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=2",
		"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
		"-metadata", "location=+48.8584+002.2945/",
		"-metadata", "com.apple.quicktime.location.ISO6709=+48.8584+002.2945+035.000/",
		"-metadata", "com.apple.quicktime.model=iPhone 15",
		"-metadata:s:a:0", "handler_name=Core Media Audio",
		"-movflags", "use_metadata_tags", src)
	if out, err := gen.CombinedOutput(); err != nil {
		t.Fatalf("generate clip: %v: %s", err, out)
	}
	if tags := allTags(t, src); !strings.Contains(tags, "48.8584") {
		t.Fatalf("the fixture has no location to strip: %s", tags)
	}
	probe, err := ProbeFile(ctx, "ffprobe", src)
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "out")
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	rate := OutputRate(probe)
	rungs := PlanLadder(probe.Width, probe.Height, rate.FPS)
	plan := EncodePlan{Input: src, OutDir: out, Rungs: rungs, Rate: rate, HasAudio: probe.HasAudio, Preset: "ultrafast"}
	if err := Transcode(ctx, "ffmpeg", plan, probe.Duration, func(float64) {}); err != nil {
		t.Fatal(err)
	}
	for _, rung := range rungs {
		playlist, err := os.ReadFile(filepath.Join(out, rung.Name, "index.m3u8"))
		if err != nil {
			t.Fatal(err)
		}
		_, after, found := strings.Cut(string(playlist), "#EXT-X-MAP:URI=\"")
		init, _, _ := strings.Cut(after, "\"")
		if !found || init == "" {
			t.Fatalf("%s: no init segment in the playlist", rung.Name)
		}
		tags := allTags(t, filepath.Join(out, rung.Name, init))
		for _, leaked := range []string{"48.8584", "location", "iPhone", "com.apple", "Core Media"} {
			if strings.Contains(tags, leaked) {
				t.Errorf("%s/%s still carries %q: %s", rung.Name, init, leaked, tags)
			}
		}
	}
}

// allTags is every container and stream tag ffprobe sees in a file.
func allTags(t *testing.T, path string) string {
	t.Helper()
	cmd := exec.Command("ffprobe", "-v", "error", "-show_entries", "format_tags:stream_tags",
		"-of", "json", path)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v: %s", path, err, stderr.String())
	}
	return string(out)
}
