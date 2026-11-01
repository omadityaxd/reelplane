package media

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/omadityashukla/reelplane/services/worker/internal/proc"
)

// SegmentSeconds is the HLS segment length. Two seconds suits short videos: the first segment
// arrives fast (quick start, cheap preloading of the next reels) and ABR can switch often.
const SegmentSeconds = 2

// EncodePlan describes one HLS encode of a source.
type EncodePlan struct {
	Input    string
	OutDir   string
	Rungs    []Rung
	FPS      int
	HasAudio bool
	Preset   string
}

// HLSArgs builds a single FFmpeg invocation that decodes once, scales into every rung with
// `split`, and writes CMAF/fMP4 HLS: one folder per rendition plus a master playlist.
func HLSArgs(plan EncodePlan) []string {
	n := len(plan.Rungs)
	var filter strings.Builder
	fmt.Fprintf(&filter, "[0:v]fps=%d,split=%d", plan.FPS, n)
	for i := range n {
		fmt.Fprintf(&filter, "[s%d]", i)
	}
	for i, rung := range plan.Rungs {
		fmt.Fprintf(&filter, ";[s%d]scale=%d:%d:flags=bicubic,setsar=1[v%d]", i, rung.Width, rung.Height, i)
	}

	gop := strconv.Itoa(plan.FPS * SegmentSeconds)
	args := []string{
		"-hide_banner", "-nostdin", "-y", "-v", "error",
		"-progress", "pipe:1", "-nostats", "-stats_period", "0.5",
		"-i", plan.Input,
		"-filter_complex", filter.String(),
	}
	var streamMap []string
	for i, rung := range plan.Rungs {
		args = append(args, "-map", fmt.Sprintf("[v%d]", i))
		entry := fmt.Sprintf("v:%d", i)
		if plan.HasAudio {
			args = append(args, "-map", "0:a:0")
			entry += fmt.Sprintf(",a:%d", i)
		}
		streamMap = append(streamMap, entry+",name:"+rung.Name)
	}
	args = append(args,
		"-c:v", "libx264", "-preset", plan.Preset, "-pix_fmt", "yuv420p",
		// A keyframe exactly every segment boundary: segments start independently decodable
		// at identical times across renditions, which ABR switching requires.
		"-g", gop, "-keyint_min", gop, "-sc_threshold", "0",
		"-force_key_frames", fmt.Sprintf("expr:gte(t,n_forced*%d)", SegmentSeconds),
		"-fps_mode", "cfr",
	)
	for i, rung := range plan.Rungs {
		args = append(args,
			fmt.Sprintf("-profile:v:%d", i), rung.Profile,
			fmt.Sprintf("-b:v:%d", i), fmt.Sprintf("%dk", rung.VideoKbps),
			fmt.Sprintf("-maxrate:v:%d", i), fmt.Sprintf("%dk", rung.MaxrateKbps),
			fmt.Sprintf("-bufsize:v:%d", i), fmt.Sprintf("%dk", rung.BufsizeKbps),
		)
		if plan.HasAudio {
			args = append(args, fmt.Sprintf("-b:a:%d", i), fmt.Sprintf("%dk", rung.AudioKbps))
		}
	}
	if plan.HasAudio {
		args = append(args, "-c:a", "aac", "-ac", "2", "-ar", "48000")
	}
	args = append(args,
		"-f", "hls",
		"-hls_time", strconv.Itoa(SegmentSeconds),
		"-hls_playlist_type", "vod",
		"-hls_segment_type", "fmp4",
		"-hls_flags", "independent_segments",
		"-hls_fmp4_init_filename", "init.mp4",
		"-hls_segment_filename", plan.OutDir+"/%v/seg_%03d.m4s",
		"-master_pl_name", "master.m3u8",
		"-var_stream_map", strings.Join(streamMap, " "),
		plan.OutDir+"/%v/index.m3u8",
	)
	return args
}

// Transcode runs the HLS encode, reporting progress in [0, 1] as FFmpeg advances.
func Transcode(ctx context.Context, ffmpeg string, plan EncodePlan, duration time.Duration, onProgress func(float64)) error {
	cmd := proc.Command(ctx, ffmpeg, HLSArgs(plan)...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("ffmpeg stdout: %w", err)
	}
	var stderr strings.Builder
	cmd.Stderr = &limitedWriter{w: &stderr, remaining: 8 << 10}
	if err := proc.Start(cmd); err != nil {
		return fmt.Errorf("start ffmpeg: %w", err)
	}
	readProgress(stdout, duration, onProgress)
	if err := cmd.Wait(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("ffmpeg failed: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// readProgress parses FFmpeg's `-progress` key=value stream (out_time_us is microseconds).
func readProgress(r io.Reader, duration time.Duration, onProgress func(float64)) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		key, value, ok := strings.Cut(scanner.Text(), "=")
		if !ok || key != "out_time_us" || duration <= 0 || onProgress == nil {
			continue
		}
		micros, err := strconv.ParseInt(value, 10, 64)
		if err != nil || micros < 0 {
			continue
		}
		onProgress(min(1, float64(micros)/float64(duration.Microseconds())))
	}
}

// limitedWriter keeps the first N bytes of stderr for error messages and drops the rest.
type limitedWriter struct {
	w         io.Writer
	remaining int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.remaining > 0 {
		chunk := p[:min(len(p), l.remaining)]
		l.remaining -= len(chunk)
		_, _ = l.w.Write(chunk)
	}
	return len(p), nil
}
