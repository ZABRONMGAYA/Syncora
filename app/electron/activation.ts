// Activation: a buyer pastes the code they received for a prepaid plan (OrbitOne store). It is checked here, offline,
// by the vendored activation-code.js with the public key built into it. An accepted code is saved in Syncora's settings
// folder and checked again at every start-up and whenever the window asks. main.ts refuses writing XML and the AI first
// cut without a running plan; the renderer shows the plan, the reminder and the Activate dialog.
import { promises as fs } from "node:fs";
import path from "node:path";

import { type ActivationAttempt, type ActivationStatus, planInfo, statusFromCheck } from "../src/lib/activation";
import "./vendor/activation-code.js";

/** Pasted text longer than this is not a code, even with spaces and dashes. */
const MAX_PASTE = 400;

export interface ActivationOptions {
  /** Another public key: tests and development builds, with codes made from a throwaway key pair. */
  publicKey?: string;
  /** Today, "YYYY-MM-DD" (tests); otherwise this computer's local date. */
  today?: () => string;
}

export class Activation {
  constructor(
    private readonly file: string,
    private readonly options: ActivationOptions = {},
  ) {}

  private check(code: string) {
    return globalThis.OrbitActivation.checkCode(code, {
      product: "syncora", // a KineticLane + Syncora code passes too
      publicKey: this.options.publicKey,
      today: this.options.today?.(),
    });
  }

  /** The saved code; null when there is none or the file cannot be read. */
  async savedCode(): Promise<string | null> {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf-8")) as { code?: unknown } | null;
      return typeof saved?.code === "string" && saved.code ? saved.code : null;
    } catch {
      return null;
    }
  }

  /** The saved code, checked now. */
  async status(): Promise<ActivationStatus> {
    const code = await this.savedCode();
    return statusFromCheck(code ? await this.check(code) : null);
  }

  /** Check a pasted code. One that passes replaces the saved code (renewals); a refused one changes nothing. */
  async activate(pasted: string): Promise<ActivationAttempt> {
    const code = pasted.replace(/[\s-]/g, "").toUpperCase();
    const check = pasted.length <= MAX_PASTE ? await this.check(code) : { ok: false, reason: "format" as const };
    if (!check.ok) {
      return { ok: false, reason: check.reason ?? "format", plan: planInfo(check), status: await this.status() };
    }
    await this.save(code);
    return { ok: true, status: statusFromCheck(check) };
  }

  private async save(code: string): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const partial = `${this.file}.partial`;
    await fs.writeFile(partial, `${JSON.stringify({ code, saved_at: new Date().toISOString() }, null, 2)}\n`, "utf-8");
    await fs.rename(partial, this.file);
  }
}
