package media

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// liveWebM writes a WebM the way a browser's MediaRecorder does: no duration in any header.
func liveWebM(t *testing.T, dir string) string {
	t.Helper()
	src := filepath.Join(dir, "clip.mp4")
	if err := GenerateClip(context.Background(), "ffmpeg", src, Clip{Width: 360, Height: 640, Duration: 2 * time.Second, FPS: 30}); err != nil {
		t.Fatal(err)
	}
	webm := filepath.Join(dir, "recorded.webm")
	out, err := exec.Command("ffmpeg", "-hide_banner", "-nostdin", "-y", "-v", "error", "-i", src,
		"-c:v", "libvpx-vp9", "-deadline", "realtime", "-live", "1", "-f", "webm", webm).CombinedOutput()
	if err != nil {
		t.Fatalf("make webm: %v: %s", err, out)
	}
	return webm
}

func TestAWebMWithoutADurationIsMeasuredFromItsPackets(t *testing.T) {
	requireFFmpeg(t)
	dir := t.TempDir()
	webm := liveWebM(t, dir)
	if header := probeField(t, webm, "format=duration"); header != "N/A" && header != "" {
		t.Fatalf("fixture has a duration header (%q); the test would prove nothing", header)
	}
	probe, err := ProbeFile(context.Background(), "ffprobe", webm)
	if err != nil {
		t.Fatal(err)
	}
	if probe.Duration < 1900*time.Millisecond || probe.Duration > 2100*time.Millisecond {
		t.Fatalf("duration = %s, want about 2s", probe.Duration)
	}
	if err := probe.Validate(Limits{MaxDuration: time.Minute, MaxSide: 4096, MinSide: 64}); err != nil {
		t.Fatalf("a duration-less WebM must be accepted: %v", err)
	}
}

func TestPlaylistsDisguisedAsUploadsAreRefused(t *testing.T) {
	requireFFmpeg(t)
	dir := t.TempDir()
	clip := filepath.Join(dir, "inner.mp4")
	if err := GenerateClip(context.Background(), "ffmpeg", clip, Clip{Width: 360, Height: 640, Duration: time.Second, FPS: 30}); err != nil {
		t.Fatal(err)
	}
	// Without the guard, FFmpeg sniffs these as playlists and opens what they point to.
	for name, body := range map[string]string{
		// A relative name: concat's safe mode allows it, and ffprobe accepts this unguarded.
		"concat": "ffconcat version 1.0\nfile 'inner.mp4'\n",
		"hls":    "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://169.254.169.254/latest/meta-data\n#EXT-X-ENDLIST\n",
	} {
		upload := filepath.Join(dir, name)
		if err := os.WriteFile(upload, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := ProbeFile(context.Background(), "ffprobe", upload); !IsInvalidInput(err) {
			t.Errorf("%s: probe err = %v, want InvalidInputError", name, err)
		}
		plan := EncodePlan{Input: upload, OutDir: filepath.Join(dir, "out-"+name), Rungs: PlanLadder(360, 640, 30), Rate: Rate{"30/1", 30}, Preset: "ultrafast"}
		_ = os.MkdirAll(plan.OutDir, 0o755)
		if err := Transcode(context.Background(), "ffmpeg", plan, time.Second, nil); !IsInvalidInput(err) {
			t.Errorf("%s: encode err = %v, want InvalidInputError", name, err)
		}
	}
}

func TestACorruptFileFailsPermanently(t *testing.T) {
	requireFFmpeg(t)
	dir := t.TempDir()
	clip := filepath.Join(dir, "clip.mp4")
	if err := GenerateClip(context.Background(), "ffmpeg", clip, Clip{Width: 360, Height: 640, Duration: 2 * time.Second, FPS: 30}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(clip)
	if err != nil {
		t.Fatal(err)
	}
	broken := filepath.Join(dir, "broken.mp4")
	if err := os.WriteFile(broken, raw[:len(raw)/2], 0o644); err != nil { // the index is at the end
		t.Fatal(err)
	}
	plan := EncodePlan{Input: broken, OutDir: dir, Rungs: PlanLadder(360, 640, 30), Rate: Rate{"30/1", 30}, Preset: "ultrafast"}
	if err := Transcode(context.Background(), "ffmpeg", plan, 2*time.Second, nil); !IsInvalidInput(err) {
		t.Fatalf("err = %v, want InvalidInputError (retrying cannot fix the file)", err)
	}
}
