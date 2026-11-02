"use client";

import {
  FeedController,
  type FeedControllerOptions,
  type FeedItem,
  type FeedName,
  type FeedState,
  type PlaybackMetric,
} from "@reelplane/sdk-core";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DebugOverlay } from "./DebugOverlay.tsx";
import { STYLES } from "./styles.ts";

export interface ReelFeedProps {
  /** Your project's publishable key (`rp_pk_…`). Safe in the browser. */
  publishableKey: string;
  /** `trending` (default), `latest`, or `creator:<id>`. */
  feed?: FeedName;
  /** Where the Reelplane API lives (default: this page's origin). */
  apiBaseUrl?: string;
  /** Preload upcoming videos for instant swipe-to-play (default true). */
  preload?: boolean;
  pageSize?: number;
  /** Start muted (default true; browsers only autoplay muted video). */
  muted?: boolean;
  /** Called with every playback metric (time to first frame, rebuffers, watch time…). */
  onMetric?: (metric: PlaybackMetric) => void;
  /** Called when the visible video changes. */
  onActiveChange?: (item: FeedItem, index: number) => void;
  /** Replace the default title/credit overlay. */
  renderOverlay?: (item: FeedItem, index: number) => ReactNode;
  /** Show live playback details (rendition, bitrate, fps, buffer, dropped frames). */
  debug?: boolean;
  /** Advanced controller options (benchmarks use `urlTransform` and `sendMetrics`). */
  controllerOptions?: Partial<FeedControllerOptions>;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
}

/** Visible fraction at which an item becomes the active one. */
const ACTIVE_THRESHOLD = 0.6;

function useController(props: ReelFeedProps): FeedController | null {
  const [controller, setController] = useState<FeedController | null>(null);
  const {
    publishableKey,
    feed,
    apiBaseUrl,
    preload,
    pageSize,
    muted,
    onMetric,
    controllerOptions,
  } = props;
  const onMetricRef = useRef(onMetric);
  onMetricRef.current = onMetric;
  // Read when a controller is created; changing them later must not rebuild the feed.
  const initial = useRef({ muted, controllerOptions });
  useEffect(() => {
    const next = new FeedController({
      apiBaseUrl: apiBaseUrl ?? window.location.origin,
      publishableKey,
      feed: feed ?? "trending",
      preload: preload ?? true,
      pageSize: pageSize ?? 10,
      muted: initial.current.muted ?? true,
      onMetric: (metric) => onMetricRef.current?.(metric),
      ...initial.current.controllerOptions,
    });
    setController(next);
    return () => next.destroy();
  }, [publishableKey, feed, apiBaseUrl, preload, pageSize]);
  // A changed `muted` prop is applied to the running feed.
  useEffect(() => {
    if (controller && muted !== undefined) controller.setMuted(muted);
  }, [controller, muted]);
  return controller;
}

function useFeedState(controller: FeedController | null): FeedState | null {
  const [state, setState] = useState<FeedState | null>(null);
  useEffect(() => {
    if (!controller) return;
    setState(controller.getState());
    return controller.subscribe(setState);
  }, [controller]);
  return state;
}

/**
 * A vertical, swipeable short-video feed. Swipe, scroll-wheel or arrow keys to move; tap to
 * pause; `m` to toggle sound. Fills its parent: give the parent a height (e.g. `100dvh`).
 */
export function ReelFeed(props: ReelFeedProps) {
  const controller = useController(props);
  const state = useFeedState(controller);
  const scroller = useRef<HTMLDivElement>(null);
  const videos = useRef<HTMLVideoElement[]>([]);
  const [announcement, setAnnouncement] = useState("");

  // Hand the video pool to the controller, then start the feed.
  useEffect(() => {
    if (!controller) return;
    controller.attach(videos.current.slice(0, controller.slotCount));
    void controller.start();
  }, [controller]);

  useActiveItemObserver(scroller, controller, state?.items.length ?? 0);

  const { onActiveChange } = props;
  const activeIndex = state?.activeIndex ?? -1;
  const activeItem = state?.items[activeIndex];
  useEffect(() => {
    if (activeItem) onActiveChange?.(activeItem, activeIndex);
  }, [activeItem, activeIndex, onActiveChange]);

  const go = useCallback((delta: number) => {
    const el = scroller.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ top: delta * el.clientHeight, behavior: reduced ? "auto" : "smooth" });
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!controller) return;
    const key = event.key;
    if (key === "ArrowDown" || key === "PageDown" || key === "j") go(1);
    else if (key === "ArrowUp" || key === "PageUp" || key === "k") go(-1);
    else if (key === " " || key === "Enter") {
      controller.togglePause();
      setAnnouncement(controller.getState().paused ? "Paused" : "Playing");
    } else if (key === "m") controller.setMuted(!controller.getState().muted);
    else return;
    event.preventDefault();
  };

  const slotCount = controller?.slotCount ?? 0;
  const items = state?.items ?? [];

  return (
    <section
      className={`rp-feed ${props.className ?? ""}`}
      style={props.style}
      aria-roledescription="video feed"
      aria-label={props["aria-label"] ?? "Video feed"}
      // A scrollable region must be keyboard-reachable (WCAG 2.1.1, axe scrollable-region-focusable);
      // it handles arrow keys, Space and "m" itself.
      // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable scroll region, see above
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <style>{STYLES}</style>
      <div ref={scroller} className="rp-scroller" role="feed" aria-busy={state?.loading ?? true}>
        {/* Explicit geometry: the track is `items.length` viewports tall, so slides and the
            video pool can be positioned in percentages of it. */}
        <div className="rp-track" style={{ height: `${Math.max(items.length, 1) * 100}%` }}>
          {items.map((item, index) => (
            <FeedSlide
              key={item.id}
              item={item}
              index={index}
              total={items.length}
              active={index === activeIndex}
              overlay={props.renderOverlay?.(item, index)}
              onTap={() => {
                controller?.togglePause();
                setAnnouncement(controller?.getState().paused ? "Paused" : "Playing");
              }}
            />
          ))}
          {/* The recycled video pool: each element is moved to the item it currently serves. */}
          {Array.from({ length: slotCount }, (_, slot) => {
            const index = state?.slots[slot] ?? null;
            return (
              <video
                // biome-ignore lint/suspicious/noArrayIndexKey: slots are a fixed pool by position
                key={slot}
                ref={(el) => {
                  if (el) videos.current[slot] = el;
                }}
                className="rp-video"
                data-idle={index === null}
                data-index={index ?? undefined}
                // Percentages of the track, which is `items.length` viewports tall.
                style={{
                  top: `${((index ?? 0) * 100) / Math.max(items.length, 1)}%`,
                  height: `${100 / Math.max(items.length, 1)}%`,
                }}
                muted
                playsInline
                tabIndex={-1}
                aria-hidden="true"
              />
            );
          })}
        </div>
        {state && !state.loading && items.length === 0 && (
          <div className="rp-empty">{state.error ?? "No videos yet."}</div>
        )}
      </div>
      {state && activeItem && (
        <Controls
          state={state}
          onToggleMute={() => controller?.setMuted(!state.muted)}
          onPrevious={() => go(-1)}
          onNext={() => go(1)}
        />
      )}
      {props.debug && controller && <DebugOverlay controller={controller} />}
      <p className="rp-sr-only" aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}

