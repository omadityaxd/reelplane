# Showcase content

The demo feed only plays videos whose license is recorded in
[`showcase/licenses.json`](showcase/licenses.json). The media files themselves are gitignored.

| Folder               | What goes there                                                                    |
| -------------------- | ---------------------------------------------------------------------------------- |
| `showcase/phone/`    | Videos you recorded yourself (you own the copyright).                              |
| `showcase/licensed/` | Clips cut from openly licensed films by `node scripts/prepare-licensed-clips.mjs`. |
| `downloads/`         | The original licensed downloads (cache, never served).                             |

## Adding your phone videos

1. Copy the files (`.mov` or `.mp4`, up to 60 s and 100 MB each) into `content/showcase/phone/`.
2. Run `pnpm showcase:seed`. It uploads every file through the real API upload path; the worker
   transcodes them. Files you add get a manifest entry with license
   `"Owned by the project author"`, which you can edit afterwards.

## Licensed clips

- **Big Buck Bunny**: © copyright 2008, Blender Foundation | www.bigbuckbunny.org, licensed
  [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
- **Sintel**: © copyright Blender Foundation | durian.blender.org, licensed
  [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).

The demo shows each clip's credit and license on screen, as CC BY requires. Changes made: short
excerpts, cropped to 9:16 and re-encoded (recorded per clip in the manifest).
