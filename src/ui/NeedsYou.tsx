import { useState, type ReactNode } from "react";
import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { DISMISS_METHOD, editRoute, jobsRoute, MISSED_METHOD, RESUME_METHOD, RUN_NOW_METHOD, RUN_STOP_METHOD, runRoute, SERVICE_ACTION_TIMEOUT_MS, SERVICE_METHODS } from "../integrations/runner-api";
import { sessionIdOf } from "../keeper/ids";
import { isMissedChoiceResult, isRunActionResult, RUN_ALL_CONFIRM_ABOVE, type NeedsYouItem } from "../scheduler/model";
import { Button, PanelCard, PanelEmpty, useToast } from "./kit";
import styles from "./NeedsYou.module.css";
import { RunAllConfirm } from "./RunAllConfirm";
import { RunAtField } from "./RunAtField";
import { aheadMoment, needLook } from "./panelWords";
import { useNow } from "./useNow";

const bold = (name: string, rest: string): ReactNode => (
  <>
    <b>{name}</b> {rest}
  </>
);

/** A refusal the scheduler answered: `{ ok: false, reason }`. */
function refusal(answer: unknown): string | null {
  if (typeof answer !== "object" || answer === null || !("ok" in answer) || answer.ok !== false) return null;
  return "reason" in answer && typeof answer.reason === "string" ? answer.reason : "refused";
}

/** One Needs-you card: the job's name (it opens what the card is about), the (i) help, the time, the
 *  text, and the item's actions inline. Every outcome and refusal is a toast. */
