package media

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/omadityaxd/reelplane/services/worker/internal/proc"
)

const (
	posterShortSide      = 720
	thumbnailShortSide   = 180
	placeholderShortSide = 16
	thumbnailCount       = 3
)

// Images are the stills generated for a video.
type Images struct {
	Poster      string   // file name inside OutDir
	Thumbnails  []string // file names inside OutDir
	Placeholder string   // a tiny blurred JPEG as a data: URI, shown before anything loads
}

// GenerateImages writes poster.jpg, thumb_N.jpg and builds the inline placeholder.
func GenerateImages(ctx context.Context, ffmpeg, input, outDir string, probe Probe) (Images, error) {
	duration := probe.Duration
	images := Images{Poster: "poster.jpg"}
	poster, err := GeneratePoster(ctx, ffmpeg, input, outDir, images.Poster, probe)
	if err != nil {
		return Images{}, err
	}
	images.Placeholder = poster.Placeholder
	for i := 1; i <= thumbnailCount; i++ {
		name := fmt.Sprintf("thumb_%d.jpg", i)
		at := duration * time.Duration(i) / time.Duration(thumbnailCount+1)
		if err := still(ctx, ffmpeg, input, filepath.Join(outDir, name), at, probe, thumbnailShortSide, "", 5); err != nil {
			return Images{}, fmt.Errorf("thumbnail %d: %w", i, err)
		}
		images.Thumbnails = append(images.Thumbnails, name)
	}
	return images, nil
}

// Poster is a poster still and the inline placeholder made from the same frame.
type Poster struct {
	At          time.Duration
	Placeholder string // a tiny blurred JPEG as a data: URI
}

// GeneratePoster writes the poster to outDir/name from a representative frame (PickPosterTime)
// and builds the placeholder from the same frame. A clip that can't be analysed gets the
// default time: a poster is never worth failing a job over.
func GeneratePoster(ctx context.Context, ffmpeg, input, outDir, name string, probe Probe) (Poster, error) {
	at, err := PickPosterTime(ctx, ffmpeg, input, probe)
	if err != nil && ctx.Err() != nil {
		return Poster{}, err
	}
	if err := still(ctx, ffmpeg, input, filepath.Join(outDir, name), at, probe, posterShortSide, "", 3); err != nil {
		return Poster{}, fmt.Errorf("poster: %w", err)
	}
	placeholderPath := filepath.Join(outDir, "placeholder.jpg")
	if err := still(ctx, ffmpeg, input, placeholderPath, at, probe, placeholderShortSide, ",boxblur=2:1", 10); err != nil {
		return Poster{}, fmt.Errorf("placeholder: %w", err)
	}
	raw, err := os.ReadFile(placeholderPath)
	if err != nil {
		return Poster{}, fmt.Errorf("read placeholder: %w", err)
	}
	_ = os.Remove(placeholderPath) // inlined into the database row; never uploaded
	return Poster{At: at, Placeholder: "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(raw)}, nil
}

func still(ctx context.Context, ffmpeg, input, output string, at time.Duration, probe Probe, short int, extraFilter string, quality int) error {
	w, h := ScaleToShortSide(probe.Width, probe.Height, min(short, min(probe.Width, probe.Height)))
	args := []string{"-hide_banner", "-nostdin", "-y", "-v", "error"}
	args = append(args, InputGuard...)
	args = append(args,
		"-ss", strconv.FormatFloat(at.Seconds(), 'f', 3, 64),
		"-i", input,
		"-map", fmt.Sprintf("0:v:%d", probe.VideoStream),
		"-frames:v", "1",
		"-vf", stillFilter(probe, w, h, extraFilter),
		"-q:v", strconv.Itoa(quality),
		output,
	)
	var stderr strings.Builder
	cmd := proc.Command(ctx, ffmpeg, args...)
	cmd.Stderr = &limitedWriter{w: &stderr, remaining: 4 << 10}
	if err := proc.Run(cmd); err != nil {
		if ctx.Err() != nil {
			return context.Cause(ctx)
		}
		return ClassifyFailure(err, stderr.String())
	}
	return nil
}

// stillFilter scales a still and tone-maps HDR sources like the video renditions.
func stillFilter(probe Probe, w, h int, extra string) string {
	scale := fmt.Sprintf("scale=%d:%d%s", w, h, extra)
	if probe.IsHDR() {
		return ToneMapFilter + "," + scale
	}
	return scale
}
