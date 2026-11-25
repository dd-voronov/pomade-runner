import { useEffect, useState } from "react";
import { WORKSPACE_PROJECT_ID, type GitRunResult } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { DISMISS_METHOD, editRoute, MISSED_METHOD, outputTab, RUN_NOW_METHOD, runRoute } from "../integrations/runner-api";
import {
  isMissedChoiceResult,
  isRunActionResult,
  LAST_LINES,
  limitWords,
  missedRunsWords,
  otherMissedRuns,
  plainLines,
  RUN_ALL_CONFIRM_ABOVE,
  runWords,
  TRIGGER_WORDS,
  waitingAt,
  waitsForBackground,
  type ActiveRun,
  type AgentRun,
  type AgentWait,
  type JobRuns,
  type NeedsYouItem,
  type RunRecord,
  type RunView,
} from "../scheduler/model";
import type { LastMessage } from "../integrations/agents";
import { NO_ANSWER_REASON } from "../scheduler/agent-runs";
import { MessageText } from "./MessageText";
import { Button, Dialog, DialogBody, DialogFoot, DialogHead, Help, Icon, LinkButton, Pill, useToast } from "./kit";
import styles from "./RunCard.module.css";
import { terminalLabel } from "./rowRun";
import { dayWords, isRecord, KIND_WORDS, promptLines, runDuration, runLook, runningSince, runTime, shortDuration, slotHolders, TRIGGER_HELP, waitsSentence, whenWords, whyWords } from "./runLook";
import { useOpenRunTerminal, useStopRun } from "./useRunActions";
import { shortClock, upWords } from "./serviceWords";
import { aheadMoment } from "./panelWords";
import { RunAllConfirm } from "./RunAllConfirm";
import { RunAtField } from "./RunAtField";
import { NO_SESSION, useLastMessage, type AgentsState } from "./useAgents";
import { useRunningNow } from "./useNow";
import { useRunOutput } from "./useRunOutput";
import { useRun } from "./useRunnerApi";

/** A run's result card (the prototype's `cardHtml`), a dialog over History that Esc, the close
 *  button or a click outside closes back to History. Its head says the run's job, result, when,
 *  how long and what started it; its body what the run left — exit code and last lines, a git
 *  run's repos, why one never started, what a queued one waits for; its foot what can be done —
 *  View output opens the run's output tab beside the Runner tab.
 *  Opening a failed run that is a Needs-you item resolves the item. */
