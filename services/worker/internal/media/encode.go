package media

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/omadityaxd/reelplane/services/worker/internal/proc"
)

// ToneMapFilter converts HLG/PQ HDR (iPhone HDR video, Dolby Vision 8.4 base layer, HDR10)
// to SDR BT.709. Without it, HDR phone clips encoded to 8-bit H.264 look grey and washed out.
const ToneMapFilter = "zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709," +
	"tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"

// SegmentSeconds is the HLS segment length. Two seconds suits short videos: the first segment
// arrives fast (quick start, cheap preloading of the next reels) and ABR can switch often.
const SegmentSeconds = 2

// EncodePlan describes one HLS encode of a source.
type EncodePlan struct {
	Input  string
	OutDir string
	Rungs  []Rung
	// Rate is the output frame rate, preserved from the source (see OutputRate).
	Rate Rate
	// HDR sources are tone-mapped to SDR BT.709 (H.264 8-bit renditions).
	HDR      bool
	HasAudio bool
	// VideoStream selects the source's video stream (Probe.VideoStream).
	VideoStream int
	Preset      string
	// Threads is how many CPUs the encode may use (0 = FFmpeg's default: every core it can
	// see). In a container with a CPU quota FFmpeg still sees all the host's cores, so each
	// encoder would start that many threads; measured on a 2-CPU container, a 1080p60 encode
	// took 2.2x longer that way (docs/BENCHMARKS.md).
	Threads int
}

// encoderThreads splits the CPU budget across the rungs, which encode in parallel.
func encoderThreads(threads, rungs int) int {
	return max(1, (threads+rungs-1)/max(rungs, 1))
}

// HLSArgs builds a single FFmpeg invocation that decodes once, scales into every rung with
// `split`, and writes CMAF/fMP4 HLS: one folder per rendition plus a master playlist.
func HLSArgs(plan EncodePlan) []string {
	n := len(plan.Rungs)
	var filter strings.Builder
	fmt.Fprintf(&filter, "[0:v:%d]", plan.VideoStream)
	if plan.HDR {
		filter.WriteString(ToneMapFilter + ",")
	}
	fmt.Fprintf(&filter, "fps=%s,split=%d", plan.Rate.Expr, n)
	for i := range n {
		fmt.Fprintf(&filter, "[s%d]", i)
	}
	for i, rung := range plan.Rungs {
		fmt.Fprintf(&filter, ";[s%d]scale=%d:%d:flags=bicubic,setsar=1[v%d]", i, rung.Width, rung.Height, i)
	}

	gop := strconv.Itoa(int(math.Round(plan.Rate.FPS * SegmentSeconds)))
	args := []string{
		"-hide_banner", "-nostdin", "-y", "-v", "error",
		"-progress", "pipe:1", "-nostats", "-stats_period", "0.5",
	}
	if plan.Threads > 0 {
		t := strconv.Itoa(plan.Threads)
		args = append(args, "-threads", t, "-filter_complex_threads", t)
	}
	args = append(args, InputGuard...)
	args = append(args,
		"-i", plan.Input,
		"-filter_complex", filter.String(),
		// Publish pictures and sound, nothing else from the upload: phone videos carry GPS
		// location, device model and dates in their metadata, which FFmpeg copies by default.
		"-map_metadata", "-1", "-map_chapters", "-1",
	)
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
		// Tag SDR BT.709 explicitly so players do not guess (and mis-render) the colours.
		"-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
	)
	for i, rung := range plan.Rungs {
		args = append(args,
			fmt.Sprintf("-profile:v:%d", i), rung.Profile,
			fmt.Sprintf("-b:v:%d", i), fmt.Sprintf("%dk", rung.VideoKbps),
			fmt.Sprintf("-maxrate:v:%d", i), fmt.Sprintf("%dk", rung.MaxrateKbps),
			fmt.Sprintf("-bufsize:v:%d", i), fmt.Sprintf("%dk", rung.BufsizeKbps),
		)
		if plan.Threads > 0 {
			args = append(args, fmt.Sprintf("-threads:v:%d", i), strconv.Itoa(encoderThreads(plan.Threads, n)))
		}
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
			return context.Cause(ctx)
		}
		return ClassifyFailure(fmt.Errorf("ffmpeg failed: %w", err), stderr.String())
	}
	return nil
}

// Phrases FFmpeg prints when the input itself is broken: corrupt or truncated data, a codec it
// cannot decode, a demuxer or protocol the InputGuard refuses. Encoding the same bytes again
// fails the same way.
var inputFailures = []string{
	"Invalid data found when processing input",
	"moov atom not found",
	"Error opening input",
	"Error while decoding stream",
	"Error splitting the input into NAL units",
	"Invalid NAL unit size",
	"Could not find codec parameters",
	"Decoding requested, but no decoder found",
	"Unsupported codec",
	"not on whitelist",
}

// Phrases that point at the machine instead (disk, memory, a signal): worth retrying even when
// an input phrase also appears.
var environmentFailures = []string{
	"No space left on device",
	"Cannot allocate memory",
	"Resource temporarily unavailable",
	"Killed",
}

// ClassifyFailure turns a failed FFmpeg run into an InvalidInputError (do not retry) when its
// stderr blames the input, and otherwise keeps it retryable. The stderr is kept in both.
func ClassifyFailure(err error, stderr string) error {
	stderr = strings.TrimSpace(stderr)
	// Killed by a signal (the OOM killer, say): the stderr's decode warnings are not why.
	var exit *exec.ExitError
	permanent := !(errors.As(err, &exit) && exit.ExitCode() == -1)
	matched := false
	for _, phrase := range inputFailures {
		matched = matched || strings.Contains(stderr, phrase)
	}
	permanent = permanent && matched
	for _, phrase := range environmentFailures {
		permanent = permanent && !strings.Contains(stderr, phrase)
	}
	if permanent {
		return &InvalidInputError{Reason: "FFmpeg could not decode the file: " + lastLine(stderr)}
	}
	return fmt.Errorf("%w: %s", err, stderr)
}

func lastLine(text string) string {
	if i := strings.LastIndexByte(text, '\n'); i >= 0 {
		return strings.TrimSpace(text[i+1:])
	}
	return text
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
