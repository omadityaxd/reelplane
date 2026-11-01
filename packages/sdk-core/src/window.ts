/**
 * The preload window: which feed items get a live <video> element, and what each one does.
 *
 * While item N plays, N+1 and N+2 load their playlist and first segment so a swipe starts
 * instantly, and N-1 stays loaded so swiping back is instant too. Everything else is
 * released, which bounds memory and data use no matter how long the feed is.
 */
export interface WindowOptions {
  /** Items after the active one to preload (default 2). 0 disables preloading. */
  ahead: number;
  /** Items before the active one to keep loaded (default 1). */
  behind: number;
}

export const DEFAULT_WINDOW: WindowOptions = { ahead: 2, behind: 1 };

export type SlotRole = "play" | "preload" | "keep";

export interface WindowPlan {
  /** Index → role for every item that should hold a video element. */
  roles: Map<number, SlotRole>;
}

export function planWindow(
  active: number,
  total: number,
  options: WindowOptions = DEFAULT_WINDOW,
): WindowPlan {
  const roles = new Map<number, SlotRole>();
  if (total <= 0 || active < 0 || active >= total) return { roles };
  roles.set(active, "play");
  for (let i = 1; i <= options.ahead && active + i < total; i += 1)
    roles.set(active + i, "preload");
  for (let i = 1; i <= options.behind && active - i >= 0; i += 1) roles.set(active - i, "keep");
  return { roles };
}

/** Number of video elements the pool needs for these options. */
export function poolSize(options: WindowOptions = DEFAULT_WINDOW): number {
  return 1 + options.ahead + options.behind;
}

/**
 * Assigns items to a fixed pool of slots. A slot already holding a wanted item keeps it (no
 * reload); freed slots take the remaining items. Returns slot → item index (or null = idle).
 */
export function assignSlots(
  current: readonly (number | null)[],
  plan: WindowPlan,
): (number | null)[] {
  const wanted = new Set(plan.roles.keys());
  const next: (number | null)[] = current.map((index) =>
    index !== null && wanted.has(index) ? index : null,
  );
  const placed = new Set(next.filter((index): index is number => index !== null));
  // Fill free slots in priority order: the playing item first, then preloads, then kept.
  const order = [...plan.roles.entries()]
    .sort(([, a], [, b]) => rank(a) - rank(b))
    .map(([index]) => index)
    .filter((index) => !placed.has(index));
  for (let slot = 0; slot < next.length && order.length > 0; slot += 1) {
    if (next[slot] === null) next[slot] = order.shift() ?? null;
  }
  return next;
}

function rank(role: SlotRole): number {
  return role === "play" ? 0 : role === "preload" ? 1 : 2;
}
