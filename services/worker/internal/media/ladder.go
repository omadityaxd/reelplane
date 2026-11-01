package media

import (
	"fmt"
	"math"
	"strconv"
	"strings"
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
	videoKbps int // at up to 30 fps
	audioKbps int
	profile   string
}

// The ladder is defined by the SHORT side, so the same table serves 9:16 vertical
// (240x426 … 1080x1920) and 16:9 sources. Bitrates are H.264 at ≤30 fps, set from a VMAF
// (phone model) sweep on vertical 1080x1920 content (docs/BENCHMARKS.md, "Ladder quality"). That
// content is animation, which compresses easily (720p reaches VMAF 98.7 at 1.6 Mbps), so the
// targets keep headroom for camera footage (sensor noise, fine texture); re-run
// cmd/ladder-quality on real phone clips to validate them.
var ladder = []rungSpec{
	{short: 240, videoKbps: 300, audioKbps: 64, profile: "main"},
	{short: 480, videoKbps: 1000, audioKbps: 96, profile: "main"},
	{short: 720, videoKbps: 2500, audioKbps: 128, profile: "high"},
	{short: 1080, videoKbps: 4500, audioKbps: 128, profile: "high"},
}

// HighFrameRateFactor scales bitrates above 30 fps: twice the frames cost ~1.5x the bits,
// because consecutive frames are more alike and compress better.
const HighFrameRateFactor = 1.5

// PlanLadder picks the rungs for a source of the given display size and output frame rate,
// never upscaling. A source smaller than the lowest rung gets one rendition at its own size.
func PlanLadder(width, height int, fps float64) []Rung {
	short := min(width, height)
	factor := 1.0
	if fps > 30.5 {
		factor = HighFrameRateFactor
	}
	var rungs []Rung
	for _, spec := range ladder {
		if spec.short <= short {
			rungs = append(rungs, makeRung(spec, width, height, factor))
		}
	}
	if native, ok := nativeTopRung(short, len(rungs)); ok {
		rungs = append(rungs, makeRung(native, width, height, factor))
	}
	if len(rungs) == 0 {
		lowest := ladder[0]
		scaled := rungSpec{
			short:     evenFloor(short),
			videoKbps: max(150, lowest.videoKbps*short/lowest.short),
			audioKbps: lowest.audioKbps,
			profile:   lowest.profile,
		}
		rungs = append(rungs, makeRung(scaled, width, height, factor))
	}
	return rungs
}

// nativeGapRatio: a source this much larger than its highest standard rung gets an extra rung
// at its own size. Without it a 460x818 source (Sintel, letterbox removed) had only a 240p
// rendition, which a phone upscaled to its 1170 px-wide screen: visibly soft.
const nativeGapRatio = 1.2

// nativeTopRung returns a rung at the source's own short side when it falls between standard
// rungs (below 1080p), with a bitrate interpolated by pixel area between its neighbours.
func nativeTopRung(short, included int) (rungSpec, bool) {
	if included == 0 || included >= len(ladder) {
		return rungSpec{}, false // tiny sources are handled separately; ≥1080p is capped at 1080p
	}
	below, above := ladder[included-1], ladder[included]
	if float64(short) < float64(below.short)*nativeGapRatio {
		return rungSpec{}, false
	}
	area := func(s int) float64 { return float64(s) * float64(s) }
	t := (area(short) - area(below.short)) / (area(above.short) - area(below.short))
	return rungSpec{
		short:     evenFloor(short),
		videoKbps: below.videoKbps + int(math.Round(t*float64(above.videoKbps-below.videoKbps))),
		audioKbps: above.audioKbps,
		profile:   above.profile,
	}, true
}

func makeRung(spec rungSpec, width, height int, factor float64) Rung {
	w, h := ScaleToShortSide(width, height, spec.short)
	video := int(math.Round(float64(spec.videoKbps) * factor))
	return Rung{
		Name:        fmt.Sprintf("%dp", spec.short),
		Width:       w,
		Height:      h,
		VideoKbps:   video,
		MaxrateKbps: video * 11 / 10, // capped VBR: at most 10% over target
		BufsizeKbps: video * 2,
		AudioKbps:   spec.audioKbps,
		Profile:     spec.profile,
	}
}

// StartRung is the rendition players should start on when the network is unknown or fast:
// 720p, or the best rung below it. Starting at 240p looked soft on phones for the first
// seconds (Safari's native HLS starts on the first variant of the master playlist).
func StartRung(rungs []Rung) Rung {
	start := rungs[0]
	for _, rung := range rungs {
		if min(rung.Width, rung.Height) <= 720 {
			start = rung
		}
	}
	return start
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

// Rate is an output frame rate: an exact FFmpeg rate expression plus its value.
type Rate struct {
	Expr string // e.g. "30000/1001", "60/1"
	FPS  float64
}

// MaxOutputFPS bounds output for high-speed captures (120/240 fps slow-motion): browsers and
// HLS players do not present them reliably. 24, 25, 30, 50 and 60 fps are always preserved.
const MaxOutputFPS = 60

var standardRates = []Rate{
	{"24000/1001", 24000.0 / 1001}, {"24/1", 24}, {"25/1", 25}, {"30000/1001", 30000.0 / 1001},
	{"30/1", 30}, {"48/1", 48}, {"50/1", 50}, {"60000/1001", 60000.0 / 1001}, {"60/1", 60},
}

// OutputRate preserves the source frame rate. Constant-rate sources keep their exact nominal
// rate; variable-rate sources (phones) snap their average to the nearest standard rate, so a
// 60 fps phone clip stays 60 fps at every rung.
func OutputRate(p Probe) Rate {
	if !p.VariableFPS {
		if rate, ok := parseExactRate(p.NominalRate); ok && rate.FPS <= MaxOutputFPS+0.5 {
			return rate
		}
	}
	fps := p.FrameRate
	if fps <= 0 || math.IsNaN(fps) {
		fps = parseRate(p.NominalRate)
	}
	if fps <= 0 {
		return Rate{"30/1", 30}
	}
	fps = math.Min(fps, MaxOutputFPS)
	best := standardRates[0]
	for _, rate := range standardRates {
		if math.Abs(rate.FPS-fps) < math.Abs(best.FPS-fps) {
			best = rate
		}
	}
	return best
}

func parseExactRate(raw string) (Rate, bool) {
	num, den, ok := strings.Cut(raw, "/")
	if !ok {
		return Rate{}, false
	}
	n, errN := strconv.Atoi(num)
	d, errD := strconv.Atoi(den)
	if errN != nil || errD != nil || n <= 0 || d <= 0 {
		return Rate{}, false
	}
	return Rate{Expr: raw, FPS: float64(n) / float64(d)}, true
}
