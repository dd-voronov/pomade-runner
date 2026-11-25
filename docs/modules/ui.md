---
doc: docs/modules/ui.md
audience: engineers, product
holds: the ui module — what it does and its rules, the file map of `src/ui/`, invariants, tests, known limits
kind: reference
---

# Module: ui

The UI is one React bundle that Pomade opens on three surfaces: the Runner side panel, the Runner
tab and — a tab kind of its own — a run's output tab. `main.tsx` connects to Pomade's Host API and
`App.tsx` picks the frame from the connection's surface: no host (a plain browser) and a refused
connection are one-screen messages. Everything the UI knows comes from Runner's API through Pomade's
broker (`jobs.list`, `services.list`, `runs.list`, `history.list`, `runs.get`, `runs.output`,
`settings.get`, `environment.get`, and the actions) and from Pomade (projects, repos, the route);
`src/ui/useRunnerApi.ts` holds the live reads, each asked again on the scheduler's change event.
The look is light only, on the tokens of the approved prototype.

The design is in [DESIGN](../DESIGN.md) "UI" (side panel, Runner tab, routes, result card, the
output tab, job form, deleting a job, help) — this page is the code map and what a change must keep true.

## What it does and its rules

- **No state of its own about jobs.** The scheduler owns the jobs and runs; the UI reads them and asks
  for actions. The job form writes job files through the Host API (`jobFiles.ts`) and re-reads the
  file on every change on disk; the file is the truth.
- **One validator.** The form checks the text it would write with `checkJobAmong` (`src/jobs/check.ts`)
  and shows each error on its field in `describeJobError`'s words. It keeps no copy of the format's rules.
- **Routes.** The tab's view is a route (`parseRoute` in `src/integrations/runner-api.ts`): Jobs, a marked
  job, History, Services, Settings, a run's card, a waiting run's prompt, a run's output, New job,
  Edit job. The tab follows Pomade's `route.changed` and tells Pomade each route it goes to by itself.
- **Every non-obvious field, policy and status carries an (i) help** with an example; the texts are in
  `help.ts`, keyed `<area>.<what>`. A new key is added there and nowhere else.
- **Tooltips** are one layer per surface: `data-tip` (a text) or `data-help` (a help key) on any element.
  A text wider than the tooltip's largest width (280 px, narrower in a narrow frame such as the side
  panel; a `data-tip-code` text 480 px) wraps onto further lines, and a line break in a text starts a
  new line (`white-space: pre-line`, `Tooltip.module.css`). The Jobs view's job name carries the job's
  `description` as its `data-tip`, none without one.
- **A view extends a kit primitive** (`kit/`) rather than forking it.
- **The scheduler's words, once.** A run's state and trigger in words (`runWords`, `runTriggerWords`,
  `missedRunsWords`, `heldRunsWords` in `src/scheduler/model.ts`) are the scheduler's — a run whose
  agent's background work goes reads `BACKGROUND_WORDS` ("running · waiting for the agent's background
  work") where `waitsForBackground` holds, in History, the Jobs cells, the card and the CLI — and so is whether
  a caught-up run's card offers Run the other N (`otherMissedRuns`); History, the
  cards, Needs you, the Jobs cells and `pomade-runner` read the same functions. Whether a job is held
  comes from the report (`NextRun.held`, `JobRuns.held`), never from the UI's own reading of the switch.
- **Resizable tables.** Services and History lay out through one kit part, `ResizableTable`
  (`kit/ResizableTable.tsx`, the widths' pure rules in `kit/columnWidths.ts`); Jobs stays a fixed
  layout. A view lists its columns once: a fixed column (`width` px: an icon, the row's buttons, History's
  Time) or a sized one (`min` px and its default CSS `track`) whose head cell is a `ColumnHead` with a
  grip on its right edge. Services: Service, Command, Status (each at least 120 px); History: Job, Result
  (80), Duration (62), Trigger (86). Dragging a grip, or Left and Right on a focused one (16 px, with
  Shift 64), changes that column's width and no other's, between its minimum and 2000 px; a double
  click puts the table back to its default layout. While no column was resized the default tracks apply;
  from the first resize every sized column has a fixed width, the first resize starting from the widths
  as rendered. The table is as wide as the view or, when the widths need more
  (`tableMinWidth`), wider: it scrolls sideways inside the view with its head and rows together, and a
  History day head (`GroupHead` `pinned`) keeps its title at the left edge. The widths are kept in the
  browser's `localStorage` (`pomade-runner.services.column-widths`, `pomade-runner.history.column-widths`,
  one JSON object per table); a store that is missing or refuses, or widths missing a sized column,
  leave the default layout and the table still resizes. A Services view narrower than 800 px (a
  container query, `ServicesView.module.css`) drops the Command column from the head, puts each command
  under its name, shows no grips and does not scroll sideways; the widths kept stay for a wider tab.
