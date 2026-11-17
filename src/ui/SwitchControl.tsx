import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { SWITCH_METHOD } from "../integrations/runner-api";
import { SWITCH_POSITIONS, SWITCH_WORDS, type SwitchState } from "../scheduler/model";
import styles from "./Runs.module.css";
import { useAction } from "./useAction";

/** The global switch: Running · Pause low-priority · Pause all. A stand-in until the panel's real
 *  three-position switch. */
export function SwitchControl({ host, state }: { host: HostClient; state: SwitchState }): React.JSX.Element {
  const action = useAction();
  return (
    <section className={styles.section} data-testid="switch" data-position={state.position}>
      <div className={styles.switch} role="group" aria-label="Runner switch">
        {SWITCH_POSITIONS.map((position) => (
          <button
            key={position}
            type="button"
            className={styles.switchButton}
            aria-pressed={state.position === position}
            data-testid={`switch-${position}`}
            onClick={() => action.run(() => host.apps.call(APP_ID, SWITCH_METHOD, { position }))}
          >
            {SWITCH_WORDS[position]}
          </button>
        ))}
      </div>
      {state.position !== "running" && (
        <p className={styles.note} data-testid="switch-note">
          {state.position === "pause-low" ? "Low-priority runs are held." : "Every scheduled run is held."} Services keep running; held runs follow their missed-run policy on resume.
        </p>
      )}
      {action.error !== null && (
        <p className={styles.error} role="alert">
          {action.error}
        </p>
      )}
    </section>
  );
}
