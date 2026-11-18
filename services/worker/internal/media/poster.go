package media

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/omadityaxd/reelplane/services/worker/internal/proc"
)

// Poster frame selection. A fixed timestamp often lands on a fade, a black cut or a white title
// card, so the clip is sampled and the earliest frame that looks like a picture is used: not
// dark, not blown out, and with real contrast. Luma is 8-bit video range (16 black, 235 white).
const (
	posterSampleFPS   = 2
	posterSkipStart   = 500 * time.Millisecond // the very first frames are often a fade-in
	posterMinMean     = 48
	posterMaxMean     = 220
	posterMinSpread   = 64 // brightest minus darkest: a flat card or a black frame has ~0
	posterDarkMean    = 32 // fallback: never prefer a frame darker than this
	posterStatsMaxOut = 1 << 20
)

// FrameStats is the luma of one sampled frame.
type FrameStats struct {
	At              time.Duration
	Mean, Low, High float64
}

func (f FrameStats) spread() float64 { return f.High - f.Low }

func (f FrameStats) good() bool {
	return f.Mean >= posterMinMean && f.Mean <= posterMaxMean && f.spread() >= posterMinSpread
}

// DefaultPosterTime is where the poster comes from when the clip can't be analysed.
func DefaultPosterTime(duration time.Duration) time.Duration {
	return min(time.Second, duration/3)
}

// ChoosePosterTime picks the poster frame from sampled stats: the earliest good frame after the
// first half second; else the frame with the most contrast that isn't near-black; else the
// brightest; else the default.
func ChoosePosterTime(frames []FrameStats, duration time.Duration) time.Duration {
	var best, brightest *FrameStats
	for i := range frames {
		frame := &frames[i]
		if frame.At < posterSkipStart && duration > 2*posterSkipStart {
			continue
		}
		if frame.good() {
			return frame.At
		}
		if frame.Mean >= posterDarkMean && (best == nil || frame.spread() > best.spread()) {
			best = frame
		}
		if brightest == nil || frame.Mean > brightest.Mean {
			brightest = frame
		}
	}
	switch {
	case best != nil:
		return best.At
	case brightest != nil:
		return brightest.At
	default:
		return DefaultPosterTime(duration)
	}
}

var (
	statsTimeRE  = regexp.MustCompile(`pts_time:\s*([0-9.]+)`)
	statsValueRE = regexp.MustCompile(`lavfi\.signalstats\.(YLOW|YAVG|YHIGH)=([0-9.]+)`)
)

// ParseFrameStats reads FFmpeg's `metadata=mode=print` log of signalstats values.
func ParseFrameStats(log string) []FrameStats {
	var frames []FrameStats
	for line := range strings.SplitSeq(log, "\n") {
		if match := statsTimeRE.FindStringSubmatch(line); match != nil {
			seconds, err := strconv.ParseFloat(match[1], 64)
			if err != nil {
				continue
			}
			frames = append(frames, FrameStats{At: time.Duration(seconds * float64(time.Second))})
			continue
		}
		match := statsValueRE.FindStringSubmatch(line)
		if match == nil || len(frames) == 0 {
			continue
		}
		value, err := strconv.ParseFloat(match[2], 64)
		if err != nil {
			continue
		}
		frame := &frames[len(frames)-1]
		switch match[1] {
		case "YLOW":
			frame.Low = value
		case "YAVG":
			frame.Mean = value
		case "YHIGH":
			frame.High = value
		}
	}
	return frames
}

// PickPosterTime samples the clip and chooses the poster frame (ChoosePosterTime). It returns
// the default time with the error if FFmpeg fails: a poster is never worth failing a job over.
func PickPosterTime(ctx context.Context, ffmpeg, input string, probe Probe) (time.Duration, error) {
	// `select` keeps each sampled frame's real timestamp, so `-ss` at that time extracts that
	// very frame. (The fps filter relabels frames with rounded times, which at a cut can be a
	// frame from the other side of it.)
	interval := strconv.FormatFloat(1/float64(posterSampleFPS), 'f', 3, 64)
	filter := "select='isnan(prev_selected_t)+gte(t-prev_selected_t\\," + interval + ")'," +
		"scale=96:-2,format=yuv420p,signalstats,metadata=mode=print"
	if probe.IsHDR() {
		filter = ToneMapFilter + "," + filter
	}
	args := []string{"-hide_banner", "-nostdin", "-v", "info"}
	args = append(args, InputGuard...)
	args = append(args, "-i", input, "-map", "0:v:"+strconv.Itoa(probe.VideoStream), "-an",
		"-vf", filter, "-f", "null", "-")
	var log strings.Builder
	cmd := proc.Command(ctx, ffmpeg, args...)
	cmd.Stderr = &limitedWriter{w: &log, remaining: posterStatsMaxOut}
	if err := proc.Run(cmd); err != nil {
		if ctx.Err() != nil {
			return DefaultPosterTime(probe.Duration), context.Cause(ctx)
		}
		return DefaultPosterTime(probe.Duration), ClassifyFailure(err, log.String())
	}
	return ChoosePosterTime(ParseFrameStats(log.String()), probe.Duration), nil
}
