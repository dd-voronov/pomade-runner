import { useEffect, useRef, useState } from "react";
import { WORKSPACE_PROJECT_ID } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import { jobsRoute, runRoute } from "../integrations/runner-api";
import { runTriggerWords, type ActiveRun } from "../scheduler/model";
import styles from "./HistoryView.module.css";
import { Chip, ColumnHead, EmptyBlock, GroupHead, Help, KindCell, ResizableTable, Status, TableHead, TableRow, useColumnSizing, type Column } from "./kit";
import {
  byDay,
  FILTER_WORDS,
  filterCounts,
  HISTORY_FILTERS,
  isHeld,
  itemKey,
  keeps,
  KIND_WORDS,
  runDuration,
  runLook,
  runningSince,
  runTime,
  shortDuration,
  TRIGGER_HELP,
  type HistoryFilter,
  type HistoryItem,
} from "./runLook";
import { shortClock, upWords } from "./serviceWords";
import { ViewFilters } from "./shell/TabShell";
import { useHistoryPages } from "./useHistoryPages";
import { useRunningNow } from "./useNow";
import { useActiveProject, useSettings } from "./useRunnerApi";

/** The table's columns: Time · the kind icon · Job · Result · Duration · Trigger. At its default the
 *  Job, Result and Trigger columns share the view; the Trigger column is at least 86 px, and wide
 *  enough for "hook: Mac login" and a caught-up run's "missed 4 runs, 17:40–17:46 · caught up once"
 *  in a tab of the usual width. */
const COLUMNS: readonly Column[] = [
  { id: "time", width: 44 },
  { id: "kind", width: 16 },
  { id: "job", min: 80, track: "minmax(0, 0.8fr)" },
  { id: "result", min: 80, track: "minmax(0, 1.1fr)" },
  { id: "duration", min: 62, track: "62px" },
  { id: "trigger", min: 86, track: "minmax(86px, 1fr)" },
];

/** History: the runs going, the jobs the switch holds — a row each, with the runs held so far — and
 *  every run that ended or never started, newest first, in their days — each row its time, job,
 *  result, duration and what started it; a row opens its result card, a held row its job.
 *  The result chips keep the runs going, the failed ones or the ones that never started; "This
 *  project" those of the project Pomade has open. Older pages load as the list scrolls to its end.
 *  The columns are as wide as the viewer dragged them to, and the table scrolls sideways where they
 *  are wider than the tab. */
