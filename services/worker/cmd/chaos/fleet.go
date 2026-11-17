package main

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/omadityaxd/reelplane/services/worker/internal/proc"
)

func exeSuffix() string {
	if runtime.GOOS == "windows" {
		return ".exe"
	}
	return ""
}

type process struct {
	id  string
	cmd *exec.Cmd
	log *os.File
}

// fleet keeps `workers` real worker processes running, each with a unique WORKER_ID per life.
type fleet struct {
	opts  options
	dbURL string

	mu         sync.Mutex
	slots      []*process
	generation int
}

func newFleet(opts options, dbURL string) *fleet {
	return &fleet{opts: opts, dbURL: dbURL, slots: make([]*process, opts.workers)}
}

func (f *fleet) startAll() error {
	for slot := range f.slots {
		if err := f.start(slot); err != nil {
			return err
		}
	}
	return nil
}

func (f *fleet) start(slot int) error {
	f.mu.Lock()
	f.generation++
	id := fmt.Sprintf("chaos-w%d-g%d", slot, f.generation)
	f.mu.Unlock()

	logFile, err := os.Create(filepath.Join(f.opts.outDir, id+".log"))
	if err != nil {
		return err
	}
	// proc.Command puts the worker in this process's kill-on-exit group, so aborting the chaos
	// run never leaves workers (or their FFmpeg children) behind.
	cmd := proc.Command(context.Background(), f.opts.workerBin)
	cmd.Stdout, cmd.Stderr = logFile, logFile
	cmd.Env = append(os.Environ(),
		"DATABASE_URL="+f.dbURL,
		"WORKER_ID="+id,
		"WORKER_LEASE_DURATION="+f.opts.lease.String(),
		"WORKER_HEARTBEAT_INTERVAL="+f.opts.heartbeat.String(),
		"WORKER_POLL_INTERVAL=200ms",
		"WORKER_RETRY_BASE=500ms",
		"WORKER_RETRY_MAX=3s",
		"WORKER_GARBAGE_DELAY=2s",
		"FFMPEG_PRESET="+f.opts.preset,
	)
	if err := proc.Start(cmd); err != nil {
		_ = logFile.Close()
		return fmt.Errorf("start worker %s: %w", id, err)
	}
	go func() { _ = cmd.Wait(); _ = logFile.Close() }()
	f.mu.Lock()
	f.slots[slot] = &process{id: id, cmd: cmd, log: logFile}
	f.mu.Unlock()
	return nil
}

// kill terminates a worker the hard way: no signal handler runs, no lease is released.
func (f *fleet) kill(slot int) string {
	f.mu.Lock()
	p := f.slots[slot]
	f.slots[slot] = nil
	f.mu.Unlock()
	if p == nil {
		return ""
	}
	_ = p.cmd.Process.Kill()
	return p.id
}

func (f *fleet) stopAll() {
	for slot := range f.slots {
		f.kill(slot)
	}
}

type chaosOutcome struct {
	kills, killsMidJob int
	err                error
}

// runChaos kills a random worker at random intervals (restarting it shortly after) until
// every job has reached a terminal state.
func runChaos(ctx context.Context, owner *pgxpool.Pool, f *fleet, rng *rand.Rand, opts options, started time.Time) chaosOutcome {
	var out chaosOutcome
	nextKill := time.Now().Add(randomBetween(rng, opts.killMin, opts.killMax))
	lastReport := time.Now()
	for {
		if ctx.Err() != nil {
			out.err = ctx.Err()
			return out
		}
		if time.Since(started) > opts.timeout {
			out.err = fmt.Errorf("timed out after %s with jobs still pending", opts.timeout)
			return out
		}
		pending, running, done, err := counts(ctx, owner)
		if err != nil {
			out.err = err
			return out
		}
		if pending == 0 && running == 0 {
			return out
		}
		if time.Since(lastReport) > 5*time.Second {
			logf("done %d/%d · running %d · kills %d (%d mid-job)", done, opts.jobs, running, out.kills, out.killsMidJob)
			lastReport = time.Now()
		}
		if time.Now().After(nextKill) {
			slot := rng.IntN(opts.workers)
			victim := f.slots[slot]
			if victim != nil {
				midJob := holdsJob(ctx, owner, victim.id)
				f.kill(slot)
				out.kills++
				if midJob {
					out.killsMidJob++
				}
				restartIn := randomBetween(rng, 200*time.Millisecond, 1500*time.Millisecond)
				go func() {
					time.Sleep(restartIn)
					_ = f.start(slot)
				}()
			}
			nextKill = time.Now().Add(randomBetween(rng, opts.killMin, opts.killMax))
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func counts(ctx context.Context, owner *pgxpool.Pool) (pending, running, done int, err error) {
	err = owner.QueryRow(ctx, `
		select count(*) filter (where state = 'queued'),
		       count(*) filter (where state = 'running'),
		       count(*) filter (where state in ('succeeded', 'dead', 'cancelled'))
		  from reelplane.jobs`).Scan(&pending, &running, &done)
	return
}

func holdsJob(ctx context.Context, owner *pgxpool.Pool, workerID string) bool {
	var n int
	_ = owner.QueryRow(ctx, `select count(*) from reelplane.jobs where state = 'running' and lease_owner = $1`, workerID).Scan(&n)
	return n > 0
}

func randomBetween(rng *rand.Rand, lo, hi time.Duration) time.Duration {
	if hi <= lo {
		return lo
	}
	return lo + time.Duration(rng.Int64N(int64(hi-lo)))
}
