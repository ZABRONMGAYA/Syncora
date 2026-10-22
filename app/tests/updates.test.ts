import { describe, expect, it } from "vitest";

import {
  RELEASES_PAGE,
  compareVersions,
  isReleaseUrl,
  pickInstaller,
  releaseNotes,
  releaseVersion,
  updateFromRelease,
} from "../src/lib/updates";

const download = (name: string) => ({
  name,
  browser_download_url: `https://github.com/ZABRONMGAYA/Syncora/releases/download/v1.4.0-build.31/${name}`,
});

const ASSETS = [
  download("Syncora-Setup-1.4.0.exe"),
  download("Syncora-1.4.0-macOS-arm64.dmg"),
  download("Syncora-1.4.0-macOS-x64.dmg"),
];

const RELEASE = {
  tag_name: "v1.4.0-build.31",
  name: "Syncora 1.4.0 (v1.4.0-build.31)",
  html_url: "https://github.com/ZABRONMGAYA/Syncora/releases/tag/v1.4.0-build.31",
  published_at: "2026-11-02T10:00:00Z",
  body: [
    "Installers for Syncora 1.4.0.",
    "",
    "| Computer | File |",
    "|---|---|",
    "| Windows | `Syncora-Setup-1.4.0.exe` |",
    "",
    "## What's new",
    "",
    "* **Update notice** when Syncora opens.",
    "* Bins follow your [folders](https://example.com).",
  ].join("\n"),
  assets: ASSETS,
};

describe("versions", () => {
  it("reads the version from release tags", () => {
    expect(releaseVersion("v1.3.0-build.28")).toBe("1.3.0");
    expect(releaseVersion("1.10.2")).toBe("1.10.2");
    expect(releaseVersion("nightly")).toBeNull();
  });

  it("compares numerically, not as text", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.3.0-build.28", "1.3.0")).toBe(0);
    expect(compareVersions("1.2.9", "1.3.0")).toBeLessThan(0);
  });
});

describe("installers", () => {
  it("picks the installer for each platform", () => {
    expect(pickInstaller(ASSETS, "win32", "x64")).toMatch(/Setup-1\.4\.0\.exe$/);
    expect(pickInstaller(ASSETS, "darwin", "arm64")).toMatch(/macOS-arm64\.dmg$/);
    expect(pickInstaller(ASSETS, "darwin", "x64")).toMatch(/macOS-x64\.dmg$/);
    expect(pickInstaller(ASSETS, "linux", "x64")).toBeNull();
  });
});

describe("the latest release", () => {
  it("is newer than this version", () => {
    const info = updateFromRelease(RELEASE, "1.3.0", "win32", "x64");
    expect(info).toMatchObject({ current: "1.3.0", latest: "1.4.0", available: true });
    expect(info.pageUrl).toBe(RELEASE.html_url);
    expect(info.downloadUrl).toMatch(/\.exe$/);
  });

  it("is not an update for the same or a newer version", () => {
    expect(updateFromRelease(RELEASE, "1.4.0", "win32", "x64").available).toBe(false);
    expect(updateFromRelease(RELEASE, "1.5.0", "win32", "x64").available).toBe(false);
  });

  it("keeps only the notes after 'What's new', without Markdown", () => {
    const notes = releaseNotes(RELEASE.body);
    expect(notes).toBe("• Update notice when Syncora opens.\n• Bins follow your folders.");
  });

  it("falls back to the releases page for links elsewhere", () => {
    const info = updateFromRelease(
      { ...RELEASE, html_url: "https://evil.example/x", assets: [] },
      "1.3.0",
      "win32",
      "x64",
    );
    expect(info.pageUrl).toBe(RELEASES_PAGE);
    expect(info.downloadUrl).toBeNull();
  });

  it("rejects an answer that is not a release", () => {
    expect(() => updateFromRelease({ message: "Not Found" }, "1.3.0", "win32", "x64")).toThrow(/version/);
  });
});

describe("opening pages", () => {
  it("allows Syncora's releases only", () => {
    expect(isReleaseUrl(RELEASES_PAGE)).toBe(true);
    expect(isReleaseUrl(`${RELEASES_PAGE}/tag/v1.4.0-build.31`)).toBe(true);
    expect(isReleaseUrl("https://github.com/someone/else/releases")).toBe(false);
    expect(isReleaseUrl(`${RELEASES_PAGE}.evil.example/`)).toBe(false);
  });
});