export function HistoryView({
  host,
  active,
  asked,
  open,
  thisProject,
  onThisProject,
  newJob,
}: {
  host: HostClient;
  active: readonly ActiveRun[];
  /** The result chip the route asks for (`history/missed`): it turns on as the view opens. */
  asked: HistoryFilter | null;
  open: (route: string) => void;
  /** The "This project" chip, kept by the tab: it holds across the Jobs, History and Services views. */
  thisProject: boolean;
  onThisProject: (on: boolean) => void;
  /** The New job button the empty view offers. */
  newJob: (testId: string) => React.JSX.Element;
}): React.JSX.Element {
  const history = useHistoryPages(host);
  const sizing = useColumnSizing("pomade-runner.history.column-widths", COLUMNS);
  const settings = useSettings(host);
  const project = useActiveProject(host);
  const now = useRunningNow(runningSince(active), 10_000);
  const [filter, setFilter] = useState<HistoryFilter>(asked ?? "all");
  // The chip the route asked for turns on; the route goes back to plain History, so the next ask
  // is heard even when the person changed the chip meanwhile.
  useEffect(() => {
    if (asked === null) return;
    setFilter(asked);
    open("history");
  }, [asked, open]);
  const end = useRef<HTMLDivElement>(null);
  const ready = history.status === "ready" ? history : null;

  // The end of the list in sight with older runs left: load the next page. Asked again after each
  // page, so a filter that keeps few runs loads on until the view is full or History ends.
  useEffect(() => {
    const target = end.current;
    if (ready === null || !ready.more || ready.loading || target === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) ready.loadOlder();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [ready, filter, thisProject]);

  if (history.status === "loading") return <section data-testid="history-loading" />;
  if (ready === null) {
    return (
      <p className={styles.problem} role="alert" data-testid="history-problem">
        {history.status === "failed" ? history.message : "Runner's scheduler is not running."}
      </p>
    );
  }

  const all: HistoryItem[] = [...ready.held, ...active, ...ready.records];
  if (all.length === 0) {
    return (
      <EmptyBlock title="Nothing here yet" testId="history-empty" action={newJob("history-empty-new-job")}>
        <p>Every run lands here with its result and output.</p>
      </EmptyBlock>
    );
  }
  const projectId = project === null || project.id === WORKSPACE_PROJECT_ID ? null : project.id;
  const inScope = thisProject ? all.filter((view) => view.project === projectId) : all;
  const counts = filterCounts(inScope);
  const days = byDay(
    inScope.filter((view) => keeps(filter, view)),
    now,
  );
  // While older pages remain, a count is of the runs loaded so far.
  const more = ready.more ? "+" : "";
  const kept = settings.status === "ready" ? settings.value.settings.historyDays : null;

  return (
    <section data-testid="history">
      <ViewFilters summary={kept === null ? undefined : `kept ${kept} ${kept === 1 ? "day" : "days"}`}>
        {HISTORY_FILTERS.map((key) => (
          <Chip key={key} on={filter === key} check={false} count={key === "all" ? undefined : `${counts[key]}${more}`} onClick={() => setFilter(key)} data-testid={`history-filter-${key}`}>
            {FILTER_WORDS[key]}
          </Chip>
        ))}
        <span className={styles.chipGap} />
        <Chip on={thisProject} count={project?.name ?? "…"} onClick={() => onThisProject(!thisProject)} data-testid="this-project">
          This project
        </Chip>
      </ViewFilters>
      <ResizableTable sizing={sizing}>
        <TableHead columns={undefined}>
          <span>Time</span>
          <span />
          <ColumnHead id="job" label="Job">
            Job
          </ColumnHead>
          <ColumnHead id="result" label="Result">
            Result
          </ColumnHead>
          <ColumnHead id="duration" label="Duration" className={styles.right} whole after={<Help k="hist.dur" />}>
            Duration
          </ColumnHead>
          <ColumnHead id="trigger" label="Trigger">
            Trigger
          </ColumnHead>
        </TableHead>
        <div className={styles.list}>
          {days.map(({ day, key, runs }) => [
            <GroupHead key={`day:${key}`} title={day} pinned testId="history-day" />,
            ...runs.map((view) => <HistoryRow key={itemKey(view)} view={view} now={now} onOpen={() => open(isHeld(view) ? jobsRoute(view.job) : runRoute(view.job, view.run))} />),
          ])}
          {days.length === 0 && !ready.more && (
            <div className={styles.none} data-testid="history-none">
              No runs match this filter.
            </div>
          )}
        </div>
      </ResizableTable>
      <div ref={end} className={styles.end} data-testid="history-end">
        {ready.more && "Loading older runs…"}
      </div>
    </section>
  );
}

/** One run: its time, kind, job, result — the status explains itself on hover — duration and
 *  trigger; a click, Enter or Space opens its result card. */
function HistoryRow({ view, now, onOpen }: { view: HistoryItem; now: number; onOpen: () => void }): React.JSX.Element {
  const look = runLook(view, now);
  const duration = runDuration(view, now);
  return (
    <TableRow
      columns={undefined}
      className={styles.row}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
      data-testid="history-row"
      data-state={view.state}
      data-job={view.job}
    >
      <span className={styles.time}>{shortClock(runTime(view))}</span>
      <KindCell icon={view.kind} label={KIND_WORDS[view.kind]} />
      <span className={styles.name} data-tip-cut="">
        {view.name}
      </span>
      <span className={styles.result}>
        <Status tone={look.tone} live={look.live} size="sm" help={look.help} cutTip testId="history-result">
          {look.words}
        </Status>
      </span>
      <span className={styles.duration} data-testid="history-duration">{duration === null ? "—" : view.state === "running" ? upWords(duration) : shortDuration(duration)}</span>
      <span className={styles.trigger} data-help={TRIGGER_HELP[isHeld(view) ? "scheduled" : view.trigger]} data-tip-cut="" data-testid="history-trigger">
        {runTriggerWords(isHeld(view) ? { trigger: "scheduled", cause: null } : view)}
      </span>
    </TableRow>
  );
}
