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

func TestParseFrameStats(t *testing.T) {
	log := `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'source.mp4':
[Parsed_metadata_4 @ 0x1] frame:0    pts:0       pts_time:0
[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YLOW=16
[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YAVG=16.2
[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YHIGH=18
[Parsed_metadata_4 @ 0x1] frame:1    pts:1       pts_time:0.5
[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YLOW=20
[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YAVG=120.5
[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YHIGH=230
`
	got := ParseFrameStats(log)
	want := []FrameStats{
		{At: 0, Mean: 16.2, Low: 16, High: 18},
		{At: 500 * time.Millisecond, Mean: 120.5, Low: 20, High: 230},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d frames, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("frame %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestChoosePosterTime(t *testing.T) {
	frame := func(seconds float64, mean, low, high float64) FrameStats {
		return FrameStats{At: time.Duration(seconds * float64(time.Second)), Mean: mean, Low: low, High: high}
	}
	black := func(seconds float64) FrameStats { return frame(seconds, 17, 16, 18) }
	cases := []struct {
		name     string
		frames   []FrameStats
		duration time.Duration
		want     time.Duration
	}{
		{
			name:     "skips a dark opening (the black Sintel poster)",
			frames:   []FrameStats{frame(0, 53, 30, 74), black(1), frame(2, 46, 20, 70), black(3), frame(6, 79, 10, 122)},
			duration: 12 * time.Second,
			want:     6 * time.Second,
		},
		{
			name:     "skips a flat white title card",
			frames:   []FrameStats{frame(0.5, 230, 230, 230), frame(1, 229, 228, 229), frame(3, 116, 40, 134)},
			duration: 10 * time.Second,
			want:     3 * time.Second,
		},
		{
			name:     "ignores the first half second",
			frames:   []FrameStats{frame(0, 120, 20, 230), frame(0.5, 125, 20, 230)},
			duration: 10 * time.Second,
			want:     500 * time.Millisecond,
		},
		{
			name:     "a clip with no good frame gets its most contrasty non-dark frame",
			frames:   []FrameStats{black(1), frame(2, 40, 30, 60), frame(3, 36, 20, 70), frame(4, 25, 16, 120)},
			duration: 5 * time.Second,
			want:     3 * time.Second,
		},
		{
			name:     "an all-black clip gets its brightest frame",
			frames:   []FrameStats{black(1), frame(2, 20, 16, 24), black(3)},
			duration: 4 * time.Second,
			want:     2 * time.Second,
		},
		{
			name:     "no samples: the default time",
			duration: 9 * time.Second,
			want:     time.Second,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ChoosePosterTime(tc.frames, tc.duration); got != tc.want {
				t.Errorf("ChoosePosterTime = %v, want %v", got, tc.want)
			}
		})
	}
}

// Clips that open on something that makes a bad poster, then a real picture: the poster must
// come from the picture. The white card ends between two sample points, where a sampled
// frame labelled with a rounded time (the fps filter) was extracted from the wrong side of the cut.
func TestPosterComesFromThePictureAfterABadOpening(t *testing.T) {
	requireFFmpeg(t)
	for _, opening := range []struct{ name, source string }{
		{"black for 3 s (the black Sintel poster)", "color=black:size=360x640:rate=25:duration=3"},
		{"a white title card for 2.24 s", "color=white:size=360x640:rate=25:duration=2.24"},
	} {
		t.Run(opening.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			dir := t.TempDir()
			src := filepath.Join(dir, "source.mp4")
			gen := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-nostdin", "-y", "-v", "error",
				"-f", "lavfi", "-i", opening.source,
				"-f", "lavfi", "-i", "testsrc2=size=360x640:rate=25:duration=3",
				"-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]",
				"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", src)
			if out, err := gen.CombinedOutput(); err != nil {
				t.Fatalf("generate clip: %v: %s", err, out)
			}
			probe, err := ProbeFile(ctx, "ffprobe", src)
			if err != nil {
				t.Fatal(err)
			}

			poster, err := GeneratePoster(ctx, "ffmpeg", src, dir, "poster.jpg", probe)
			if err != nil {
				t.Fatal(err)
			}
			if stats := imageStats(t, filepath.Join(dir, "poster.jpg")); !stats.good() {
				t.Errorf("poster at %v: mean %.1f, spread %.1f (not a picture)", poster.At, stats.Mean, stats.spread())
			}
			if !strings.HasPrefix(poster.Placeholder, "data:image/jpeg;base64,") {
				t.Errorf("placeholder = %.40q", poster.Placeholder)
			}
			if _, err := os.Stat(filepath.Join(dir, "placeholder.jpg")); !os.IsNotExist(err) {
				t.Error("the placeholder file was left behind")
			}
		})
	}
}

func imageStats(t *testing.T, image string) FrameStats {
	t.Helper()
	out, err := exec.Command("ffmpeg", "-hide_banner", "-nostdin", "-v", "info", "-i", image,
		"-vf", "format=yuv420p,signalstats,metadata=mode=print", "-f", "null", "-").CombinedOutput()
	if err != nil {
		t.Fatalf("measure %s: %v: %s", image, err, out)
	}
	frames := ParseFrameStats(string(out))
	if len(frames) == 0 {
		t.Fatalf("no stats for %s", image)
	}
	return frames[0]
}
