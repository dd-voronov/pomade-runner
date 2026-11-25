---
doc: docs/modules/scheduler.md
audience: engineers, product
holds: the scheduler module (with the keeper's supervision and turn-following it drives) — what it does and its rules, the file map of `src/scheduler/`, invariants, tests, known limits
kind: reference
---

# Module: scheduler

The scheduler is Runner's always-on backend: a login item (launchd) that keeps running when Pomade
quits. It loads the job files, supervises the services (through `src/keeper/`), evaluates triggers,
applies the missed-run, queue and load policies, runs scripts, agents and git operations as keeper
sessions, writes history, posts notices and serves Runner's API. It works with Pomade open or
closed; an agent run needs Pomade up and has the scheduler open it
([`integrations`](index.md) `pomade-open.ts`).

The design — states, rules, numbers, data files — is in [DESIGN](../DESIGN.md): "Triggers", "Runs",
"Project renamed", "Missed runs and load", "Services" (with "Service events"), "Settings",
"Notifications", "Data and locations", "Interfaces", "The scheduler's control socket". This page is the code map and what a change must
keep true.

## What it does and its rules

- **One tick a second** on a `Clock` (`clock.ts`). Every tick: follow the workspace, follow the keeper,
  read the settings, take each scheduled job's occurrences since its previous look (`triggers.ts`),
  fire the latest when it is at most 5 minutes old, hand every other one to the job's missed-run
  policy (`missed.ts`), start the queued runs the queue lets go (`queue.ts`), supervise services.
- **Missed runs, counted** — every occurrence missed is counted (`passedOccurrences`, `triggers.ts`);
  a job's one decision keeps the count and the first and last missed time (`MissedRuns`), and the run
  or record it makes carries them (`missed`), the Needs-you item of a run waiting for you too. A
  later miss adds to a caught-up run still queued or a missed run still waiting (`addMissed`).
- **Run all** — the person's choice, never a policy's: Run all N on a missed run waiting (`missed`,
  choice `run-all`), Run the other N on the job's latest caught-up run that stood for more than one
  (`run-others`; `otherMissedRuns` says when). One run of the series (`series`: n of N) is active at a
  time, waiting for the job's previous run whatever its overlap (`queue.ts`); `record()` queues the
  next in the same save that ends a run that ran and ended done or failed (`carryOn`), so the series
  lives in `runs.json`. A run stopped by you, one that never started, or a job gone drops the rest with
  one skipped record, its id made from the run it follows so a restart never writes it twice. The
  switch's release leaves a series run queued; an on-time run never covers it.
- **The switch** — a job it holds keeps its look in `held` (in `runs.json`); nothing is decided for
  it while held — no record, no Needs-you item, no notice — and the report marks it (`JobRuns.held`).
  Its held runs are counted on each ask, never stored: `heldRows()` takes every occurrence of the job's
  schedule since its `held` look up to the clock (`passedOccurrences`), one `HeldRun` per job with at
  least one, by job id; `heldRuns` is the sum of their counts. On release every occurrence it held is
  missed, however recent, and goes, counted, to the job's policy.
- **Held rows** — History's row for a job the switch holds: "held · 3 runs so far, 17:40–17:44" (one
  run: "held · 1 run so far, 17:40"; across days "Tue 23:40–Wed 00:20"; `heldRowWords`, `model.ts`).
  They travel as `HistoryPage.held`, never in the history day files: `historyPage` (`scheduler.ts`)
  fills them on the newest page (no `before`), only the asked job's when one is asked (by id; the control answer resolves a name first),
  and leaves them `[]` on older pages; the control `history` answer is always the newest page. They
  sit outside the page's `limit`. On release the held row is gone and the record the policy writes
  takes its place; a held row makes no Needs-you item or notice. `onChange` fires when the count of
  held runs goes up, so a view reads the rows again. The route `history/missed`
  (`HISTORY_MISSED_ROUTE`, `integrations/runner-api.ts`) opens History with Skipped & missed on; the
  count under the switch links to it.
- **Hooks** — one firing path, `hook()` in `runs.ts`, for every event; `hooks.ts` says which jobs an event
  fires and what environment its runs get. Events: Mac login (a scheduler start at another console login than the one last acted on,
  `console-login.ts`), Pomade started, first open of a project, project opened (every open), project created,
  agent session finished, session status changed. Hooks have no missed-run policy: a run the switch held runs late. The projects
  opened since Pomade started are kept with the start (`integrations/pomade-start.ts`): a first open
  fires once per Pomade start, a restarted scheduler too, while project opened fires at every open;
  the supervisor starts a first-open service of an opened project as soon as it exists.