- **Cut text carries its whole text.** An element with `data-tip-cut` (History's Job, Result and
  Trigger; `Status` with `cutTip`) shows its whole text first in its tooltip while its text is cut with
  "…", above its own help or line; while it fits the tooltip is its help alone. A service's command
  (`CommandCell.tsx`) is a cut mono line that, only while cut, is focusable and shows the whole
  command as its tooltip; it is measured again whenever the column or the tab changes size.
- **A going run's time is one clock.** Running now, History's Duration and the result card read the
  time a run has been going from `useRunningNow(runningSince(runs))`: the clock is read again at
  the run's next whole second while one run is under a minute (`upChangeIn`), then at each multiple of
  10 s of its time (with no run going, every 10 s in History and the card, 30 s in the panel), so the
  three show the same words at every moment. `upWords` words it ("20s", "3m", "2h 05m", "3d 4h"). A view with
  no run going schedules no per-second read.
- **History's held rows.** `history.list`'s newest page carries `held`: one row per job the switch
  holds, shown with the records and the runs going (`HistoryItem`, `isHeld`). The row reads "held · N
  runs so far, HH:MM–HH:MM" (`heldRowWords`) in amber, its Duration "—", its Trigger `scheduled`, its
  time the latest held run's; it counts under the Skipped & missed chip (not Active, not Failed) and a
  click opens its job in Jobs. The switch's count ("2 runs so far") is a link (`LinkButton`) that opens
  the Runner tab on `history/missed` (`HISTORY_MISSED_ROUTE`): History turns Skipped & missed on and
  sends the tab back to plain `history`, so the next click is heard even after the person changed the
  chip.
- **A job row acts on its latest run.** A script, agent or git row with a run going (`state:
  "running"`; a queued run has no terminal and nothing to stop) shows `Open terminal` and `Stop run`
  before `Run now`, for the latest such run (`latestGoing` in `rowRun.ts`: by start, then run id);
  `Open terminal` is `Open at the prompt` for an agent run waiting at a prompt (`terminalLabel`, also the
  card's button). With no run going, or none with a session, the place is an empty slot of the same width
  so the other icons stay where they are. The row and the result card share `useStopRun` and
  `useOpenRunTerminal` (`useRunActions.tsx`).
- **An agent run's card** (`RunCard.tsx`). An ended run whose reason is `NO_ANSWER_REASON` shows the
  reason and **Last lines** (`record.lastLines`) and does not ask the Agents app for a message; any
  other ended agent run reads its last message, and a session the Agents app does not have
  (`useLastMessage` → `NO_SESSION`) says "The agent never started a session." and drops Open session.
  A running run waiting for background work shows its sentence (`run-background`) above its Latest
  output; a run waiting for you shows the sentence of what it waits at (`WAITING_SENTENCE`:
  permission, trust, question, unknown, `not-started`), the Needs-you card's line (`WAITING_TEXT` in
  `panelWords.ts`: "Waiting for your answer to its question.", "Waiting at a screen Runner does not
  know.") and its help (`WAITING_HELP`: `need.approval`, `need.question`, `need.unknown`,
  `need.notstarted`). A run's `agent.answered` — the options Runner picked at the agent's question
  forms in Full autonomy — is one line each, "Runner answered: <option>" (`Answered`, `run-answered`),
  above Latest output while the run goes and above Last message once it ended. A queued run waiting
  for a fresh keeper (`waits.kind` `keeper`) says why in `waitsSentence` (`runLook.ts`).
- **A git run's card and words.** A failed repo's line ends with **Open in Git** (`GitBody` in
  `RunCard.tsx`) while the host serves `git.reveal`: Pomade's `git.getState` and `project.list` give the
  repo's root and the projects, `revealProject` (`gitReveal.ts`) picks the project that holds it (the
  job's own, else the first by id, else the Workspace), and the call is `git.reveal` with the repo's
  path and that project. The kit's client has no method for it, so `main.tsx` keeps the transport it
  connects with and `platformCalls.ts` sends the call over it (`PlatformCalls`, `transportCaller`); the
  first card with a failed repo probes once with an empty path per UI session (`useGitReveal`:
  `invalid-params` or `not-found` = served, `unknown-method` or `capability-denied` = not; any other
  answer is not kept and the next card asks again), and the button is absent until the verdict is
  "served". A `not-found` answer toasts "Could not open <repo> in Git: Pomade has no such repo or
  project now". The call's types and the pull count sit in `src/integrations/pomade-next.ts`. A done
  run's words carry what its pulls got (`pulledWords`, `src/scheduler/model.ts`): "done · 2 commits
  pulled", "done · 1 commit pulled", "done · up to date" in the Jobs cell and, with the commit, in History
  ("done · a1b2c3d · 2 commits pulled"); with no done pull, or any pull's count unknown, the words stay
  "done" (or "done · <commit>"). The Jobs cell's sub line keeps the commit in place of the duration.
