// A click that calls Runner or Pomade: what went wrong with the latest one — a refusal the
// scheduler answered (`{ ok: false, reason }`) or a failed call — for the frame to show.

import { useCallback, useState } from "react";

export interface Action {
  /** Run `work`; a refusal or an error becomes `error`. */
  run(work: () => Promise<unknown>): void;
  error: string | null;
}

function refusal(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("ok" in value) || value.ok !== false) return null;
  return "reason" in value && typeof value.reason === "string" ? value.reason : "refused";
}

export function useAction(): Action {
  const [error, setError] = useState<string | null>(null);
  const run = useCallback((work: () => Promise<unknown>) => {
    setError(null);
    work().then(
      (value) => setError(refusal(value)),
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, []);
  return { run, error };
}