- **Service lifetimes** — a service's `start` (`login`, `pomade-started`, `project-first-open`) is both
  when it starts and how long it lives. The scheduler tells the supervisor where Pomade stands
  (`PomadeState`: running · closed · unsure); the two Pomade-bound starts (`pomadeBound`) run only while
  it is running. Pomade has quit when the link is down and no Pomade start is found for the quit grace
  (`QUIT_GRACE_MS`, 15 s; `POMADE_RUNNER_QUIT_GRACE_MS` in tests): `pomadeEnded()` then stops every
  bound service and clears their stopped-by-you, failed and crash-count records. A scheduler started
  while Pomade is closed stops the bound services it finds running. Start is refused for a bound
  service while Pomade is closed (`NOT_WITH_POMADE`).
- **Mac login** (`console-login.ts`, decided in `runs.ts` `decideStart`, once per scheduler when it
  first follows the keeper) — a start is a login when the Mac's console login differs from the one in
  `login.json` (state folder). The console login is the user's `loginwindow` process, its pid and start
  time, read with `ps` (`loginwindowOf`, `consoleLoginOf`; `POMADE_RUNNER_CONSOLE_LOGIN` replaces it in
  tests). A log-out and log-in and a Mac restart are logins whether or not the keeper outlived them; a
  scheduler restart, an update, sleep and fast user switching are none. With no login kept, or one that
  cannot be told, `sessions.startedKeeper()` decides (`decideStart`): a start that had to start the
  keeper is a login. A login begins the staged start and fires the login hooks, whose runs wait for the warm-up; the
  login acted on is written once the hooks fired (at once for a start that is no login). The
  decision is a log line either way.
- **Service events** — the supervisor (`keeper/supervisor.ts`) writes every start, stop, restart and
  give-up of a service through `onEvent`; `scheduler.ts` appends it to history, or `put`s it when it
  is a crash window's row (updated in place as the restarts add up; the window lives in the service's
  supervision record). A chain's action on a service is written by `runs.ts` from the supervisor's
  outcome (`chainEvent`: the session it started and the one it ended), never by the supervisor. The
  record is a `RunRecord` with `event` (`ServiceEvent`: `what`, `cause`, `detail`, `session`,
  `ended`, `restarts`, `ends`); `history.sessionEnd` finds the event whose `ended` holds the session
  an event started. A record with an `action` field instead of `event` reads as its event
  (`parseRunRecord`). A service event fires no chain (`parentResult` is `null`).
- **The agent skill** (`jobs/skill/place.ts`) — the scheduler keeps a copy of the installed skill in the
  workspace's skills folder (the `skills-folder` setting): placed at every start, moved when the
  setting changes, linked to no agent.
- **Chains** (`chains.ts`) — a run that ends done or failed fires its followers; a service follows with
  its `action` and never waits for the warm-up or the switch. The three results are worded once,
  `RESULT_WORDS` (`jobs/words.ts`): "is done", "fails", "finishes either way".
- **Loop guard** (`loop-guard.ts`) — more than 10 firings of a job in 10 minutes by hooks or chains pauses
  it until Resume; Run now never counts.
- **Runs** (`runs.ts`) — queued → running ⇄ waiting for you → done · failed · stopped by you; skipped and
  missed ones are records. A queued run waits for one of: its time, the switch, the warm-up, the job's
  previous run, Pomade (an agent run), a fresh keeper (an agent run), a slot — in that order
  (`queue.ts`, `Waits`). Agent runs (`agent-runs.ts` for the rules, the launch in `runs.ts`) and git
  runs (`git-runs.ts`) are script runs with their own command and end.
