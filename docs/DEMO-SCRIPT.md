# 60-second demo video

**What it shows:**

1. The feed is instant on a real phone.
2. An upload becomes an adaptive stream.
3. The queue survives workers being killed.
4. It's a few lines of code to use.

**How to make it:** record short clips, then cut them together. Captions, not voiceover, so
the video works muted on LinkedIn and GitHub. Every number in a caption is from
[BENCHMARKS.md](BENCHMARKS.md).

## Before recording

- [ ] `pnpm infra:up`, then `pnpm phone`: the worker, demo videos and app, plus the URL for your
      phone.
- [ ] Your **original** phone clips are in `content/showcase/phone/` and seeded, not
      copies recompressed by a messaging app. They lead the feed and show the 1080p/60 fps ladder.
- [ ] One extra phone clip under 60 s, **not** seeded, kept on the laptop for the upload shot.
- [ ] Phone: Do Not Disturb on, brightness up, sound on. Screen recording on (iOS Control
      Centre → Screen Recording; long-press it to turn the microphone off).
- [ ] Laptop: a 1920×1080 window, a clean browser profile (no bookmarks bar), terminal font 18+,
      OBS or the Xbox Game Bar (Win+Alt+R) for the screen.
- [ ] A second terminal ready with `pnpm worker:chaos -jobs 30 -workers 3 -seed 7`.
      30 jobs keeps it under a minute.
- [ ] Dashboard signed in. Locally that's no sign-in, or `REELPLANE_TEST_AUTH=1`: sign in with
      GitHub as your own login.

## Shots

| Time    | On screen                                                                                                                                                                                                                                                                 | Caption                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 0–6 s   | **Phone, full screen:** swipe through 5–6 videos quickly, each starting the instant it lands. Start on one of your own clips.                                                                                                                                             | "Swipe → playing in 35 ms."                                            |
| 6–12 s  | **Phone, `/?debug=1`:** pause on one video with the overlay visible (rendition, fps shown/encoded, buffer, stalls 0), then swipe once.                                                                                                                                    | "Adaptive HLS ladder, frame rate kept, 0 stalls."                      |
| 12–24 s | **Laptop, dashboard → project → Videos:** Upload a video, pick the clip, watch the progress bar, land on the video page. Let the timeline tick through _Upload complete_ → _Attempt 1 started_ → _Transcoded_ → _Ready_, then press play in the preview.                  | "Upload straight to storage → Go/FFmpeg worker → ready."               |
| 24–28 s | **Same page:** scroll to the **Renditions** table (240p … native, fps column).                                                                                                                                                                                            | "One decode, every rung, 2 s CMAF segments."                           |
| 28–42 s | **Terminal:** run the chaos command. Let the `done … · kills …` progress lines scroll, then hold on the report: `Chaos test: PASS`, `jobs succeeded 30 / 30`, `videos completed exactly once 30 / 30`, `orphaned objects from losing attempts 0`. Speed up the middle 2×. | "Workers killed mid-encode. Every video still published exactly once." |
| 42–48 s | **Dashboard → Webhooks:** the delivery log with `video.ready` → 200, then **Analytics** with the TTFF p50/p95 tiles and the chart.                                                                                                                                        | "Signed webhooks. Real playback analytics."                            |
| 48–55 s | **Editor:** the 8-line `<ReelFeed publishableKey=… />` snippet from the README, zoomed.                                                                                                                                                                                   | "Drop-in React component."                                             |
| 55–60 s | **End card:** the repo URL, `npm i @reelplane/sdk-react`, three numbers: "35 ms swipe-to-play · 100/100 exactly-once under chaos · Lighthouse 96".                                                                                                                        | "Open source · runs on free tiers."                                    |

## Tips

- **Record each shot two or three times** and keep the cleanest. Cut on the swipe, so the next
  shot starts mid-motion.
- **The timeline shot is the slowest part:** a 10–15 s clip transcodes in a few seconds on the
  laptop, so it fits. If it lingers, cut from _Attempt 1 started_ straight to _Ready_.
- **If anything stalls** while recording the feed, rerun with `?debug=1` and check the overlay
  before re-recording.
- **Export:** 1080×1920 for Reels/Shorts. For LinkedIn and the README GIF, 1920×1080 with the
  phone shots centred on a dark background. Make the README GIF from the first 12 seconds at
  480 px wide with `gifski`, under 5 MB, and save it as `docs/demo.gif`; the README already
  points there.
- **Captions:** a short phrase, on screen for at least 2 s, in the lower third, kept clear of
  the feed's own title overlay.
