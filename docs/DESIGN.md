# Runner — design

`pomade-runner` ("Runner" in the UI) is the Pomade app that runs things without Daniil. It runs:
- **always-on services** that outlive Pomade;
- **scripts, git operations and unattended agent runs**, on schedules, hooks and chains.

It keeps runs going when the Mac sleeps or Pomade is closed, and keeps the Mac responsive while
they run. Every result reaches Daniil as a notification and a result card. It is a
workspace-level app: one list of every job, filterable to the current project.

- **Reasoning and history:** the G3 grill outcome
  (`../Pomade/docs/auxiliary/grills/2026-11-09-g3-runner.md`) and the final reconciliation
  (`../Pomade/docs/auxiliary/grills/2026-11-09-final-reconciliation-g1-g4.md`).
- **Platform rules:** `../Pomade/docs/PLATFORM.md`.

## Parts

| Part | What it does | Lifecycle |
|---|---|---|
| **UI** | the Runner side panel and the Runner tab, in Pomade (`pomade-app://pomade-runner/`) | hidden-not-unmounted, like every pane |
| **Keeper** | owns every service's and run's terminal session (PTY); serves the attach protocol Pomade tabs use; reports exits | always-on login item; tiny and rarely updated; a keeper update asks the user before restarting services |
| **Scheduler** | loads job files; evaluates triggers; applies missed-run, queue and load policies; starts runs through the keeper; writes history; posts notices; publishes events; serves Runner's API | started by the keeper; updated freely; reattaches to running sessions on restart |
| **`pomade-runner` command** | `check [file…]` validates job files · `run <job>` starts a run now · `list` prints jobs with their next run and last result | on `PATH` via `~/.pomade/bin`; talks to the scheduler directly, so it works with Pomade closed |
| **Skill** | `skill/pomade-runner-jobs/SKILL.md` teaches agents the job format and location | master in this repo; install links it into agents' skill folders |

**What Runner tracks:** only jobs created in Runner. A terminal opened by hand, inside Pomade or
outside it, is just a terminal.

**Pomade is never required for a run to keep going.** Services, scripts and git jobs run while
Pomade is closed. Agent jobs need Pomade: when one is due and Pomade is closed, Runner launches it
and waits until it is ready.

## Jobs

A job has a **kind**, a **trigger**, a **folder** and **policies**.

| Kind | Does | Trigger |
|---|---|---|
| **Service** | keeps a command running; restarts it on crash | always on: at login, or on the first open of a project |
| **Script** | runs a command once per trigger | schedule · hook · chain |
| **Agent** | runs an agent with a prompt, unattended | schedule · hook · chain |
| **Git** | runs `pomade-git <operation> <repo>` for one or more repos | schedule · hook · chain |

### Job files

**Location.** One md file per job, in `<workspace>/Apps/pomade-runner/jobs/`:
- workspace jobs at the top level;
- project jobs in a sub-folder named after the project
  (`jobs/coda-helper/coda-web.md`).
- The file name is the job's slug.
- A job is bound to its project by the stable project id, so renaming the project doesn't orphan
  it; Runner renames the sub-folder to match.

**Readers and writers.** The file is the agents' interface. Daniil edits through the form, which
writes field-only changes, so comments and the body survive. The file on disk is the truth:
- an edit by hand or by an agent applies within a second;
- an invalid file is shown with its error and never runs.

```markdown
---
kind: service                    # service | script | agent | git
name: Coda web
project: <stable project id>     # omit for a workspace job
folder: Projects/coda-helper     # working folder, workspace-relative
enabled: true
command: ./start.sh              # service, script
start: login                     # service: login | project-first-opened
ready: { port: 5173 }            # service, optional: up = port open / url answers; default: alive after 5 s
notify: on-failure               # on-failure | always | never
---
Notes for humans and agents.
```

**Fields by kind:**

| Field | Kinds | Values (default first) |
|---|---|---|
| `schedule` | script · agent · git | a `pomade-kit` schedule-format block (schema owned by `pomade-kit:E-003`) |
| `hook` | script · agent · git | `{ event, …filters }` (see Triggers) |
| `after` | script · agent · git · service | `{ job, result: done \| failed \| any }` (chains); a service also takes `action: restart \| start \| stop` |
| `agent`, `mode` | agent | a roster id from `pomade-agents`, and one of that agent's modes (`normal`, `full-autonomy`, …); the file **body is the prompt** |
| `git` | git | `{ operation: commit-push \| pull \| push \| fetch, repos: [...] }` |
| `missed` | scheduled jobs | `run-on-wake` (agent, script) · `wait-for-me` · `skip` (git); `worth-until: "12:00"` or `next-run` (default) for run-on-wake |
| `overlap` | non-service jobs | `skip` · `parallel` · `queue` |
| `low-priority` | all | `true` for agent and script; `false` for service and git |
| `time-limit` | non-service jobs | empty (none) or a duration (`45m`) |
| `notify` | all | `always` for agent; `on-failure` otherwise; `never` |

