// The AI first cut in the real app, and what this release adds around it: synchronise a shoot, cut a first version,
// export it as XML (in bins that mirror the folders); a new version's notice; the developer in About.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type ElectronApplication, type Page, _electron as electron, expect, test } from "@playwright/test";

import { closeApp, mainWindow, printEngineLog } from "./helpers";

const appDir = path.resolve(import.meta.dirname, "..");
const python = process.env.MCSYNC_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const screens = path.join(appDir, "test-results", "screens");

const GENERATE = `
import json, sys
from pathlib import Path
from mcsync.testing.media import generate_wedding_shoot
shoot = generate_wedding_shoot(Path(sys.argv[1]))
print(json.dumps(len(shoot.truth)))
`;

let work: string;
let shootDir: string;
let files: number;
let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: "serial" });

const packagedApp = process.env.MCSYNC_E2E_APP;

test.beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "syncora-cut-"));
  shootDir = path.join(work, "Smith wedding");
  files = JSON.parse(execFileSync(python, ["-c", GENERATE, shootDir], { encoding: "utf-8" })) as number;
  fs.mkdirSync(screens, { recursive: true });
  app = await electron.launch({
    ...(packagedApp ? { executablePath: packagedApp } : { args: [appDir] }),
    env: {
      ...process.env,
      MCSYNC_NO_SANDBOX: "1",
      MCSYNC_NO_UPDATE_CHECK: "1",
      MCSYNC_NO_SPLASH: "1",
      MCSYNC_CACHE_DIR: path.join(work, "cache"),
      MCSYNC_USER_DATA: path.join(work, "user-data"),
    },
  });
  page = await mainWindow(app);
  await page.setViewportSize({ width: 1440, height: 900 });
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && page) {
    printEngineLog(path.join(work, "user-data"), `"${testInfo.title}" failed`);
    await page.screenshot({ path: testInfo.outputPath("failure.png") }).catch(() => undefined);
  }
});

test.afterAll(async () => {
  if (app) await closeApp(app, path.join(work, "user-data")).catch(() => undefined);
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

async function answerDialogs(answers: { save?: string; open?: string[] }): Promise<void> {
  await app.evaluate(({ dialog }, { save, open }) => {
    dialog.showSaveDialog = (async () => ({ canceled: !save, filePath: save ?? "" })) as typeof dialog.showSaveDialog;
    dialog.showOpenDialog = (async () => ({ canceled: !open, filePaths: open ?? [] })) as typeof dialog.showOpenDialog;
  }, answers);
}

test("names OrbitOne Studios as the developer", async () => {
  await expect(page.getByTestId("welcome")).toBeVisible();
  await answerDialogs({ save: path.join(work, "Smith.syncora"), open: [shootDir] });
  await page.getByTestId("new-project").click();
  await expect(page.getByTestId("toolbar")).toContainText("Smith");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-about").click();
  await expect(page.getByTestId("settings")).toContainText("OrbitOne Studios");
});

test("shows a newer version, and opens its release page", async () => {
  // GitHub, as the main process sees it, answers with a newer release.
  await app.evaluate(({ ipcMain, shell }) => {
    ipcMain.removeHandler("updates:check");
    ipcMain.handle("updates:check", () => ({
      ok: true,
      info: {
        current: "1.3.0",
        latest: "9.9.0",
        available: true,
        name: "Syncora 9.9.0",
        notes: "• Bins follow your folders.",
        pageUrl: "https://github.com/ZABRONMGAYA/Syncora/releases/tag/v9.9.0-build.99",
        downloadUrl: null,
        publishedAt: "2026-11-01T10:00:00Z",
      },
    }));
    (globalThis as unknown as { opened: string[] }).opened = [];
    shell.openExternal = (async (url: string) => {
      (globalThis as unknown as { opened: string[] }).opened.push(url);
    }) as typeof shell.openExternal;
  });
  await page.getByTestId("settings-updates").click();
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByTestId("update-latest")).toHaveText("9.9.0");
  await page.getByRole("button", { name: "Close settings" }).click();
  const notice = page.getByTestId("update-notice");
  await expect(notice).toContainText("Syncora 9.9.0 is available");
  await notice.getByRole("button", { name: "What's new" }).click();
  await expect(notice).toContainText("Bins follow your folders.");
  await page.screenshot({ path: path.join(screens, "cut-01-update-notice.png") });
  await notice.getByRole("button", { name: "Download" }).click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened))
    .toEqual(["https://github.com/ZABRONMGAYA/Syncora/releases/tag/v9.9.0-build.99"]);
  await notice.getByRole("button", { name: "Skip this version" }).click();
  await expect(notice).toHaveCount(0);
});

test("imports and synchronises the shoot", async () => {
  await page.getByTestId("import-folder").click();
  await expect(page.getByTestId("media-summary")).toContainText(`${files} clips`);
  await expect(page.getByTestId("import-progress")).toContainText(`audio ${files - 1} / ${files - 1}`, {
    timeout: 180_000,
  });
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-synchronization").click();
  await page.getByRole("switch", { name: "Timecode is jam-synced" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByTestId("sync").click();
  await expect(page.getByTestId("results")).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("sync-stats")).toContainText(`${files} synced`);
});

test("cuts a first version and exports it", async () => {
  await page.getByTestId("open-first-cut").click();
  const dialog = page.getByTestId("first-cut-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("first-cut-style-wedding").check();
  await dialog.getByTestId("first-cut-make").click();
  const plan = dialog.getByTestId("first-cut-plan");
  await expect(plan).toContainText("A first cut of", { timeout: 120_000 });
  await expect(plan).toContainText("shots");
  await expect(plan.locator(".first-cut__cameras li").first()).toBeVisible();
  await page.screenshot({ path: path.join(screens, "cut-02-plan.png") });

  const out = path.join(work, "Smith first cut.xml");
  await answerDialogs({ save: out });
  await dialog.getByTestId("first-cut-export").click();
  await expect(page.getByTestId("toast-success").filter({ hasText: "First cut written" })).toBeVisible({
    timeout: 120_000,
  });
  const xml = fs.readFileSync(out, "utf-8");
  expect(xml).toContain("<xmeml");
  expect(xml).toContain("<name>Smith – first cut</name>");
  expect(xml).toContain("<bin>"); // the files in bins that mirror the shoot's folders
  await page.screenshot({ path: path.join(screens, "cut-03-exported.png") });
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
});
