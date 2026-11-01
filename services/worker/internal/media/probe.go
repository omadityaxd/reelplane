// Package media inspects and transcodes videos with ffprobe/FFmpeg.
package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/omadityashukla/reelplane/services/worker/internal/proc"
)

// InvalidInputError means the file itself is unusable: retrying will not help.
type InvalidInputError struct{ Reason string }

func (e *InvalidInputError) Error() string { return "invalid video: " + e.Reason }

// IsInvalidInput reports whether err is (or wraps) an InvalidInputError.
func IsInvalidInput(err error) bool {
	var target *InvalidInputError
	return errors.As(err, &target)
}

// Probe is what the pipeline needs to know about a source file.
type Probe struct {
	Duration time.Duration
	// Coded size, as stored in the stream.
	CodedWidth, CodedHeight int
	// Rotation in degrees from the display matrix (phones record portrait as rotated landscape).
	Rotation int
	// Display size after applying rotation: what viewers see and what the ladder plans from.
	Width, Height int
	FrameRate     float64
	// NominalRate is the exact rational rate (r_frame_rate), e.g. "30000/1001" or "60/1".
	NominalRate string
	VariableFPS bool
	HasAudio    bool
	VideoCodec  string
	// ColorTransfer is the transfer characteristic, e.g. "bt709", "arib-std-b67" (HLG, iPhone
	// HDR / Dolby Vision 8.4) or "smpte2084" (PQ / HDR10).
	ColorTransfer string
}

// IsHDR reports an HDR transfer function, which needs tone mapping for an SDR H.264 ladder.
func (p Probe) IsHDR() bool {
	return p.ColorTransfer == "arib-std-b67" || p.ColorTransfer == "smpte2084"
}

// IsVertical reports portrait orientation (the 9:16 case Reels are made for).
func (p Probe) IsVertical() bool { return p.Height > p.Width }

type ffprobeOutput struct {
	Streams []struct {
		CodecType     string            `json:"codec_type"`
		CodecName     string            `json:"codec_name"`
		Width         int               `json:"width"`
		Height        int               `json:"height"`
		RFrameRate    string            `json:"r_frame_rate"`
		AvgFrameRate  string            `json:"avg_frame_rate"`
		ColorTransfer string            `json:"color_transfer"`
		Tags          map[string]string `json:"tags"`
		Disposition   struct {
			AttachedPic int `json:"attached_pic"`
		} `json:"disposition"`
		SideDataList []struct {
			Rotation *float64 `json:"rotation"`
		} `json:"side_data_list"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

// ffprobe reports a still image (or a renamed one) as a one-frame "video" stream.
var stillImageCodecs = map[string]bool{
	"png": true, "mjpeg": true, "jpegls": true, "bmp": true, "gif": true, "webp": true,
	"tiff": true, "heif": true, "av1_image": true, "jpeg2000": true,
}

// ParseProbe interprets ffprobe's JSON (-show_streams -show_format).
func ParseProbe(raw []byte) (Probe, error) {
	var out ffprobeOutput
	if err := json.Unmarshal(raw, &out); err != nil {
		return Probe{}, &InvalidInputError{Reason: "unreadable container"}
	}
	var p Probe
	foundVideo := false
	for _, s := range out.Streams {
		switch {
		case s.CodecType == "audio":
			p.HasAudio = true
		case s.CodecType == "video" && s.Disposition.AttachedPic == 0 && !stillImageCodecs[s.CodecName] && !foundVideo:
			foundVideo = true
			p.VideoCodec = s.CodecName
			p.CodedWidth, p.CodedHeight = s.Width, s.Height
			p.Rotation = rotationOf(s.Tags, s.SideDataList)
			p.NominalRate = s.RFrameRate
			p.ColorTransfer = s.ColorTransfer
			rFPS, avgFPS := parseRate(s.RFrameRate), parseRate(s.AvgFrameRate)
			p.FrameRate = avgFPS
			if p.FrameRate == 0 {
				p.FrameRate = rFPS
			}
			// Phones record variable frame rate: the nominal and average rates disagree.
			p.VariableFPS = rFPS > 0 && avgFPS > 0 && math.Abs(rFPS-avgFPS)/rFPS > 0.05
		}
	}
	if !foundVideo {
		return Probe{}, &InvalidInputError{Reason: "no video stream"}
	}
	p.Width, p.Height = p.CodedWidth, p.CodedHeight
	if r := ((p.Rotation % 360) + 360) % 360; r == 90 || r == 270 {
		p.Width, p.Height = p.CodedHeight, p.CodedWidth
	}
	seconds, err := strconv.ParseFloat(out.Format.Duration, 64)
	if err == nil && seconds > 0 {
		p.Duration = time.Duration(seconds * float64(time.Second))
	}
	return p, nil
}

func rotationOf(tags map[string]string, sideData []struct {
	Rotation *float64 `json:"rotation"`
}) int {
	for _, d := range sideData {
		if d.Rotation != nil {
			return int(math.Round(*d.Rotation))
		}
	}
	if raw, ok := tags["rotate"]; ok { // older muxers
		if value, err := strconv.Atoi(raw); err == nil {
			return value
		}
	}
	return 0
}

func parseRate(raw string) float64 {
	num, den, ok := strings.Cut(raw, "/")
	if !ok {
		value, _ := strconv.ParseFloat(raw, 64)
		return value
	}
	n, errN := strconv.ParseFloat(num, 64)
	d, errD := strconv.ParseFloat(den, 64)
	if errN != nil || errD != nil || d == 0 {
		return 0
	}
	return n / d
}

// Limits a source must satisfy. The API checks the declared values; this is the real check.
type Limits struct {
	MaxDuration time.Duration
	MaxSide     int
	MinSide     int
}

// durationTolerance absorbs container rounding (a "60 s" phone clip is often 60.03 s).
const durationTolerance = 500 * time.Millisecond

func (p Probe) Validate(limits Limits) error {
	switch {
	case p.Duration <= 0:
		return &InvalidInputError{Reason: "unknown or zero duration"}
	case p.Duration > limits.MaxDuration+durationTolerance:
		return &InvalidInputError{Reason: fmt.Sprintf("video is %.1fs long; the limit is %.0fs", p.Duration.Seconds(), limits.MaxDuration.Seconds())}
	case min(p.Width, p.Height) < limits.MinSide:
		return &InvalidInputError{Reason: fmt.Sprintf("video is %dx%d; too small", p.Width, p.Height)}
	case max(p.Width, p.Height) > limits.MaxSide:
		return &InvalidInputError{Reason: fmt.Sprintf("video is %dx%d; the limit is %dpx", p.Width, p.Height, limits.MaxSide)}
	}
	return nil
}

// ProbeFile runs ffprobe on a local file.
func ProbeFile(ctx context.Context, ffprobe, path string) (Probe, error) {
	cmd := proc.Command(ctx, ffprobe, "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path)
	output, err := proc.Output(cmd)
	if err != nil {
		if ctx.Err() != nil {
			return Probe{}, ctx.Err()
		}
		// ffprobe fails on files that are not media at all.
		return Probe{}, &InvalidInputError{Reason: "not a readable video file"}
	}
	return ParseProbe(output)
}
