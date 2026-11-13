package media

import (
	"errors"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestParseProbeFallsBackToTheStreamDuration(t *testing.T) {
	for name, tc := range map[string]struct {
		raw  string
		want time.Duration
	}{
		"stream duration": {
			`{"streams":[{"codec_type":"video","width":720,"height":1280,"r_frame_rate":"30/1","duration":"7.250000"}],"format":{}}`,
			7250 * time.Millisecond,
		},
		"matroska DURATION tag": {
			`{"streams":[{"codec_type":"video","width":720,"height":1280,"r_frame_rate":"30/1","tags":{"DURATION":"00:01:02.500000000"}}],"format":{"duration":"N/A"}}`,
			62500 * time.Millisecond,
		},
		"container wins": {
			`{"streams":[{"codec_type":"video","width":720,"height":1280,"r_frame_rate":"30/1","duration":"9"}],"format":{"duration":"4"}}`,
			4 * time.Second,
		},
		"nothing usable": {
			`{"streams":[{"codec_type":"video","width":720,"height":1280,"r_frame_rate":"30/1","duration":"NaN","tags":{"DURATION":"bogus"}}],"format":{}}`,
			0,
		},
	} {
		p, err := ParseProbe([]byte(tc.raw))
		if err != nil || p.Duration != tc.want {
			t.Errorf("%s: duration = %s, %v; want %s", name, p.Duration, err, tc.want)
		}
	}
}

func TestParseProbeRemembersWhichVideoStreamItChose(t *testing.T) {
	// Cover art is a video stream too: FFmpeg's plain [0:v] would encode the album cover.
	raw := `{"streams":[
	  {"codec_type":"video","codec_name":"mjpeg","width":600,"height":600,"disposition":{"attached_pic":1}},
	  {"codec_type":"audio","codec_name":"aac"},
	  {"codec_type":"video","codec_name":"h264","width":720,"height":1280,"r_frame_rate":"30/1"}],
	  "format":{"duration":"3"}}`
	p, err := ParseProbe([]byte(raw))
	if err != nil || p.VideoStream != 1 || p.Width != 720 {
		t.Fatalf("probe = %+v, %v; want video stream 1 (720 wide)", p, err)
	}
	args := strings.Join(HLSArgs(EncodePlan{Input: "in", OutDir: "out", Rungs: PlanLadder(720, 1280, 30),
		Rate: Rate{"30/1", 30}, VideoStream: p.VideoStream, Preset: "veryfast"}), " ")
	if !strings.Contains(args, "[0:v:1]") {
		t.Errorf("encode must read the probed stream:\n%s", args)
	}
}

func TestParsePacketEnd(t *testing.T) {
	csv := "0.000000,0.033000\nN/A,0.033000\n1.933000,0.033000\n1.967000,0.033000\n\n"
	if got := ParsePacketEnd([]byte(csv)); got != 2*time.Second {
		t.Errorf("end = %s, want 2s", got)
	}
	if got := ParsePacketEnd([]byte("N/A,N/A\n")); got != 0 {
		t.Errorf("no timestamps: end = %s, want 0", got)
	}
}

func TestEveryFFmpegInputIsGuarded(t *testing.T) {
	args := strings.Join(HLSArgs(EncodePlan{Input: "in", OutDir: "out", Rungs: PlanLadder(720, 1280, 30), Rate: Rate{"30/1", 30}, Preset: "veryfast"}), " ")
	guard := strings.Join(InputGuard, " ")
	if !strings.Contains(args, guard+" -i in") {
		t.Errorf("the encode's input is not guarded:\n%s", args)
	}
}

func TestClassifyFailure(t *testing.T) {
	failed := errors.New("exit status 1")
	for _, tc := range []struct {
		stderr    string
		permanent bool
	}{
		{"[mov,mp4,m4a,3gp,3g2,mj2 @ 0x1] moov atom not found\nsource: Invalid data found when processing input", true},
		{"[in#0 @ 0x1] Error opening input: Invalid data found when processing input", true},
		{"[h264 @ 0x1] Invalid NAL unit size (1234 > 99).\nError while decoding stream #0:0: Invalid data found when processing input", true},
		{"[concat @ 0x1] Format not on whitelist 'mov,matroska'", true},
		{"[hls @ 0x1] Failed to open file 'out/240p/seg_003.m4s': No space left on device", false},
		{"Error while decoding stream #0:0\nav_malloc: Cannot allocate memory", false},
		{"[aost#0:1/aac @ 0x1] Error submitting audio frame to the encoder", false},
		{"", false},
	} {
		err := ClassifyFailure(failed, tc.stderr)
		if IsInvalidInput(err) != tc.permanent {
			t.Errorf("%q: permanent = %v, want %v (%v)", tc.stderr, IsInvalidInput(err), tc.permanent, err)
		}
		if !tc.permanent && !errors.Is(err, failed) {
			t.Errorf("%q: a retryable failure must wrap the original error", tc.stderr)
		}
	}
}

func TestAProcessKilledBySignalIsRetryable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("signals: Unix only")
	}
	cmd := exec.Command("sh", "-c", "kill -9 $$")
	err := cmd.Run()
	if err == nil {
		t.Fatal("expected the shell to be killed")
	}
	if got := ClassifyFailure(err, "Invalid data found when processing input"); IsInvalidInput(got) {
		t.Errorf("an OOM-killed FFmpeg must be retried, got %v", got)
	}
}
