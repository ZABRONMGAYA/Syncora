// What the Activate dialog, the status bar and the reminder say for each state of a code (src/lib/activation.ts).
import { describe, expect, it } from "vitest";

import { ENGINE_METHODS } from "../src/api/contract";
import {
  type CodeCheck,
  NOT_ACTIVATED,
  PLAN_METHODS,
  type PlanInfo,
  daysLeftText,
  isActivated,
  localDay,
  longDate,
  planRequiredText,
  reasonText,
  reminder,
  statusFromCheck,
  statusLine,
} from "../src/lib/activation";

const plan = (fields: Partial<PlanInfo> = {}): PlanInfo => ({
  product: "syncora",
  plan: "year",
  expires: "2027-10-24",
  serial: "A1B2C3D4",
  daysLeft: 365,
  ...fields,
});
const genuine = (fields: Partial<PlanInfo> = {}, check: Partial<CodeCheck> = { ok: true }): CodeCheck => ({
  ...plan(fields),
  ok: false,
  ...check,
});

describe("statusFromCheck", () => {
  it("is not activated without a saved code", () => {
    expect(statusFromCheck(null)).toEqual(NOT_ACTIVATED);
    expect(isActivated(NOT_ACTIVATED)).toBe(false);
    expect(isActivated(null)).toBe(false);
  });

  it("is active, then ending from 7 days before the last day through the last day", () => {
    expect(statusFromCheck(genuine({ daysLeft: 8 })).state).toBe("active");
    expect(statusFromCheck(genuine({ daysLeft: 7 })).state).toBe("ending");
    expect(statusFromCheck(genuine({ daysLeft: 0 }))).toEqual({
      state: "ending",
      plan: plan({ daysLeft: 0 }),
      reason: null,
    });
    expect(isActivated(statusFromCheck(genuine({ daysLeft: 0 })))).toBe(true);
  });

  it("keeps an ended plan's details", () => {
    const status = statusFromCheck(genuine({ daysLeft: -3 }, { ok: false, reason: "expired" }));
    expect(status).toEqual({ state: "expired", plan: plan({ daysLeft: -3 }), reason: null });
    expect(isActivated(status)).toBe(false);
  });

  it("reports a saved code that no longer passes", () => {
    expect(statusFromCheck({ ok: false, reason: "signature" })).toEqual({
      state: "invalid",
      plan: null,
      reason: "signature",
    });
    expect(statusFromCheck(genuine({ product: "kineticlane" }, { ok: false, reason: "product" }))).toMatchObject({
      state: "invalid",
      reason: "product",
      plan: { product: "kineticlane" },
    });
  });
});

describe("words", () => {
  it("writes dates as the buyer's message does", () => {
    expect(longDate("2026-11-24")).toBe("24 November 2026");
    expect(longDate("2027-01-05")).toBe("5 January 2027");
    expect(localDay(new Date(2026, 9, 4, 23, 59))).toBe("2026-10-04");
  });

  it("counts the days left", () => {
    expect(daysLeftText(30)).toBe("30 days left");
    expect(daysLeftText(1)).toBe("1 day left");
    expect(daysLeftText(0)).toBe("last day today");
    expect(daysLeftText(-1)).toBe("ended");
  });

  it("explains each refusal", () => {
    expect(reasonText("format", null)).toMatch(/^This is not an activation code\. .*117 letters and numbers/);
    expect(reasonText("signature", null)).toMatch(/not made by OrbitOne Studios/);
    expect(reasonText("product", plan({ product: "kineticlane" }))).toBe(
      "This code is for KineticLane, not Syncora. Paste your Syncora code, or a KineticLane + Syncora code.",
    );
    expect(reasonText("expired", plan({ expires: "2026-10-23", daysLeft: -1 }))).toBe(
      "This code ended on 23 October 2026. Paste the code for your new plan.",
    );
  });

  it("says nothing in the status bar while the plan runs with more than 7 days left", () => {
    expect(statusLine(statusFromCheck(genuine({ daysLeft: 8 })))).toBeNull();
    expect(statusLine(NOT_ACTIVATED)).toEqual({ text: "Not activated", action: "Activate", tone: "info" });
    expect(statusLine(statusFromCheck(genuine({ daysLeft: 3 })))).toEqual({
      text: "Plan ends in 3 days",
      action: "Enter new code",
      tone: "warn",
    });
    expect(statusLine(statusFromCheck(genuine({ daysLeft: 0 })))?.text).toBe("Plan ends today");
    expect(
      statusLine(statusFromCheck(genuine({ expires: "2026-10-23", daysLeft: -1 }, { ok: false, reason: "expired" }))),
    ).toEqual({ text: "Plan ended 23 October 2026", action: "Enter new code", tone: "error" });
    expect(statusLine(statusFromCheck({ ok: false, reason: "signature" }))?.tone).toBe("error");
  });

  it("reminds before the end and after it, never while more than 7 days are left or without a code", () => {
    expect(reminder(NOT_ACTIVATED)).toBeNull();
    expect(reminder(statusFromCheck(genuine({ daysLeft: 8 })))).toBeNull();
    expect(reminder(statusFromCheck(genuine({ expires: "2026-10-31", daysLeft: 7 })))).toEqual({
      title: "Your Syncora plan ends in 7 days",
      body: "It works until 31 October 2026. Renew at any time: a code bought early starts when this one ends, so no days are lost.",
    });
    expect(reminder(statusFromCheck(genuine({ plan: "trial", daysLeft: 1 })))?.title).toBe(
      "Your Syncora trial ends in 1 day",
    );
    const ended = reminder(statusFromCheck(genuine({ expires: "2026-10-23", daysLeft: -1 }, { reason: "expired" })));
    expect(ended?.title).toBe("Your Syncora plan has ended");
    expect(ended?.body).toMatch(/^It ended on 23 October 2026\. .*Your projects and original media stay exactly/);
  });
});

describe("what needs a running plan", () => {
  it("is writing XML and the AI first cut, both engine methods", () => {
    expect([...PLAN_METHODS].sort()).toEqual(["edit.first_cut", "export.xml"]);
    for (const method of PLAN_METHODS) expect(ENGINE_METHODS).toContain(method);
  });

  it("says why the export asks for a code, and when the plan ended", () => {
    expect(planRequiredText(NOT_ACTIVATED, "Exporting XML")).toBe(
      "Exporting XML needs an active Syncora plan. Everything else keeps working and your project stays as it is: activate, then carry on.",
    );
    const ended = statusFromCheck(genuine({ expires: "2026-10-23", daysLeft: -1 }, { reason: "expired" }));
    expect(planRequiredText(ended, "The AI first cut")).toMatch(
      /^Your plan ended on 23 October 2026. The AI first cut needs an active Syncora plan./,
    );
  });
});
