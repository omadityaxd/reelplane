// Command ladder-quality measures the perceptual quality of every rung of the ladder for a
// source clip: VMAF (phone model) and SSIM against the source, plus the actual bitrate.
//
// Each rung is encoded with the same settings as the pipeline (scaler, frame rate, GOP, x264
// preset, capped VBR), then upscaled to the viewing size (the phone screen: 1080x1920, or the
// source if smaller) and compared with the source at that size. With -sweep, each rung is also
// tried at 0.35x, 0.6x and 1.4x its target bitrate, to see where quality stops paying for bits.
//
//	go run ./cmd/ladder-quality -sweep content/showcase/licensed/bbb60-01.mp4
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/omadityaxd/reelplane/services/worker/internal/media"
)

type measurement struct {
	Rung       string  `json:"rung"`
	Size       string  `json:"size"`
	TargetKbps int     `json:"targetKbps"`
	ActualKbps int     `json:"actualKbps"`
	VMAFPhone  float64 `json:"vmafPhone"`
	SSIM       float64 `json:"ssim"`
}

type report struct {
	Source       string        `json:"source"`
	Display      string        `json:"display"`
	FrameRate    string        `json:"frameRate"`
	EvalSize     string        `json:"evaluatedAt"`
	Seconds      float64       `json:"seconds"`
	Preset       string        `json:"preset"`
	Measurements []measurement `json:"measurements"`
}

func main() {
	sweep := flag.Bool("sweep", false, "also try 0.35x, 0.6x and 1.4x of each rung's target bitrate")
	seconds := flag.Float64("seconds", 10, "seconds of the source to measure")
	preset := flag.String("preset", "veryfast", "x264 preset (the worker's default)")
	jsonOut := flag.String("json", "", "also write the report as JSON to this file")
	flag.Parse()
	if flag.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: ladder-quality [-sweep] [-seconds 10] <source>")
		os.Exit(2)
	}
	r, err := run(context.Background(), flag.Arg(0), *seconds, *preset, *sweep)
	if err != nil {
		fmt.Fprintln(os.Stderr, "ladder-quality:", err)
		os.Exit(1)
	}
	printMarkdown(r)
	if *jsonOut != "" {
		body, _ := json.MarshalIndent(r, "", "  ")
		if err := os.WriteFile(*jsonOut, append(body, '\n'), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, "write json:", err)
		}
	}
}