**Validation.** `pomade-runner check` and the form share one validator. Every error names:
- the file, field and line;
- the fix.

Chains that loop back (A → B → A) are refused.

## Triggers

**Schedules:**
- **Shapes:**
  - once at
  - every N minutes or hours (optionally within hours)
  - daily at one or more times
  - weekly on chosen days
  - monthly on one or more days (the last day, the first Monday…)
- **Weekdays only / Weekends only** filter.
- **Clock:** local time, following the Mac's clock.
- **Engine:** the format and next-occurrence engine are `pomade-kit`'s `schedule-format`.
- **No raw cron syntax.**
- **UI:** shows every schedule in words ("weekdays at 7:00").

**Hooks:**

| Hook | Source | Note |
|---|---|---|
| Mac login | Runner | one-shot scripts after the warm-up |
| Pomade started | platform event bus | fires when Pomade is ready (tabs restored) |
| First open of project X since Pomade started | platform event bus | — |
| Project created | platform event bus | — |
| Agent session finished | `pomade-agents` event B | sessions started by Runner never fire it (loop guard) |
| Session status changed to X | `pomade-agents` event C | always fires: it is a user action |
| Another job finished (done / failed / any) | Runner | a **chain** |

**Context for scripts.** Scripts receive the context as environment variables:
- `POMADE_JOB`, `POMADE_RUN_ID`, `POMADE_TRIGGER`
- `POMADE_PROJECT`, `POMADE_PROJECT_PATH`
- `POMADE_SESSION_ID`, `POMADE_AGENT`, `POMADE_SESSION_STATUS`
- `POMADE_PARENT_JOB`, `POMADE_PARENT_RUN_ID`, `POMADE_PARENT_RESULT`

**Loop safety net.** A job fired more than 10 times in 10 minutes by hooks or chains is paused
and goes to Needs you.

## Runs

**States:** `queued` → `running` ⇄ `waiting for you` → `done` · `failed` · `stopped by you` ·
`stopped: time limit`. A run that never started is `skipped` (with a reason) or `missed`.