export function RunDialog({
  host,
  job,
  run,
  needsYou,
  active,
  jobs,
  open,
}: {
  host: HostClient;
  job: string;
  run: string;
  needsYou: readonly NeedsYouItem[];
  /** The runs going: a queued run's card names the low-priority ones holding the slots. */
  active: readonly ActiveRun[];
  /** Each job's runs: a caught-up run's card offers Run the other N while it is its job's latest. */
  jobs: readonly JobRuns[];
  open: (route: string) => void;
}): React.JSX.Element {
  const close = (): void => open("history");
  const view = useRun(host, job, run);
  const item = needsYou.find((candidate) => candidate.kind === "run-failed" && candidate.job === job && candidate.run === run);

  useEffect(() => {
    if (item !== undefined) host.apps.call(APP_ID, DISMISS_METHOD, { id: item.id }).catch(() => undefined);
  }, [host, item]);

  const value = view.status === "ready" ? view.value : null;
  if (value === null) {
    return (
      <Dialog onClose={close} testId="run-dialog" label={view.status === "loading" ? "Result" : undefined}>
        {view.status === "loading" ? (
          <DialogHead title="" onClose={close} />
        ) : (
          <>
            <DialogHead title="Result" onClose={close} />
            <DialogBody>
              <p className={styles.problem} role="alert" data-testid="run-missing">
                {view.status === "ready" ? "This run is not in the history any more." : view.status === "failed" ? view.message : "Runner's scheduler is not running."}
              </p>
            </DialogBody>
          </>
        )}
      </Dialog>
    );
  }
  return (
    <Dialog onClose={close} testId="run-dialog" tone={runLook(value).cardTone}>
      <RunCard host={host} view={value} going={slotHolders(active)} others={otherMissedRuns(value, jobs.find((info) => info.job === value.job)?.last ?? null, active)} open={open} close={close} />
    </Dialog>
  );
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function RunCard({
  host,
  view,
  going,
  others,
  open,
  close,
}: {
  host: HostClient;
  view: RunView;
  going: readonly string[];
  /** A caught-up run's other missed runs it can still run (Run the other N); 0 for none. */
  others: number;
  open: (route: string) => void;
  close: () => void;
}): React.JSX.Element {
  const now = useRunningNow(runningSince([view]), 10_000);
  const toast = useToast();
  const [runAt, setRunAt] = useState<string | null>(null);
  /** The Run all waiting for the confirm above `RUN_ALL_CONFIRM_ABOVE` runs: how many it runs. */
  const [confirming, setConfirming] = useState<{ choice: "run-all" | "run-others"; count: number } | null>(null);
  const look = runLook(view);
  const duration = runDuration(view, now);
  const parent = view.cause?.kind === "chain" ? view.cause : null;
  const why =
    parent !== null ? (
      <>
        After{" "}
        <LinkButton aria-label={`Open ${parent.name}'s run`} data-tip={`Open ${parent.name}'s run`} onClick={() => open(runRoute(parent.job, parent.run))}>
          {parent.name}
        </LinkButton>
        : {parent.result}
      </>
    ) : (
      whyWords(view, now)
    );
  const meta = [
    <span key="when" data-testid="run-when">
      {whenWords(runTime(view), now)}
    </span>,
    ...(duration === null ? [] : [<span key="duration" data-testid="run-duration">{view.state === "running" ? upWords(duration) : shortDuration(duration)}</span>]),
    <span key="trigger" className={styles.helped} data-help={TRIGGER_HELP[view.trigger]} data-testid="run-trigger">
      {TRIGGER_WORDS[view.trigger]}
    </span>,
    ...(view.agent === null ? [] : [<span key="agent" data-testid="run-agent">{`${view.agent.name} · ${view.agent.modeName}`}</span>]),
  ];

  const failed = (what: string) => (err: unknown) => toast(`Could not ${what}: ${err instanceof Error ? err.message : String(err)}`);
  const stopRun = useStopRun(host);
  const stop = (): void => stopRun(view, close);
  const runNow = (): void => {
    host.apps.call(APP_ID, RUN_NOW_METHOD, { job: view.job }).then(
      (answer: unknown) => {
        if (isRunActionResult(answer) && !answer.ok) return toast(`Could not run ${view.name}: ${answer.reason}`);
        const queued = isRunActionResult(answer) && "run" in answer && answer.run.state === "queued";
        toast(
          <>
            <b>{view.name}</b> {queued ? "queued" : "started"} · trigger “manual”
          </>,
        );
      },
      failed(`run ${view.name}`),
    );
  };
  const choose = (params: { choice: "run-now" | "skip" | "run-all" } | { choice: "run-at"; at: string } | { choice: "run-others"; run: string }): void => {
    host.apps.call(APP_ID, MISSED_METHOD, { job: view.job, ...params }).then(
      (answer: unknown) => {
        if (isMissedChoiceResult(answer) && !answer.ok) return toast(`Could not ${params.choice === "skip" ? "skip" : "run"} ${view.name}: ${answer.reason}`);
        const settled = isMissedChoiceResult(answer) && answer.ok ? answer : null;
        const at = settled?.at ?? null;
        const many = params.choice === "run-all" || params.choice === "run-others";
        toast(
          params.choice === "skip" ? (
            "Recorded as “missed · skipped”"
          ) : (
            <>
              <b>{view.name}</b>{" "}
              {many ? `${settled?.runs ?? "the"} runs queued, one after another` : params.choice === "run-at" && at !== null ? `will run ${aheadMoment(at, Date.now())}` : "started"}
            </>
          ),
        );
        close();
      },
      failed(`settle ${view.name}`),
    );
  };
  /** Run all, or Run the other N: `count` runs, asked once more above `RUN_ALL_CONFIRM_ABOVE`. */
  const runMany = (choice: "run-all" | "run-others", count: number): void => {
    if (count > RUN_ALL_CONFIRM_ABOVE) return setConfirming({ choice, count });
    choose(choice === "run-all" ? { choice } : { choice, run: view.run });
  };
  const missedCount = view.missed?.count ?? 1;
  const openOutput = (): void => {
    host.tabs.openApp(outputTab(view.job, view.run, view.name)).catch(failed(`open ${view.name}'s output`));
  };
  const openSession = (agent: string, session: string): void => {
    // The session in a Pomade agent tab, in the job's project, in the folder it ran in.
    host.agentTabs
      .resume({ agentId: agent, sessionId: session, projectId: view.project ?? WORKSPACE_PROJECT_ID, ...(view.folder === "" ? {} : { cwd: view.folder }) })
      .catch(failed(`open ${view.name}'s session`));
  };
  const openRunTerminal = useOpenRunTerminal(host);
  const openTerminal = (session: string): void => openRunTerminal(view, session);

  const record = isRecord(view) ? view : null;
  const started = view.startedAt !== null;
  const unanswered = record?.state === "failed" && record.reason === NO_ANSWER_REASON;
  const message = useLastMessage(host, record === null || unanswered ? null : (record.agent?.sessionId ?? null));
  const noSession = message.status === "ready" && message.value === NO_SESSION;
  const wait = view.state === "running" ? waitingAt(view) : null;
  let foot: React.ReactNode;
  if (view.state === "missed-waiting") {
    foot = (
      <>
        <Button variant="primary" onClick={() => choose({ choice: "run-now" })}>
          {missedCount > 1 ? "Run once" : "Run now"}
        </Button>
        {missedCount > 1 && <Button onClick={() => runMany("run-all", missedCount)}>Run all {missedCount}</Button>}
        <Button aria-expanded={runAt !== null} onClick={() => setRunAt(runAt === null ? "tonight 23:00" : null)}>
          Run at…
        </Button>
        <Button onClick={() => choose({ choice: "skip" })}>Skip</Button>
      </>
    );
  } else if (view.state === "running") {
    const session = view.session;
    foot = (
      <>
        {session !== null && (
          <Button variant="primary" onClick={() => openTerminal(session)}>
            {terminalLabel(view)}
          </Button>
        )}
        <Button variant="danger" onClick={stop}>
          Stop run
        </Button>
      </>
    );
  } else {
    const agent = view.agent;
    foot = (
      <>
        {agent !== null && agent.sessionId !== null && !noSession && (
          <Button variant="primary" data-help="c.session" onClick={() => openSession(agent.agent, agent.sessionId ?? "")}>
            Open session
          </Button>
        )}
        {view.log !== null && (
          <Button data-help="c.output" onClick={openOutput}>
            View output
          </Button>
        )}
        {others > 0 && <Button onClick={() => runMany("run-others", others)}>Run the other {others}</Button>}
        {view.kind !== "service" && <Button onClick={runNow}>{started ? "Run again" : "Run now"}</Button>}
      </>
    );
  }

  return (
    <>
      <DialogHead
        icon={view.kind}
        iconTip={KIND_WORDS[view.kind]}
        title={view.name}
        badge={
          <Pill tone={look.pill} help={look.help} data-testid="run-result">
            {look.label}
          </Pill>
        }
        meta={meta}
        why={why ?? undefined}
        onClose={close}
      />
      <DialogBody>
        <section className={styles.content} data-testid="run-card" data-state={view.state}>
          {view.state === "missed-waiting" ? (
            <MissedBody view={view} now={now} runAt={runAt} setRunAt={setRunAt} onSet={(at) => choose({ choice: "run-at", at })} onClose={() => setRunAt(null)} />
          ) : view.state === "queued" ? (
            <p data-testid="run-waits">{waitsSentence(view.waits, now, going)}</p>
          ) : view.state === "running" && wait !== null ? (
            <WaitingBody host={host} view={view} wait={wait} />
          ) : view.state === "running" ? (
            <RunningBody host={host} view={view} />
          ) : record === null ? null : record.action !== null || !started ? (
            <p data-testid="run-reason">{neverWords(record)}</p>
          ) : record.git !== null ? (
            <GitBody record={record} />
          ) : record.agent !== null ? (
            <AgentBody record={record} unanswered={unanswered} message={message} />
          ) : (
            <EndedBody record={record} />
          )}
        </section>
      </DialogBody>
      <DialogFoot
        end={
          <Button variant="ghost" onClick={() => open(editRoute(view.job))}>
            Edit job
          </Button>
        }
      >
        {foot}
      </DialogFoot>
      {confirming !== null && (
        <RunAllConfirm
          name={view.name}
          count={confirming.count}
          action={confirming.choice === "run-all" ? `Run all ${confirming.count}` : `Run the other ${confirming.count}`}
          onConfirm={() => {
            const { choice } = confirming;
            setConfirming(null);
            choose(choice === "run-all" ? { choice } : { choice, run: view.run });
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  );
}

/** A run that never started, or a chain's action on a service, in a sentence. */
function neverWords(record: RunRecord): string {
  if (record.action !== null) {
    const done = { restart: "Restarted", start: "Started", stop: "Stopped" }[record.action];
    const parent = record.cause?.kind === "chain" ? ` after ${record.cause.name}` : "";
    if (record.state === "done") return `${done} by a chain${parent}.`;
    return `${capital(record.state === "skipped" ? "skipped" : "failed")}: ${record.reason ?? "the chain did not act"}.`;
  }
  // A record of more than one missed run says how many: "Missed 4 runs, 17:40–17:46 · skipped."
  if (record.state === "missed" && missedRunsWords(record.missed) !== null) return `${capital(runWords(record))}.`;
  return `${capital(record.reason ?? (record.state === "missed" ? "missed" : "it never started"))}.`;
}

/** The lines of a run's output in a box under their label — a first line that is the command, faint. */
function Lines({ lines, title, testId }: { lines: readonly string[]; title: string; testId: string }): React.JSX.Element {
  return (
    <div>
      <h5 className={styles.label}>{title}</h5>
      {lines.length === 0 ? (
        <p className={styles.note}>It printed nothing.</p>
      ) : (
        <pre className={styles.lines} data-testid={testId}>
          {lines.map((line, index) => (
            <span key={index} className={index === 0 && line.startsWith("$") ? styles.dim : undefined}>
              {line === "" ? " " : line}
              {index < lines.length - 1 && "\n"}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

/** A run that ended: its exit code — red when it failed — or why it failed (a time limit: the
 *  limit), then its last lines. */
function EndedBody({ record }: { record: RunRecord }): React.JSX.Element {
  const failed = record.state === "failed";
  const limit = record.limitHit;
  return (
    <>
      <dl className={styles.kv}>
        {limit !== null && (
          <>
            <dt>Stopped</dt>
            <dd data-testid="run-limit">
              {capital(limitWords(limit).replace(/^stopped: /, ""))} — the job’s time limit <Help k="st.limit" />
            </dd>
          </>
        )}
        {limit === null && record.exitCode !== null && (
          <>
            <dt>
              Exit code <Help k="c.exit" />
            </dt>
            <dd className={failed ? `${styles.code} ${styles.bad}` : styles.code} data-testid="run-exit">
              {record.exitCode}
            </dd>
          </>
        )}
        {record.exitCode === null && record.signal !== null && record.reason === null && (
          <>
            <dt>Signal</dt>
            <dd className={styles.code}>{record.signal}</dd>
          </>
        )}
        {failed && limit === null && record.reason !== null && (
          <>
            <dt>Reason</dt>
            <dd className={styles.bad} data-testid="run-why">
              {capital(record.reason)}
            </dd>
          </>
        )}
      </dl>
      <Lines lines={record.lastLines} title="Last lines" testId="run-last-lines" />
    </>
  );
}

/** What Runner answered for the agent at its question forms (Full autonomy), one line each. */
function Answered({ agent }: { agent: AgentRun | null }): React.JSX.Element | null {
  if (agent === null || agent.answered.length === 0) return null;
  return (
    <div data-testid="run-answered">
      {agent.answered.map((option, index) => (
        <p key={index}>Runner answered: {option}</p>
      ))}
    </div>
  );
}

/** An agent run that ended: why it failed, when it did — its time limit, its reason, its exit — and
 *  the agent's last message in the session, from the Agents app (`message`). A turn that ended
 *  without an answer has none to read: its last lines show instead, the agent's screen with what
 *  went wrong. A session the Agents app does not have is one the agent never started. */
function AgentBody({ record, unanswered, message }: { record: RunRecord; unanswered: boolean; message: AgentsState<LastMessage | null | typeof NO_SESSION> }): React.JSX.Element {
  const session = record.agent?.sessionId ?? null;
  const failed = record.state === "failed";
  if (unanswered)
    return (
      <>
        <dl className={styles.kv}>
          <dt>Reason</dt>
          <dd className={styles.bad} data-testid="run-why">
            {capital(NO_ANSWER_REASON)}
          </dd>
        </dl>
        <Lines lines={record.lastLines} title="Last lines" testId="run-last-lines" />
      </>
    );
  return (
    <>
      {failed && (
        <dl className={styles.kv}>
          <dt>{record.limitHit === null ? "Reason" : "Stopped"}</dt>
          <dd className={styles.bad} data-testid="run-why">
            {record.limitHit !== null ? `${capital(limitWords(record.limitHit).replace(/^stopped: /, ""))} — the job’s time limit` : capital(record.reason ?? (record.exitCode === null ? (record.signal ?? "it ended") : `exit ${record.exitCode}`))}
          </dd>
        </dl>
      )}
      <Answered agent={record.agent} />
      <div>
        <h5 className={styles.label}>
          Last message <Help k="c.lastmsg" />
        </h5>
        {session === null ? (
          <p className={styles.note} data-testid="run-agent-note">
            Runner did not learn this run’s session, so its last message cannot be read.
          </p>
        ) : message.status === "ready" && message.value === NO_SESSION ? (
          <p className={styles.note} data-testid="run-agent-note">
            The agent never started a session.
          </p>
        ) : message.status === "ready" && message.value !== null && message.value !== NO_SESSION ? (
          <MessageText text={message.value.text} testId="run-agent-message" />
        ) : (
          <p className={styles.note} data-testid="run-agent-note">
            {message.status === "loading"
              ? "Reading the agent’s last message…"
              : message.status === "ready"
                ? "The agent left no message in this session."
                : message.status === "absent"
                  ? "The Agents app is not running, so the last message cannot be read now."
                  : `The last message cannot be read: ${message.message}.`}
          </p>
        )}
      </div>
    </>
  );
}

/** A running run: the end of its output so far, followed as it grows — under a sentence saying it
 *  waits for its agent's background work, while it does. */
function RunningBody({ host, view }: { host: HostClient; view: ActiveRun }): React.JSX.Element {
  const output = useRunOutput(host, view.job, view.run, true);
  const background = waitsForBackground(view) && (
    <p data-testid="run-background">The agent’s turn is over, but work it started in the background still goes. Runner waits for that work: the agent goes on once it ends, and the run is done when the agent is. The time limit keeps counting.</p>
  );
  if (output.status !== "ready")
    return (
      <>
        {background}
        <Answered agent={view.agent} />
        <p className={styles.note}>{output.status === "loading" ? "Reading its output…" : output.status === "failed" ? output.message : "Runner's scheduler is not running."}</p>
      </>
    );
  const lines = plainLines(output.value.text);
  if (lines.at(-1) === "") lines.pop();
  return (
    <>
      {background}
      <Answered agent={view.agent} />
      <Lines lines={lines.slice(-LAST_LINES)} title="Latest output" testId="run-last-lines" />
    </>
  );
}

/** What a waiting run's card says it waits at. */
const WAITING_SENTENCE: Record<AgentWait["prompt"], string> = {
  permission: "The agent stopped at a permission prompt and waits for your answer.",
  trust: "The agent stopped to ask whether it may trust its folder, and waits for your answer.",
  question: "The agent asks you a question and waits for you to pick an option.",
  unknown: "The agent stopped at a screen Runner does not know and waits for you. Look at its terminal.",
  "not-started": "The agent has not started working: it stopped at a screen Runner does not know — a consent, a login, a first-run step. Look at its terminal.",
};

/** An agent run that waits for you: what it waits at — the end of its output, the prompt — and
 *  that its time limit is paused. */
function WaitingBody({ host, view, wait }: { host: HostClient; view: ActiveRun; wait: AgentWait }): React.JSX.Element {
  const output = useRunOutput(host, view.job, view.run, true);
  const lines = output.status === "ready" ? plainLines(output.value.text) : [];
  return (
    <>
      <p data-testid="run-waits">{WAITING_SENTENCE[wait.prompt]}</p>
      {output.status === "ready" ? (
        <Lines lines={promptLines(lines)} title="Waiting at" testId="run-prompt" />
      ) : (
        <p className={styles.note}>{output.status === "loading" ? "Reading its output…" : output.status === "failed" ? output.message : "Runner's scheduler is not running."}</p>
      )}
      <p className={styles.note}>
        The time limit is paused while it waits. <Help k="st.waiting" />
      </p>
    </>
  );
}

const STEP_CLASS = { done: styles.yes, failed: styles.no, skipped: styles.skip } as const;

/** A repo's steps as the card lists them: each step's detail with its outcome, the reason a repo
 *  that did not finish gives when no step says it. */
function repoSteps(result: GitRunResult): { key: string; outcome: GitRunResult["status"]; text: string }[] {
  const steps = result.steps.filter((step) => !(step.step === "agents" && step.outcome === "done")).map((step, index) => ({ key: `${index}:${step.step}`, outcome: step.outcome, text: step.detail }));
  if (result.status !== "done" && !steps.some((step) => step.outcome === result.status)) steps.push({ key: "reason", outcome: result.status, text: result.reason ?? result.status });
  if (steps.length === 0) steps.push({ key: "none", outcome: "skipped", text: "nothing to do" });
  return steps;
}

/** What a repo that did not finish says beyond its steps: its reason, when a step already shows
 *  the outcome and the reason adds to it ("The repo was left as it was before the pull."). */
function repoNotes(results: readonly GitRunResult[]): string[] {
  return results.flatMap((result) => {
    const shown = result.steps.some((step) => step.outcome === result.status);
    if (result.status === "done" || result.reason === null || !shown || result.steps.some((step) => step.detail === result.reason)) return [];
    return [results.length > 1 ? `${result.repo}: ${result.reason}` : result.reason];
  });
}

/** A git run: each repo with its commit and steps, in order; what a repo that did not finish adds. */
function GitBody({ record }: { record: RunRecord }): React.JSX.Element {
  const results = record.git?.results ?? [];
  return (
    <>
      <div>
        <h5 className={styles.label}>
          Repositories <Help k="c.steps" />
        </h5>
        <div className={styles.repos} data-testid="run-git-repos">
          {results.map((result, index) => (
            <div key={`${index}:${result.repo}`} className={styles.repo} data-testid="run-git-repo" data-status={result.status}>
              <div className={styles.repoTop}>
                <Icon name="git" size={14} />
                <span>{result.repo}</span>
                {result.commit !== null && (
                  <code className={styles.hash} data-tip="Commit hash">
                    {result.commit.slice(0, 7)}
                  </code>
                )}
              </div>
              <div className={styles.steps}>
                {repoSteps(result).map((step) => (
                  <span key={step.key} className={STEP_CLASS[step.outcome]} data-testid="run-git-step" data-outcome={step.outcome}>
                    {step.outcome === "done" && <Icon name="check" size={12} />}
                    {step.outcome === "failed" && <Icon name="x" size={12} />}
                    {step.text}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      {repoNotes(results).map((note) => (
        <p key={note} className={styles.note} data-testid="run-git-note">
          {note}
        </p>
      ))}
    </>
  );
}

/** A missed run that waits for you: when it was due, why it did not catch up, and — after Run at… —
 *  the field for the time to run it at. */
function MissedBody({
  view,
  now,
  runAt,
  setRunAt,
  onSet,
  onClose,
}: {
  view: ActiveRun;
  now: number;
  runAt: string | null;
  setRunAt: (value: string) => void;
  onSet: (at: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const missed = missedRunsWords(view.missed);
  return (
    <>
      {missed === null ? (
        <p>
          This run was due{" "}
          <b>
            {dayWords(view.dueAt, now).replace(/^Today$/, "today")} at {shortClock(view.dueAt)}
          </b>{" "}
          and was missed.
        </p>
      ) : (
        <p data-testid="run-missed-runs">
          This job <b>{missed}</b>.
        </p>
      )}
      <p className={styles.note}>
        Its missed-run policy is “Wait for me”, so it didn’t catch up on its own. <Help k="need.waitforme" />
      </p>
      {runAt !== null && (
        <div>
          <h5 className={styles.label}>
            Run at <Help k="c.runat" />
          </h5>
          <RunAtField at={runAt} setAt={setRunAt} onSet={() => runAt.trim() !== "" && onSet(runAt.trim())} onClose={onClose} />
        </div>
      )}
    </>
  );
}
