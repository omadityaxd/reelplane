// Package dbsetup creates throwaway databases from packages/db/migrations. Used by tests
// (via testdb) and by the chaos run; never by the production worker.
package dbsetup

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var safeName = regexp.MustCompile(`^reelplane_(test|chaos)[a-z0-9_]*$`)

// MigrationsDir locates the shared SQL migrations relative to this source file.
func MigrationsDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "packages", "db", "migrations")
}

// Recreate drops and recreates database `name` next to baseURL's and returns its URL.
// Only names starting with reelplane_test or reelplane_chaos are accepted.
func Recreate(ctx context.Context, baseURL, name string) (string, error) {
	if !safeName.MatchString(name) {
		return "", fmt.Errorf("refusing to recreate database %q", name)
	}
	admin, err := pgx.Connect(ctx, baseURL)
	if err != nil {
		return "", fmt.Errorf("connect to postgres (is `pnpm infra:up` running?): %w", err)
	}
	defer admin.Close(ctx)
	for _, stmt := range []string{
		fmt.Sprintf("drop database if exists %s with (force)", name),
		fmt.Sprintf("create database %s", name),
	} {
		if _, err := admin.Exec(ctx, stmt); err != nil {
			return "", fmt.Errorf("%s: %w", stmt, err)
		}
	}
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return "", fmt.Errorf("parse database URL: %w", err)
	}
	parsed.Path = "/" + name
	return parsed.String(), nil
}

// Migrate applies every migration file in order (fresh databases only).
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	files, err := filepath.Glob(filepath.Join(MigrationsDir(), "*.sql"))
	if err != nil || len(files) == 0 {
		return fmt.Errorf("no migrations found in %s", MigrationsDir())
	}
	sort.Strings(files)
	if _, err := pool.Exec(ctx, "create schema if not exists reelplane"); err != nil {
		return fmt.Errorf("create schema: %w", err)
	}
	for _, file := range files {
		sql, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		if _, err := pool.Exec(ctx, string(sql)); err != nil {
			return fmt.Errorf("apply %s: %w", filepath.Base(file), err)
		}
	}
	return nil
}
