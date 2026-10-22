// New versions: the latest GitHub release compared with this one. The main process fetches it (electron/updates.ts);
// the launch notice and Settings → Updates show it. Pure functions, shared by both sides.

export const RELEASES_REPO = "ZABRONMGAYA/Syncora";
export const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases`;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;

export interface UpdateInfo {
  /** This version ("1.3.0"). */
  current: string;
  /** The latest release's version ("1.4.0"). */
  latest: string;
  /** The latest release is newer than this version. */
  available: boolean;
  /** The release title ("Syncora 1.4.0 (v1.4.0-build.31)"). */
  name: string;
  /** What's new, as plain text (may be empty). */
  notes: string;
  /** The release page, with every installer and the first-launch instructions. */
  pageUrl: string;
  /** The installer for this computer, when the release has one. */
  downloadUrl: string | null;
  publishedAt: string | null;
}

export type UpdateCheck = { ok: true; info: UpdateInfo } | { ok: false; error: string };

/** "v1.3.0-build.28", "1.3.0" → "1.3.0"; null when the tag carries no version. */
export function releaseVersion(tag: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(tag);
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

/** Negative, zero or positive as version `a` is older than, the same as or newer than `b` (major.minor.patch). */
export function compareVersions(a: string, b: string): number {
  const pa = (releaseVersion(a) ?? "0.0.0").split(".").map(Number);
  const pb = (releaseVersion(b) ?? "0.0.0").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

/** The installer for this platform and architecture, named as electron-builder.yml names them. */
export function pickInstaller(assets: readonly ReleaseAsset[], platform: string, arch: string): string | null {
  const match = (test: (name: string) => boolean) =>
    assets.find((a) => test(a.name.toLowerCase()))?.browser_download_url ?? null;
  if (platform === "win32") return match((n) => n.endsWith(".exe"));
  if (platform === "darwin") return match((n) => n.endsWith(`-macos-${arch === "arm64" ? "arm64" : "x64"}.dmg`));
  return null;
}

const NOTES_LIMIT = 1600;

/**
 * The release description as plain text: from its "What's new" heading when it has one (the installer table and
 * checksums above it are for the release page), with Markdown markup removed.
 */
export function releaseNotes(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s*what['’]?s new/i.test(l.trim()));
  const text = (start >= 0 ? lines.slice(start + 1) : lines)
    .map((l) =>
      l
        .replace(/^#{1,6}\s*/, "")
        .replace(/^\s*[-*]\s+/, "• ")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > NOTES_LIMIT ? `${text.slice(0, NOTES_LIMIT).trimEnd()}…` : text;
}

/** The pages Syncora may open in the browser for an update: its own releases only. */
export function isReleaseUrl(url: string): boolean {
  return (
    url === RELEASES_PAGE ||
    url.startsWith(`${RELEASES_PAGE}/`) ||
    url.startsWith(`https://github.com/${RELEASES_REPO}/releases/download/`)
  );
}

/** Read the GitHub API's latest release; throws when the answer is not one. */
export function updateFromRelease(release: unknown, current: string, platform: string, arch: string): UpdateInfo {
  const r = release as {
    tag_name?: unknown;
    name?: unknown;
    body?: unknown;
    html_url?: unknown;
    published_at?: unknown;
    assets?: unknown;
  };
  const latest = typeof r?.tag_name === "string" ? releaseVersion(r.tag_name) : null;
  if (!latest) throw new Error("the latest release has no version number");
  const assets = Array.isArray(r.assets)
    ? (r.assets as unknown[]).filter(
        (a): a is ReleaseAsset =>
          typeof (a as ReleaseAsset)?.name === "string" &&
          typeof (a as ReleaseAsset)?.browser_download_url === "string",
      )
    : [];
  const page = typeof r.html_url === "string" && isReleaseUrl(r.html_url) ? r.html_url : RELEASES_PAGE;
  const download = pickInstaller(assets, platform, arch);
  return {
    current,
    latest,
    available: compareVersions(latest, current) > 0,
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : `Syncora ${latest}`,
    notes: typeof r.body === "string" ? releaseNotes(r.body) : "",
    pageUrl: page,
    downloadUrl: download && isReleaseUrl(download) ? download : null,
    publishedAt: typeof r.published_at === "string" ? r.published_at : null,
  };
}
