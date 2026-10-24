// Activation: the plan a buyer's code unlocks (prepaid plans from the OrbitOne store, no renewal by themselves). The
// main process checks codes offline (electron/activation.ts, with the vendored activation-code.js); the Activate dialog,
// the status bar and the reminder show the result in these words. Pure functions, shared by both sides.

export type ActivationProduct = "kineticlane" | "syncora" | "bundle";
export type ActivationPlan = "month" | "quarter" | "year" | "trial" | "custom";
/** Why a code is refused: not a code · not signed by OrbitOne · for the other app · its plan has ended. */
export type ActivationReason = "format" | "signature" | "product" | "expired";

/** What `OrbitActivation.checkCode` answers (the fields after `reason` are there once the signature is genuine). */
export interface CodeCheck {
  ok: boolean;
  reason?: ActivationReason;
  product?: ActivationProduct;
  plan?: ActivationPlan;
  /** The plan's last day, "YYYY-MM-DD": valid through that day by this computer's date. */
  expires?: string;
  /** The code ID (8 characters), as the Code Maker lists it. */
  serial?: string;
  /** Days from today to the last day: 0 on the last day, negative once the plan has ended. */
  daysLeft?: number;
}

export interface PlanInfo {
  product: ActivationProduct;
  plan: ActivationPlan;
  expires: string;
  serial: string;
  daysLeft: number;
}

/**
 * none: no code on this computer yet · active · ending: REMIND_DAYS or fewer days left · expired: the plan has ended ·
 * invalid: the saved code is no longer accepted (edited by hand, or signed with a key that was replaced).
 */
export type ActivationState = "none" | "active" | "ending" | "expired" | "invalid";

export interface ActivationStatus {
  state: ActivationState;
  /** The saved code's plan; null when there is no code or it cannot be read. */
  plan: PlanInfo | null;
  /** invalid: why the saved code is refused. */
  reason: ActivationReason | null;
}

/** A pasted code: accepted (it replaced the saved one), or refused with the saved code's status unchanged. */
export type ActivationAttempt =
  | { ok: true; status: ActivationStatus }
  | { ok: false; reason: ActivationReason; plan: PlanInfo | null; status: ActivationStatus };

/** Reminders start this many days before the plan's last day (as the store promises). */
export const REMIND_DAYS = 7;

export const NOT_ACTIVATED: ActivationStatus = { state: "none", plan: null, reason: null };

export function planInfo(check: CodeCheck): PlanInfo | null {
  const { product, plan, expires, serial, daysLeft } = check;
  if (!product || !plan || !expires || !serial || daysLeft === undefined) return null;
  return { product, plan, expires, serial, daysLeft };
}

/** The status of the code saved on this computer, from its check (null: no code saved). */
export function statusFromCheck(check: CodeCheck | null): ActivationStatus {
  if (!check) return NOT_ACTIVATED;
  const plan = planInfo(check);
  if (check.ok && plan) return { state: plan.daysLeft <= REMIND_DAYS ? "ending" : "active", plan, reason: null };
  if (check.reason === "expired" && plan) return { state: "expired", plan, reason: null };
  return { state: "invalid", plan, reason: check.reason ?? "format" };
}

/** The plan is running (reminders included). */
export function isActivated(status: ActivationStatus | null): boolean {
  return status?.state === "active" || status?.state === "ending";
}

/**
 * Engine methods that need a running plan (the owner's choice, 2026-10-24): writing XML and the AI first cut.
 * Projects, import, sync, review, transcripts and search work without one.
 */
export const PLAN_METHODS: readonly string[] = ["export.xml", "edit.first_cut"];
/** The error the main process answers PLAN_METHODS with while there is no running plan. */
export const ACTIVATION_REQUIRED = -32010;
export const ACTIVATION_REQUIRED_MESSAGE =
  "Exporting XML and the AI first cut need an active Syncora plan. Activate Syncora (File → Activate Syncora…), then try again: your project stays as it is.";

// ------------------------------------------------------------------------------------------------------------- words

// The names the Code Maker writes in the buyer's message.
const PLAN_NAMES: Record<ActivationPlan, string> = {
  month: "1 month",
  quarter: "3 months",
  year: "1 year",
  trial: "7-day free trial",
  custom: "Custom plan",
};

