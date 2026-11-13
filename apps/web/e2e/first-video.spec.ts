import { expect, test } from "@playwright/test";

/**
 * The feed's first page carries the first video's master and starting variant playlists, so
 * the browser (hls.js) goes straight to the segments: neither playlist is requested, and the
 * video still plays. (/bench fetches its first page in the browser, like an SDK user would.)
 */
test("the first video plays without requesting the playlists the feed inlined", async ({
  page,
}) => {
  const playlists: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.endsWith(".m3u8")) playlists.push(pathname);
  });
  const feed = page.waitForResponse((response) => /\/v1\/feeds\/latest\?/.test(response.url()));
  await page.goto("/bench?swipes=1");

  const body = (await (await feed).json()) as {
    data: { playback: { inline?: { playlists: Record<string, string> } } }[];
  };
  const inlined = Object.keys(body.data[0]?.playback.inline?.playlists ?? {}).map(
    (url) => new URL(url).pathname,
  );
  expect(inlined).toHaveLength(2); // master + starting variant

  await page.waitForFunction(
    () =>
      (window as { __reelplaneBench?: { initialTtffMs: number | null } }).__reelplaneBench
        ?.initialTtffMs != null,
    undefined,
    { timeout: 30_000 },
  );
  for (const pathname of inlined) expect(playlists).not.toContain(pathname);
  // The preloaded next videos still fetch theirs: the loader only answers what it was given.
  expect(playlists.length).toBeGreaterThan(0);
});