- **Service events.** A service's start, stop, restart and give-up is a History record with an `event`
  (`isEventRecord`, `eventLook` in `runLook.ts`; the words are the scheduler's `serviceEventWords`,
  `SERVICE_CAUSE_WORDS`). The row has no duration, its cause as Trigger with that cause's help
  (`CAUSE_HELP`, `ev.*`), and a dot by what happened (`ring-ok` is the green ring of a restart by you or
  a chain; a restart after a crash is an amber dot with plain words, `plain`). Gave up counts under
  Failed; a chain's skipped action under Skipped & missed, its refused one under Failed. The
  **Service events** chip (`history-events`, on by default, with its help `hist.events`) hides the
  rows and their count; the result chips' counts follow it. The newest page replaces a record it brings
  again (`withHead` in `useHistoryPages.ts`), since a crash window's row is written again as its
  restarts add up. A row opens `EventCard` in place of `RunCard` (`RunDialog` picks by `event`): the
  cause as a sentence (`eventWords.ts`), the Exit code, and the Session — "still going · up 3h 48m"
  while the session the event started runs (`useServices`, matched by the keeper's start stamp), else
  "ended 11:20 — it crashed" from the event that ended it (`useSessionEnd`, `history.sessionEnd`).
  **Open terminal** while that session goes; **Start** on a gave-up service that does not run; no View
  output.
- **A chain's result** is worded once, `RESULT_WORDS` in `src/jobs/words.ts`: "is done", "fails",
  "finishes either way". The trigger words (Jobs, History, the line under the editor), the script, agent,
  git and service forms' result control (`RESULT_CHOICES` capitalised, `SERVICE_RESULT_OPTIONS` in
  `form/triggerWords.ts`) and the one help text on that control (`RESULT_HELP` in `help.ts`, behind
  `hk.result` and `f.after`) all read from it.
- **The Git form's repository picker** (`form/RepoPicker.tsx`, the pure math in `form/repoList.ts`):
  the workspace's repos (`useRepos`, live) as checkboxes in a box, grouped by top folder — Top level
  first, the rest by name, each group's repos by name with their path ("workspace root" for the root's
  own repo) — each group head with a checkbox for its shown repos (mixed while some are picked) and
  "n of m". Above: "N of M selected", **Select all**, **Clear** and, from 10 repos (`FILTER_FROM`), a
  filter by name or path; while it holds text the actions read **Select N shown** and **Clear shown**
  and act on what shows. The picks are written in the list's order (`inListOrder`), which is the order
  `pomade-git` goes through them; a file that lists them in another order says so under the box, with
  **Use this list's order**, else the line "Runs one repo at a time, top to bottom in this list."
  (`f.repos.order`). A repo the file names that the workspace lacks stays picked in a red **Not in this
  workspace** group at the bottom and in a line under the box; it does not keep Save from writing, and
  Clear takes it too. The list keeps a fixed height from 10 repos up.
- **The job form's description** (`DescriptionField` in `form/JobForm.tsx`): the link "Add a
  description (optional)" until it is clicked or the file has one, then the Description text box;
  `form/state.ts` writes it trimmed, and leaves the field out when empty.
- **The Folder field's menu** (`form/FolderField.tsx`): Choose… opens Workspace, Connected projects
  (an agent job's projects connected to its agent, in the order the Agents app gives them), Other
  projects (Projects when none is connected) and Other folder…. There are no chips under the field.
- **A manual job's Next run** reads "not scheduled" (`nextLook` in `jobWords.ts`; `jobs.next` in
  `help.ts`).
- **Output tab** (`OutputPage.tsx`): a keyed Pomade tab per run, "<job> · output", with Copy; it closes
  itself when its run is gone from the history.

## File map

