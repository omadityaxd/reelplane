package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Dir is a directory-backed Store for tests: keys map to files under Root.
type Dir struct{ Root string }

func (d Dir) path(key string) string { return filepath.Join(d.Root, filepath.FromSlash(key)) }

func (d Dir) Download(_ context.Context, key, dst string, maxBytes int64) error {
	src, err := os.Open(d.path(key))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("%w: %s", ErrNotFound, key)
		}
		return err
	}
	defer src.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if err := copyLimited(out, src, maxBytes); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

func (d Dir) Put(_ context.Context, key string, body []byte, _ string) error {
	target := d.path(key)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	return os.WriteFile(target, body, 0o644)
}

func (d Dir) UploadDir(ctx context.Context, dir, prefix string) ([]string, error) {
	if err := validPrefix(prefix); err != nil {
		return nil, err
	}
	files, err := localFiles(dir)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(files))
	for _, rel := range files {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		body, err := os.ReadFile(filepath.Join(dir, rel))
		if err != nil {
			return nil, err
		}
		key := joinKey(prefix, rel)
		if err := d.Put(ctx, key, body, ContentType(key)); err != nil {
			return nil, err
		}
		keys = append(keys, key)
	}
	return keys, nil
}

func (d Dir) List(_ context.Context, prefix string) ([]string, error) {
	var keys []string
	err := filepath.WalkDir(d.Root, func(p string, entry fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if entry.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(d.Root, p)
		if err != nil {
			return err
		}
		if key := filepath.ToSlash(rel); strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
		return nil
	})
	sort.Strings(keys)
	return keys, err
}

func (d Dir) DeletePrefix(ctx context.Context, prefix string) (int, error) {
	if err := validPrefix(prefix); err != nil {
		return 0, err
	}
	keys, err := d.List(ctx, prefix)
	if err != nil {
		return 0, err
	}
	for _, key := range keys {
		if err := os.Remove(d.path(key)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return 0, err
		}
	}
	return len(keys), nil
}

// localFiles lists files under dir as slash-separated relative paths, sorted.
// AbortMultipart is a no-op: the directory store has no multipart uploads.
func (d Dir) AbortMultipart(context.Context, string, string) error { return nil }

func localFiles(dir string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(dir, func(p string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		files = append(files, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("list %s: %w", dir, err)
	}
	sort.Strings(files)
	return files, nil
}

func joinKey(prefix, rel string) string { return strings.TrimRight(prefix, "/") + "/" + rel }

func bytesReader(body []byte) io.Reader { return bytes.NewReader(body) }
