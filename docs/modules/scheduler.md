---
doc: docs/modules/scheduler.md
audience: engineers, product
holds: the scheduler module — what it does and its rules, the file map of `src/scheduler/`, invariants, tests, known limits
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
"Project renamed", "Missed runs and load", "Settings", "Notifications", "Data and locations",
"Interfaces", "The scheduler's control socket". This page is the code map and what a change must
keep true.

## What it does and its rules

- **One tick a second** on a `Clock` (`clock.ts`). Every tick: follow the workspace, follow the keeper,
  read the settings, take each scheduled job's occurrences since its previous look (`triggers.ts`),
  fire the latest when it is at most 5 minutes old, hand every other one to the job's missed-run
  policy (`missed.ts`), start the queued runs the queue lets go (`queue.ts`), supervise services.
- **Hooks** — one firing path, `hook()` in `runs.ts`, for every event; `hooks.ts` says which jobs an event
  fires and what environment its runs get. Events: Mac login (a scheduler start that finds no keeper
  running), Pomade started, first open of a project, project created, agent session finished, session
  status changed. Hooks have no missed-run policy: a run the switch held runs late. The projects
  opened since Pomade started are kept with the start (`integrations/pomade-start.ts`): a first open
  fires once per Pomade start, a restarted scheduler too, and the supervisor starts a first-open
  service of an opened project as soon as it exists.
- **Chains** (`chains.ts`) — a run that ends done or failed fires its followers; a service follows with
  its `action` and never waits for the warm-up or the switch.
- **Loop guard** (`loop-guard.ts`) — more than 10 firings of a job in 10 minutes by hooks or chains pauses
  it until Resume; Run now never counts.
- **Runs** (`runs.ts`) — queued → running ⇄ waiting for you → done · failed · stopped by you; skipped and
  missed ones are records. Agent runs (`agent-runs.ts` for the rules, the launch in `runs.ts`) and git
  runs (`git-runs.ts`) are script runs with their own command and end.
- **Records** — history (`history.ts`, JSON Lines per day, output log moved in at the run's end),
  `runs.json`, `switch.json`, `needs-you.json`, `services.json`, `renamed.json` in the workspace's records
  folder; sessions, projects, crash counts and the Pomade start in the machine-local state folder.
- **Needs you and notices** (`needs-you.ts`) — one item per failed job; items for a service that gave up,
  a missed run that waits, an agent run waiting for you, a long run, a loop-guard pause.
- **Settings** (`settings.ts` pure, `settings-file.ts` read each tick and written field-only).
- **Workspace** (`workspace-follow.ts`) — one workspace at a time; another recorded one restarts the
  scheduler on it, the keeper and its sessions untouched.

## File map

| File | Holds |
|---|---|
| `main.ts` | the entry: reads the app key and keeper socket from the environment, runs the scheduler on the workspace Pomade records |
| `scheduler.ts` | the wiring: the control socket, the Pomade connection and its events, the tick, the loaded jobs and settings, notices and the badge, the broker API |
| `runs.ts` | the run lifecycle: the look, wake, overlap, the staged start, the login hook, firing hooks and chains, starting and ending sessions, time limits, long-run warnings, agent launch, waiting for you |
| `triggers.ts` | which of a schedule's occurrences fell since the previous look (pure; `pomade-kit`'s engine) |
| `missed.ts` | what a missed-run policy makes of missed occurrences; Run at…'s time |
| `queue.ts` | which queued runs start now, what each other waits for (time, switch, warm-up, previous run, Pomade, slot) |
| `switch.ts` | the switch's position, kept in `switch.json` |
| `hooks.ts` | which jobs an event fires, the filters, the environment of a hook's runs (`projectFiring`, `sessionFiring`, `POMADE_STARTED`) |
| `chains.ts` | which jobs a finished run fires |
| `loop-guard.ts` | the firing count per job, the pause, Resume |
| `agent-runs.ts` | an agent run's rules (pure): what its session runs, how its end reads, which session the lookup by folder and start time picks |
| `git-runs.ts` | a git run's command line, its end read with `pomade-git`'s result, its lines per repo, the `jobs.forRepo` answer |
| `history.ts` | history records and the output logs: appending, reading a page, retention, moving a log into the records folder |
| `records-move.ts` | the one-time move of the records from the state folder into the workspace |
| `renamed.ts` | `renamed.json`: old job id → new id after a project move; a job's history takes in every id it had |
| `project-moves.ts` | following a project renamed or moved: job files' `folder:`, the jobs sub-folder, the jobs' state |
| `projects.ts` | Pomade's projects as last heard, in `projects.json` |
| `needs-you.ts` | Needs-you items and the notices runs make |
| `delete.ts` | `jobs.delete`: stop a running service, refuse while a run is going, remove the file |
| `settings.ts`, `settings-file.ts` | the four workspace settings: validation (pure); the file read and written |
| `environment.ts`, `read-environment.ts` | what Settings shows about the Mac (notification permission, the skill's links): the shared type and check (pure); reading it from the Mac |
| `workspace-follow.ts` | waiting for a workspace, starting again on another |
| `run-events.ts` | the payloads of `run.started` and `run.finished`, agent fields included |
| `model.ts` | the shared model of runs, history records, Needs you, the switch, and their words (`runTriggerWords`, `hookCauseWords`, `waitsWords`) |
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
- A history file is append-only; a half line at its end never swallows the next record.
- `runs.json` is written on every change and at least once a minute; the last look in it is why a
  scheduler started after a power-off sees what it missed.
- A service is never held by the switch or the warm-up and never followed by a chain's run.
- The state folder and the records folder are two types (`src/locations.ts`); a path in one is never
  taken for the other, and nothing under the workspace grows with a live run's output.
- An invalid or half-written job file never stops or starts a running service.
- Every firing passes the loop guard, Pomade's hooks included; a first-open service's start is no firing.

## Tests

Unit (vitest), beside the files: `agent-runs`, `chains`, `clock`, `control/protocol`, `delete`,
`environment`, `git-runs`, `history`, `hooks`, `hooks-chains`, `load`, `loop-guard`, `missed`, `model`,
`needs-you`, `project-moves`, `queue`, `records-move`, `renamed`, `runs`, `scheduler`, `settings`,
`settings-file`, `triggers`, `workspace-follow`. E2E: `background`, `runs`, `load`, `chains`, `git`,
`services` (processes, Pomade closed); `pomade`, `pomade-hooks`, `pomade-agent-hooks`, `pomade-agents`,
`pomade-agents-real`, `pomade-open`, `pomade-load`, `pomade-git` (a real Pomade).

## Known limits

- Two Macs running one workspace at once both fire (`P-008-multi-device-double-fire`).
- Pomade's and the Agents app's events are heard only while the scheduler is connected; nothing catches
  up one that came while Pomade or the scheduler was not listening.
- A restarted scheduler learns that an agent's turn is done only from the next window title the agent
  sets; a session id the provider does not pre-assign (Codex) is found by folder and start time.
- With no workspace recorded the scheduler waits and writes nothing.
- A schedule's weekdays are Mon–Fri; national holidays are not skipped.
- History's files and retention days are in UTC; every schedule is in the Mac's local time.
