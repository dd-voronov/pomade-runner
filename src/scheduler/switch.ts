// The global switch's position — Running · Pause low-priority · Pause all — kept in Runner's
// records folder in the workspace (`switch.json`), so it survives a restart of the scheduler and of
// the Mac, and goes with a copy of the workspace.
// What it holds is the queue's rule (`queue.ts`, `holds`).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { switchRecordPath, type RecordsFolder } from "../locations";
import type { Log } from "./log";
import { isSwitchState, type SwitchState } from "./model";

export const DEFAULT_SWITCH: SwitchState = { position: "running", since: null };

export interface SwitchStore {
  load(): Promise<SwitchState>;
  /** Keep the position; writes happen in order and never overlap. */
  save(state: SwitchState): void;
  flush(): Promise<void>;
}

/** The position in `<records>/switch.json`; a missing or unreadable file is Running. */
export function fileSwitchStore(records: RecordsFolder, log: Log): SwitchStore {
  const file = switchRecordPath(records);
  let writing: Promise<void> = Promise.resolve();
  return {
    async load() {
      let data: unknown;
      try {
        data = JSON.parse(await readFile(file, "utf8"));
      } catch {
        return DEFAULT_SWITCH;
      }
      if (isSwitchState(data)) return data;
      log(`switch: ${file} is not a switch position; Running`);
      return DEFAULT_SWITCH;
    },
    save(next) {
      const data = `${JSON.stringify(next, null, 2)}\n`;
      writing = writing
        .then(async () => {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(`${file}.tmp`, data);
          await rename(`${file}.tmp`, file);
        })
        .catch((err: unknown) => log(`switch: cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`));
    },
    flush: () => writing,
  };
}
