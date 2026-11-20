import { createContext, Fragment, useContext, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button } from "./Button";
import { FieldError } from "./Field";
import styles from "./Dialog.module.css";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import type { IconName } from "./icons";
import { useFocusTrap } from "./useFocusTrap";

export type DialogTone = "danger" | "warning";

/** The id of the open dialog's title, so `DialogHead` names the dialog. */
const DialogTitleId = createContext<string | undefined>(undefined);

/** A modal card over the whole frame — the result card's frame. Focus moves to the card (or to
 *  `initialFocus`) and stays in; Esc,
 *  the close button or a click on the scrim calls `onClose`; focus goes back where it was. Compose
 *  it from `DialogHead`, `DialogBody` and `DialogFoot`. `narrow` is the confirm's 420 px width. */
export function Dialog({
  label,
  tone,
  narrow = false,
  onClose,
  children,
  testId,
  initialFocus,
}: {
  /** The accessible name, when no `DialogHead` title names it. */
  label?: string | undefined;
  tone?: DialogTone | undefined;
  narrow?: boolean | undefined;
  onClose: () => void;
  children: ReactNode;
  testId?: string | undefined;
  initialFocus?: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const card = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(card, onClose, initialFocus);
  return createPortal(
    <div
      className={styles.scrim}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        // No focus change on the scrim: focus goes back where it was before the dialog.
        event.preventDefault();
        onClose();
      }}
    >
      <div
        ref={card}
        className={narrow ? `${styles.card} ${styles.narrow}` : styles.card}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={label === undefined ? titleId : undefined}
        data-tone={tone}
        data-testid={testId}
        tabIndex={-1}
      >
        <DialogTitleId.Provider value={titleId}>{children}</DialogTitleId.Provider>
      </div>
    </div>,
    document.body,
  );
}

/** A dialog's head: the kind icon, the title with a pill beside it, the meta line (parts joined by
 *  "·") and a why line; the close button at its end. */
export function DialogHead({
  icon,
  iconTip,
  title,
  badge,
  meta,
  why,
  onClose,
}: {
  icon?: IconName | undefined;
  iconTip?: string | undefined;
  title: ReactNode;
  badge?: ReactNode | undefined;
  meta?: readonly ReactNode[] | undefined;
  why?: ReactNode | undefined;
  onClose: () => void;
}): React.JSX.Element {
  const titleId = useContext(DialogTitleId);
  return (
    <div className={styles.head}>
      {icon !== undefined && (
        <span className={styles.icon} data-tip={iconTip}>
          <Icon name={icon} />
        </span>
      )}
      <div className={styles.headMain}>
        <div className={styles.titleLine}>
          <h2 className={styles.title} id={titleId}>
            {title}
          </h2>
          {badge}
        </div>
        {meta !== undefined && meta.length > 0 && (
          <div className={styles.meta}>
            {meta.map((part, index) => (
              <Fragment key={index}>
                {index > 0 && <span className={styles.sep}>·</span>}
                {part}
              </Fragment>
            ))}
          </div>
        )}
        {why !== undefined && <div className={styles.why}>{why}</div>}
      </div>
      <IconButton icon="x" label="Close (Esc)" onClick={onClose} />
    </div>
  );
}

export function DialogBody({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className={styles.body}>{children}</div>;
}

/** A dialog's foot: `children` from the left, `end` pushed to the right edge. */
export function DialogFoot({ children, end }: { children?: ReactNode | undefined; end?: ReactNode | undefined }): React.JSX.Element {
  return (
    <div className={styles.foot}>
      {children}
      {end !== undefined && (
        <>
          <span className={styles.spacer} />
          {end}
        </>
      )}
    </div>
  );
}

/** A yes-or-no question before something that cannot be undone: the title, what happens, Cancel and
 *  the confirming action — red for a destructive one. Cancel has the first focus. While `busy` the
 *  action is under way: the confirming button says `busy` and waits; `error` says why it failed. */
export function ConfirmDialog({
  title,
  children,
  confirm,
  danger = false,
  busy,
  error,
  onConfirm,
  onCancel,
  testId,
}: {
  title: ReactNode;
  children: ReactNode;
  /** The confirming button's words: what it does ("Delete job"). */
  confirm: string;
  danger?: boolean | undefined;
  /** The confirming button's words while the action runs ("Deleting…"); absent when it does not. */
  busy?: string | undefined;
  error?: ReactNode | undefined;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string | undefined;
}): React.JSX.Element {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog narrow onClose={onCancel} testId={testId} initialFocus={cancel}>
      <DialogHead title={title} onClose={onCancel} />
      <DialogBody>
        {children}
        {error !== undefined && error !== null && <FieldError>{error}</FieldError>}
      </DialogBody>
      <DialogFoot
        end={
          <>
            <Button ref={cancel} onClick={onCancel}>
              Cancel
            </Button>
            <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy !== undefined}>
              {busy ?? confirm}
            </Button>
          </>
        }
      />
    </Dialog>
  );
}
