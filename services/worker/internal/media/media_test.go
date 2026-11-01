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
	if fps := TargetFPS(p.FrameRate); fps != 24 {
		t.Errorf("target fps = %d, want 24", fps)
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
		{"between rungs", 600, 1066, []string{"240p:240x426", "480p:480x852"}},
		{"tiny source", 201, 357, []string{"200p:200x356"}},
	}
	for _, tc := range cases {
		var got []string
		for _, rung := range PlanLadder(tc.width, tc.height) {
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

func TestTargetFPSCapsAt30(t *testing.T) {
	for source, want := range map[float64]int{60: 30, 59.94: 30, 29.97: 30, 25: 25, 24: 24, 0: 30} {
		if got := TargetFPS(source); got != want {
			t.Errorf("TargetFPS(%v) = %d, want %d", source, got, want)
		}
	}
}

func TestHLSArgs(t *testing.T) {
	plan := EncodePlan{Input: "in.mp4", OutDir: "out", Rungs: PlanLadder(720, 1280), FPS: 30, HasAudio: true, Preset: "veryfast"}
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
	} {
		if !strings.Contains(args, want) {
			t.Errorf("args missing %q\n%s", want, args)
		}
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
