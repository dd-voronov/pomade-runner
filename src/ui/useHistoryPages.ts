// History, a page at a time (`history.list` with `before` and `limit`): the newest page, asked again
// whenever the scheduler announces `runs.changed`, and the older pages the person scrolls to, each
// asked once — a record is written once and never changes, and a page's cursor stays valid while
// new runs land. The held rows come with the newest page, so they are as fresh as it is.

import { useCallback, useEffect, useRef, useState } from "react";
import { HostError, type HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { HISTORY_LIST_METHOD, RUNS_CHANGED_EVENT } from "../integrations/runner-api";
import { isHistoryPage, type HeldRun, type HistoryPage, type RunRecord } from "../scheduler/model";

/** How many records a page asks for. */
export const HISTORY_PAGE = 100;

export type HistoryPages =
  | { status: "loading" }
  | { status: "no-scheduler" }
  | { status: "failed"; message: string }
  | {
      status: "ready";
      /** The jobs the switch holds now, one row each, as the newest page brought them. */
      held: HeldRun[];
      /** Every record loaded, newest first. */
      records: RunRecord[];
      /** Older records remain to load. */
      more: boolean;
      /** An older page is being asked for. */
      loading: boolean;
      /** Ask for the next older page; nothing while one is asked for or none remains. */
      loadOlder: () => void;
    };

const keyOf = (record: RunRecord): string => `${record.job}/${record.run}`;

interface Loaded {
  held: HeldRun[];
  records: RunRecord[];
  /** Where the next older page starts; `null` at the oldest record. */
  next: string | null;
  /** Older pages were loaded beyond the newest one. */
  older: boolean;
}

/** The newest page merged into what is loaded: alone, it is the whole list; with older pages
 *  loaded, it adds the records that landed since. */
function withHead(loaded: Loaded | null, head: HistoryPage): Loaded {
  if (loaded === null || !loaded.older) return { held: head.held, records: head.records, next: head.next, older: false };
  const known = new Set(loaded.records.map(keyOf));
  return { ...loaded, held: head.held, records: [...head.records.filter((record) => !known.has(keyOf(record))), ...loaded.records] };
}

export function useHistoryPages(host: HostClient): HistoryPages {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<{ status: "no-scheduler" } | { status: "failed"; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const current = useRef<Loaded | null>(null);
  useEffect(() => {
    current.current = loaded;
  }, [loaded]);

  const fail = useCallback((err: unknown): void => {
    const absent = err instanceof HostError && (err.code === "app-absent" || err.code === "app-not-responding");
    setProblem(absent ? { status: "no-scheduler" } : { status: "failed", message: err instanceof Error ? err.message : String(err) });
  }, []);

  useEffect(() => {
    let live = true;
    let asked = 0;
    const load = (): void => {
      const call = ++asked;
      host.apps.call(APP_ID, HISTORY_LIST_METHOD, { limit: HISTORY_PAGE }).then(
        (page) => {
          if (!live || call !== asked) return;
          if (!isHistoryPage(page)) {
            setProblem({ status: "failed", message: "the scheduler answered something that is not a history page" });
            return;
          }
          setProblem(null);
          setLoaded((known) => withHead(known, page));
        },
        (err: unknown) => {
          if (live && call === asked) fail(err);
        },
      );
    };
    // Listen first, then ask: a change between the two is heard, never lost.
    const subscription = host.events.subscribe(`${APP_ID}:${RUNS_CHANGED_EVENT}`, load);
    subscription.then(load, load);
    return () => {
      live = false;
      void subscription.then(
        (s) => s.close(),
        () => undefined,
      );
    };
  }, [host, fail]);

  const loadOlder = useCallback((): void => {
    const known = current.current;
    if (loading || known === null || known.next === null) return;
    setLoading(true);
    host.apps.call(APP_ID, HISTORY_LIST_METHOD, { before: known.next, limit: HISTORY_PAGE }).then(
      (page) => {
        setLoading(false);
        if (!isHistoryPage(page)) return;
        setLoaded((now) => {
          if (now === null || now.next !== known.next) return now;
          const have = new Set(now.records.map(keyOf));
          return { held: now.held, records: [...now.records, ...page.records.filter((record) => !have.has(keyOf(record)))], next: page.next, older: true };
        });
      },
      (err: unknown) => {
        setLoading(false);
        fail(err);
      },
    );
  }, [host, loading, fail]);

  if (problem !== null) return problem;
  if (loaded === null) return { status: "loading" };
  return { status: "ready", held: loaded.held, records: loaded.records, more: loaded.next !== null, loading, loadOlder };
}
