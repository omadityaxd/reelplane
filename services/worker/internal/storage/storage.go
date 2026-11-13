// Package storage is the worker's side of the S3-compatible storage interface
// (packages/storage is the API's side). Same STORAGE_* configuration, same providers.
package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
)

// ErrNotFound is returned when a key does not exist.
var ErrNotFound = errors.New("storage: object not found")

// ErrTooLarge is returned when a download exceeds its byte limit.
var ErrTooLarge = errors.New("storage: object is larger than the limit")

// Store is everything the worker needs from object storage.
type Store interface {
	// Download streams an object to a local file, stopping with ErrTooLarge past maxBytes
	// (0 = no limit).
	Download(ctx context.Context, key, dst string, maxBytes int64) error
	// Put writes a small object (used for seeding in tests and the chaos run).
	Put(ctx context.Context, key string, body []byte, contentType string) error
	// UploadDir uploads every file under dir to prefix/<relative path>, returning the keys.
	UploadDir(ctx context.Context, dir, prefix string) ([]string, error)
	// List returns every key under prefix.
	List(ctx context.Context, prefix string) ([]string, error)
	// DeletePrefix deletes every key under prefix; it returns how many were deleted.
	DeletePrefix(ctx context.Context, prefix string) (int, error)
	// AbortMultipart frees the parts of an upload that was never completed. An upload that no
	// longer exists is not an error.
	AbortMultipart(ctx context.Context, key, uploadID string) error
}

// ContentType maps HLS and image outputs to the types players and CDNs expect.
func ContentType(key string) string {
	switch strings.ToLower(path.Ext(key)) {
	case ".m3u8":
		return "application/vnd.apple.mpegurl"
	case ".m4s":
		return "video/iso.segment"
	case ".mp4":
		return "video/mp4"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	default:
		return "application/octet-stream"
	}
}

// CacheControl: every published file lives under a unique per-attempt prefix and is never
// rewritten, so all of it (playlists included) can be cached forever by browsers and CDNs.
const CacheControl = "public, max-age=31536000, immutable"

// copyLimited copies src to dst, failing with ErrTooLarge as soon as more than maxBytes
// arrive (0 = no limit), so an oversized object never fills the disk.
func copyLimited(dst io.Writer, src io.Reader, maxBytes int64) error {
	if maxBytes <= 0 {
		_, err := io.Copy(dst, src)
		return err
	}
	n, err := io.Copy(dst, io.LimitReader(src, maxBytes+1))
	if err != nil {
		return err
	}
	if n > maxBytes {
		return fmt.Errorf("%w (%d bytes)", ErrTooLarge, maxBytes)
	}
	return nil
}

func validPrefix(prefix string) error {
	if strings.Trim(prefix, "/") == "" {
		return errors.New("storage: refusing to operate on an empty prefix")
	}
	return nil
}
