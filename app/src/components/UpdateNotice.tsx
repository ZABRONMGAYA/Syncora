// Shown when Syncora opens and a newer version is out: what's new, and the release page to download it from.
import { Download, X } from "lucide-react";
import { useState } from "react";

import { Button } from "../design-system/components";
import { useUpdates } from "../state/updates";

export function UpdateNotice() {
  const notice = useUpdates((s) => s.notice);
  const info = useUpdates((s) => s.info);
  const [notes, setNotes] = useState(false);
  if (!notice || !info) return null;
  const { download, dismiss, skip } = useUpdates.getState();
  const date = info.publishedAt ? new Date(info.publishedAt).toLocaleDateString() : null;
  return (
    <aside className="sy-update" role="dialog" aria-label="Update available" data-testid="update-notice">
      <Download size={20} className="sy-update__icon" aria-hidden />
      <div className="sy-update__main">
        <div className="sy-update__title">Syncora {info.latest} is available</div>
        <div className="sy-update__body">
          You have {info.current}.{date ? ` Released ${date}.` : ""} Projects, settings and models are kept when you
          install it.
        </div>
        {notes && info.notes && <div className="sy-update__notes">{info.notes}</div>}
        <div className="sy-update__actions">
          <Button variant="primary" size="compact" onClick={download}>
            Download
          </Button>
          {info.notes && (
            <Button variant="ghost" size="compact" aria-expanded={notes} onClick={() => setNotes(!notes)}>
              {notes ? "Hide what's new" : "What's new"}
            </Button>
          )}
          <Button variant="ghost" size="compact" onClick={skip}>
            Skip this version
          </Button>
        </div>
      </div>
      <button type="button" className="sy-update__close" aria-label="Remind me later" onClick={dismiss}>
        <X size={14} aria-hidden />
      </button>
    </aside>
  );
}