- **Agent runs** — started in a keeper that reaches the macOS keychain: before the launch the
  scheduler runs the keychain check (`Sessions.checkKeychain`, `keychain.ts`); a keeper that fails it is
  replaced (`replaceKeeper`) and checked again. While other runs are going the agent run stays queued,
  waiting for a fresh keeper, since replacing the keeper ends them; a fresh keeper that fails too fails
  the run (`KEYCHAIN_LOST`); a check that cannot run does not hold the run back. `run.started` names the
  run's keeper session as `terminal` (`run-events.ts`). The scanner's reading of the agent's screen
  (`keeper/agent-turns.ts`) drives four more states of a running run:
  - *waiting for you* — at a permission or trust prompt, at the agent's question form (`question`),
    at a screen Runner does not know (`unknown`), or `not-started` (`AgentWait`, `AGENT_WAIT_KINDS`).
    `unknown` is the scanner's wait at the idle title over any screen but the agent's empty prompt,
    and counts only once the agent has worked, and not after the exit command (the exit wait ends
    it); before the agent worked such a screen is the `not-started` case: the agent has not been seen
    working `NOT_STARTED_MS` (20 s, its waits left out; as long again after a scheduler restart) into
    the run and waits at no prompt the scanner names, a consent or login screen. Only the agent
    working ends a `not-started` wait. The run holds no low-priority slot meanwhile, its time limit
    is paused, and it is a Needs-you item and a notice (`WAIT_WORDS`, `WAIT_NOTICES`);
  - *a question form answered* (`answer`, `AgentRun.answered`) — in Full autonomy (`FULL_AUTONOMY_MODE`)
    Runner presses Enter on the option the form highlights, once per question, and keeps the option
    on the run's agent and in the log; no wait, no item, no notice. With no option highlighted, one
    of the form's free-text rows (`FREE_TEXT_OPTIONS`), or in any other mode, the form is a wait;
  - *waiting for the agent's background work* (`AgentRun.background`, `waitsForBackground`,
    `BACKGROUND_WORDS`) — the turn ended with background work going: the run stays running, its time
    limit counting and its slot kept, and types no exit command until the agent is idle without that
    work. Not a wait for you: no Needs-you item, no notice;
  - *exit typed* (`exitSentAt`) — once the turn is done: the scanner reports idle only at the agent's
    empty prompt (Claude's composer with nothing typed in it, Codex's with only its placeholder), and
    the command is typed on that alone, since its Enter confirms whatever the screen highlights. An
    agent that works on `WORKS_AGAIN_MS` (3 s) after the command (`workedOn`, `worksOn`) is not stopped
    after the exit wait: the run follows the turn afresh and types the command again once it is
    done; one that exits by itself meanwhile is done, as the command's. An agent that waits at a
    prompt for the person after the command did not take it (`notTaken`): the command's time and exit
    wait are cleared, an exit of its own is an early exit (failed), and the command is typed again
    once the turn is done. An agent that answers the exit command with its
    background-work question has it declined with Escape (`background: "asked"`) and the run waits for
    the turn's end afresh; if it is stopped after the exit wait with the question still up, it is
    failed (`BACKGROUND_LEFT_REASON`).

  How an agent run ends (`agentEnd`, `answeredEnd`): the agent exiting, or Runner's stop after the
  exit wait, once the exit command was typed is **done**; an exit before it is **failed** ("the agent
  exited before its turn was done"); a done run whose agent never answered — the Agents app's
  `sessions.lastMessage` is `null` — is **failed**, `NO_ANSWER_REASON`; an answer that cannot be asked
  leaves it done. Stopped by you and the time limit read as for a script. An agent stopped at the
  `not-started` screen made no session of its own: the Agents app has none for the run's session id,
  and the card says so.
- **Records** — history (`history.ts`, JSON Lines per day, output log moved in at the run's end),
  `runs.json`, `switch.json`, `needs-you.json`, `services.json`, `renamed.json` in the workspace's records
  folder; sessions, projects, crash counts (and the crash window going), the Pomade start and the
  console login acted on (`login.json`) in the machine-local state folder.
- **Needs you and notices** (`needs-you.ts`) — one item per failed job; items for a service that gave up
  (with why its last start failed, and whether it has a session), a missed run that waits, an agent run waiting for you (at a prompt, at a question, at a screen Runner does not know, or one that has not started), a long run, a loop-guard pause.
- **Settings** (`settings.ts` pure, `settings-file.ts` read each tick and written field-only).
- **Workspace** (`workspace-follow.ts`) — one workspace at a time; another recorded one restarts the
  scheduler on it, the keeper and its sessions untouched.

## File map

| File | Holds |
|---|---|
| `main.ts` | the entry: reads the app key and keeper socket from the environment, runs the scheduler on the workspace Pomade records |
| `scheduler.ts` | the wiring: the control socket, the Pomade connection and its events, the tick, the loaded jobs and settings, notices and the badge, the broker API |
| `runs.ts` | the run lifecycle: the look, wake, overlap, the switch and its held rows (`heldRows`, `heldRuns`), the staged start and the login decision, firing hooks and chains and writing a chain's action as a service event, starting and ending sessions, time limits, long-run warnings, agent launch, waiting for you, answering a question form, an agent that works on after its exit command |
| `console-login.ts` | the Mac's console login (`consoleLoginOf`, `loginwindowOf`), `login.json` (`loginRecord`), and whether a start is a login (`decideStart`) |
| `triggers.ts` | which of a schedule's occurrences fell since the previous look, every one counted (pure; `pomade-kit`'s engine) |
| `missed.ts` | what a missed-run policy makes of missed occurrences, their count kept with the decision; adding two counts; Run at…'s time (Run all is in `runs.ts`: it is the person's choice, no policy's) |
| `queue.ts` | which queued runs start now, what each other waits for (time, switch, warm-up, previous run, Pomade, a fresh keeper, slot) |
| `switch.ts` | the switch's position, kept in `switch.json` |
| `hooks.ts` | which jobs an event fires, the filters, the environment of a hook's runs (`projectFiring`, `sessionFiring`, `POMADE_STARTED`) |
| `chains.ts` | which jobs a finished run fires; the result a chain sees (none for a service event) |
| `loop-guard.ts` | the firing count per job, the pause, Resume |
| `agent-runs.ts` | an agent run's rules (pure): what its session runs, how its end reads — an unanswered turn and background work left included —, which session the lookup by folder and start time picks, the time an agent has to start working (`NOT_STARTED_MS`; `POMADE_RUNNER_NOT_STARTED_MS` in tests), the question form's free-text rows Runner never answers (`FREE_TEXT_OPTIONS`), the keychain failure's reason |
| `git-runs.ts` | a git run's command line (the repos in the job file's order), its end read with `pomade-git`'s result, its lines per repo, the `jobs.forRepo` answer; a done pull's commit count is read from the result by `integrations/pomade-next.ts` (`pulledCommits`) |
| `history.ts` | history records and the output logs: appending, replacing a crash window's record in place (`put`), reading a page of records (`HistoryRecords`: a `HistoryPage` without its held rows, which `runs.ts` knows), the event that ended a service session (`sessionEnd`), retention, moving a log into the records folder |
| `records-move.ts` | the one-time move of the records from the state folder into the workspace |
| `renamed.ts` | `renamed.json`: old job id → new id after a project move; a job's history takes in every id it had |
| `project-moves.ts` | following a project renamed or moved: job files' `folder:`, the jobs sub-folder, the jobs' state |
| `projects.ts` | Pomade's projects as last heard, in `projects.json` |
| `needs-you.ts` | Needs-you items and the notices runs make |
| `delete.ts` | `jobs.delete`: stop a running service, refuse while a run is going, remove the file |
| `settings.ts`, `settings-file.ts` | the five workspace settings: validation (pure); the file read and written |
| `environment.ts`, `read-environment.ts` | what Settings shows about the Mac (notification permission, where the skill's copy is): the shared type and check (pure); reading it from the Mac |
| `workspace-follow.ts` | waiting for a workspace, starting again on another |
| `run-events.ts` | the payloads of `run.started` and `run.finished`, agent fields included — the run's `terminal`, its keeper session |
| `model.ts` | the shared model of runs (`AgentRun`: `worked`, `workedOn`, `waiting`, `background`, `answered`), history records and their `ServiceEvent`, Needs you, the switch, and their words (`runTriggerWords`, `hookCauseWords`, `waitsWords`, `runWords`, `serviceEventWords`, `pulledWords`, `missedRunsWords`, `heldRunsWords`, `heldRowWords`), `HeldRun` and `HistoryPage.held` |
| `clock.ts` | the `Clock`, the tick length, the test overrides `POMADE_RUNNER_TICK_MS`, `POMADE_RUNNER_CLOCK`, `POMADE_RUNNER_CLOCK_RATE` |
| `log.ts` | one timestamped line per event on stdout (`<userData>/app-logs/pomade-runner/backend.log`) |
| `control/protocol.ts` | the control protocol both sides import: methods, versions, shapes |
| `control/server.ts`, `control/client.ts` | the socket server (it also makes the scheduler single); one request, one answer |
| `runs-fixture.ts` | test support only: in-memory sessions, records, switch and a script job file for `runs.test.ts` and `load.test.ts` |

## Invariants

- Every scheduling decision reads time from the `Clock` it is given. The system clock is read only
  where the keeper's own stamps and a session lookup's window are on it (`runs.ts`: an agent
  session's lookup, the age of a session's end).
- A run's record is written once, when its session's end is 0.5 s old; a restarted scheduler never writes
  one twice and never loses an end that came while it was down.
- A history file is appended to, and the one line ever rewritten is a crash window's, replaced where it
  stands through a temporary file (`put`); a half line at its end never swallows the next record.
- `runs.json` is written on every change and at least once a minute; the last look in it is why a
  scheduler started after a power-off sees what it missed.
- A service is never held by the switch or the warm-up and never followed by a chain's run.
- A job the switch holds gets no record, Needs-you item or notice until the switch lets it go; then
  one decision, whose run or record counts every occurrence it held.
- A held row is derived on each ask from `held`, the job's schedule and the clock, and never written
  to history; the rows' counts add up to `heldRuns`; a job released has no held row beside its record.
- A job has at most one run of a Run all active; its runs never run at once, and each ended run either
  queues the next or is followed by the one record that drops the rest.
- The state folder and the records folder are two types (`src/locations.ts`); a path in one is never
  taken for the other, and nothing under the workspace grows with a live run's output.
- An invalid or half-written job file never stops or starts a running service.
- Every firing passes the loop guard, Pomade's hooks included; a service's start is no firing.
- A Pomade-bound service never runs while Pomade is closed, and a `login` service is untouched by a Pomade quit.
- An agent run starts in a keeper that passed the keychain check or whose check could not run; the keychain
  check never replaces a keeper while a run is going.
- An agent run that waits for the person (a prompt, `not-started`) has its wait left out of its time limit and holds no
  low-priority slot; one that waits for the agent's background work has and holds both.
- The exit command is typed only on the scanner's `idle`, the agent's empty prompt; a screen that is not
  one is never typed into except by Runner's answer to a question form in Full autonomy.
- A service event is written once per happening: Stop's and a chain's stop are not written again when
  the session's end is heard; a crash window is one row, whatever the restarts.
- A start is a login only at another console login than the one last acted on (or, with none to
  compare, when the scheduler started the keeper); the console login acted on is kept only after a
  login's hooks fired.
- An agent's background-work question is declined, never answered with the exit: Runner never stops
  background work by its own exit command.

## Tests

Unit (vitest), beside the files: `agent-runs`, `chains`, `clock`, `console-login`, `control/protocol`,
`delete`, `environment`, `git-runs`, `history`, `hooks`, `hooks-chains`, `load`, `loop-guard`, `missed`, `model`,
`needs-you`, `project-moves`, `queue`, `read-environment`, `records-move`, `renamed`, `runs`, `scheduler`, `settings`,
`settings-file`, `triggers`, `workspace-follow`. E2E: `background`, `runs`, `load`, `chains`, `git`,
`services` (processes, Pomade closed); `pomade`, `pomade-hooks`, `pomade-agent-hooks`, `pomade-agents`,
`pomade-agents-real`, `pomade-open`, `pomade-load`, `pomade-git`, `pomade-lifetimes` (a real Pomade).

Environment seams of the scheduler process, for tests: `POMADE_RUNNER_TICK_MS`, `POMADE_RUNNER_CLOCK`,
`POMADE_RUNNER_CLOCK_RATE` (`clock.ts`), `POMADE_RUNNER_QUIT_GRACE_MS` (Pomade's quit grace),
`POMADE_RUNNER_NOT_STARTED_MS` (`agent-runs.ts`: how long an agent has to start working),
`POMADE_RUNNER_CONSOLE_LOGIN` (`console-login.ts`: the console login in place of the Mac's — a simulated log-out is the scheduler stopped, this changed, the keeper kept or stopped, the scheduler started) and
`POMADE_RUNNER_KEYCHAIN_CHECK` (`keeper/keychain.ts`: a command line the keychain check runs in place of
`security list-keychains` — the stand-in for a keeper that lost the keychain). The scripted fake agent's
words (`[long]`, `[ask]`, `[no-answer]`, `[stuck]`, `[background…]`, …) are documented in the header of
`e2e/fixtures/fake-agent.mjs`.

## Known limits

- Two Macs running one workspace at once both fire (`P-008-multi-device-double-fire`).
- Pomade's and the Agents app's events are heard only while the scheduler is connected; nothing catches
  up one that came while Pomade or the scheduler was not listening.
- A restarted scheduler learns that an agent's turn is done only from the next window title the agent
  sets; a session id the provider does not pre-assign (Codex) is found by folder and start time.
- With no workspace recorded the scheduler waits and writes nothing.
- The console login is read with `ps` as the user's `loginwindow`; when none can be read, a login is
  told from whether the scheduler had to start the keeper, so a log-out with the keeper surviving
  then goes unnoticed.
- A schedule's weekdays are Mon–Fri; national holidays are not skipped.
- History's files and retention days are in UTC; every schedule is in the Mac's local time.
