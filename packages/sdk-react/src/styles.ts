/**
 * Component styles, injected once per page. Everything is themeable through CSS custom
 * properties on the feed (or any ancestor):
 *
 *   --rp-background   letterbox colour around the phone-width column (desktop)
 *   --rp-foreground   overlay text
 *   --rp-accent       focus ring and active controls
 *   --rp-font         overlay font stack
 *   --rp-radius       control corner radius
 */
export const STYLES = `
.rp-feed {
  --rp-background: #f4f4f5;
  --rp-foreground: #ffffff;
  --rp-accent: #ff3d6e;
  --rp-font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --rp-radius: 999px;
  position: relative;
  height: 100%;
  width: 100%;
  background: var(--rp-background);
  font-family: var(--rp-font);
  color: var(--rp-foreground);
}
@media (prefers-color-scheme: dark) {
  .rp-feed { --rp-background: #09090b; }
}
.rp-feed:focus-visible { outline: none; }
.rp-feed:focus-visible .rp-scroller { box-shadow: 0 0 0 3px var(--rp-accent); }
.rp-scroller {
  position: relative;
  height: 100%;
  /* Phone-width column on desktop, full screen on phones. */
  width: min(100%, calc(100dvh * 9 / 16));
  max-width: 100%;
  margin: 0 auto;
  overflow-y: scroll;
  overscroll-behavior: contain;
  scroll-snap-type: y mandatory;
  scrollbar-width: none;
  background: #000;
  -webkit-overflow-scrolling: touch;
}
.rp-scroller::-webkit-scrollbar { display: none; }
.rp-track { position: relative; }
.rp-item {
  position: relative;
  scroll-snap-align: start;
  scroll-snap-stop: always;
  overflow: hidden;
  background: #000 center / cover no-repeat;
}
.rp-poster { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
/* Stacking inside the track: poster < video (z 0) < tap target (z 1) < overlay text (z 2).
   The video pool comes after the slides in the DOM, so without explicit z-indexes it would
   paint over every slide's title and credit. */
.rp-video {
  position: absolute;
  z-index: 0;
  left: 0;
  width: 100%;
  object-fit: cover;
  background: transparent;
  pointer-events: none;
}
.rp-video[data-idle="true"] { visibility: hidden; }
.rp-overlay {
  position: absolute;
  inset: auto 0 0 0;
  padding: 48px 16px calc(20px + env(safe-area-inset-bottom));
  background: linear-gradient(to top, rgb(0 0 0 / 0.65), transparent);
  pointer-events: none;
  z-index: 2;
  text-shadow: 0 1px 2px rgb(0 0 0 / 0.6);
}
.rp-title { margin: 0 56px 4px 0; font-size: 15px; font-weight: 600; line-height: 1.3; }
.rp-credit { margin: 0 56px 0 0; font-size: 12px; opacity: 0.85; line-height: 1.35; }
.rp-controls {
  position: absolute;
  right: 12px;
  bottom: calc(24px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 12px;
  z-index: 2;
}
.rp-button {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: var(--rp-radius);
  background: rgb(0 0 0 / 0.45);
  color: var(--rp-foreground);
  font: 600 12px var(--rp-font);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.rp-button:focus-visible { outline: 3px solid var(--rp-accent); outline-offset: 2px; }
.rp-button[aria-pressed="true"] { color: var(--rp-accent); }
.rp-button svg { width: 22px; height: 22px; }
.rp-status {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
  z-index: 1;
}
.rp-status-badge {
  padding: 10px 16px;
  border-radius: var(--rp-radius);
  background: rgb(0 0 0 / 0.55);
  font-size: 14px;
  font-weight: 600;
}
.rp-tap { position: absolute; inset: 0; z-index: 1; background: transparent; border: 0; cursor: pointer; }
.rp-empty { display: grid; place-items: center; height: 100%; padding: 24px; text-align: center; color: #d4d4d8; }
.rp-sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
@media (prefers-reduced-motion: reduce) {
  .rp-scroller { scroll-behavior: auto; }
}
`;