/** Sets the active item when one is at least 60% visible (scroll-snap settles there). */
function useActiveItemObserver(
  scroller: React.RefObject<HTMLDivElement | null>,
  controller: FeedController | null,
  count: number,
) {
  useEffect(() => {
    const root = scroller.current;
    if (!root || !controller || count === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= ACTIVE_THRESHOLD) {
            const index = Number((entry.target as HTMLElement).dataset.index);
            if (Number.isInteger(index) && controller.getState().activeIndex !== -1)
              controller.setActive(index);
          }
        }
      },
      { root, threshold: [ACTIVE_THRESHOLD] },
    );
    for (const item of root.querySelectorAll<HTMLElement>(".rp-item")) observer.observe(item);
    return () => observer.disconnect();
  }, [scroller, controller, count]);
}

interface FeedSlideProps {
  item: FeedItem;
  index: number;
  total: number;
  active: boolean;
  overlay: ReactNode;
  onTap: () => void;
}

function FeedSlide({ item, index, total, active, overlay, onTap }: FeedSlideProps) {
  const credit = typeof item.metadata.credit === "string" ? item.metadata.credit : null;
  const license = typeof item.metadata.license === "string" ? item.metadata.license : null;
  // Each slide is exactly one viewport: 1/total of the track (see the track's height).
  const style = useMemo(
    () => ({
      height: `${100 / Math.max(total, 1)}%`,
      ...(item.playback.placeholder
        ? { backgroundImage: `url("${item.playback.placeholder}")` }
        : {}),
    }),
    [item.playback.placeholder, total],
  );
  return (
    <article
      className="rp-item"
      data-index={index}
      style={style}
      aria-posinset={index + 1}
      aria-setsize={total}
      aria-label={item.title ?? `Video ${index + 1}`}
      aria-current={active ? "true" : undefined}
    >
      {item.playback.posterUrl && (
        <img
          className="rp-poster"
          src={item.playback.posterUrl}
          alt=""
          loading={index < 3 ? "eager" : "lazy"}
          decoding="async"
        />
      )}
      <button
        type="button"
        className="rp-tap"
        aria-label={active ? "Pause or play" : `Play ${item.title ?? "video"}`}
        onClick={onTap}
      />
      <div className="rp-overlay">
        {overlay ?? (
          <>
            {item.title && <p className="rp-title">{item.title}</p>}
            {(credit || license) && (
              <p className="rp-credit">{[credit, license].filter(Boolean).join(" · ")}</p>
            )}
          </>
        )}
      </div>
    </article>
  );
}

interface ControlsProps {
  state: FeedState;
  onToggleMute: () => void;
  onPrevious: () => void;
  onNext: () => void;
}

function Controls({ state, onToggleMute, onPrevious, onNext }: ControlsProps) {
  return (
    <>
      {(state.paused || state.needsGesture) && (
        <div className="rp-status" aria-hidden="true">
          <span className="rp-status-badge">{state.needsGesture ? "Tap to play" : "Paused"}</span>
        </div>
      )}
      <div className="rp-controls">
        <button
          type="button"
          className="rp-button"
          aria-label={state.muted ? "Unmute" : "Mute"}
          aria-pressed={!state.muted}
          onClick={onToggleMute}
        >
          {state.muted ? <MutedIcon /> : <SoundIcon />}
        </button>
        <button
          type="button"
          className="rp-button"
          aria-label="Previous video"
          onClick={onPrevious}
          disabled={state.activeIndex <= 0}
        >
          <ChevronIcon up />
        </button>
        <button
          type="button"
          className="rp-button"
          aria-label="Next video"
          onClick={onNext}
          disabled={state.activeIndex >= state.items.length - 1}
        >
          <ChevronIcon />
        </button>
      </div>
    </>
  );
}

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  "aria-hidden": true,
} as const;

function MutedIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M11 5 6 9H2v6h4l5 4V5Z" />
      <path d="m22 9-6 6M16 9l6 6" />
    </svg>
  );
}

function SoundIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M11 5 6 9H2v6h4l5 4V5Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
    </svg>
  );
}

function ChevronIcon({ up = false }: { up?: boolean }) {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d={up ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6"} />
    </svg>
  );
}
