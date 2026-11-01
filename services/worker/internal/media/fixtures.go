package media

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Clip describes a synthetic test video generated with FFmpeg's lavfi sources. Used by tests
// and the chaos test so neither needs binary fixtures checked into the repo.
type Clip struct {
	Width, Height int
	Duration      time.Duration
	FPS           int
	Audio         bool
	// Rotation is written as display-matrix metadata, like a phone held upright.
	Rotation int
	// HLG makes a 10-bit BT.2020 HLG clip, like iPhone HDR video.
	HLG bool
}

// GenerateClip writes the clip to path (H.264/AAC MP4).
func GenerateClip(ctx context.Context, ffmpeg, path string, clip Clip) error {
	seconds := strconv.FormatFloat(clip.Duration.Seconds(), 'f', 3, 64)
	args := []string{"-hide_banner", "-nostdin", "-y", "-v", "error",
		"-f", "lavfi", "-i", fmt.Sprintf("testsrc2=size=%dx%d:rate=%d:duration=%s", clip.Width, clip.Height, clip.FPS, seconds)}
	if clip.Audio {
		args = append(args, "-f", "lavfi", "-i", "sine=frequency=440:duration="+seconds)
	}
	if clip.HLG {
		// libx264 only writes the colour description into the stream via its own params.
		args = append(args, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le",
			"-x264-params", "colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
			"-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc")
	} else {
		args = append(args, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p")
	}
	if clip.Audio {
		args = append(args, "-c:a", "aac", "-shortest")
	}
	target := path
	if clip.Rotation != 0 {
		target = path + ".unrotated.mp4"
	}
	if out, err := exec.CommandContext(ctx, ffmpeg, append(args, target)...).CombinedOutput(); err != nil {
		return fmt.Errorf("generate clip: %w: %s", err, strings.TrimSpace(string(out)))
	}
	if clip.Rotation == 0 {
		return nil
	}
	rotate := []string{"-hide_banner", "-nostdin", "-y", "-v", "error",
		"-display_rotation", strconv.Itoa(clip.Rotation), "-i", target, "-c", "copy", path}
	if out, err := exec.CommandContext(ctx, ffmpeg, rotate...).CombinedOutput(); err != nil {
		return fmt.Errorf("rotate clip: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
