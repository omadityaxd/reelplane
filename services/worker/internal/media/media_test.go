package media

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

const phoneProbe = `{
  "streams": [
    {"codec_type":"video","codec_name":"hevc","width":1920,"height":1080,
     "r_frame_rate":"30/1","avg_frame_rate":"2940/100",
     "side_data_list":[{"side_data_type":"Display Matrix","rotation":-90}]},
    {"codec_type":"audio","codec_name":"aac"}
  ],
  "format": {"duration":"14.533000"}
}`

func TestParseProbeHandlesPhoneRotationAndVariableFrameRate(t *testing.T) {
	p, err := ParseProbe([]byte(phoneProbe))
	if err != nil {
		t.Fatal(err)
	}
	if p.Width != 1080 || p.Height != 1920 || !p.IsVertical() {
		t.Errorf("display size = %dx%d, want 1080x1920 (rotation applied)", p.Width, p.Height)
	}
	if p.Rotation != -90 || p.CodedWidth != 1920 {
		t.Errorf("rotation=%d coded=%dx%d", p.Rotation, p.CodedWidth, p.CodedHeight)
	}
	if p.VariableFPS {
		t.Errorf("29.4 vs 30 fps is within tolerance, should not be VFR")
	}
	if !p.HasAudio || p.Duration != 14533*time.Millisecond {
		t.Errorf("audio=%v duration=%s", p.HasAudio, p.Duration)
	}
}

