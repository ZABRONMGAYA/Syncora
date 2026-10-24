// @vitest-environment node
// The main process's activation check (electron/activation.ts) with codes signed by a throwaway key pair: the real
// signing key never comes near the tests.
import { createHash, type webcrypto } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { Activation } from "../../electron/activation";
import type { ActivationPlan, ActivationProduct } from "../../src/lib/activation";

const vendorDir = path.resolve(import.meta.dirname, "..", "..", "electron", "vendor");

/** A new Ed25519 key pair; its private half (with the public `x`) as JSON, like make-keys.mjs writes it. */
async function throwawayKey(): Promise<webcrypto.JsonWebKey> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return crypto.subtle.exportKey("jwk", (pair as unknown as webcrypto.CryptoKeyPair).privateKey);
}

let jwk: webcrypto.JsonWebKey;
let otherJwk: webcrypto.JsonWebKey;
beforeAll(async () => {
  jwk = await throwawayKey();
  otherJwk = await throwawayKey();
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

let today = "2026-10-24";

/**
 * A settings folder of its own, and the check as Syncora's main process makes it: with the throwaway public key, or
 * (null) the one built into activation-code.js.
 */
function setup(publicKey: string | null = jwk.x!) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncora-activation-"));
  dirs.push(dir);
  const file = path.join(dir, "activation.json");
  const open = () => new Activation(file, { publicKey: publicKey ?? undefined, today: () => today });
  return { file, open, activation: open() };
}

function code(
  fields: { product?: ActivationProduct; plan?: ActivationPlan; expires?: string; serial?: number } = {},
  key = jwk,
) {
  return globalThis.OrbitActivation.makeCode(
    { product: "syncora", plan: "month", expires: "2026-11-24", serial: 0xa1b2c3d4, ...fields },
    key,
  );
}

afterEach(() => {
  today = "2026-10-24";
});

describe("Activation", () => {
  it("is not activated before a code is pasted", async () => {
    const { activation, file } = setup();
    expect(await activation.status()).toEqual({ state: "none", plan: null, reason: null });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("saves an accepted code and finds it again at the next start-up", async () => {
    const { activation, open, file } = setup();
    const attempt = await activation.activate(await code({ plan: "year", expires: "2027-10-24" }));
    const plan = { product: "syncora", plan: "year", expires: "2027-10-24", serial: "A1B2C3D4", daysLeft: 365 };
    expect(attempt).toEqual({ ok: true, status: { state: "active", plan, reason: null } });
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).code).toMatch(/^[0-9A-HJKMNP-TV-Z]{117}$/);
    expect(await open().status()).toEqual({ state: "active", plan, reason: null });
  });

  it("accepts a code as people paste it: lower case, dashes, line breaks", async () => {
    const { activation, open } = setup();
    const messy = ` ${(await code()).toLowerCase().replace(/(.{20})/g, "$1-\n")} `;
    expect((await activation.activate(messy)).ok).toBe(true);
    expect((await open().status()).state).toBe("active");
  });

  it("accepts a KineticLane + Syncora code", async () => {
    const { activation } = setup();
    const attempt = await activation.activate(await code({ product: "bundle" }));
    expect(attempt.ok && attempt.status.plan?.product).toBe("bundle");
  });

  it("refuses a code for KineticLane, an ended code, another key's code and garbage, and keeps the saved code", async () => {
    const { activation, file } = setup();
    await activation.activate(await code());
    const saved = fs.readFileSync(file, "utf-8");
    const status = await activation.status();

    const kineticlane = await activation.activate(await code({ product: "kineticlane" }));
    expect(kineticlane).toMatchObject({ ok: false, reason: "product", plan: { product: "kineticlane" }, status });

    const ended = await activation.activate(await code({ expires: "2026-10-23" }));
    expect(ended).toMatchObject({ ok: false, reason: "expired", plan: { expires: "2026-10-23", daysLeft: -1 } });

    expect(await activation.activate(await code({}, otherJwk))).toEqual({
      ok: false,
      reason: "signature",
      plan: null,
      status,
    });
    expect(await activation.activate("hello")).toMatchObject({ ok: false, reason: "format", plan: null });
    expect(await activation.activate("0".repeat(5000))).toMatchObject({ ok: false, reason: "format" });
    expect(fs.readFileSync(file, "utf-8")).toBe(saved);
  });

  it("refuses codes signed by anything but OrbitOne's key when no other key is given", async () => {
    const { activation } = setup(null);
    expect(await activation.activate(await code())).toMatchObject({ ok: false, reason: "signature" });
  });

  it("takes a renewal at any time: the new code replaces the saved one", async () => {
    const { activation, open } = setup();
    await activation.activate(await code({ expires: "2026-11-24", serial: 1 }));
    const renewal = await activation.activate(await code({ plan: "quarter", expires: "2027-02-24", serial: 2 }));
    expect(renewal.ok).toBe(true);
    expect((await open().status()).plan).toMatchObject({ plan: "quarter", expires: "2027-02-24", serial: "00000002" });
  });

  it("reminds from 7 days before the last day, and reports an ended plan without forgetting it", async () => {
    const { activation, file } = setup();
    await activation.activate(await code({ expires: "2026-11-24" }));
    today = "2026-11-16";
    expect(await activation.status()).toMatchObject({ state: "active", plan: { daysLeft: 8 } });
    today = "2026-11-17";
    expect(await activation.status()).toMatchObject({ state: "ending", plan: { daysLeft: 7 } });
    today = "2026-11-24";
    expect(await activation.status()).toMatchObject({ state: "ending", plan: { daysLeft: 0 } });
    today = "2026-11-25";
    expect(await activation.status()).toMatchObject({ state: "expired", plan: { daysLeft: -1 }, reason: null });
    expect(fs.existsSync(file)).toBe(true);
    // A new code after the end works as on the first day.
    expect((await activation.activate(await code({ expires: "2026-12-25" }))).ok).toBe(true);
    expect(await activation.status()).toMatchObject({ state: "active", plan: { daysLeft: 30 } });
  });

  it("treats an unreadable settings file as no code, and a saved code that fails as not accepted", async () => {
    const { activation, file } = setup();
    fs.writeFileSync(file, "{ not json");
    expect((await activation.status()).state).toBe("none");
    fs.writeFileSync(file, JSON.stringify({ code: await code({}, otherJwk) }));
    expect(await activation.status()).toEqual({ state: "invalid", plan: null, reason: "signature" });
  });

  it("uses the vendored activation-code.js unchanged (the checksum its README records)", () => {
    const readme = fs.readFileSync(path.join(vendorDir, "README.md"), "utf-8");
    const recorded = /SHA-256\s*\|\s*`([0-9a-f]{64})`/.exec(readme)?.[1];
    const actual = createHash("sha256")
      .update(fs.readFileSync(path.join(vendorDir, "activation-code.js")))
      .digest("hex");
    expect(actual).toBe(recorded);
  });
});
