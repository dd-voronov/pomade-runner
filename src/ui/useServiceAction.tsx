import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { SERVICE_ACTION_TIMEOUT_MS, SERVICE_METHODS, type ServiceVerb } from "../integrations/runner-api";
import { isServiceActionResult } from "../keeper/model";
import { useToast } from "./kit";

const DONE: Record<ServiceVerb, string> = { start: "started", restart: "restarted", stop: "stopped by you — it stays stopped until Start" };

/** Start, Stop or Restart a service through the scheduler, by its id; the toast says what it did or
 *  why it was refused. The Services view and the Jobs view share it. */
export function useServiceAction(host: HostClient): (verb: ServiceVerb, service: { id: string; name: string }) => void {
  const toast = useToast();
  return (verb, service) => {
    host.apps.call(APP_ID, SERVICE_METHODS[verb], { job: service.id }, { timeoutMs: SERVICE_ACTION_TIMEOUT_MS }).then(
      (answer: unknown) => {
        if (!isServiceActionResult(answer)) toast(`Could not ${verb} ${service.name}: the scheduler answered something else`);
        else if (answer.ok)
          toast(
            <>
              <b>{service.name}</b> {DONE[verb]}
            </>,
          );
        else toast(`Could not ${verb} ${service.name}: ${answer.reason}`);
      },
      (err: unknown) => toast(`Could not ${verb} ${service.name}: ${err instanceof Error ? err.message : String(err)}`),
    );
  };
}
