import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { SWITCH_METHOD } from "../integrations/runner-api";
import { SWITCH_POSITIONS, SWITCH_WORDS, type SwitchPosition, type SwitchState } from "../scheduler/model";
import type { HelpKey } from "./help";
import { Segmented, type DotTone } from "./kit";
import styles from "./Runs.module.css";
import { useAction } from "./useAction";

/** Each position's words in a narrow panel, its dot and its help. */
const POSITION: Record<SwitchPosition, { short: string; tone: DotTone; help: HelpKey }> = {
  running: { short: "Running", tone: "ok", help: "sw.running" },
  "pause-low": { short: "Pause low", tone: "warning", help: "sw.low" },
  "pause-all": { short: "Pause all", tone: "warning", help: "sw.all" },
};

/** The global switch: Running · Pause low-priority · Pause all, on the panel's three-position
 *  control. Its note is a stand-in until the switch's own slice. */
export function SwitchControl({ host, state }: { host: HostClient; state: SwitchState }): React.JSX.Element {
  const action = useAction();
  return (
    <div className={styles.switchWrap} data-testid="switch" data-position={state.position}>
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
    </div>
  );
}
