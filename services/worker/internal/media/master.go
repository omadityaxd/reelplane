package media

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Variant is one EXT-X-STREAM-INF entry of a master playlist.
type Variant struct {
	Name             string // rendition folder, e.g. "720p"
	URI              string // e.g. "720p/index.m3u8"
	Attributes       string // the attribute list as FFmpeg wrote it
	Bandwidth        int    // peak bits/s, measured by FFmpeg
	AverageBandwidth int    // average bits/s, measured by FFmpeg
	Codecs           string
}

// Master playlist file names. Players that honour variant order (Safari / iOS native HLS
// starts on the FIRST variant) get the starting quality from the file they load.
const (
	MasterPlaylist    = "master.m3u8"     // starts at StartRung (720p or the best below)
	LowStartPlaylist  = "master_low.m3u8" // starts at the lowest rung, for slow networks
	streamInfPrefix   = "#EXT-X-STREAM-INF:"
	masterHeaderLines = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n"
)

var attributePattern = regexp.MustCompile(`([A-Z0-9-]+)=("[^"]*"|[^,]*)`)

// ParseMaster reads the variants of a master playlist (FFmpeg's output).
func ParseMaster(content string) ([]Variant, error) {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	var variants []Variant
	for i := 0; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(line, streamInfPrefix) {
			continue
		}
		uri := ""
		for i+1 < len(lines) && uri == "" {
			i++
			uri = strings.TrimSpace(lines[i])
		}
		if uri == "" || strings.HasPrefix(uri, "#") {
			return nil, fmt.Errorf("variant without URI after %q", line)
		}
		v := Variant{URI: uri, Name: path.Dir(uri), Attributes: strings.TrimPrefix(line, streamInfPrefix)}
		for _, match := range attributePattern.FindAllStringSubmatch(v.Attributes, -1) {
			switch match[1] {
			case "BANDWIDTH":
				v.Bandwidth, _ = strconv.Atoi(match[2])
			case "AVERAGE-BANDWIDTH":
				v.AverageBandwidth, _ = strconv.Atoi(match[2])
			case "CODECS":
				v.Codecs = strings.Trim(match[2], `"`)
			}
		}
		variants = append(variants, v)
	}
	if len(variants) == 0 {
		return nil, errors.New("master playlist has no variants")
	}
	return variants, nil
}

// RenderMaster writes a master playlist with `first` as the first variant and the rest in
// ascending bandwidth. FRAME-RATE is added (FFmpeg omits it; Apple's HLS spec requires it for
// video variants), so players know a 60 fps rendition is 60 fps before loading it.
func RenderMaster(variants []Variant, first string, fps float64) string {
	ordered := append([]Variant(nil), variants...)
	sort.SliceStable(ordered, func(i, j int) bool {
		if (ordered[i].Name == first) != (ordered[j].Name == first) {
			return ordered[i].Name == first
		}
		return ordered[i].Bandwidth < ordered[j].Bandwidth
	})
	var b strings.Builder
	b.WriteString(masterHeaderLines)
	for _, v := range ordered {
		attrs := v.Attributes
		if !strings.Contains(attrs, "FRAME-RATE=") && fps > 0 {
			attrs += fmt.Sprintf(",FRAME-RATE=%.3f", fps)
		}
		fmt.Fprintf(&b, "%s%s\n%s\n", streamInfPrefix, attrs, v.URI)
	}
	return b.String()
}

// WriteMasters replaces FFmpeg's master playlist in outDir with the two start orders and
// returns the parsed variants.
func WriteMasters(outDir string, rungs []Rung, rate Rate) ([]Variant, error) {
	raw, err := os.ReadFile(filepath.Join(outDir, MasterPlaylist))
	if err != nil {
		return nil, fmt.Errorf("read master playlist: %w", err)
	}
	variants, err := ParseMaster(string(raw))
	if err != nil {
		return nil, err
	}
	files := map[string]string{
		MasterPlaylist:   RenderMaster(variants, StartRung(rungs).Name, rate.FPS),
		LowStartPlaylist: RenderMaster(variants, rungs[0].Name, rate.FPS),
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(outDir, name), []byte(content), 0o644); err != nil {
			return nil, fmt.Errorf("write %s: %w", name, err)
		}
	}
	return variants, nil
}
