import { useEffect, useRef, useState } from "react";

import styles from "./CommandCell.module.css";

/** A service's command in the Command column: one line cut with "…". Only a cut one is focusable
 *  and carries the whole command as its tooltip (measured, and again whenever the column or the tab
 *  changes size). */
export function CommandCell({ command }: { command: string }): React.JSX.Element {
  const cell = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useEffect(() => {
    const el = cell.current;
    if (el === null) return;
    const measure = (): void => setCut(el.scrollWidth > el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [command]);
  return (
    <div className={styles.cell}>
      <span ref={cell} className={styles.command} data-tip={cut ? command : undefined} data-tip-code={cut ? "" : undefined} tabIndex={cut ? 0 : undefined} data-cut={cut} data-testid="service-command">
        {command}
      </span>
    </div>
  );
}
