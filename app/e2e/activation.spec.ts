// Activation in the real app: the status bar item, the Activate dialog with each refusal, an accepted code in Settings
// and About, the reminder from 7 days before the end (checked at start-up), an ended plan, a code that no longer
// passes, and Export XML and the AI first cut asking for a plan. Codes are signed with a throwaway key that the
// development build accepts (MCSYNC_ACTIVATION_PUBLIC_KEY). The engine is the stand-in (fake-engine.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type ElectronApplication, type Page, _electron as electron, expect, test } from "@playwright/test";

import type { ActivationPlan, ActivationProduct } from "../src/lib/activation";
import { localDay, longDate } from "../src/lib/activation";
import { closeApp, mainWindow } from "./helpers";
import "../electron/vendor/activation-code.js";

const appDir = path.resolve(import.meta.dirname, "..");
const fakeEngine = path.join(appDir, "e2e", "fake-engine.mjs");
const screens = path.join(appDir, "test-results", "screens");

// A packaged Syncora accepts OrbitOne's key only, so these codes cannot be checked there.
test.skip(Boolean(process.env.MCSYNC_E2E_APP), "codes signed with a test key work in development builds only");
test.describe.configure({ mode: "serial" });

let work: string;
let userData: string;
let key: JsonWebKey;
let otherKey: JsonWebKey;
let app: ElectronApplication;
let page: Page;

async function throwawayKey(): Promise<JsonWebKey> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return crypto.subtle.exportKey("jwk", (pair as CryptoKeyPair).privateKey);
}

/** Today on this computer plus `days`, "YYYY-MM-DD" (the app checks codes by the local date). */
function day(days: number): string {
  const [y, m, d] = localDay().split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

function code(
  fields: { product?: ActivationProduct; plan?: ActivationPlan; expires: string },
  signer: JsonWebKey = key,
): Promise<string> {
  return globalThis.OrbitActivation.makeCode({ product: "syncora", plan: "month", ...fields }, signer);
}

/**
 * The stand-in engine: started directly where a script with a shebang is an executable; on Windows through
 * `python -m mcsync.cli serve`, with a two-line mcsync package in the work folder that runs it with Node.
 */
function standIn(): Record<string, string> {
  if (process.platform !== "win32") {
    fs.chmodSync(fakeEngine, 0o755);
    return { MCSYNC_ENGINE: fakeEngine };
  }
  const shim = path.join(work, "stand-in");
  fs.mkdirSync(path.join(shim, "mcsync"), { recursive: true });
  fs.writeFileSync(path.join(shim, "mcsync", "__init__.py"), "");
  fs.writeFileSync(
    path.join(shim, "mcsync", "cli.py"),
    `import subprocess, sys
sys.exit(subprocess.call([${JSON.stringify(process.execPath)}, ${JSON.stringify(fakeEngine)}]))
`,
  );
  return { PYTHONPATH: shim };
}

async function launch(): Promise<void> {
  app = await electron.launch({
    args: [appDir],
    env: {
      ...process.env,
      ...standIn(),
      MCSYNC_NO_SANDBOX: "1",
      MCSYNC_NO_UPDATE_CHECK: "1",
      MCSYNC_NO_SPLASH: "1",
      MCSYNC_CACHE_DIR: path.join(work, "cache"),
      MCSYNC_USER_DATA: userData,
      MCSYNC_ACTIVATION_PUBLIC_KEY: key.x!,
    },
  });
  page = await mainWindow(app);
  await page.setViewportSize({ width: 1440, height: 900 });
}

/** Quit and open Syncora again, with this code saved as if it had been accepted before (null: no code). */
async function restartWith(saved: string | null): Promise<void> {
  await closeApp(app, userData);
  const file = path.join(userData, "activation.json");
  if (saved) fs.writeFileSync(file, JSON.stringify({ code: saved }));
  else fs.rmSync(file, { force: true });
  await launch();
}

const shot = (name: string) => page.screenshot({ path: path.join(screens, `activation-${name}.png`) });
const dialog = () => page.getByTestId("activate-dialog");
const statusItem = () => page.getByTestId("statusbar-activation");

test.beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "syncora-activation-"));
  userData = path.join(work, "user-data");
  key = await throwawayKey();
  otherKey = await throwawayKey();
  fs.mkdirSync(screens, { recursive: true });
  await launch();
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && page)
    await page.screenshot({ path: testInfo.outputPath("failure.png") }).catch(() => undefined);
});