func run(ctx context.Context, source string, seconds float64, preset string, sweep bool) (*report, error) {
	abs, err := filepath.Abs(source)
	if err != nil {
		return nil, err
	}
	probe, err := media.ProbeFile(ctx, "ffprobe", abs)
	if err != nil {
		return nil, err
	}
	rate := media.OutputRate(probe)
	rungs := media.PlanLadder(probe.Width, probe.Height, rate.FPS)
	evalW, evalH := media.ScaleToShortSide(probe.Width, probe.Height, min(1080, min(probe.Width, probe.Height)))
	work, err := os.MkdirTemp("", "ladder-quality-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(work)

	r := &report{
		Source: filepath.Base(source), Display: fmt.Sprintf("%dx%d", probe.Width, probe.Height),
		FrameRate: rate.Expr, EvalSize: fmt.Sprintf("%dx%d", evalW, evalH),
		Seconds: math.Min(seconds, probe.Duration.Seconds()), Preset: preset,
	}
	factors := []float64{1}
	if sweep {
		factors = []float64{0.35, 0.6, 1, 1.4}
	}
	for _, rung := range rungs {
		for _, factor := range factors {
			kbps := int(math.Round(float64(rung.VideoKbps) * factor))
			fmt.Fprintf(os.Stderr, "%s @ %d kbps…\n", rung.Name, kbps)
			m, err := measure(ctx, work, abs, rung, kbps, rate, probe.IsHDR(), preset, r.Seconds, evalW, evalH)
			if err != nil {
				return nil, fmt.Errorf("%s @ %d kbps: %w", rung.Name, kbps, err)
			}
			r.Measurements = append(r.Measurements, m)
		}
	}
	return r, nil
}

func measure(ctx context.Context, work, source string, rung media.Rung, kbps int, rate media.Rate, hdr bool, preset string, seconds float64, evalW, evalH int) (measurement, error) {
	encoded := filepath.Join(work, fmt.Sprintf("%s-%d.mp4", rung.Name, kbps))
	gop := strconv.Itoa(int(math.Round(rate.FPS * media.SegmentSeconds)))
	prefix := ""
	if hdr {
		prefix = media.ToneMapFilter + ","
	}
	secs := strconv.FormatFloat(seconds, 'f', 3, 64)
	encode := []string{"-hide_banner", "-v", "error", "-y", "-t", secs, "-i", source,
		"-vf", fmt.Sprintf("%sfps=%s,scale=%d:%d:flags=bicubic,setsar=1", prefix, rate.Expr, rung.Width, rung.Height),
		"-c:v", "libx264", "-preset", preset, "-profile:v", rung.Profile, "-pix_fmt", "yuv420p",
		"-b:v", fmt.Sprintf("%dk", kbps), "-maxrate", fmt.Sprintf("%dk", kbps*11/10), "-bufsize", fmt.Sprintf("%dk", kbps*2),
		"-g", gop, "-keyint_min", gop, "-sc_threshold", "0", "-an", encoded}
	if out, err := exec.CommandContext(ctx, "ffmpeg", encode...).CombinedOutput(); err != nil {
		return measurement{}, fmt.Errorf("encode: %w: %s", err, out)
	}

	// libvmaf parses ':' inside log_path, so run in the work dir with a relative path.
	graph := fmt.Sprintf("[0:v]scale=%[1]d:%[2]d:flags=bicubic,setpts=PTS-STARTPTS[d];"+
		"[1:v]%[3]sfps=%[4]s,scale=%[1]d:%[2]d:flags=bicubic,setpts=PTS-STARTPTS[r];"+
		// The model value is quoted: inside -lavfi, FFmpeg unescapes twice, and an unquoted
		// "\:" never reaches libvmaf (it then rejects enable_transform, the phone model).
		"[d][r]libvmaf=model='version=vmaf_v0.6.1\\:enable_transform=true':feature=name=float_ssim:"+
		"n_threads=%[5]d:log_fmt=json:log_path=vmaf.json", evalW, evalH, prefix, rate.Expr, max(2, numCPU()))
	cmd := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-v", "error", "-i", encoded, "-t", secs, "-i", source,
		"-lavfi", graph, "-f", "null", "-")
	cmd.Dir = work
	if out, err := cmd.CombinedOutput(); err != nil {
		return measurement{}, fmt.Errorf("vmaf: %w: %s", err, out)
	}
	vmaf, ssim, err := readVMAFLog(filepath.Join(work, "vmaf.json"))
	if err != nil {
		return measurement{}, err
	}
	info, err := os.Stat(encoded)
	if err != nil {
		return measurement{}, err
	}
	return measurement{
		Rung: rung.Name, Size: fmt.Sprintf("%dx%d", rung.Width, rung.Height), TargetKbps: kbps,
		ActualKbps: int(float64(info.Size()) * 8 / seconds / 1000), VMAFPhone: round2(vmaf), SSIM: round4(ssim),
	}, nil
}

func readVMAFLog(path string) (vmaf, ssim float64, err error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, err
	}
	var log struct {
		Pooled map[string]struct {
			Mean float64 `json:"mean"`
		} `json:"pooled_metrics"`
	}
	if err := json.Unmarshal(raw, &log); err != nil {
		return 0, 0, err
	}
	return log.Pooled["vmaf"].Mean, log.Pooled["float_ssim"].Mean, nil
}

func printMarkdown(r *report) {
	fmt.Printf("\n%s — %s @ %s fps, %.0f s, VMAF phone model at %s, preset %s (%s)\n\n",
		r.Source, r.Display, r.FrameRate, r.Seconds, r.EvalSize, r.Preset, time.Now().Format("2006-01-02"))
	fmt.Println("| Rung | Size | Target kbps | Actual kbps | VMAF (phone) | SSIM |")
	fmt.Println("| --- | --- | --- | --- | --- | --- |")
	for _, m := range r.Measurements {
		fmt.Printf("| %s | %s | %d | %d | %.2f | %.4f |\n", m.Rung, m.Size, m.TargetKbps, m.ActualKbps, m.VMAFPhone, m.SSIM)
	}
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }
func round4(v float64) float64 { return math.Round(v*10000) / 10000 }

func numCPU() int {
	if n, err := strconv.Atoi(strings.TrimSpace(os.Getenv("NUMBER_OF_PROCESSORS"))); err == nil {
		return min(n, 8)
	}
	return 4
}
