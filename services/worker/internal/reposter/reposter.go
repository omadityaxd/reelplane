// Package reposter regenerates the posters (and inline placeholders) of published showcase videos
// from their kept originals, with the worker's current poster-frame selection, without re-transcoding.
//
// Published files are cached forever (storage.CacheControl), so a new poster goes under a new
// key next to the old one (poster-<ms>.jpg, named after the chosen frame), the video row is
// switched to it, and only then is the old poster deleted.
package reposter

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path"
	"path/filepath"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/omadityaxd/reelplane/services/worker/internal/media"
	"github.com/omadityaxd/reelplane/services/worker/internal/storage"
)

// Options configures a run.
type Options struct {
	FFmpeg, FFprobe string
	TempDir         string
	// DryRun chooses the frames and reports them, but uploads and changes nothing.
	DryRun bool
	Log    *slog.Logger
}

// Result is what happened to one video.
type Result struct {
	VideoID, OldKey, NewKey string
	AtMillis                int64
	Changed                 bool
}

type video struct {
	id, sourceKey, posterKey string
	sizeBytes                int64
}

// Run regenerates the poster of every ready showcase video with a poster (other videos' originals
// are deleted once published, see queue.OriginalPrefix). A video that fails is
// reported and skipped; the run returns the first such error after finishing the rest.
func Run(ctx context.Context, pool *pgxpool.Pool, store storage.Store, opts Options) ([]Result, error) {
	videos, err := readyVideos(ctx, pool)
	if err != nil {
		return nil, err
	}
	var results []Result
	var firstErr error
	for _, v := range videos {
		result, err := repost(ctx, pool, store, opts, v)
		if err != nil {
			if ctx.Err() != nil {
				return results, context.Cause(ctx)
			}
			opts.Log.Error("poster not regenerated", "video", v.id, "error", err)
			if firstErr == nil {
				firstErr = fmt.Errorf("video %s: %w", v.id, err)
			}
			continue
		}
		opts.Log.Info("poster", "video", v.id, "frame_ms", result.AtMillis, "changed", result.Changed,
			"new_key", result.NewKey, "dry_run", opts.DryRun)
		results = append(results, result)
	}
	return results, firstErr
}

func readyVideos(ctx context.Context, pool *pgxpool.Pool) ([]video, error) {
	rows, err := pool.Query(ctx, `
		select id, source_key, poster_key, size_bytes from reelplane.videos
		 where status = 'ready' and poster_key is not null and is_showcase
		 order by ready_at, id`)
	if err != nil {
		return nil, fmt.Errorf("list ready videos: %w", err)
	}
	defer rows.Close()
	var videos []video
	for rows.Next() {
		var v video
		if err := rows.Scan(&v.id, &v.sourceKey, &v.posterKey, &v.sizeBytes); err != nil {
			return nil, fmt.Errorf("read video row: %w", err)
		}
		videos = append(videos, v)
	}
	return videos, rows.Err()
}

func repost(ctx context.Context, pool *pgxpool.Pool, store storage.Store, opts Options, v video) (Result, error) {
	work, err := os.MkdirTemp(opts.TempDir, "reposter-*")
	if err != nil {
		return Result{}, err
	}
	defer os.RemoveAll(work)

	source := filepath.Join(work, "source")
	if err := store.Download(ctx, v.sourceKey, source, v.sizeBytes); err != nil {
		return Result{}, fmt.Errorf("download original: %w", err)
	}
	probe, err := media.ProbeFile(ctx, opts.FFprobe, source)
	if err != nil {
		return Result{}, fmt.Errorf("probe: %w", err)
	}
	stage := filepath.Join(work, "out")
	if err := os.Mkdir(stage, 0o700); err != nil {
		return Result{}, err
	}
	poster, err := media.GeneratePoster(ctx, opts.FFmpeg, source, work, "poster.jpg", probe)
	if err != nil {
		return Result{}, err
	}
	name := fmt.Sprintf("poster-%d.jpg", poster.At.Milliseconds())
	prefix := path.Dir(v.posterKey)
	result := Result{VideoID: v.id, OldKey: v.posterKey, NewKey: prefix + "/" + name, AtMillis: poster.At.Milliseconds()}
	if result.NewKey == v.posterKey || opts.DryRun {
		return result, nil
	}
	if err := os.Rename(filepath.Join(work, "poster.jpg"), filepath.Join(stage, name)); err != nil {
		return Result{}, err
	}
	if _, err := store.UploadDir(ctx, stage, prefix); err != nil {
		return Result{}, fmt.Errorf("upload poster: %w", err)
	}
	tag, err := pool.Exec(ctx, `
		update reelplane.videos set poster_key = $2, placeholder = $3
		 where id = $1 and poster_key = $4 and status = 'ready'`,
		v.id, result.NewKey, poster.Placeholder, v.posterKey)
	if err != nil {
		return Result{}, fmt.Errorf("switch poster: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// Changed or deleted meanwhile: leave it, and don't leave the new file behind.
		_, _ = store.DeletePrefix(ctx, result.NewKey)
		return result, nil
	}
	result.Changed = true
	// Unreferenced now; if this fails, it is only a small orphaned file.
	if _, err := store.DeletePrefix(ctx, v.posterKey); err != nil {
		opts.Log.Warn("old poster not deleted", "key", v.posterKey, "error", err)
	}
	return result, nil
}
