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
	// VideoStream is the probed stream's position among the file's video streams, for
	// FFmpeg's `0:v:N`: plain `[0:v]` would pick cover art if that comes first.
	VideoStream int
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
		Duration      string            `json:"duration"`
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
	videoStreams := 0
	var streamDuration time.Duration
	for _, s := range out.Streams {
		if s.CodecType == "video" {
			videoStreams++
		}
		switch {
		case s.CodecType == "audio":
			p.HasAudio = true
		case s.CodecType == "video" && s.Disposition.AttachedPic == 0 && !stillImageCodecs[s.CodecName] && !foundVideo:
			foundVideo = true
			p.VideoStream = videoStreams - 1
			streamDuration = parseSeconds(s.Duration)
			if streamDuration == 0 {
				// Matroska/WebM keeps a per-stream "DURATION" tag (HH:MM:SS.nnnnnnnnn).
				streamDuration = parseClock(s.Tags["DURATION"])
			}
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
	// The container's duration first, then the video stream's. ProbeFile falls back further
	// to reading packet timestamps.
	p.Duration = parseSeconds(out.Format.Duration)
	if p.Duration == 0 {
		p.Duration = streamDuration
	}
	return p, nil
}

func parseSeconds(raw string) time.Duration {
	seconds, err := strconv.ParseFloat(raw, 64)
	if err != nil || !(seconds > 0) || math.IsInf(seconds, 0) {
		return 0
	}
	return time.Duration(seconds * float64(time.Second))
}

// parseClock reads "HH:MM:SS.fraction".
func parseClock(raw string) time.Duration {
	parts := strings.Split(raw, ":")
	if len(parts) != 3 {
		return 0
	}
	hours, errH := strconv.Atoi(parts[0])
	minutes, errM := strconv.Atoi(parts[1])
	if errH != nil || errM != nil || hours < 0 || minutes < 0 {
		return 0
	}
	seconds := parseSeconds(parts[2])
	if seconds == 0 {
		return 0
	}
	return time.Duration(hours)*time.Hour + time.Duration(minutes)*time.Minute + seconds
}

// ParsePacketEnd returns where the last packet ends, from ffprobe's
// `packet=pts_time,duration_time` CSV: the duration of a file whose headers lack one (a WebM
// recorded by a browser's MediaRecorder).
func ParsePacketEnd(csv []byte) time.Duration {
	var end float64
	for line := range strings.Lines(string(csv)) {
		pts, dur, _ := strings.Cut(strings.TrimSpace(line), ",")
		start, err := strconv.ParseFloat(pts, 64)
		if err != nil {
			continue // packets without a timestamp report "N/A"
		}
		length, _ := strconv.ParseFloat(dur, 64)
		end = max(end, start+length)
	}
	if !(end > 0) || math.IsInf(end, 0) {
		return 0
	}
	return time.Duration(end * float64(time.Second))
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

// InputGuard goes before every `-i` of an uploaded file. Content sniffing would otherwise let
// an upload that is really a playlist (HLS, concat, SDP) make FFmpeg open other files or URLs:
// only local files, and only the MP4/MOV and Matroska/WebM demuxers the API accepts.
var InputGuard = []string{"-protocol_whitelist", "file", "-format_whitelist", "mov,matroska"}

// ProbeFile runs ffprobe on a local file.
func ProbeFile(ctx context.Context, ffprobe, path string) (Probe, error) {
	args := append(append([]string{"-v", "error"}, InputGuard...),
		"-print_format", "json", "-show_streams", "-show_format", path)
	output, err := proc.Output(proc.Command(ctx, ffprobe, args...))
	if err != nil {
		if ctx.Err() != nil {
			return Probe{}, context.Cause(ctx)
		}
		// ffprobe fails on files that are not media at all.
		return Probe{}, &InvalidInputError{Reason: "not a readable video file"}
	}
	p, err := ParseProbe(output)
	if err != nil || p.Duration > 0 {
		return p, err
	}
	// No duration in any header: read the video packets' timestamps (no decoding).
	args = append(append([]string{"-v", "error"}, InputGuard...),
		"-select_streams", fmt.Sprintf("v:%d", p.VideoStream),
		"-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0", path)
	packets, err := proc.Output(proc.Command(ctx, ffprobe, args...))
	if err != nil {
		if ctx.Err() != nil {
			return Probe{}, context.Cause(ctx)
		}
		return p, nil // Validate rejects the unknown duration
	}
	p.Duration = ParsePacketEnd(packets)
	return p, nil
}
