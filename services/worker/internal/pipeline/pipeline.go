// Package pipeline turns one claimed job into published HLS: download, probe, transcode,
// stills, upload. It never touches the database; the worker commits the Result.
package pipeline

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/omadityashukla/reelplane/services/worker/internal/media"
	"github.com/omadityashukla/reelplane/services/worker/internal/queue"
	"github.com/omadityashukla/reelplane/services/worker/internal/storage"
)

// Progress budget: transcoding dominates, stills and upload are quick.
const (
	transcodeShare = 85
	imagesShare    = 5
)

type Pipeline struct {
	Store   storage.Store
	FFmpeg  string
	FFprobe string
	Preset  string
	// Threads caps FFmpeg's threads (0 = FFmpeg's default); see media.EncodePlan.Threads.
	Threads int
	Limits  media.Limits
	TempDir string
	// Now is injectable for tests.
	Now func() time.Time
}

// Run processes a job. Invalid input is reported as media.InvalidInputError (do not retry).
func (p *Pipeline) Run(ctx context.Context, job *queue.Job, progress func(int)) (queue.Result, error) {
	now := p.Now
	if now == nil {
		now = time.Now
	}
	started := now()
	work, err := os.MkdirTemp(p.TempDir, "reelplane-job-")
	if err != nil {
		return queue.Result{}, fmt.Errorf("create work dir: %w", err)
	}
	defer os.RemoveAll(work)

	source := filepath.Join(work, "source")
	if err := p.Store.Download(ctx, job.SourceKey, source); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return queue.Result{}, &media.InvalidInputError{Reason: "source file is missing from storage"}
		}
		return queue.Result{}, err
	}
	probe, err := media.ProbeFile(ctx, p.FFprobe, source)
	if err != nil {
		return queue.Result{}, err
	}
	if err := probe.Validate(p.Limits); err != nil {
		return queue.Result{}, err
	}

	out := filepath.Join(work, "out")
	if err := os.MkdirAll(out, 0o755); err != nil {
		return queue.Result{}, err
	}
	rate := media.OutputRate(probe)
	rungs := media.PlanLadder(probe.Width, probe.Height, rate.FPS)
	plan := media.EncodePlan{
		Input: source, OutDir: out, Rungs: rungs, Rate: rate, HDR: probe.IsHDR(),
		HasAudio: probe.HasAudio, Preset: p.Preset, Threads: p.Threads,
	}
	encodeStart := now()
	if err := media.Transcode(ctx, p.FFmpeg, plan, probe.Duration, func(f float64) {
		progress(int(f * transcodeShare))
	}); err != nil {
		return queue.Result{}, err
	}
	encodeTime := now().Sub(encodeStart)
	variants, err := media.WriteMasters(out, rungs, rate)
	if err != nil {
		return queue.Result{}, err
	}

	images, err := media.GenerateImages(ctx, p.FFmpeg, source, out, probe)
	if err != nil {
		return queue.Result{}, err
	}
	progress(transcodeShare + imagesShare)

	prefix := queue.AttemptPrefix(job)
	if _, err := p.Store.UploadDir(ctx, out, prefix); err != nil {
		return queue.Result{}, fmt.Errorf("upload outputs: %w", err)
	}
	progress(99)
	return buildResult(prefix, probe, rungs, variants, images, plan, encodeTime, now().Sub(started)), nil
}

func buildResult(prefix string, probe media.Probe, rungs []media.Rung, variants []media.Variant, images media.Images, plan media.EncodePlan, encode, total time.Duration) queue.Result {
	measured := make(map[string]media.Variant, len(variants))
	for _, v := range variants {
		measured[v.Name] = v
	}
	renditions := make([]queue.Rendition, len(rungs))
	for i, rung := range rungs {
		// Prefer what FFmpeg measured (real average bitrate, exact codec string) over targets.
		bitrate, codecs := rung.VideoKbps+rung.AudioKbps, "avc1"
		if v, ok := measured[rung.Name]; ok {
			if v.AverageBandwidth > 0 {
				bitrate = v.AverageBandwidth / 1000
			}
			if v.Codecs != "" {
				codecs = v.Codecs
			}
		}
		renditions[i] = queue.Rendition{
			Name: rung.Name, Width: rung.Width, Height: rung.Height, BitrateKbps: bitrate,
			FPS: plan.Rate.FPS, Codecs: codecs, PlaylistKey: prefix + "/" + rung.Name + "/index.m3u8",
		}
	}
	thumbs := make([]string, len(images.Thumbnails))
	for i, name := range images.Thumbnails {
		thumbs[i] = prefix + "/" + name
	}
	speed := 0.0
	if encode > 0 {
		speed = probe.Duration.Seconds() / encode.Seconds()
	}
	return queue.Result{
		Prefix: prefix, MasterKey: prefix + "/master.m3u8", PosterKey: prefix + "/" + images.Poster,
		ThumbnailKeys: thumbs, Placeholder: images.Placeholder,
		DurationMs: int(probe.Duration.Milliseconds()), Width: probe.Width, Height: probe.Height,
		Renditions: renditions,
		Metrics: map[string]any{
			"mediaDurationMs": probe.Duration.Milliseconds(),
			"encodeMs":        encode.Milliseconds(),
			"totalMs":         total.Milliseconds(),
			// How many seconds of video are encoded per wall-clock second, all rungs together.
			"speedRealtime": speed,
			"renditions":    len(rungs),
			"preset":        plan.Preset,
			"source":        fmt.Sprintf("%dx%d@%.2ffps", probe.Width, probe.Height, probe.FrameRate),
			"outputFps":     plan.Rate.Expr,
			"hdrToneMapped": plan.HDR,
		},
	}
}
