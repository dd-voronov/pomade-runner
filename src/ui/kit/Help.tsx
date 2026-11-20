import type { HelpKey } from "../help";
import styles from "./Help.module.css";
import { Icon } from "./Icon";

/** The (i) beside a field, policy or status: hovering or focusing it shows its help text — what it
 *  does and a one-line example — from `help.ts`. */
export function Help({ k, className }: { k: HelpKey; className?: string | undefined }): React.JSX.Element {
  return (
    <button type="button" className={className === undefined ? styles.root : `${styles.root} ${className}`} data-help={k} aria-label="Help" data-testid={`help-${k}`}>
      <Icon name="info" size={14} />
    </button>
  );
}
