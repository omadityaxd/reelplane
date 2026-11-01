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

	"github.com/omadityashukla/reelplane/services/worker/internal/proc"
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
	// The poster comes from early in the clip (the first frame is often black).
	posterAt := min(time.Second, duration/3)
	images := Images{Poster: "poster.jpg"}

	if err := still(ctx, ffmpeg, input, filepath.Join(outDir, images.Poster), posterAt, probe, posterShortSide, "", 3); err != nil {
		return Images{}, fmt.Errorf("poster: %w", err)
	}
	for i := 1; i <= thumbnailCount; i++ {
		name := fmt.Sprintf("thumb_%d.jpg", i)
		at := duration * time.Duration(i) / time.Duration(thumbnailCount+1)
		if err := still(ctx, ffmpeg, input, filepath.Join(outDir, name), at, probe, thumbnailShortSide, "", 5); err != nil {
			return Images{}, fmt.Errorf("thumbnail %d: %w", i, err)
		}
		images.Thumbnails = append(images.Thumbnails, name)
	}

	placeholderPath := filepath.Join(outDir, "placeholder.jpg")
	if err := still(ctx, ffmpeg, input, placeholderPath, posterAt, probe, placeholderShortSide, ",boxblur=2:1", 10); err != nil {
		return Images{}, fmt.Errorf("placeholder: %w", err)
	}
	raw, err := os.ReadFile(placeholderPath)
	if err != nil {
		return Images{}, fmt.Errorf("read placeholder: %w", err)
	}
	_ = os.Remove(placeholderPath) // inlined into the database row; never uploaded
	images.Placeholder = "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(raw)
	return images, nil
}

func still(ctx context.Context, ffmpeg, input, output string, at time.Duration, probe Probe, short int, extraFilter string, quality int) error {
	w, h := ScaleToShortSide(probe.Width, probe.Height, min(short, min(probe.Width, probe.Height)))
	args := []string{
		"-hide_banner", "-nostdin", "-y", "-v", "error",
		"-ss", strconv.FormatFloat(at.Seconds(), 'f', 3, 64),
		"-i", input,
		"-frames:v", "1",
		"-vf", fmt.Sprintf("scale=%d:%d%s", w, h, extraFilter),
		"-q:v", strconv.Itoa(quality),
		output,
	}
	var stderr strings.Builder
	cmd := proc.Command(ctx, ffmpeg, args...)
	cmd.Stderr = &limitedWriter{w: &stderr, remaining: 4 << 10}
	if err := proc.Run(cmd); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}
