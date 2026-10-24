// Activate: one field for the code received after buying a plan, checked on this computer (no internet, no account).
// Opened from Settings → Activation, Settings → About, File → Activate Syncora…, the status bar and the reminder.
import { Check, CircleX, KeyRound, type LucideIcon, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";

import { Button, Dialog } from "../design-system/components";
import {
  type ActivationReason,
  type ActivationStatus,
  type PlanInfo,
  daysLeftText,
  longDate,
  planName,
  productName,
  reasonText,
} from "../lib/activation";
import { useActivation } from "../state/activation";
import { useApp } from "../state/store";

export function ActivateDialog() {
  const open = useActivation((s) => s.dialog);
  // A fresh form each time it opens; above the Settings sheet when opened from there.
  return open ? (
    <div className="sy-over-settings">
      <ActivateForm />
    </div>
  ) : null;
}

function ActivateForm() {
  const status = useActivation((s) => s.status);
  const close = () => useActivation.getState().closeDialog();
  const [code, setCode] = useState("");
  const [checking, setChecking] = useState(false);
  const [refused, setRefused] = useState<{ reason: ActivationReason; plan: PlanInfo | null } | null>(null);
  const [accepted, setAccepted] = useState(false);
  const fieldId = useId();
  const errorId = useId();

  async function submit() {
    if (!code.trim() || checking) return;
    setChecking(true);
    try {
      const attempt = await useActivation.getState().activate(code);
      if (attempt.ok) {
        setAccepted(true);
        setCode("");
        setRefused(null);
      } else {
        setRefused({ reason: attempt.reason, plan: attempt.plan });
      }
    } catch (err) {
      useApp.getState().toast("error", `The code could not be checked: ${err instanceof Error ? err.message : err}`);
    } finally {
      setChecking(false);
    }
  }

  if (accepted && status?.plan) {
    return (
      <Dialog
        title="Syncora is activated"
        icon={Check}
        iconTone="success"
        onClose={close}
        testId="activate-dialog"
        footer={
          <>
            <span className="sy-spacer" />
            <Button variant="primary" size="36" onClick={close}>
              Done
            </Button>
          </>
        }
      >
        <p>Your code is saved on this computer and is checked offline each time Syncora opens. Thank you.</p>
        <PlanFacts status={status} />
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Activate Syncora"
      icon={KeyRound}
      iconTone="info"
      onClose={close}
      testId="activate-dialog"
      footer={
        <>
          <Button variant="ghost" size="36" onClick={close}>
            {status?.state === "none" ? "Not now" : "Close"}
          </Button>
          <span className="sy-spacer" />
          <Button
            variant="primary"
            size="36"
            loading={checking}
            loadingLabel="Checking…"
            disabled={!code.trim()}
            onClick={() => void submit()}
            data-testid="activate-submit"
          >
            Activate
          </Button>
        </>
      }
    >
      <p>{introText(status)}</p>
      {status?.plan && <PlanFacts status={status} />}
      <div className="sy-field sy-activate__field">
        <label htmlFor={fieldId} className="sy-activate__label" data-error={refused ? true : undefined}>
          Paste your activation code
        </label>
        <textarea
          id={fieldId}
          className="sy-input sy-activate__code"
          rows={3}
          value={code}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={refused ? true : undefined}
          aria-describedby={refused ? errorId : undefined}
          data-testid="activate-code"
          onChange={(e) => {
            setCode(e.target.value);
            setRefused(null);
          }}
          onKeyDown={(e) => {
            // A code has no line breaks: Enter activates.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {refused && (
          <div id={errorId} className="sy-activate__error" role="alert" data-testid="activate-error">
            <CircleX size={14} aria-hidden />
            <span>{reasonText(refused.reason, refused.plan)}</span>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function introText(status: ActivationStatus | null): string {
  const plan = status?.plan;
  switch (status?.state) {
    case "active":
      return "Syncora is activated. To renew, paste your new code at any time: a code bought early starts when this one ends, so no days are lost.";
    case "ending":
      return `Your plan ends on ${plan ? longDate(plan.expires) : "its last day"}. Paste your new code to renew: a code bought early starts when this one ends.`;
    case "expired":
      return `Your plan ended${plan ? ` on ${longDate(plan.expires)}` : ""}. Paste the code for a new plan to export XML and make AI first cuts again. Your projects and original media stay exactly as they are.`;
    case "invalid":
      return "The activation code saved on this computer is no longer accepted. Paste your code again.";
    default:
      return "Paste the code you received after buying a plan: it unlocks Export XML and the AI first cut. Syncora checks it on this computer, with no internet or account.";
  }
}

/** The saved code's plan: what it is for, its last day, its ID. */
function PlanFacts({ status }: { status: ActivationStatus }) {
  const plan = status.plan;
  if (!plan) return null;
  return (
    <dl className="sy-kv sy-activate__facts" data-testid="activate-plan">
      <dt>Status</dt>
      <dd>
        <ActivationBadge status={status} />
      </dd>
      <dt>Plan</dt>
      <dd>{planName(plan.plan)}</dd>
      <dt>For</dt>
      <dd>{productName(plan.product)}</dd>
      <dt>Last day</dt>
      <dd className="tnum">
        {longDate(plan.expires)} · {daysLeftText(plan.daysLeft)}
      </dd>
      <dt>Code ID</dt>
      <dd className="sy-mono">{plan.serial}</dd>
    </dl>
  );
}

const BADGES: Record<ActivationStatus["state"], { icon: LucideIcon; tone: string }> = {
  active: { icon: Check, tone: "sy-ok" },
  ending: { icon: TriangleAlert, tone: "sy-warn" },
  expired: { icon: CircleX, tone: "sy-activate--error" },
  invalid: { icon: CircleX, tone: "sy-activate--error" },
  none: { icon: KeyRound, tone: "sy-dim" },
};

/** In the export and first-cut dialogs while there is no running plan: why their action is Activate… instead. */
export function PlanRequired({ text }: { text: string }) {
  return (
    <p className="notice plan-required" role="status" data-testid="plan-required">
      <KeyRound size={14} aria-hidden />
      <span>{text}</span>
    </p>
  );
}

/** Icon + word + colour for the plan's state (Settings, About, the dialog). */
export function ActivationBadge({ status }: { status: ActivationStatus }) {
  const { icon: Icon, tone } = BADGES[status.state];
  const days = status.plan?.daysLeft ?? 0;
  const word = {
    active: "Activated",
    ending: days > 0 ? `Ends in ${days === 1 ? "1 day" : `${days} days`}` : "Ends today",
    expired: "Ended",
    invalid: "Code not accepted",
    none: "Not activated",
  }[status.state];
  return (
    <span className={`sy-activate__badge ${tone}`} data-testid="activation-badge">
      <Icon size={13} aria-hidden />
      {word}
    </span>
  );
}