const PRODUCT_NAMES: Record<ActivationProduct, string> = {
  kineticlane: "KineticLane",
  syncora: "Syncora",
  bundle: "KineticLane + Syncora",
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const planName = (plan: ActivationPlan): string => PLAN_NAMES[plan];
export const productName = (product: ActivationProduct): string => PRODUCT_NAMES[product];

/** "2026-11-24" → "24 November 2026", as in the buyer's message (a calendar day: no time zone). */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const month = MONTHS[(m ?? 1) - 1];
  return month && y && d ? `${d} ${month} ${y}` : iso;
}

/** Today on this computer, "YYYY-MM-DD" (codes are valid through their last day by the local date). */
export function localDay(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function daysLeftText(daysLeft: number): string {
  if (daysLeft < 0) return "ended";
  if (daysLeft === 0) return "last day today";
  return daysLeft === 1 ? "1 day left" : `${daysLeft} days left`;
}

/** Why a pasted code was refused, and what to do instead. */
export function reasonText(reason: ActivationReason, plan: PlanInfo | null): string {
  switch (reason) {
    case "format":
      return "This is not an activation code. Copy the whole code (117 letters and numbers) from the WhatsApp message or email you received, and paste it here.";
    case "signature":
      return "This code was not made by OrbitOne Studios, or part of it changed while it was copied. Copy it again from the message you received.";
    case "product":
      return `This code is for ${plan ? productName(plan.product) : "another app"}, not Syncora. Paste your Syncora code, or a KineticLane + Syncora code.`;
    case "expired":
      return plan
        ? `This code ended on ${longDate(plan.expires)}. Paste the code for your new plan.`
        : "This code has ended. Paste the code for your new plan.";
  }
}

/** Why the export or the first cut asks for a code first (shown in their dialogs). */
export function planRequiredText(status: ActivationStatus | null, what: "Exporting XML" | "The AI first cut"): string {
  const ended =
    status?.state === "expired" && status.plan ? `Your plan ended on ${longDate(status.plan.expires)}. ` : "";
  return `${ended}${what} needs an active Syncora plan. Everything else keeps working and your project stays as it is: activate, then carry on.`;
}

/** The status bar's activation item; null while the plan runs with more than REMIND_DAYS left. */
export function statusLine(
  status: ActivationStatus,
): { text: string; action: string; tone: "info" | "warn" | "error" } | null {
  const plan = status.plan;
  switch (status.state) {
    case "none":
      return { text: "Not activated", action: "Activate", tone: "info" };
    case "ending":
      return {
        text: plan && plan.daysLeft > 0 ? `Plan ends in ${daysWord(plan.daysLeft)}` : "Plan ends today",
        action: "Enter new code",
        tone: "warn",
      };
    case "expired":
      return {
        text: plan ? `Plan ended ${longDate(plan.expires)}` : "Plan ended",
        action: "Enter new code",
        tone: "error",
      };
    case "invalid":
      return { text: "Activation code not accepted", action: "Activate", tone: "error" };
    case "active":
      return null;
  }
}

/** The reminder shown when Syncora opens: from REMIND_DAYS before the last day, and after it. */
export function reminder(status: ActivationStatus): { title: string; body: string } | null {
  const plan = status.plan;
  const what = plan?.plan === "trial" ? "trial" : "plan";
  if (status.state === "ending" && plan) {
    return {
      title:
        plan.daysLeft > 0
          ? `Your Syncora ${what} ends in ${daysWord(plan.daysLeft)}`
          : `Your Syncora ${what} ends today`,
      body: `It works until ${longDate(plan.expires)}. Renew at any time: a code bought early starts when this one ends, so no days are lost.`,
    };
  }
  if (status.state === "expired") {
    return {
      title: `Your Syncora ${what} has ended`,
      body: `${plan ? `It ended on ${longDate(plan.expires)}. ` : ""}Exporting XML and the AI first cut need a new code; everything else keeps working. Your projects and original media stay exactly as they are.`,
    };
  }
  if (status.state === "invalid") {
    return {
      title: "Syncora is not activated",
      body: "The activation code saved on this computer is no longer accepted. Paste your code again.",
    };
  }
  return null;
}

function daysWord(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}
