// Downloads clearly licensed open movies and cuts them into vertical (9:16) showcase clips.
// Reproducible: `node scripts/prepare-licensed-clips.mjs`. Media is gitignored; the license
// manifest (content/showcase/licenses.json) is committed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "content");
const downloads = join(root, "downloads");
const out = join(root, "showcase", "licensed");

const SOURCES = {
  sintel: {
    url: "https://download.blender.org/durian/trailer/sintel_trailer-1080p.mp4",
    file: "sintel_trailer-1080p.mp4",
    title: "Sintel",
    credit: "© copyright Blender Foundation | durian.blender.org",
    license: "CC BY 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
    homepage: "https://durian.blender.org/",
    // The trailer is 2.35:1 film letterboxed in 1920x1080 (found with ffmpeg cropdetect).
    picture: { y: 130, height: 818 },
  },
  bbb: {
    url: "https://download.blender.org/peach/trailer/trailer_1080p.mov",
    file: "bbb_trailer_1080p.mov",
    title: "Big Buck Bunny",
    credit: "© copyright 2008, Blender Foundation | www.bigbuckbunny.org",
    license: "CC BY 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
    homepage: "https://peach.blender.org/",
    picture: { y: 0, height: 1080 },
  },
};

// [source, start s, duration s, horizontal crop centre 0..1]
const CLIPS = [
  ["bbb", 1, 10, 0.5],
  ["bbb", 11, 10, 0.45],
  ["bbb", 21, 11, 0.55],
  ["sintel", 4, 12, 0.5],
  ["sintel", 17, 12, 0.4],
  ["sintel", 30, 12, 0.6],
];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

mkdirSync(downloads, { recursive: true });
mkdirSync(out, { recursive: true });

for (const source of Object.values(SOURCES)) {
  const path = join(downloads, source.file);
  if (!existsSync(path)) {
    process.stdout.write(`downloading ${source.url}\n`);
    execFileSync("curl", ["-sSfL", "-o", path, source.url], { stdio: "inherit" });
  }
  source.sha256 = sha256(path);
}

const manifest = CLIPS.map(([id, start, duration, centre], index) => {
  const source = SOURCES[id];
  const name = `${id}-${String(index + 1).padStart(2, "0")}.mp4`;
  // Vertical 9:16 window over the active picture (letterbox removed), native size, no upscaling.
  const { y, height } = source.picture;
  const width = Math.round((height * 9) / 16 / 2) * 2;
  const crop = `crop=${width}:${height}:(iw-${width})*${centre}:${y}`;
  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-ss",
      String(start),
      "-t",
      String(duration),
      "-i",
      join(downloads, source.file),
      "-vf",
      crop,
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      join(out, name),
    ],
    { stdio: "inherit" },
  );
  process.stdout.write(`wrote ${name}\n`);
  return {
    file: `licensed/${name}`,
    title: `${source.title} (excerpt ${start}s–${start + duration}s)`,
    creator: "Blender Foundation",
    credit: source.credit,
    license: source.license,
    licenseUrl: source.licenseUrl,
    source: source.url,
    sourceSha256: source.sha256,
    changes: `Excerpt ${start}s–${start + duration}s, cropped to 9:16 (${width}x${height}), re-encoded.`,
  };
});

const manifestPath = join(root, "showcase", "licenses.json");
const existing = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
const phone = existing.filter((entry) => entry.file.startsWith("phone/"));
writeFileSync(manifestPath, `${JSON.stringify([...manifest, ...phone], null, 2)}\n`);
process.stdout.write(`manifest: ${manifestPath}\n`);
