package media

import (
	"fmt"
	"math"
)

// Rung is one rendition in the adaptive bitrate ladder.
type Rung struct {
	Name        string
	Width       int
	Height      int
	VideoKbps   int
	MaxrateKbps int
	BufsizeKbps int
	AudioKbps   int
	// H.264 profile: Main for the small rungs (oldest devices), High above.
	Profile string
}

type rungSpec struct {
	short     int
	videoKbps int
	audioKbps int
	profile   string
}

// The ladder is defined by the SHORT side, so the same table serves 9:16 vertical
// (240x426 ... 1080x1920) and 16:9 horizontal sources. Bitrates target H.264 at <=30 fps for
// talking-head and phone content; short videos are watched on phones, so the top rungs stop
// at 1080p and the low rungs are generous enough to look decent while ABR ramps up.
var ladder = []rungSpec{
	{short: 240, videoKbps: 400, audioKbps: 64, profile: "main"},
	{short: 480, videoKbps: 1000, audioKbps: 96, profile: "main"},
	{short: 720, videoKbps: 2500, audioKbps: 128, profile: "high"},
	{short: 1080, videoKbps: 4500, audioKbps: 128, profile: "high"},
}

// PlanLadder picks the rungs for a source of the given display size, never upscaling.
// A source smaller than the lowest rung gets a single rendition at its own size.
func PlanLadder(width, height int) []Rung {
	short := min(width, height)
	var rungs []Rung
	for _, spec := range ladder {
		if spec.short <= short {
			rungs = append(rungs, makeRung(spec, width, height))
		}
	}
	if len(rungs) == 0 {
		lowest := ladder[0]
		scaled := rungSpec{
			short:     evenFloor(short),
			videoKbps: max(150, lowest.videoKbps*short/lowest.short),
			audioKbps: lowest.audioKbps,
			profile:   lowest.profile,
		}
		rungs = append(rungs, makeRung(scaled, width, height))
	}
	return rungs
}

func makeRung(spec rungSpec, width, height int) Rung {
	w, h := ScaleToShortSide(width, height, spec.short)
	return Rung{
		Name:        fmt.Sprintf("%dp", spec.short),
		Width:       w,
		Height:      h,
		VideoKbps:   spec.videoKbps,
		MaxrateKbps: spec.videoKbps * 11 / 10, // capped VBR: at most 10% over target
		BufsizeKbps: spec.videoKbps * 2,
		AudioKbps:   spec.audioKbps,
		Profile:     spec.profile,
	}
}

// ScaleToShortSide keeps the aspect ratio and makes both sides even (required by yuv420p).
func ScaleToShortSide(width, height, short int) (int, int) {
	long := evenRound(float64(short) * float64(max(width, height)) / float64(min(width, height)))
	short = evenFloor(short)
	if height >= width {
		return short, long
	}
	return long, short
}

func evenRound(value float64) int { return int(math.Round(value/2)) * 2 }
func evenFloor(value int) int     { return value - value%2 }

// TargetFPS caps output at 30 fps: 60 fps phone clips double encode cost for little gain at
// Reels sizes. Variable-rate sources are converted to this constant rate.
func TargetFPS(source float64) int {
	if source <= 0 || math.IsNaN(source) {
		return 30
	}
	return min(30, max(1, int(math.Round(source))))
}