function NeedCard({ host, item }: { host: HostClient; item: NeedsYouItem }): React.JSX.Element {
  const toast = useToast();
  const now = useNow();
  const look = needLook(item, now);
  const [at, setAt] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  const openRoute = (route: string): void => {
    host.tabs.openApp({ route }).catch((err: unknown) => toast(`Could not open ${item.name}: ${message(err)}`));
  };
  const openSession = (session: string): void => {
    host.tabs.openAttached({ session: { app: APP_ID, session }, title: item.name }).catch((err: unknown) => toast(`Could not open ${item.name}'s terminal: ${message(err)}`));
  };
  /** Call Runner's scheduler; `done` words what came of it. */
  const call = (what: string, method: string, params: Record<string, string>, done: (answer: unknown) => ReactNode | null, timeoutMs?: number): void => {
    host.apps.call(APP_ID, method, params, timeoutMs === undefined ? {} : { timeoutMs }).then(
      (answer) => {
        const reason = refusal(answer);
        if (reason !== null) toast(`Could not ${what} ${item.name}: ${reason}`);
        else {
          const said = done(answer);
          if (said !== null) toast(said);
        }
      },
      (err: unknown) => toast(`Could not ${what} ${item.name}: ${message(err)}`),
    );
  };
  const started = (answer: unknown): ReactNode => bold(item.name, isRunActionResult(answer) && answer.ok && "run" in answer && answer.run.state === "queued" ? "queued" : "started");
  const dismiss = (said: ReactNode | null): void => call("dismiss", DISMISS_METHOD, { id: item.id }, () => said);
  const choose = (choice: "run-now" | "run-at" | "skip" | "run-all", extra: Record<string, string> = {}): void =>
    call(
      "run",
      MISSED_METHOD,
      { job: item.job, choice, ...extra },
      (answer) => {
        if (choice === "skip") return "Recorded as “missed · skipped”";
        if (choice === "run-all") return bold(item.name, `${isMissedChoiceResult(answer) && answer.ok ? answer.runs : count} runs queued, one after another`);
        if (choice === "run-now" || !isMissedChoiceResult(answer) || !answer.ok || answer.at === null) return started(answer);
        return bold(item.name, `will run ${aheadMoment(answer.at, Date.now())}`);
      },
    );

  /** The runs a missed run stands for; Run all asks once more above `RUN_ALL_CONFIRM_ABOVE`. */
  const count = item.kind === "missed" ? (item.missed?.count ?? 1) : 1;
  const runAll = (): void => (count > RUN_ALL_CONFIRM_ABOVE ? setConfirming(true) : choose("run-all"));

  let title: () => void;
  let actions: ReactNode;
  switch (item.kind) {
    case "run-failed":
      title = () => openRoute(runRoute(item.job, item.run));
      actions = (
        <>
          <Button size="sm" variant="primary" onClick={title}>
            Open
          </Button>
          <Button size="sm" onClick={() => call("run", RUN_NOW_METHOD, { job: item.job }, started)}>
            Run now
          </Button>
          <Button size="sm" onClick={() => dismiss(null)}>
            Dismiss
          </Button>
        </>
      );
      break;
    case "service-failed": {
      // A service whose command never started has no session: its name opens the job instead.
      const output = (): void => openSession(sessionIdOf({ kind: "service", job: item.job }) ?? "");
      title = item.session ? output : () => openRoute(jobsRoute(item.job));
      actions = (
        <>
          <Button size="sm" variant="primary" onClick={() => call("start", SERVICE_METHODS.start, { job: item.job }, started, SERVICE_ACTION_TIMEOUT_MS)}>
            Start
          </Button>
          {item.session && (
            <Button size="sm" onClick={output}>
              View output
            </Button>
          )}
        </>
      );
      break;
    }
    case "missed":
      title = () => openRoute(runRoute(item.job, item.run));
      actions = (
        <>
          <Button size="sm" variant="primary" onClick={() => choose("run-now")}>
            {count > 1 ? "Run once" : "Run now"}
          </Button>
          {count > 1 && (
            <Button size="sm" onClick={runAll}>
              Run all {count}
            </Button>
          )}
          <Button size="sm" aria-expanded={at !== null} onClick={() => setAt(at === null ? "tonight 23:00" : null)}>
            Run at…
          </Button>
          <Button size="sm" onClick={() => choose("skip")}>
            Skip
          </Button>
        </>
      );
      break;
    case "waiting":
      title = () => openRoute(runRoute(item.job, item.run));
      actions = (
        <Button size="sm" variant="primary" onClick={() => openSession(sessionIdOf({ kind: "run", job: item.job, run: item.run }) ?? "")}>
          Open at the prompt
        </Button>
      );
      break;
    case "long-run": {
      const open = (): void => openSession(sessionIdOf({ kind: "run", job: item.job, run: item.run }) ?? "");
      title = () => openRoute(runRoute(item.job, item.run));
      actions = (
        <>
          <Button size="sm" onClick={open}>
            Open
          </Button>
          <Button size="sm" onClick={() => call("stop", RUN_STOP_METHOD, { job: item.job, run: item.run }, () => bold(item.name, "stopped by you"))}>
            Stop
          </Button>
          <Button size="sm" onClick={() => dismiss("OK — it keeps running. No more reminders for this run.")}>
            Dismiss
          </Button>
        </>
      );
      break;
    }
    case "loop-paused":
      title = () => openRoute(jobsRoute(item.job));
      actions = (
        <>
          <Button size="sm" variant="primary" onClick={() => call("resume", RESUME_METHOD, { job: item.job }, () => bold(item.name, "resumed"))}>
            Resume
          </Button>
          <Button size="sm" onClick={() => openRoute(editRoute(item.job))}>
            Edit job
          </Button>
        </>
      );
      break;
  }
  return (
    <div data-testid="needs-you-item" data-kind={item.kind}>
      <PanelCard
      title={
        <button type="button" className={styles.title} onClick={title}>
          {item.name}
        </button>
      }
      dot={look.tone}
      help={look.help}
      when={look.when}
      actions={actions}
      extra={at !== null && item.kind === "missed" ? <RunAtField compact at={at} setAt={setAt} onSet={() => choose("run-at", { at })} onClose={() => setAt(null)} /> : undefined}
    >
        <span data-testid="needs-you-words">{look.text}</span>
      </PanelCard>
      {confirming && (
        <RunAllConfirm
          name={item.name}
          count={count}
          action={`Run all ${count}`}
          onConfirm={() => {
            setConfirming(false);
            choose("run-all");
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

/** Needs you's content: a card per item, each with its actions inline. */
export function NeedsYou({ host, items }: { host: HostClient; items: readonly NeedsYouItem[] }): React.JSX.Element {
  return (
    <div data-testid="needs-you">
      {items.length === 0 ? (
        <PanelEmpty>Nothing needs you.</PanelEmpty>
      ) : (
        items.map((item) => <NeedCard key={item.id} host={host} item={item} />)
      )}
    </div>
  );
}
