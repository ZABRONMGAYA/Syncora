// Update check: asks GitHub for Syncora's latest release. Nothing is downloaded or installed; the renderer shows a
// notice and the user downloads the installer from the release page.
import { net } from "electron";

import { LATEST_RELEASE_API, type UpdateCheck, updateFromRelease } from "../src/lib/updates";

const TIMEOUT_MS = 15_000;

export async function checkForUpdate(current: string, platform: string, arch: string): Promise<UpdateCheck> {
  if (process.env.MCSYNC_NO_UPDATE_CHECK === "1") return { ok: false, error: "update checks are turned off" };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const response = await net.fetch(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `Syncora/${current}` },
      signal: abort.signal,
    });
    if (!response.ok) return { ok: false, error: `GitHub answered ${response.status}` };
    return { ok: true, info: updateFromRelease(await response.json(), current, platform, arch) };
  } catch (err) {
    const timedOut = abort.signal.aborted;
    return {
      ok: false,
      error: timedOut ? "GitHub did not answer in time" : err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