**Execution:**
- Every run and every service is a keeper session, in the job's folder, in the user's login-shell
  environment (same PATH and keys as Daniil's terminals).
- Low-priority runs start with macOS background priority (`taskpolicy -b`).

**Attached tabs.** Any session opens as a Pomade terminal tab attached to the keeper
(`pomade:E-034`):
- the tab shows earlier and live output and takes input;
- closing the tab only detaches;
- Ctrl+C typed through a tab, or Stop, ends the process as **stopped by you**.

**Services:**
- Start at login one by one, each given until it is "up" (alive after 5 s, or its `ready` check)
  before the next.
- A crash restarts it with a back-off.
- 5 crashes within 1 minute → `failed`, no more restarts.
- "Stopped by you" stays stopped until Start.

**Agent runs** (an agent → folder → mode):
- **Launch:** Runner builds the command from the agent's launch spec in `pomade-agents`.
- **Session id:** pre-assigned where the agent allows (claude `--session-id`); otherwise looked up
  in `pomade-agents` by folder + start time.
- **Waiting for you:** the session output is scanned (`pomade-kit` agent scanners). A permission
  prompt switches the run to `waiting for you`, and the time limit pauses.
- **Finish:** when the agent's turn completes and it sits idle with no pending prompt, Runner ends
  the session cleanly → `done`.

**Git runs** call `pomade-git` and record its structured result:
- done / skipped / failed + reason
- the steps
- the commit hash

**Result card.** One per run: job · time · duration · result. Kind-specific content:

| Kind | Card adds |
|---|---|
| Script | exit code and last lines |
| Agent | the agent's last message, **Open session** |
| Git | per-repo steps and the commit hash |

Every card has **View output** (the full captured log).

## Missed runs and load

- **Missed-run detection.** The scheduler records its last alive time. On start or wake, it
  computes each job's missed occurrences, after sleep and after power-off alike.
- **Missed-run policies, per job:**
  - **Run on wake:** once, while within "still worth it until".
  - **Wait for me:** a Needs-you card with Run now · Run at… · Skip.
  - **Skip:** recorded only.
- **Overlap**, per job: skip (default) · parallel · queue after.
- **Concurrency:** at most 2 low-priority runs at once; others are `queued · N ahead`.
- **Staged start after login or wake:**
  1. services, one by one;
  2. a 2-minute warm-up;
  3. caught-up runs and hooks, through the queue.
- **Global switch**, three positions: **Running · Pause low-priority · Pause all**.
  - Held runs become missed runs and follow their policy on resume.
  - Services keep running in every position.
- **Time limits:**
  - per job, empty by default;
  - when hit: the run stops with a red card.
- **Long-run warning:** always on, never kills; at 3h: *"still expected? · Open · Stop"*.

## Notifications

- **Notify me** per job: always · on failure · never.
- **"Needs you" items always notify:**
  - waiting for approval
  - wait-for-me missed runs
  - a crash loop that gave up
  - a loop-guard pause
  - a long-run warning
- **While Pomade runs:** Pomade notices with a click action, and a badge on the Runner icon while
  Needs you is non-empty.
- **While Pomade is closed:**
  - notices wait in the platform queue and show on the next launch;
  - "needs you" items also post a native macOS notification, whose click opens Pomade at the item.

## UI

**Side panel** (the Runner icon on the left strip):
1. the three-position switch;
2. **Needs you**, with actions inline;
3. **Running now** (services and active runs: name, project, folder, uptime, status; click opens
   the attached tab);
4. **Next up** (the next ~5 runs);
5. **Open Runner**.

**Runner tab:**
- **Jobs:** grouped by project, workspace jobs first, "This project" chip. Each row: trigger in
  words, last result, next run, Run now · Edit · Disable · Open file.
- **History:** every run, with time, job, result, duration and trigger type (scheduled · caught
  up · manual · hook · chain); opens the result card or the output.
- **Services:** start / stop / restart, crash count, log.
- **Settings.**

**Job form.** Creating and editing a job happens in a form, never by hand-editing md. Order: kind
→ trigger → folder and project (agent: agent → folder → mode) → policies.

**Help.** Every non-obvious field, policy and status carries an (i) tooltip with a one-line
example. This is a product requirement, not polish.

## Data and locations

| What | Where |
|---|---|
| Job files | `<workspace>/Apps/pomade-runner/jobs/` (synced with the workspace) |
| Workspace settings (max heavy runs 2, warm-up 2 min, long-run warning 3h, retention 30 days) | `<workspace>/Apps/pomade-runner/settings.yaml` |
| Run history, captured output (30 days), keeper state, switch position, last-alive record, logs | `<userData>/app-state/pomade-runner/` (machine-local) |
| Installed build (keeper login item path) | `<userData>/apps/pomade-runner/` |

## Interfaces

**Runner offers:**
- **"Jobs that target repo X"** through the broker: name, operation, schedule in words, next run,
  last result, open-in-Runner link. Pomade's git repo row reads it (PLATFORM rule 7).
- **Events** on the platform bus: **run started**, **run finished**.
  - Payload: job name, run id, kind, folder, project id, and on run finished the result.
  - For agent runs, also the session id, the agent and the started-by-Runner flag.
  - `pomade-agents` subscribes (its "agent live here?" and event B use them), and never calls
    Runner.
- **The `pomade-runner` command.**

**Runner uses:**

| Source | What |
|---|---|
| Platform (`pomade:E-027`) | app hosting |
| Platform (`pomade:E-028`) | always-on backend, commands, broker, launching Pomade |
| Platform (`pomade:E-029`) | side panel and badge |
| Platform (`pomade:E-030`) | projects, stable ids, repos, open file, folder picker |
| Platform (`pomade:E-031`) | events |
| Platform (`pomade:E-032`) | notices and the closed-Pomade queue |
| Platform (`pomade:E-033`) | Open session |
| Platform (`pomade:E-034`) | attached terminals |
| `pomade-git` (`pomade:E-042`) | git operations, structured results |
| `pomade-kit` | SDK, schedule format, date phrases, agent scanners |
| `pomade-agents` | agents + modes + launch specs, projects ↔ agents, last message, session lookup, events B and C |

## Stack

Chosen by the first epic ([[T-002-app-skeleton]]) on top of `pomade-kit`'s SDK, and recorded here.
