// Shared by the end-to-end suites: closing the app within a time limit, the engine's log when something fails, and
// an activation code for the suites that export.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { ElectronApplication, Page } from "@playwright/test";

import "../electron/vendor/activation-code.js";

export interface TestActivation {
  /** A code this app accepts: a year for Syncora. */
  code: string;
  /** For electron.launch: the throwaway public key a development build then accepts. */
  env: Record<string, string>;
}

/**
 * Writing XML and the AI first cut need a running plan. A development build accepts codes signed with a throwaway key
 * (MCSYNC_ACTIVATION_PUBLIC_KEY); an installed Syncora only OrbitOne's, so it needs a real code from the Code Maker
 * in MCSYNC_E2E_ACTIVATION_CODE (a secret in the release workflow). null: an installed app without one.
 */
export async function testActivation(): Promise<TestActivation | null> {
  if (process.env.MCSYNC_E2E_ACTIVATION_CODE) return { code: process.env.MCSYNC_E2E_ACTIVATION_CODE, env: {} };
  if (process.env.MCSYNC_E2E_APP) return null;
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const key = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const A = globalThis.OrbitActivation;
  const code = await A.makeCode(
    { product: "syncora", plan: "year", expires: A.planExpiry("year", A.localToday()) },
    key,
  );
  return { code, env: { MCSYNC_ACTIVATION_PUBLIC_KEY: key.x! } };
}

/** The activation code, saved as if it had been pasted into the Activate dialog before the app opens. */
export function saveActivation(userData: string, code: string): void {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "activation.json"), JSON.stringify({ code }));
}

export const NO_TEST_CODE =
  "Exporting from an installed Syncora needs an active plan: set MCSYNC_E2E_ACTIVATION_CODE to a Syncora code from the Code Maker";

/**
 * The app's main window. The S00 splash opens alongside it while the engine starts and may load first, so the
 * first window is not necessarily the main one.
 */
export async function mainWindow(app: ElectronApplication, timeoutMs = 60_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      if (page.isClosed()) continue;
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      if (!page.isClosed() && page.url() !== "about:blank" && !page.url().includes("splash.html")) return page;
    }
    await app.waitForEvent("window", { timeout: 500 }).catch(() => undefined);
  }
  throw new Error("the main window did not open");
}

/** The last lines of the engine log the app keeps in its user-data folder (MCSYNC_USER_DATA). */
export function engineLog(userData: string, lines = 120): string {
  try {
    const text = fs.readFileSync(path.join(userData, "logs", "engine.log"), "utf-8");
    return text.split("\n").slice(-lines).join("\n");
  } catch {
    return "(no engine log)";
  }
}

/** Print the engine log into the test output (CI logs keep it; the artifacts may not be reachable). */
export function printEngineLog(userData: string, why: string): void {
  console.log(`--- ${why}; engine log (${path.join(userData, "logs", "engine.log")}):\n${engineLog(userData)}\n---`);
}

/** The processes under `pid` (state, CPU, elapsed time, command), where `ps` exists. */
function processTree(pid: number | undefined): string {
  if (pid === undefined || process.platform === "win32") return "(process list not available)";
  try {
    const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,stat=,pcpu=,etime=,command="], { encoding: "utf-8" })
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols.length >= 6);
    const keep = new Set([String(pid)]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const cols of rows)
        if (keep.has(cols[1]!) && !keep.has(cols[0]!)) {
          keep.add(cols[0]!);
          grew = true;
        }
    }
    // Also processes that outlived their parent (re-parented away from the app).
    const related = /electron|mcsync|multiprocessing|ffmpeg|ffprobe/i;
    return rows
      .filter((cols) => keep.has(cols[0]!) || related.test(cols.slice(5).join(" ")))
      .map((cols) => `${cols.slice(0, 5).join(" ")} ${cols.slice(5).join(" ").slice(0, 160)}`)
      .join("\n");
  } catch (err) {
    return `(ps failed: ${String(err)})`;
  }
}

/** Where the app's main thread is waiting (Linux, when gdb is installed): its stack and each thread's wait channel. */
function mainThreadStack(pid: number | undefined): string {
  if (pid === undefined || process.platform !== "linux") return "";
  const out: string[] = [];
  try {
    for (const tid of fs.readdirSync(`/proc/${pid}/task`).slice(0, 40)) {
      const comm = fs.readFileSync(`/proc/${pid}/task/${tid}/comm`, "utf-8").trim();
      const wchan = fs.readFileSync(`/proc/${pid}/task/${tid}/wchan`, "utf-8").trim();
      out.push(`thread ${tid} ${comm}: ${wchan}`);
    }
  } catch {
    // the process is gone
  }
  try {
    const gdb = execFileSync("gdb", ["-p", String(pid), "-batch", "-ex", "thread apply 1 bt 40"], {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    out.push(
      gdb
        .split("\n")
        .filter((line) => /^#|^Thread/.test(line))
        .join("\n"),
    );
  } catch {
    out.push("(gdb not available)");
  }
  return out.join("\n");
}

/**
 * Quit the app as a user would. An app that has not quit after `timeoutMs` fails the test with the engine log
 * printed, and is killed so the next test starts clean (Playwright would otherwise wait on it indefinitely).
 */
export async function closeApp(app: ElectronApplication, userData: string, timeoutMs = 60_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), timeoutMs)));
  const result = await Promise.race([app.close().then(() => "closed" as const), timedOut]);
  clearTimeout(timer);
  if (result === "timeout") {
    printEngineLog(userData, `the app did not quit within ${timeoutMs / 1000} s`);
    console.log(`--- processes of the app:\n${processTree(app.process().pid)}\n---`);
    console.log(`--- the app's main thread:\n${mainThreadStack(app.process().pid)}\n---`);
    app.process().kill("SIGKILL");
    throw new Error(`the app did not quit within ${timeoutMs / 1000} s`);
  }
}
