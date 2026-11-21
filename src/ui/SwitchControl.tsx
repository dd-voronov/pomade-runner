import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { SWITCH_METHOD } from "../integrations/runner-api";
import { SWITCH_POSITIONS, SWITCH_WORDS, type SwitchPosition, type SwitchState } from "../scheduler/model";
import type { HelpKey } from "./help";
import { Help, Segmented, type DotTone } from "./kit";
import styles from "./SwitchControl.module.css";
import { useAction } from "./useAction";

/** Each position's words in a narrow panel, its dot, its help and what it holds. */
const POSITION: Record<SwitchPosition, { short: string; tone: DotTone; help: HelpKey; held: string | null }> = {
  running: { short: "Running", tone: "ok", help: "sw.running", held: null },
  "pause-low": { short: "Pause low", tone: "warning", help: "sw.low", held: "Low-priority jobs are held." },
  "pause-all": { short: "Pause all", tone: "warning", help: "sw.all", held: "Every scheduled job is held." },
};

/** The global switch, pinned above the panel's scroll: Running · Pause low-priority · Pause all, on
 *  the panel's three-position control; below 268 px the middle one reads "Pause low". A position that
 *  holds runs says so, and that services keep running; the (i) tells what becomes of a held run. */
export function SwitchControl({ host, state }: { host: HostClient; state: SwitchState }): React.JSX.Element {
  const action = useAction();
  const { held } = POSITION[state.position];
  return (
    <div className={styles.root} data-testid="switch" data-position={state.position}>
      <Segmented
        variant="switch"
        label="Runner switch"
        value={state.position}
        options={SWITCH_POSITIONS.map((position) => ({
          value: position,
          label: SWITCH_WORDS[position],
          name: SWITCH_WORDS[position],
          short: POSITION[position].short,
          tone: POSITION[position].tone,
          help: POSITION[position].help,
        }))}
        optionTestId={(position) => `switch-${position}`}
        onChange={(position) => action.run(() => host.apps.call(APP_ID, SWITCH_METHOD, { position }))}
      />
      {held !== null && (
        <div className={styles.note} data-testid="switch-note">
          <span className={styles.words}>{held} Services keep running.</span>
          <Help k="sw.held" />
        </div>
      )}
      {action.error !== null && (
        <p className={styles.error} role="alert">
          {action.error}
        </p>
      )}
    </div>
  );
}
