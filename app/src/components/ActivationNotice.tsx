// Shown each day from 7 days before the plan's last day, and after it: renew with a new code. Projects and media are
// never touched.
import { CircleX, TriangleAlert, X } from "lucide-react";

import { Button } from "../design-system/components";
import { reminder } from "../lib/activation";
import { useActivation } from "../state/activation";

export function ActivationNotice() {
  const notice = useActivation((s) => s.notice);
  const status = useActivation((s) => s.status);
  const words = status ? reminder(status) : null;
  if (!notice || !status || !words) return null;
  const { openDialog, dismiss } = useActivation.getState();
  const ending = status.state === "ending";
  const Icon = ending ? TriangleAlert : CircleX;
  return (
    <aside
      className={`sy-update ${ending ? "sy-update--warn" : "sy-update--error"}`}
      role="dialog"
      aria-label={words.title}
      data-testid="activation-notice"
    >
      <Icon size={20} className="sy-update__icon" aria-hidden />
      <div className="sy-update__main">
        <div className="sy-update__title">{words.title}</div>
        <div className="sy-update__body">{words.body}</div>
        <div className="sy-update__actions">
          <Button variant="primary" size="compact" onClick={openDialog}>
            {status.state === "invalid" ? "Activate" : "Enter new code"}
          </Button>
          <Button variant="ghost" size="compact" onClick={dismiss}>
            Remind me tomorrow
          </Button>
        </div>
      </div>
      <button type="button" className="sy-update__close" aria-label="Remind me tomorrow" onClick={dismiss}>
        <X size={14} aria-hidden />
      </button>
    </aside>
  );
}
