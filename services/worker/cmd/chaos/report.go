package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

func printReport(r *Results) {
	verdict := "PASS"
	if !r.Passed {
		verdict = "FAIL"
	}
	fmt.Println()
	fmt.Printf("Chaos test: %s   (%d jobs, %v, seed %d)\n", verdict, r.Jobs, r.Config, r.Seed)
	fmt.Println("────────────────────────────────────────────────────────────────")
	row := func(label string, value any) { fmt.Printf("  %-44s %v\n", label, value) }
	row("wall time", r.Elapsed.Round(time.Second))
	row("workers killed (hard kill, no cleanup)", r.Kills)
	row("  … of which were holding a job", r.KillsMidJob)
	row("jobs requeued after a lease expired", r.LeaseExpiries)
	row("zombie completions rejected by fencing", r.ZombieRejections)
	row("jobs abandoned on lease loss", r.AbandonedOnLeaseLoss)
	row("attempts per job (attempts: jobs)", histogram(r.AttemptHistogram))
	fmt.Println("  invariants ──────────────────────────────────────────────────")
	row("jobs succeeded", fmt.Sprintf("%d / %d", r.JobStates["succeeded"], r.Jobs))
	row("videos ready (none lost)", fmt.Sprintf("%d / %d", r.VideosReady, r.Jobs))
	row("videos completed exactly once", fmt.Sprintf("%d / %d", r.ExactlyOnce, r.Jobs))
	row("videos with duplicate jobs", r.VideosWithDuplicates)
	row("videos with the full rendition ladder", fmt.Sprintf("%d / %d", r.RenditionsOK, r.Jobs))
	row("playlists complete in storage", fmt.Sprintf("%d / %d", r.PlaylistsComplete, r.Jobs))
	row("referenced objects missing", r.MissingObjects)
	row("orphaned objects from losing attempts", r.OrphanObjects)
	row("mean transcode speed (× realtime, 3 rungs)", fmt.Sprintf("%.2f", r.MeanSpeedRealtime))
	for _, violation := range r.Violations {
		fmt.Println("  VIOLATION:", violation)
	}
	fmt.Println()
}

func histogram(h map[int]int) string {
	keys := make([]int, 0, len(h))
	for k := range h {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	out := ""
	for i, k := range keys {
		if i > 0 {
			out += "  "
		}
		out += fmt.Sprintf("%d:%d", k, h[k])
	}
	return out
}

func writeReport(path string, r *Results) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	body, err := json.MarshalIndent(struct {
		*Results
		RanAt   string  `json:"ranAt"`
		Seconds float64 `json:"elapsedSeconds"`
	}{r, time.Now().UTC().Format(time.RFC3339), r.Elapsed.Seconds()}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(body, '\n'), 0o644)
}
