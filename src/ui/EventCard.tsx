import type { HostClient } from "pomade-kit/sdk";

import { editRoute, runRoute } from "../integrations/runner-api";
import { causeMeta, causeSentence, endedAt, endedByWords, endedWhen } from "./eventWords";
import { Button, DialogBody, DialogFoot, DialogHead, Dot, Help, LinkButton, Pill } from "./kit";
import styles from "./RunCard.module.css";
import { CAUSE_HELP, eventLook, KIND_WORDS, whenWords, type EventRecord } from "./runLook";
import { readyWords, upWords } from "./serviceWords";
import { useRunningNow } from "./useNow";
import { useOpenRunTerminal } from "./useRunActions";
import { useJobs, useServices, useSessionEnd } from "./useRunnerApi";
import { useServiceAction } from "./useServiceAction";

/** A service event's card (the prototype's `evCardHtml`): what happened and when, its cause — a
 *  chain's parent opens its run — the exit code of a crash, and the session it started: still going
 *  (with Open terminal) or ended, when and how. A service that gave up offers Start while it does
 *  not run. No duration, no output of its own. */
export function EventCard({ host, view, open, close }: { host: HostClient; view: EventRecord; open: (route: string) => void; close: () => void }): React.JSX.Element {
  const { event } = view;
  const services = useServices(host);
  const jobs = useJobs(host);
  const ender = useSessionEnd(host, view.job, view.run);
  const status = services.status === "ready" ? (services.value.services.find((service) => service.job === view.job) ?? null) : null;
  const session = status?.session ?? null;
  const ours = event.session !== null && session?.info.startedAt === event.session ? session : null;
  const going = ours?.info.state === "running" ? ours : null;
  const now = useRunningNow(going === null ? [] : [going.info.startedAt], 10_000);
  const openTerminal = useOpenRunTerminal(host);
  const act = useServiceAction(host);
  const look = eventLook(view);
  const tableNow = Date.now();

  const parent = view.cause?.kind === "chain" ? view.cause : null;
  const meta = [
    <span key="when" data-testid="run-when">
      {whenWords(view.dueAt, tableNow)}
    </span>,
    <span key="cause" className={styles.helped} data-help={CAUSE_HELP[event.cause]} data-testid="run-trigger">
      {parent === null ? (
        causeMeta(view)
      ) : (
        <>
          chain · after{" "}
          <LinkButton aria-label={`Open ${parent.name}'s run`} data-tip={`Open ${parent.name}'s run`} onClick={() => open(runRoute(parent.job, parent.run))}>
            {parent.name}
          </LinkButton>
          : {parent.result}
        </>
      )}
    </span>,
  ];

  let sessionLine: React.ReactNode = null;
  if (going !== null) {
    const starting = status?.state === "starting";
    const job = jobs.status === "ready" ? jobs.value.jobs.find((entry) => entry.valid && entry.job.id === view.job) : undefined;
    const ready = job?.valid === true && job.job.kind === "service" ? job.job.ready : null;
    const words = starting ? ["starting", ...(ready === null || ready.kind === "alive" ? [] : [readyWords(ready)])].join(", ") : `up ${upWords(now - going.info.startedAt)}`;
    sessionLine = (
      <span className={styles.session} data-testid="event-session" data-state="going">
        <Dot tone={starting ? "accent" : "ok"} live={starting} />
        still going · {words}
      </span>
    );
  } else if (event.session !== null || event.ended.length > 0) {
    const own = event.session === null ? event.ended[event.ended.length - 1] ?? null : event.session;
    const by = ender.status === "ready" ? ender.value : null;
    // The session this event ended ended at it; the one it started, when its ender says — or the
    // keeper, when that session is still the service's last.
    const at = event.session === null ? view.dueAt : by !== null && own !== null ? endedAt(by, own) : (ours?.info.exit?.at ?? null);
    const how = event.session !== null && by !== null ? endedByWords(by) : "";
    sessionLine = (
      <span className={styles.ended} data-testid="event-session" data-state="ended">
        {["ended", at === null ? null : endedWhen(at, tableNow)].filter((part) => part !== null).join(" ")}
        {how !== "" && ` — ${how}`}
      </span>
    );
  }

  const runs = status !== null && (status.state === "running" || status.state === "starting");
  return (
    <>
      <DialogHead
        icon="service"
        iconTip={KIND_WORDS.service}
        title={view.name}
        badge={
          <Pill tone={look.pill} help={look.help} data-testid="run-result">
            {look.label}
          </Pill>
        }
        meta={meta}
        onClose={close}
      />
      <DialogBody>
        <section className={styles.content} data-testid="event-card" data-event={event.what} data-cause={event.cause}>
          <dl className={`${styles.kv} ${styles.event}`}>
            <dt>Cause</dt>
            <dd data-testid="event-cause">
              {causeSentence(view)} <Help k={CAUSE_HELP[event.cause]} />
            </dd>
            {view.exitCode !== null && (
              <>
                <dt>
                  Exit code <Help k="c.exit" />
                </dt>
                <dd className={`${styles.code} ${styles.bad}`} data-testid="run-exit">
                  {view.exitCode}
                </dd>
              </>
            )}
            {view.exitCode === null && view.signal !== null && (
              <>
                <dt>Signal</dt>
                <dd className={`${styles.code} ${styles.bad}`}>{view.signal}</dd>
              </>
            )}
            {sessionLine !== null && (
              <>
                <dt>Session</dt>
                <dd>{sessionLine}</dd>
              </>
            )}
          </dl>
        </section>
      </DialogBody>
      <DialogFoot
        end={
          <Button variant="ghost" onClick={() => open(editRoute(view.job))}>
            Edit job
          </Button>
        }
      >
        {going !== null && (
          <Button variant="primary" icon="terminal" onClick={() => openTerminal({ name: view.name }, going.id)}>
            Open terminal
          </Button>
        )}
        {going === null && event.what === "gave-up" && status !== null && !runs && (
          <Button
            variant="primary"
            icon="play"
            onClick={() => {
              act("start", { id: view.job, name: view.name });
              close();
            }}
          >
            Start
          </Button>
        )}
      </DialogFoot>
    </>
  );
}
