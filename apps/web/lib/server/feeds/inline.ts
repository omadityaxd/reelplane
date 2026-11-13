import type { ObjectStorage } from "@reelplane/storage";

/**
 * The first video of a feed costs four sequential requests before a frame: master playlist,
 * variant playlist, init segment, first segment. The feed response already sits on that path,
 * so it carries the two playlists, and the player (hls.js) only has to fetch the segments.
 *
 * Playlists are immutable (every attempt publishes under its own prefix), so they are cached
 * in memory for good, bounded by MAX_ENTRIES.
 */
const MAX_ENTRIES = 500;
const cache = new Map<string, Record<string, string>>();

/** The master playlist's first variant URI (the one players start on). */
export function firstVariantUri(master: string): string | null {
  const lines = master.split(/\r?\n/).map((line) => line.trim());
  const at = lines.findIndex((line) => line.startsWith("#EXT-X-STREAM-INF"));
  if (at < 0) return null;
  return lines.slice(at + 1).find((line) => line !== "" && !line.startsWith("#")) ?? null;
}

async function text(storage: ObjectStorage, key: string): Promise<string | null> {
  const body = await storage.getObject(key);
  return body ? new TextDecoder().decode(body) : null;
}

/**
 * `{ publicUrl: playlist }` for a master playlist and its first variant, or null when either is
 * missing (the player then fetches them as usual).
 */
export async function inlinePlaylists(
  storage: ObjectStorage,
  masterKey: string,
): Promise<Record<string, string> | null> {
  const cached = cache.get(masterKey);
  if (cached) return cached;
  const master = await text(storage, masterKey);
  const variant = master ? firstVariantUri(master) : null;
  if (!master || !variant || /^[a-z]+:/i.test(variant) || variant.startsWith("/")) return null;
  const variantKey = `${masterKey.slice(0, masterKey.lastIndexOf("/") + 1)}${variant}`;
  const variantPlaylist = await text(storage, variantKey);
  if (!variantPlaylist) return null;
  const playlists = {
    [storage.publicUrl(masterKey)]: master,
    [storage.publicUrl(variantKey)]: variantPlaylist,
  };
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value ?? "");
  cache.set(masterKey, playlists);
  return playlists;
}
