// The reminder as the window shows it (src/state/activation.ts): once a day while it is due, also when Syncora stays
// open for days; hidden for the day when dismissed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bridge } from "../src/api/contract";
import { type ActivationStatus, statusFromCheck } from "../src/lib/activation";
import { REMINDED_KEY, useActivation } from "../src/state/activation";

let status: ActivationStatus;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  useActivation.setState({ status: null, notice: false, dialog: false });
  window.mcsync = { activationStatus: async () => status } as unknown as Bridge;
});

afterEach(() => {
  vi.useRealTimers();
});

const ending = (daysLeft: number) =>
  statusFromCheck({ ok: true, product: "syncora", plan: "month", expires: "2026-12-31", serial: "A1B2C3D4", daysLeft });

describe("the reminder", () => {
  it("appears once a day while it is due, and the next day again while Syncora stays open", async () => {
    vi.setSystemTime(new Date(2026, 11, 24, 9));
    status = ending(7);
    await useActivation.getState().load();
    expect(useActivation.getState().notice).toBe(true);

    // Opened from the reminder and closed without a new code: not again today, even at the hourly check.
    useActivation.getState().openDialog();
    useActivation.getState().closeDialog();
    await useActivation.getState().load();
    expect(useActivation.getState().notice).toBe(false);

    vi.setSystemTime(new Date(2026, 11, 25, 9));
    status = ending(6);
    await useActivation.getState().load();
    expect(useActivation.getState().notice).toBe(true);
  });

  it("stays hidden for the day once dismissed, and is not due with more than 7 days left", async () => {
    vi.setSystemTime(new Date(2026, 11, 10, 9));
    status = ending(8);
    await useActivation.getState().load();
    expect(useActivation.getState().notice).toBe(false);

    vi.setSystemTime(new Date(2026, 11, 11, 9));
    status = ending(7);
    await useActivation.getState().load();
    expect(useActivation.getState().notice).toBe(true);
    useActivation.getState().dismiss();
    expect(localStorage.getItem(REMINDED_KEY)).toBe("2026-12-11 ending");
    await useActivation.getState().load();
    expect(useActivation.getState().notice).toBe(false);

    vi.setSystemTime(new Date(2026, 11, 12, 9));
    status = ending(6);
    await useActivation.getState().load();
    expect(useActivation.getState().notice).toBe(true);
  });

  it("goes away once a new code is accepted", async () => {
    vi.setSystemTime(new Date(2026, 11, 20, 9));
    status = ending(2);
    await useActivation.getState().load();
    expect(useActivation.getState().notice).toBe(true);
    const renewed = ending(40);
    window.mcsync = { activate: async () => ({ ok: true, status: renewed }) } as unknown as Bridge;
    await useActivation.getState().activate("CODE");
    expect(useActivation.getState()).toMatchObject({ notice: false, status: { state: "active" } });
  });
});