test.afterAll(async () => {
  if (app) await closeApp(app, userData).catch(() => undefined);
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

test("says Not activated in the status bar, which opens the Activate dialog", async () => {
  await expect(page.getByTestId("welcome")).toBeVisible();
  await expect(statusItem()).toHaveText(/Not activated\s*Activate/);
  await expect(page.getByTestId("home-license")).toContainText("Not activated");
  await statusItem().click();
  await expect(dialog()).toContainText("Activate Syncora");
  await expect(dialog()).toContainText("Paste your activation code");
  await expect(dialog().getByTestId("activate-code")).toBeFocused();
  await expect(dialog().getByTestId("activate-submit")).toBeDisabled();
  await shot("01-not-activated");
});

test("explains each code it refuses, and saves none of them", async () => {
  const yesterday = day(-1);
  const refusals: [string, string, string][] = [
    ["02-format", "hello, this is not a code", "This is not an activation code"],
    ["03-signature", await code({ expires: day(30) }, otherKey), "not made by OrbitOne Studios"],
    [
      "04-product",
      await code({ product: "kineticlane", expires: day(30) }),
      "This code is for KineticLane, not Syncora",
    ],
    ["05-expired", await code({ expires: yesterday }), `This code ended on ${longDate(yesterday)}`],
  ];
  for (const [name, pasted, message] of refusals) {
    await dialog().getByTestId("activate-code").fill(pasted);
    await dialog().getByTestId("activate-submit").click();
    await expect(dialog().getByTestId("activate-error")).toContainText(message);
    await expect(dialog().getByTestId("activate-code")).toHaveAttribute("aria-invalid", "true");
    await shot(name);
  }
  // Typing again clears the message.
  await dialog().getByTestId("activate-code").fill("");
  await expect(dialog().getByTestId("activate-error")).toHaveCount(0);
  expect(fs.existsSync(path.join(userData, "activation.json"))).toBe(false);
});

test("activates with a year code: the plan in the dialog, Settings and About, nothing in the status bar", async () => {
  const lastDay = globalThis.OrbitActivation.planExpiry("year", localDay());
  const pasted = (await code({ plan: "year", expires: lastDay })).replace(/(.{29})/g, "$1-");
  await dialog().getByTestId("activate-code").fill(pasted);
  await dialog().getByTestId("activate-code").press("Enter");
  await expect(dialog()).toContainText("Syncora is activated");
  await expect(dialog().getByTestId("activate-plan")).toContainText("1 year");
  await expect(dialog().getByTestId("activate-plan")).toContainText(longDate(lastDay));
  await shot("06-activated");
  await dialog().getByRole("button", { name: "Done" }).click();
  await expect(dialog()).toHaveCount(0);
  await expect(statusItem()).toHaveCount(0);
  await expect(page.getByTestId("home-license")).toContainText(`1 year · until ${longDate(lastDay)}`);
  expect(JSON.parse(fs.readFileSync(path.join(userData, "activation.json"), "utf-8")).code).toMatch(/^[0-9A-Z]{117}$/);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByTestId("settings-activation").click();
  await expect(page.getByTestId("settings")).toContainText("Activated");
  await expect(page.getByTestId("settings")).toContainText(longDate(lastDay));
  await shot("07-settings");
  await page.getByTestId("settings-activate").click();
  await expect(dialog()).toContainText("To renew, paste your new code at any time");
  await shot("08-renew-over-settings");
  await dialog().getByRole("button", { name: "Close" }).click();
  await page.getByTestId("settings-about").click();
  await expect(page.getByTestId("settings")).toContainText("1 year · last day");
  await shot("09-about");
  await page.getByTestId("about-activate").click();
  await expect(dialog()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog()).toHaveCount(0);
  await page.getByRole("button", { name: "Close settings" }).click();

  // File → Activate Syncora… opens it too.
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((item) => item.label === "File");
    file?.submenu?.items.find((item) => item.label === "Activate Syncora…")?.click();
  });
  await expect(dialog()).toBeVisible();
  await dialog().getByRole("button", { name: "Close" }).click();
});