| File | Holds |
|---|---|
| `main.tsx`, `App.tsx`, `index.html` | the entry (it connects over a transport it keeps for `PlatformCalls`), the frame choice, the page |
| `Panel.tsx`, `shell/PanelShell.tsx` | the side panel and its frame: the switch pinned on top, sections, Open Runner at the foot |
| `SwitchControl.tsx` | the three-position switch and its note, with the runs held so far as a link to History's Skipped & missed |
| `NeedsYou.tsx` | Needs you's cards and their actions (a gave-up service without a session has no View output; its name opens the job in Jobs; a missed run that stands for more than one: Run once · Run all N · Run at… · Skip) |
| `RunAllConfirm.tsx` | the confirm before Run all or Run the other N runs more than 20, naming the number; shared by Needs you and the result card |
| `RunningNow.tsx`, `ActiveRunsList.tsx` | Running now: services and runs going (a run waiting for its agent's background work carries the news line "waiting for the agent's background work"); a row opens its tab, terminal or card |
| `NextUp.tsx`, `runWords.ts` | Next up; the one countdown to a run (`soonWords`: "in 56 s", "in 2 min", "in 40 min"), the Jobs view's Next run reads it too |
| `panelWords.ts` | the panel's words: a Needs-you card's look (what a waiting run waits at, with its help), a moment ahead or past, a run's age |
| `RunnerTab.tsx`, `shell/TabShell.tsx` | the Runner tab and its frame: the four views, the route, the "This project" chip, New job |
| `JobsView.tsx`, `jobWords.ts`, `JobsProblem.tsx` | the Jobs view; its Last result and Next run cells (a held job's with Next up's `held` tag, a manual job's "not scheduled"); the row's actions, Open terminal and Stop run among them; the scheduler-not-running and unreadable-jobs messages |
| `rowRun.ts`, `useRunActions.tsx` | the run a Jobs row acts on and the terminal's label (pure); Stop run and Open terminal for a run, shared by the row and the result card |
| `DeleteJobDialog.tsx` | the Delete confirm, shared by the row and the form |
| `ServicesView.tsx`, `serviceWords.ts`, `useServiceAction.tsx` | the Services view and its columns; a service's state in words (waiting for Pomade included) and `upChangeIn`, when a going run's time reads differently; Start, Stop and Restart through the scheduler, shared with the Jobs view |
| `CommandCell.tsx` | the Services view's command cell: one mono line cut with "…", focusable and with the whole command as a tooltip only while cut |
| `HistoryView.tsx`, `useHistoryPages.ts`, `runLook.ts` | History: filters and the Service events chip, day heads, the held rows, the service-event rows, pages of 100, the columns; a row's look (dot, words, pill, filter, duration; `eventLook`) and the going runs' start moments (`runningSince`) |
| `RunCard.tsx`, `MessageText.tsx`, `RunAtField.tsx` | the result card for every run state (an agent run's reason and Last lines, background-work and waiting sentences, Runner's answers, no session; a git run's repos with Open in Git); an agent's message drawn as text, never as HTML; Run at…'s field |
| `EventCard.tsx`, `eventWords.ts` | a service event's card (cause, exit code, the session still going or ended, Open terminal, Start) and its pure words: the cause in a sentence and in the head, how a session ended (`eventWords.test.ts`) |
| `gitReveal.ts`, `platformCalls.ts` | Open in Git: the project to reveal a repo in (pure); the host calls the kit's client lacks, sent over the frame's transport, and the `git.reveal` probe (`useGitReveal`) |
| `OutputPage.tsx`, `useRunOutput.ts` | a run's output tab; a run's output, followed while it runs |
| `SettingsView.tsx` | Settings: the four steppers, the skills folder's field, the read-only rows (notifications, where the agent skill is), the files |
| `form/JobForm.tsx` | the form's page: head, Kind, Name and Description, kind sections, Policies, the Save bar, following the file |
| `form/state.ts` | the form's state (pure): values, what the person set, the file as last read, the fields each kind writes (`FORM_KINDS`) |
| `form/kinds.tsx` | each kind's card, sections, policy rows and Create button (`KIND_UI`); the Git section mounts `RepoPicker` |
| `form/TriggerSection.tsx` | On a schedule / When something happens / Manually: the schedule editor, the Event list and its filters, Manually's one line, a service's chain line |
| `form/schedule.ts` | the schedule editor's values and their canonical lines (pure) |
| `form/triggerWords.ts` | the Event list (`EVENT_CHOICES`), the pickers (jobs, projects, statuses, agents) and the trigger in words under the editor (pure) |
| `form/policies.ts` | the policies' words in the one-sentence summary (pure) |
| `form/RepoPicker.tsx`, `form/repoList.ts` | the Git form's Repositories field: the grouped checkbox list with Select all, Clear and the filter, the run-order line; the grouping, filtering and ordering (pure) |
| `form/FolderField.tsx`, `form/FormSection.tsx` | the Folder field and its Choose… menu (connected projects grouped); a form section |
| `jobFiles.ts` | the form's job-file writes through the Host API: create under a free slug, field-only changes, follow the file |
| `useRunnerApi.ts` | Runner's API, live; Pomade's projects, repos (`git.read`), the open project, the tab's route |
| `useAgents.ts` | the Agents app through the broker: the roster, the projects connected to an agent, a session's last message (`NO_SESSION` for a session the app lacks) |
| `useAction.ts`, `useNow.ts` | the latest failure of a click; the Mac's clock, read again (`useNow`), read again the moment a countdown reads differently (`useCountdownNow`) and the moment a going run's time does (`useRunningNow`) |
| `help.ts` | every help text |
| `EmptyState.tsx` | a centred message for a surface with nothing to list |
| `tokens.css`, `base.css`, `*.module.css` | the design tokens (light only), base styles, each component's styles |
| `kit/` | the primitives: `Button`, `Check`, `Chip`, `DayButton`, `Dialog` (with the confirm), `EmptyBlock`, `Field`, `Help`, `Icon` and `icons.ts`, `IconButton`, `Menu`, `PanelCard`, `PanelRow`, `ResizableTable` (with `ColumnHead` and `useColumnSizing`) and `columnWidths.ts`, `Section`, `Segmented` (the switch included), `Status`, `Stepper`, `Table`, `Tag`, `Toast`, `Toggle`, `Tooltip`, `useFocusTrap` (a dialog over another — a confirm over a result card — takes the keys alone); `index.ts` exports them |

## Keys

The kit gives these keyboard behaviours: Esc closes a dialog, a menu and a tooltip (a dialog traps
Tab and Shift+Tab); Run at…'s field closes on Esc without closing the dialog around it; a menu moves
with the arrow keys, Home and End; a stepper changes by arrow up and down; a column grip of Services and History by arrow left and right (Shift: a larger step); a History row and a
clickable table cell open on Enter or Space. The repository picker's checkboxes are native inputs (Space toggles); Esc in its filter clears the filter without closing anything around it
(`form/RepoPicker.tsx:140`). There are no app-wide shortcuts.

## Invariants

- A form change writes only the fields whose value differs from the file as last read; comments, unknown
  fields and the body stay. A schedule the person left alone is never written.
- Switching kind keeps what the person set and resets the kind-dependent defaults they left alone.
- A job file the form cannot read (broken frontmatter, an unknown kind) opens a page that says so, with Open file.
- A refused action shows the scheduler's `reason` ("Could not <do it> <job>: <why>"); a missing scheduler
  is said on the surface ("Runner's scheduler is not running").
- The Delete confirm names the file and says what happens to a running service before it acts.

## Tests

Unit (vitest) for the pure parts: `kit/columnWidths`, `form/policies`, `form/repoList`, `form/schedule`, `form/state`, `form/triggers`,
`eventWords`, `gitReveal`, `help`, `jobFiles`, `jobWords`, `panelWords`, `platformCalls`, `rowRun`, `runLook`, `runWords`, `serviceWords`, `useNow`. E2E: `ui.spec.ts` drives
the built page in pomade-kit's fake host (`e2e/harness/`) and in a plain browser — it covers the
columns' grips, drag, keys, sideways scroll, kept and unreadable widths and the narrow Services tab,
the going run's time agreeing across the three places, the held rows and the switch's link, the Jobs
row's icons, the service events (rows, the chip, cards), Open in Git with and without `git.reveal`, the
done pull's words and the repository picker (grouping, Select all, Clear, the filter, the order line); `RUNNER_SHOTS=<dir>` saves a screenshot of every state. `pomade.spec.ts`, `pomade-git.spec.ts`,
`pomade-hooks.spec.ts` and `pomade-agents.spec.ts` drive it inside a real Pomade (`pomade.spec.ts` runs
a row's Open terminal and Stop run against a real run).

## Known limits

- Light theme only, whatever the system's colour scheme.
- A long-run warning set under an hour in the file shows in minutes and the stepper starts at one hour.
- History counts under a filter are of the runs loaded so far while older pages remain ("3+").
- Without the Agents app, the job form cannot offer agents or modes: it keeps the file's and says so.
- **Open in Git** is absent on a Pomade that does not serve `git.reveal`, and the pull count is absent
  on one that does not report it (the words stay "done").
- A service event has no output of its own; its terminal is the service's, open only while that
  session lives.

Tickets: T-045, T-047, T-048, T-049, T-050, T-051.
