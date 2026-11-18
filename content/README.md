# Showcase content

The demo feed only plays videos whose license is recorded: the licensed clips in
[`showcase/licenses.json`](showcase/licenses.json) (committed), your own videos in
`showcase/phone/licenses.json` (local, gitignored with the rest of `showcase/phone/`). The media
files themselves are never committed.

| Folder               | What goes there                                                                    |
| -------------------- | ---------------------------------------------------------------------------------- |
| `showcase/phone/`    | Videos you recorded yourself (you own the copyright). Local only, never committed. |
| `showcase/licensed/` | Clips cut from openly licensed films by `node scripts/prepare-licensed-clips.mjs`. |
| `downloads/`         | The original licensed downloads (cache, never served).                             |

## Adding your phone videos

1. Copy the files (`.mov` or `.mp4`, up to 60 s and 100 MB each) into `content/showcase/phone/`.
2. Run `pnpm showcase:seed`. It uploads every file through the real API upload path; the worker
   transcodes them. Files you add get an entry in `showcase/phone/licenses.json` with license
   `"Owned by the project author"`, which you can edit afterwards.

Phone videos are for your local demo only: the bench and the production seed (`pnpm prod:seed`)
use just the licensed clips. In production the feed opens with the 1080p60 Big Buck Bunny clips
(`LEAD_CLIPS` in `scripts/seed-showcase.ts`).

## Licensed clips

- **Big Buck Bunny**: © copyright 2008, Blender Foundation | www.bigbuckbunny.org, licensed
  [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
- **Sintel**: © copyright Blender Foundation | durian.blender.org, licensed
  [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).

The demo shows each clip's credit and license on screen, as CC BY requires. Changes made: short
excerpts, cropped to 9:16 and re-encoded (recorded per clip in the manifest).