func TestParseProbeDetectsVariableFrameRate(t *testing.T) {
	raw := `{"streams":[{"codec_type":"video","width":720,"height":1280,"r_frame_rate":"60/1","avg_frame_rate":"24123/1000"}],"format":{"duration":"5"}}`
	p, err := ParseProbe([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if !p.VariableFPS || p.HasAudio {
		t.Errorf("vfr=%v audio=%v", p.VariableFPS, p.HasAudio)
	}
	if rate := OutputRate(p); rate.Expr != "24/1" {
		t.Errorf("output rate = %s, want 24/1 (VFR snapped to the nearest standard rate)", rate.Expr)
	}
}

func TestParseProbeReadsLegacyRotateTag(t *testing.T) {
	raw := `{"streams":[{"codec_type":"video","width":1280,"height":720,"r_frame_rate":"30/1","avg_frame_rate":"30/1","tags":{"rotate":"270"}}],"format":{"duration":"3"}}`
	p, _ := ParseProbe([]byte(raw))
	if p.Width != 720 || p.Height != 1280 {
		t.Errorf("display = %dx%d", p.Width, p.Height)
	}
}

func TestParseProbeRejectsFilesWithoutVideo(t *testing.T) {
	for name, raw := range map[string]string{
		"audio only":      `{"streams":[{"codec_type":"audio"}],"format":{"duration":"3"}}`,
		"cover art only":  `{"streams":[{"codec_type":"video","width":500,"height":500,"disposition":{"attached_pic":1}}],"format":{"duration":"3"}}`,
		"a still image":   `{"streams":[{"codec_type":"video","codec_name":"png","width":500,"height":500}],"format":{}}`,
		"not json at all": `garbage`,
	} {
		if _, err := ParseProbe([]byte(raw)); !IsInvalidInput(err) {
			t.Errorf("%s: err = %v, want InvalidInputError", name, err)
		}
	}
}

func TestValidate(t *testing.T) {
	limits := Limits{MaxDuration: 60 * time.Second, MaxSide: 4096, MinSide: 64}
	ok := Probe{Duration: 60200 * time.Millisecond, Width: 1080, Height: 1920}
	if err := ok.Validate(limits); err != nil {
		t.Errorf("60.2s should pass (container rounding tolerance): %v", err)
	}
	for name, p := range map[string]Probe{
		"too long":  {Duration: 61 * time.Second, Width: 1080, Height: 1920},
		"too small": {Duration: time.Second, Width: 32, Height: 32},
		"too large": {Duration: time.Second, Width: 4320, Height: 7680},
		"no length": {Width: 1080, Height: 1920},
	} {
		if err := p.Validate(limits); !IsInvalidInput(err) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

func TestPlanLadderNeverUpscales(t *testing.T) {
	cases := []struct {
		name          string
		width, height int
		want          []string
	}{
		{"1080p vertical phone", 1080, 1920, []string{"240p:240x426", "480p:480x854", "720p:720x1280", "1080p:1080x1920"}},
		{"720p vertical", 720, 1280, []string{"240p:240x426", "480p:480x854", "720p:720x1280"}},
		{"horizontal 1080p", 1920, 1080, []string{"240p:426x240", "480p:854x480", "720p:1280x720", "1080p:1920x1080"}},
		{"between rungs gets a native top rung", 600, 1066, []string{"240p:240x426", "480p:480x852", "600p:600x1066"}},
		{"Sintel crop (460x818)", 460, 818, []string{"240p:240x426", "460p:460x818"}},
		{"just above a rung: no extra rung", 520, 924, []string{"240p:240x426", "480p:480x852"}},
		{"tiny source", 201, 357, []string{"200p:200x356"}},
	}
	for _, tc := range cases {
		var got []string
		for _, rung := range PlanLadder(tc.width, tc.height, 30) {
			got = append(got, rung.Name+":"+strconv.Itoa(rung.Width)+"x"+strconv.Itoa(rung.Height))
			if rung.Width%2 != 0 || rung.Height%2 != 0 {
				t.Errorf("%s: odd dimensions %dx%d", tc.name, rung.Width, rung.Height)
			}
			if rung.Width > tc.width || rung.Height > tc.height {
				t.Errorf("%s: upscaled to %dx%d", tc.name, rung.Width, rung.Height)
			}
		}
		if strings.Join(got, ",") != strings.Join(tc.want, ",") {
			t.Errorf("%s: ladder = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestOutputRatePreservesSourceFrameRate(t *testing.T) {
	cases := []struct {
		name  string
		probe Probe
		want  string
	}{
		{"film 24", Probe{NominalRate: "24/1", FrameRate: 24}, "24/1"},
		{"NTSC 29.97 kept exact", Probe{NominalRate: "30000/1001", FrameRate: 29.97}, "30000/1001"},
		{"60 fps stays 60", Probe{NominalRate: "60/1", FrameRate: 60}, "60/1"},
		{"PAL 50", Probe{NominalRate: "50/1", FrameRate: 50}, "50/1"},
		{"phone VFR around 60", Probe{NominalRate: "600/1", FrameRate: 59.81, VariableFPS: true}, "60000/1001"},
		{"phone VFR around 30", Probe{NominalRate: "120/1", FrameRate: 29.4, VariableFPS: true}, "30000/1001"},
		{"240 fps slow-motion capture", Probe{NominalRate: "240/1", FrameRate: 240}, "60/1"},
		{"unknown", Probe{}, "30/1"},
	}
	for _, tc := range cases {
		if got := OutputRate(tc.probe); got.Expr != tc.want {
			t.Errorf("%s: OutputRate = %s, want %s", tc.name, got.Expr, tc.want)
		}
	}
}

func TestHighFrameRateRungsGetMoreBits(t *testing.T) {
	at30, at60 := PlanLadder(1080, 1920, 30), PlanLadder(1080, 1920, 60)
	for i := range at30 {
		if at60[i].VideoKbps <= at30[i].VideoKbps {
			t.Errorf("%s: 60 fps %d kbps should exceed 30 fps %d kbps", at30[i].Name, at60[i].VideoKbps, at30[i].VideoKbps)
		}
	}
}

func TestStartRungIs720pOrTheBestBelow(t *testing.T) {
	for _, tc := range []struct {
		w, h int
		want string
	}{{1080, 1920, "720p"}, {720, 1280, "720p"}, {608, 1080, "608p"}, {460, 818, "460p"}, {201, 357, "200p"}} {
		if got := StartRung(PlanLadder(tc.w, tc.h, 30)).Name; got != tc.want {
			t.Errorf("%dx%d: start = %s, want %s", tc.w, tc.h, got, tc.want)
		}
	}
}

const ffmpegMaster = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=563291,AVERAGE-BANDWIDTH=390913,RESOLUTION=240x426,CODECS="avc1.4d4015,mp4a.40.2"
240p/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=1433856,AVERAGE-BANDWIDTH=1199057,RESOLUTION=480x854,CODECS="avc1.4d401f,mp4a.40.2"
480p/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=3533856,AVERAGE-BANDWIDTH=3099057,RESOLUTION=720x1280,CODECS="avc1.64001f,mp4a.40.2"
720p/index.m3u8
`

func TestMasterPlaylistsStartOnTheRightVariant(t *testing.T) {
	variants, err := ParseMaster(ffmpegMaster)
	if err != nil || len(variants) != 3 {
		t.Fatalf("parse = %v, %v", variants, err)
	}
	if v := variants[2]; v.Name != "720p" || v.AverageBandwidth != 3099057 || v.Codecs != "avc1.64001f,mp4a.40.2" {
		t.Fatalf("variant = %+v", v)
	}
	master := RenderMaster(variants, "720p", 60)
	low := RenderMaster(variants, "240p", 60)
	firstURI := func(playlist string) string {
		lines := strings.Split(playlist, "\n")
		for i, line := range lines {
			if strings.HasPrefix(line, "#EXT-X-STREAM-INF:") {
				return lines[i+1]
			}
		}
		return ""
	}
	if firstURI(master) != "720p/index.m3u8" || firstURI(low) != "240p/index.m3u8" {
		t.Errorf("first variants: master %s, low %s", firstURI(master), firstURI(low))
	}
	if strings.Count(master, "FRAME-RATE=60.000") != 3 || strings.Count(master, "#EXT-X-STREAM-INF") != 3 {
		t.Errorf("master:\n%s", master)
	}
}

func TestHLSArgs(t *testing.T) {
	plan := EncodePlan{Input: "in.mp4", OutDir: "out", Rungs: PlanLadder(720, 1280, 30), Rate: Rate{"30/1", 30}, HasAudio: true, Preset: "veryfast"}
	args := strings.Join(HLSArgs(plan), " ")
	for _, want := range []string{
		"split=3",
		"scale=240:426",
		"-hls_segment_type fmp4",
		"-hls_time 2",
		"-g 60 -keyint_min 60 -sc_threshold 0",
		"-var_stream_map v:0,a:0,name:240p v:1,a:1,name:480p v:2,a:2,name:720p",
		"-preset veryfast",
		"-profile:v:0 main",
		"-profile:v:2 high",
		"-b:a:0 64k",
		"fps=30/1",
		"-color_trc bt709",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("args missing %q\n%s", want, args)
		}
	}

	if strings.Contains(args, "tonemap") {
		t.Error("an SDR source must not be tone-mapped")
	}
	plan.Rate, plan.HDR = Rate{"60/1", 60}, true
	hdr := strings.Join(HLSArgs(plan), " ")
	if !strings.Contains(hdr, "tonemap=tonemap=hable") || !strings.Contains(hdr, "fps=60/1") || !strings.Contains(hdr, "-g 120 -keyint_min 120") {
		t.Errorf("60 fps HDR args:\n%s", hdr)
	}

	plan.HasAudio = false
	silent := strings.Join(HLSArgs(plan), " ")
	if strings.Contains(silent, "0:a") || strings.Contains(silent, "-c:a") || !strings.Contains(silent, "v:0,name:240p") {
		t.Errorf("silent source should map no audio:\n%s", silent)
	}
}

func TestReadProgress(t *testing.T) {
	stream := "frame=10\nout_time_us=1000000\nprogress=continue\nout_time_us=bogus\nout_time_us=4000000\nprogress=end\n"
	var seen []float64
	readProgress(strings.NewReader(stream), 4*time.Second, func(p float64) { seen = append(seen, p) })
	if len(seen) != 2 || seen[0] != 0.25 || seen[1] != 1 {
		t.Errorf("progress = %v", seen)
	}
}

func TestHLSArgsThreadBudget(t *testing.T) {
	plan := EncodePlan{Input: "in.mp4", OutDir: "out", Rungs: PlanLadder(1080, 1920, 60), Rate: Rate{"60/1", 60}, Preset: "veryfast"}
	if args := strings.Join(HLSArgs(plan), " "); strings.Contains(args, "-threads") {
		t.Errorf("Threads 0 must leave FFmpeg's defaults:\n%s", args)
	}
	// 2 CPUs, 4 rungs: decode and filters get 2, each parallel encoder 1.
	plan.Threads = 2
	args := strings.Join(HLSArgs(plan), " ")
	for _, want := range []string{"-threads 2 -filter_complex_threads 2 -i in.mp4", "-threads:v:0 1", "-threads:v:3 1"} {
		if !strings.Contains(args, want) {
			t.Errorf("args missing %q\n%s", want, args)
		}
	}
	if got := encoderThreads(24, 4); got != 6 {
		t.Errorf("encoderThreads(24, 4) = %d, want 6", got)
	}
}
