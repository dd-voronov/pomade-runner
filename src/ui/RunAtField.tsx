import { parseRunAt } from "../scheduler/missed";
import { Button, TextInput } from "./kit";
import { aheadMoment } from "./panelWords";
import styles from "./RunAtField.module.css";
import { useNow } from "./useNow";

/** What Run at…'s field says before a time is typed. */
const AT_HINT = "Try: tonight 23:00 · tomorrow 7:00 · +2h";

/** Run at…'s field for a missed run that waits for you: the time or phrase as typed, **Set**, and
 *  below what it comes to ("→ today 23:00") or what to try — read as the scheduler reads it
 *  (`parseRunAt`). Esc closes it. `compact` is the panel's card's; the result card's is full size. */
export function RunAtField({
  at,
  setAt,
  onSet,
  onClose,
  compact = false,
}: {
  at: string;
  setAt: (at: string) => void;
  onSet: () => void;
  onClose: () => void;
  compact?: boolean | undefined;
}): React.JSX.Element {
  const now = useNow();
  const parsed = parseRunAt(at, new Date(now));
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSet();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Esc closes the field, not the dialog around it.
        event.stopPropagation();
        onClose();
      }}
    >
      <div className={compact ? `${styles.at} ${styles.compact}` : styles.at}>
        <TextInput width={compact ? "compact" : "text"} aria-label="Run at" placeholder={compact ? undefined : "tonight 23:00"} value={at} onChange={(event) => setAt(event.target.value)} autoFocus />
        <Button type="submit" size={compact ? "sm" : "md"} variant="primary" className={compact ? undefined : styles.set}>
          Set
        </Button>
      </div>
      <div className={compact ? `${styles.hint} ${styles.compact}` : styles.hint} data-testid="run-at-hint">
        {parsed.ok ? `→ ${aheadMoment(parsed.at, now)}` : AT_HINT}
      </div>
    </form>
  );
}
