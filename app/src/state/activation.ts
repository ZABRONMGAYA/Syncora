// Activation: the plan on this computer (checked by the main process), the Activate dialog, and the reminder shown when
// Syncora opens, and again each day it stays open, from REMIND_DAYS before the plan's last day and after it. Without a
// running plan only writing XML and the AI first cut ask for a code (lib/activation.ts PLAN_METHODS).
import { create } from "zustand";

import { bridge } from "../api/client";
import { type ActivationAttempt, type ActivationStatus, localDay, reminder } from "../lib/activation";

export const REMINDED_KEY = "syncora.activation.reminded";

function remindedToday(status: ActivationStatus): boolean {
  try {
    return localStorage.getItem(REMINDED_KEY) === `${localDay()} ${status.state}`;
  } catch {
    return false;
  }
}

/** The day the reminder last appeared in this window: it comes back the next day while Syncora stays open. */
let shownOn: string | null = null;

interface ActivationStore {
  /** null until the main process has answered. */
  status: ActivationStatus | null;
  /** The Activate dialog is open. */
  dialog: boolean;
  /** The reminder is showing. */
  notice: boolean;
  /** Check the saved code again; shows the reminder once a day while it is due (unless dismissed for the day). */
  load(): Promise<void>;
  /** Check a pasted code; an accepted one replaces the saved code. */
  activate(code: string): Promise<ActivationAttempt>;
  openDialog(): void;
  closeDialog(): void;
  /** Hide the reminder until tomorrow. */
  dismiss(): void;
}

export const useActivation = create<ActivationStore>((set, get) => ({
  status: null,
  dialog: false,
  notice: false,
  async load() {
    try {
      const status = await bridge().activationStatus();
      const due = reminder(status) !== null;
      const today = localDay();
      const appear = due && shownOn !== today && !remindedToday(status);
      if (appear) shownOn = today;
      set({ status, notice: due && (get().notice || appear) });
    } catch {
      // the status stays unknown: nothing about activation is shown
    }
  },
  async activate(code) {
    const attempt = await bridge().activate(code);
    set({ status: attempt.status, notice: attempt.ok ? false : get().notice });
    return attempt;
  },
  openDialog() {
    set({ dialog: true, notice: false });
  },
  closeDialog() {
    set({ dialog: false });
  },
  dismiss() {
    const status = get().status;
    try {
      if (status) localStorage.setItem(REMINDED_KEY, `${localDay()} ${status.state}`);
    } catch {
      // hidden for this session only
    }
    set({ notice: false });
  },
}));