test("reminds at start-up from 7 days before the last day, and takes the renewal", async () => {
  await restartWith(await code({ product: "bundle", expires: day(3) }));
  const notice = page.getByTestId("activation-notice");
  await expect(notice).toContainText("Your Syncora plan ends in 3 days");
  await expect(statusItem()).toHaveText(/Plan ends in 3 days\s*Enter new code/);
  await shot("10-reminder");

  // Dismissed, it stays away for the rest of the day; the status bar keeps saying it.
  await notice.getByRole("button", { name: "Remind me tomorrow" }).first().click();
  await expect(notice).toHaveCount(0);
  await restartWith(await code({ product: "bundle", expires: day(3) }));
  await expect(statusItem()).toContainText("Plan ends in 3 days");
  await expect(page.getByTestId("activation-notice")).toHaveCount(0);

  await statusItem().click();
  await expect(dialog()).toContainText("Your plan ends on");
  await expect(dialog().getByTestId("activate-plan")).toContainText("KineticLane + Syncora");
  await expect(dialog().getByTestId("activate-plan")).toContainText("3 days left");
  await shot("11-dialog-ending");
  const renewal = globalThis.OrbitActivation.planExpiry("month", day(3)); // a renewal starts when the plan ends
  await dialog()
    .getByTestId("activate-code")
    .fill(await code({ product: "bundle", expires: renewal }));
  await dialog().getByTestId("activate-submit").click();
  await expect(dialog()).toContainText("Syncora is activated");
  await expect(dialog().getByTestId("activate-plan")).toContainText(longDate(renewal));
  await dialog().getByRole("button", { name: "Done" }).click();
  await expect(statusItem()).toHaveCount(0);
});

test("asks for a new code once the plan has ended", async () => {
  const ended = day(-2);
  await restartWith(await code({ expires: ended }));
  const notice = page.getByTestId("activation-notice");
  await expect(notice).toContainText("Your Syncora plan has ended");
  await expect(notice).toContainText("Your projects and original media stay exactly as they are");
  await expect(statusItem()).toHaveText(new RegExp(`Plan ended ${longDate(ended)}\\s*Enter new code`));
  await expect(page.getByTestId("home-license")).toContainText("Plan ended");
  await shot("12-ended");
  await notice.getByRole("button", { name: "Enter new code" }).click();
  await expect(dialog()).toContainText(`Your plan ended on ${longDate(ended)}`);
  await shot("13-dialog-ended");
  await dialog().getByRole("button", { name: "Close" }).click();
});

test("reports a saved code that no longer passes", async () => {
  await restartWith(await code({ expires: day(30) }, otherKey));
  await expect(page.getByTestId("activation-notice")).toContainText("Syncora is not activated");
  await expect(statusItem()).toHaveText(/Activation code not accepted\s*Activate/);
  await shot("14-not-accepted");
});

test("asks for a plan at Export XML and the AI first cut, and refuses them in the main process too", async () => {
  await restartWith(null);
  await app.evaluate(
    ({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
    },
    path.join(work, "Stand-in.syncora"),
  );
  await page.getByTestId("open-project").click();
  await expect(page.getByTestId("toolbar")).toBeVisible();

  await page.getByTestId("stage-export").click();
  const exportDialog = page.getByTestId("export-dialog");
  await expect(exportDialog.getByTestId("plan-required")).toContainText("Exporting XML needs an active Syncora plan");
  await expect(exportDialog.getByTestId("export-submit")).toHaveCount(0);
  await shot("15-export-needs-plan");
  // Whatever the window shows, the main process does not pass the request to the engine.
  const refused = await page.evaluate(() =>
    window.mcsync!.invoke("export.xml", { format: "xmeml", path: "nowhere.xml" }),
  );
  expect(refused).toMatchObject({ ok: false, error: { code: -32010 } });
  await exportDialog.getByRole("button", { name: "Cancel" }).click();

  await page.getByTestId("open-first-cut").click();
  const firstCut = page.getByTestId("first-cut-dialog");
  await expect(firstCut.getByTestId("plan-required")).toContainText("The AI first cut needs an active Syncora plan");
  await expect(firstCut.getByTestId("first-cut-make")).toHaveCount(0);
  await shot("16-first-cut-needs-plan");
  await firstCut.getByTestId("first-cut-activate").click();
  await dialog()
    .getByTestId("activate-code")
    .fill(await code({ plan: "year", expires: day(365) }));
  await dialog().getByTestId("activate-submit").click();
  await expect(dialog()).toContainText("Syncora is activated");
  await shot("17-activated-over-first-cut");
  await dialog().getByRole("button", { name: "Done" }).click();
  await expect(firstCut.getByTestId("plan-required")).toHaveCount(0);
  await expect(firstCut.getByTestId("first-cut-make")).toBeEnabled();
  await firstCut.getByRole("button", { name: "Close" }).click();

  await page.getByTestId("stage-export").click();
  await expect(exportDialog.getByTestId("export-submit")).toBeEnabled();
  await expect(exportDialog.getByTestId("plan-required")).toHaveCount(0);
});
