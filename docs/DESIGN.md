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
| **Scheduler** | the always-on backend: loads job files; supervises the services; evaluates triggers; applies missed-run, queue and load policies; starts the keeper and starts runs through it as its owner; writes history; posts notices; publishes events; serves Runner's API | a login item (launchd) that keeps running when Pomade quits; updated and restarted freely; reconnects to the keeper and its running sessions on restart |
| **Keeper** | `pomade-kit/keeper`, run as Runner's own detached process (`backend/keeper.mjs`): holds every service's and run's terminal session (PTY); serves the attach protocol Pomade tabs use; reports exits | started by the scheduler (`startKeeper`), and started again when it dies; does not notice a scheduler restart or update; a keeper update hands the open PTYs to the new keeper process, so sessions keep running |
| **`pomade-runner` command** | `check [file…]` validates job files · `projects` lists the project ids and jobs sub-folders · `list` prints every job with its kind, trigger in words, next run and last result · `run <job>` runs a job now — a script's run, a service's Start · `history [job]` prints the latest runs · `enable <job>` · `disable <job>` · `services` shows every service and where it stands · `stop <service>` · `restart <service>` · `sessions` shows the keeper and its sessions | on `PATH` via `~/.pomade/bin`; reads the job files and talks to the scheduler directly, so it works with Pomade closed |
| **Skill** | `pomade-runner-jobs` teaches agents the job format and location | master in `app/skills/pomade-runner-jobs/SKILL.md`, shipped in the build at `skills/pomade-runner-jobs` (the manifest's `skills`); `./install` links the installed copy into agents' skill folders |

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
- project jobs in a sub-folder named after the project's folder — the last segment of its root
  (`Projects/coda-helper` → `jobs/coda-helper/coda-web.md`); nothing sits deeper.
- The file name is the job's slug: lower-case letters, digits and single dashes. Other files —
  not `.md`, or hidden (`.x.md`, an editor's swap file) — are not job files.
- A job's **id** is its path inside the jobs folder without `.md`: `backup`,
  `coda-helper/coda-web`. Chains name jobs by id. It names the job's terminal sessions too (see
  "Sessions"), so it is at most 101 characters once encoded — a character other than a letter, a
  digit or `-` counts 3 or more; a longer one is refused.
- A job is bound to its project by the stable project id, so renaming the project doesn't orphan
  it; Runner renames the sub-folder to match. `pomade-runner projects` prints each project's id and
  sub-folder.

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
start: login                     # service: login | project-first-open
ready: { port: 5173 }            # service, optional: up = port open / url answers; default: alive after 5 s
notify: on-failure               # on-failure | always | never
---
Notes for humans and agents.
```

**Fields by kind:**

| Field | Kinds | Values (default first) |
|---|---|---|
| `kind` | all | `service` · `script` · `agent` · `git`; required |
| `name` | all | required; unique across the workspace, ignoring case — History, notices, `pomade-runner run` and git's commit wording name jobs by it |
| `project` | all | the stable project id; required in a project's sub-folder, absent at the top level |
| `enabled` | all | `true` · `false` |
| `folder` | service · script · agent | required; workspace-relative, `.` is the root; never outside the workspace or in `.pomade` |
| `command` | service · script | required; run by the login shell |
| `start` | service | `login` · `project-first-open` (needs `project`) |
| `ready` | service | empty (alive after 5 s) · `{ port: 1–65535 }` · `{ url: http(s)://… }` |
| `schedule` | script · agent · git | a `pomade-kit` schedule-format block (schema owned by `pomade-kit:E-003`), resolution `time`; `always` is refused (a service is always on by itself) |
| `hook` | script · agent · git | `{ event, …filters }` (see Triggers) |
| `after` | script · agent · git · service | `{ job: <id>, result: done \| failed \| any }` (chains); a service also takes `action: restart \| start \| stop` |
| `agent`, `mode` | agent | `agent` (required): a roster id from `pomade-agents`; `mode`: one of that agent's modes, default `normal`; the file **body is the prompt** and must not be empty |
| `git` | git | required: `{ operation: commit-push \| pull \| push \| fetch, repos: [...] }`; repos by the name `pomade-git` accepts, each once; one repo may be written without the list |
| `missed` | scheduled jobs only | `run-on-wake` (agent, script) · `wait-for-me` · `skip` (git) |
| `worth-until` | with `missed: run-on-wake` | `next-run` (default) or a time of day (`12:00`) |
| `overlap` | non-service jobs | `skip` · `parallel` · `queue` |
| `low-priority` | all | `true` for agent and script; `false` for service and git |
| `time-limit` | non-service jobs | empty (none) or a duration: hours and/or minutes (`45m`, `2h`, `1h30m`) |
| `notify` | all | `always` for agent; `on-failure` otherwise; `never` |

**Format rules:**
- A script, agent or git job has exactly one trigger: `schedule`, `hook` or `after`. A service has
  none of `schedule` and `hook`; its `after` acts on it.
- An empty field (`notify:`) means its default; in a mapping the form writes, an entry it leaves
  empty is left out.
- Values are read as YAML 1.2 core: `7:00` and `2026-11-20` are text, `yes` is not `true`.
- Hook filters by event: `project-first-open` takes `project` (none = any project);
  `session-finished` takes `project` and `agent`; `session-status` needs `status` (`active` ·
  `on-hold` · `done` · `done-skip`, the statuses of `pomade-agents`) and takes `project` and `agent`;
  the other events take none.
- A chain names an existing job, never itself and never a service (a service never finishes).

**Validation.** `pomade-runner check`, the scheduler and the form share one validator
(`src/jobs/check.ts`). Every error names:
- the file, field (a path for nested ones: `schedule.weekly.days[1]`) and line;
- the fix, worded so an agent or Daniil can act on it without the docs — a misspelled field or
  value gets the closest correct one.

Errors are one line each: `path:line: field — problem. Fix: …`. Every problem of a file is
reported, not only the first. Across files:
- chains that loop back (A → B → A) are refused on every job in the loop, naming it;
- a chain to a job that does not exist, or to a service, is refused;
- two jobs with the same name are refused.

Project ids are checked against Pomade's projects whenever they are known — the scheduler keeps
the last list it read; the command asks Pomade when it runs — and say so when they are not: an
unknown id, a project job in another project's sub-folder, a hook filter on an unknown project.

**The jobs on the UI.** The scheduler owns the loaded jobs. It reads and watches the jobs folder
itself, from disk, so it works with Pomade closed, and follows the workspace through Pomade's
workspace pointer. While connected to Pomade it serves Runner's own API method `jobs.list` (the
whole checked snapshot: valid jobs, and invalid ones with their errors) through the broker and
publishes `jobs.changed` on every change and when it connects. Runner's frames call `jobs.list` on
Runner itself and call again on `jobs.changed`; no answer means the scheduler is not running, and
the frame says so. The form writes job files through the Host API (`src/ui/jobFiles.ts`): new
files under a free slug in the right folder, field-only changes, and a re-read on every change on
disk.

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
- **Firing** (`src/scheduler/triggers.ts`, `runs.ts`). Every tick the scheduler takes each enabled,
  valid scheduled job's occurrences since its previous look (`occurrencesBetween`):
  - the latest one runs when it is at most 5 minutes old (`ON_TIME_MS`) — a tick, a short stall or
    a wake within 5 minutes still runs it, at once;
  - every other one is **missed**: the Mac slept through it, or the clock jumped past it. Missed
    runs are E-003's ("Missed runs and load"); the scheduler logs them
    (`job backup: missed 07:00 — not run`) and runs nothing for them;
  - nothing before the scheduler's start is due; a clock set back is a fresh start, so the next
    occurrence after the new time runs;
  - while the keeper is not followed nothing is due: the look waits for it, so a short keeper
    outage delays a run instead of losing it.
- **Once at** runs once; after its time it has no next run and shows as **finished**.
- Script jobs fire on schedules; hooks and chains (E-005, E-007), agent and git jobs (E-004,
  E-006) come with their epics.

**Hooks:**

| Hook | In the file | Source | Note |
|---|---|---|---|
| Mac login | `hook: { event: login }` | Runner | one-shot scripts after the warm-up |
| Pomade started | `event: pomade-started` | platform event bus | fires when Pomade is ready (tabs restored) |
| First open of project X since Pomade started | `event: project-first-open` | platform event bus | — |
| Project created | `event: project-created` | platform event bus | — |
| Agent session finished | `event: session-finished` | `pomade-agents` event B | sessions started by Runner never fire it (loop guard) |
| Session status changed to X | `event: session-status` | `pomade-agents` event C | always fires: it is a user action |
| Another job finished (done / failed / any) | `after: { job, result }` | Runner | a **chain** |

**Context for scripts.** Scripts receive the context as environment variables:
- `POMADE_JOB` (the job's id: `backup`, `coda-helper/nightly`), `POMADE_RUN_ID`, `POMADE_TRIGGER`
  (`scheduled` · `manual`; later `hook` · `chain` · `caught-up`)
- `POMADE_PROJECT` (a project job's stable id), `POMADE_PROJECT_PATH` (its project's folder,
  absolute — from Pomade's projects as the scheduler last heard them, `projects.json`; absent until
  it has heard them once)
- `POMADE_SESSION_ID`, `POMADE_AGENT`, `POMADE_SESSION_STATUS` (hooks on agent sessions)
- `POMADE_PARENT_JOB`, `POMADE_PARENT_RUN_ID`, `POMADE_PARENT_RESULT` (chains)

**Loop safety net.** A job fired more than 10 times in 10 minutes by hooks or chains is paused
and goes to Needs you.

## Runs

**States:** `queued` → `running` ⇄ `waiting for you` → `done` · `failed` · `stopped by you` ·
`stopped: time limit`. A run that never started is `skipped` (with a reason) or `missed`.

**Execution:**
- Every run and every service is a keeper session, in the job's folder, in the user's login-shell
  environment (same PATH and keys as Daniil's terminals).
- Low-priority runs start with macOS background priority (`taskpolicy -b`).

**A script's run** (`src/scheduler/runs.ts`, the model in `model.ts`):
- **Start.** A due run, or Run now, starts the session `run:<job>:<run id>`: the job's `command`
  by the login shell, in its `folder`, with low priority as the job says and the context above in
  its environment. Its run id is made from the time it was due, so ids sort by due time.
- **End.** The keeper's exit reason says how it ended: `exited` (status 0) → **done**; `crashed`
  (any other status, or a signal) → **failed**; `stopped-by-you` (Ctrl+C or Stop in its tab) →
  **stopped by you**; `lost-in-keeper-crash`, `stopped` (by Runner) and `time-limit` → **failed**
  with the reason. A session gone from the keeper is **failed** ("its session is gone"); a start
  the keeper refuses is **failed** ("cannot start — …") and never started. Once its record is
  written the session is forgotten.
- **Overlap**, when the job has a run going: `skip` (default) records the new one **skipped ·
  previous run still going** · `parallel` starts it too · `queue` holds one **queued** run that
  starts when the job has none going; while one is held, a further one is **skipped · a run is
  already queued**. A queued run whose job meanwhile is disabled, invalid or gone is skipped when
  its turn comes.
- **Run now** runs a script now, trigger `manual`, under the same overlap: refused with `skip`
  while a run goes and with `queue` while one is held, as it is for a disabled, invalid or unknown
  job and for agent and git jobs. For a service it is Start.
- **Attach.** A running run opens as an attached tab like a service
  (`tabs.openAttached({ session: { app: "pomade-runner", session: "run:…" } })`).
- **Records.** The queued and running runs and each job's latest record are in `runs.json` in
  Runner's state folder, written on every change. A restarted scheduler picks the runs going up
  from it, records the ends that came while it was down, and never writes a record twice.

**Sessions.** The scheduler owns the keeper's sessions (`src/keeper/sessions.ts`): it starts the
keeper (`startKeeper` from `pomade-kit/node`, the entry `backend/keeper.mjs` next to its own) and
stays connected to it as the owner (`connectKeeper`, with the app's key), at
`POMADE_KEEPER_SOCKET`:
- **Following.** Every tick the scheduler makes sure the keeper runs — starting it again when it
  died — and reads its `list`. A restarted scheduler rebuilds its view from that list, with no
  effect on any session.
- **Ids** (`src/keeper/ids.ts`) say whose session it is:
  - a service's one session: `svc:<job>`, the same across restarts (`svc:coda-helper.coda-web`);
  - one run of a job: `run:<job>:<run id>`.
  - `<job>` is the job id encoded into the characters a session id allows: letters, digits and `-`
    stay; `/` becomes `.`; every other character becomes `_` and two hex digits per UTF-8 byte
    (`Café/web` → `Caf_c3_a9.web`). `.` and `_` never stand for themselves, so the encoding is
    reversible and two jobs never share an id. A session id is at most 128 characters, so the
    encoded job id is at most 101 — room for `run:`, `:` and a run id.
- **Run ids** name each start: `YYYYMMDD-HHMMSS-` (UTC) and six random hex digits
  (`20261117-080509-a1b2c3`), so they sort by start time. A service gets a new run id on every
  start; its session id stays.
- **Records.** What `list` does not carry — each session's job, run and output log — is in
  `sessions.json` in Runner's state folder, with the session's end (code, signal, reason, time)
  once it is reported. Every end is reported once, an end while the scheduler was down included. A session with no record (the file lost) is
  read from its id, without a run or log; an id Runner does not make is skipped.
- **Spawn:** the job's folder as `cwd`, the `command` run by the user's login shell, `env`, and
  `background` for low priority. A service's session carries the Restart header action.
- **Stop:** SIGTERM, then SIGKILL after a grace period (default 3 s), with the reason Runner names:
  `stopped`, `stopped-by-you` or `time-limit`. **Forget** drops an ended session from the keeper
  and the records.
- **Restart** stops a running session (reason `stopped`), waits for its end and spawns the same id
  with the job file as it is now; attached tabs follow the new session.
- **Exit reasons** the keeper reports: `exited` · `crashed` · `stopped` (by Runner) ·
  `stopped-by-you` · `time-limit` · `lost-in-keeper-crash`. The scheduler logs each end
  (`session svc:web: ended: crashed — code 137, SIGKILL`).
- **Output.** The keeper keeps ~1,000 lines of scrollback per session. The full history is the
  run's output log, which the keeper appends to: `output/<encoded job id>/<run id>.log` in Runner's
  state folder.
- **Keeper updates.** The keeper's version is a digest of its bundled entry and the versions of the
  packages it loads (`src/keeper/version.ts`); the build computes it and builds the scheduler with
  it. When the running keeper reports another version — older or newer — the scheduler calls
  `upgrade` with the shipped entry, once per scheduler start: the keeper hands its PTYs to the new
  process and the sessions keep running, with the same pids. While a hand-off may be under way
  (20 s) the scheduler only reconnects and never starts a keeper, which would take the socket from
  the one holding the sessions. A hand-off that fails leaves the old keeper running, and the
  scheduler works with it.

**Attached tabs.** Any session opens as a Pomade terminal tab attached to the keeper
(`pomade:E-034`), with `tabs.openAttached({ session: { app: "pomade-runner", session } })`. Pomade
attaches at the keeper's socket directly and never calls Runner to do it:
- the tab shows earlier and live output and takes input;
- closing the tab only detaches;
- Ctrl+C typed through a tab followed by an exit within 5 s, or the tab's Stop, ends the process as
  **stopped by you**;
- header actions (Restart) are set by Runner per session; a click arrives as the platform event
  `attachedTab.action`, delivered to Runner only — the scheduler subscribes while connected to
  Pomade and restarts the service.

**Services** (`src/keeper/supervisor.ts`). The scheduler supervises every service job: each tick,
after it follows the keeper, it compares each service with its session and acts; each session end
the keeper reports updates the service's record.
- **What keeps running.** A valid, enabled service with `start: login` runs all the time. "At
  login" is the scheduler's start — the scheduler is the login item — so every such service that
  is not running is started then. A scheduler restarted after a crash or an update does the same
  and reattaches the running ones: it never restarts a running service. A new service file, or one
  enabled again, starts the same way within a tick.
- **`start: project-first-open`** services start on the first open of their project, a trigger
  that comes with the platform's event bus (E-007). Until it fires they
  are `waiting`, and Start runs them. Once started, a crash restarts them like any service; an end
  that is not their own fault (`lost-in-keeper-crash`) leaves them waiting again.
- **Staged start.** Services start one at a time, in a stable order: workspace jobs first, then
  each project's (by sub-folder), each by id. The next starts when the current one is up, or after
  30 s; one not up by then stays `starting` and keeps being checked. Restarts after a crash take
  their turn the same way. Start, Stop and Restart act at once, out of turn.
- **Up.** By default a service is up once it has run 5 s. `ready: { port }` is up once the port
  accepts a connection on this Mac's loopback (IPv4 or IPv6); `ready: { url }` once the URL gives
  any HTTP answer, an error status or a redirect included — the server is there. Checked every tick.
- **Session ends:**

  | Exit reason | The service |
  |---|---|
  | `crashed`, and `exited` with status 0 | a crash: a service is meant to stay up, so ending at all is a failure. It starts again after a back-off of 1 s, 2 s, 5 s, 10 s, 30 s, then 60 s on every further crash |
  | 5 crashes within 1 minute | `failed`: no more restarts until Start |
  | `stopped-by-you` (Ctrl+C in its tab, its tab's Stop, Stop) | stays stopped until Start |
  | `lost-in-keeper-crash` | not its fault: it starts again at once, through the staged start, and no crash is counted |
  | `stopped` (Runner's own: disable, removal, Restart), `time-limit` | nothing of its own |

  A start the keeper refuses (a folder that does not exist…) counts as a crash, and the reason
  shows as the service's `problem`.
- **"restarted 3× · last crash 14:02"** counts the restarts after a crash. It resets after 10
  minutes of uptime, and on Start; Restart is not counted.
- **Start** starts a service now: it clears `stopped by you` or `failed` and the crash count. It is
  refused for a running, disabled, invalid or unknown service and for a job of another kind.
  **Stop** stops it as stopped by you (SIGTERM, then SIGKILL after 3 s): it stays stopped, and a
  restart due is called off. **Restart** stops a running service (reason `stopped`) and starts it
  again with its job file as it is now, keeping the crash count; one that does not run is started.
  They reach the scheduler from the `pomade-runner` command (`run`, `stop`, `restart`), from
  Runner's frames through the broker, and — Restart — from an attached tab's header.
- **Job file changes:**
  - disabled (`enabled: false`) → a running service is stopped (reason `stopped`);
  - the file deleted, or no longer a service → stopped once it has been gone 2 s, then dropped with
    its session and record (an editor that saves by deleting and writing again stops nothing);
  - its `command` or `folder` edited → it keeps running with what it started with and says it
    needs a restart (`needsRestart`); a restart applies the file;
  - the file invalid → nothing starts or stops it until the file is fixed: a half-written edit
    never takes a running server down.
- **States** (`ServiceState` in `src/keeper/model.ts`, the one model of the services view, the
  broker API and the command): `queued` · `starting` · `running` · `restarting` · `failed` ·
  `stopped-by-you` · `waiting` · `disabled` · `invalid` · `removed`.
- **Records.** What the keeper does not know — holds (`stopped by you`, `failed`), crash counts,
  a restart due, the last start's problem — is in `services.json` in Runner's state folder,
  written on every change, so a restarted scheduler carries on where the last one stopped.
- Without a known workspace, or while the scheduler does not follow the keeper, supervision does
  nothing.

**Agent runs** (an agent → folder → mode):
- **Launch:** Runner builds the command from the agent's launch spec in `pomade-agents`.
- **Session id:** pre-assigned where the agent allows (claude `--session-id`); otherwise looked up
  in `pomade-agents` by folder + start time.
- **Waiting for you:** the session output is scanned (`pomade-kit` agent scanners). A permission
  prompt switches the run to `waiting for you`, and the time limit pauses.
- **Finish:** when the agent's turn completes and it sits idle with no pending prompt, Runner ends
  the session cleanly → `done`.

**Git runs** call `pomade-git <operation> <repo…> --json --job "<job name>"` and record its
structured result, a `GitRunOutput` (type and check `isGitRunOutput` from `pomade-kit/protocol`)
with one `GitRunResult` per repo:
- done / skipped / failed + reason
- the steps
- the commit hash

The command decides the "agent working" skip and appends every run to Pomade's git run log, which
the Git panel's failure mark reads. It posts no notice: Runner notifies about a failed run.

**Result card.** One per run: job · time · duration · result. Kind-specific content:

| Kind | Card adds |
|---|---|
| Script | exit code and last lines |
| Agent | the agent's last message, **Open session** |
| Git | per-repo steps and the commit hash |

Every card has **View output** (the full captured log).

**History** (`src/scheduler/history.ts`). One record per run that ended or never started
(`RunRecord`): the job's id, name and kind, project, folder, run id, trigger, when it was due,
started and ended, how long it ran, the result and its reason, exit code and signal, the output
log, and the last 20 lines of the output as plain text.
- **Format:** append-only JSON Lines, one file per day of the runs' ends (UTC):
  `history/YYYY-MM-DD.jsonl`. A record is one line, written once, when the run ends; nothing is
  rewritten, so a crash can at worst leave a half line at a file's end. A reader skips a line that
  is not a record, and the first append to a file that ends mid-line starts a new line, so a half
  line never swallows the next record. A restarted scheduler reads it as it is.
- **Reading:** newest first, a page at a time (at most 200); a page ends at a cursor
  (`<day>:<line>`) the next page starts before, valid while new runs land.
- **Retention:** whole days, 30 (`HISTORY_DAYS`; the setting comes with E-003): a day's file and
  the output logs of the runs that started that day go once the day is 30 days behind, checked at
  the scheduler's start and every hour; a log a session still writes stays.

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

- **Notify me** per job: always · on failure · never. A run that ended is noticed as its job says:
  `always` every run that started, `on-failure` a failed one, `never` none; a skipped run never.
  The notice names the job and the result ("Backup failed", "exit 3 · <its last line>"); its click
  opens the run's result card (`openApp`, route `run/<job>/<run>`).
- **"Needs you" items always notify:**
  - a failed run
  - waiting for approval
  - wait-for-me missed runs
  - a crash loop that gave up
  - a loop-guard pause
  - a long-run warning
- **The Needs-you model** (`src/scheduler/needs-you.ts`; `NeedsYouItem`):
  - **A failed run** is its job's item — one per job, the latest failure and how many since the
    item came — unless the job says `notify: never`. It goes when the person opens the run's result
    card or dismisses it (`needsYou.dismiss`), when a run of the job is done, or when the job's file
    is gone. Actions: Open · Run now · Dismiss.
  - **A service that gave up** after a crash loop is an item while it stays `failed`; Start, a
    fixed or disabled file, or its removal end it. It is noticed once per giving-up. Action: Start.
  - The items, and the giving-ups already noticed, are in `needs-you.json` in Runner's state
    folder: a restarted scheduler neither forgets an item nor notices one twice.
- **Posting:** the scheduler posts every notice: over its connection while Pomade runs, into
  Pomade's closed-Pomade queue (`<userData>/notices/queue/`) otherwise — and when posting over the
  connection fails.
- **While Pomade runs:** Pomade notices with a click action, and a red badge on the Runner icon
  with the Needs-you count while Needs you is non-empty. Pomade keeps a badge only while it runs:
  the scheduler sets it on every connection, when Pomade is ready (`pomade.ready`) and on every
  change.
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

**Routes of the Runner tab** (`parseRoute`, `src/integrations/runner-api.ts`): `""` Jobs ·
`history` · `run/<encoded job id>/<run id>` a run's result card (what a run's notice opens) ·
`output/<encoded job id>/<run id>` its full output. The tab follows Pomade's `route.changed`.

**Job form.** Creating and editing a job happens in a form, never by hand-editing md. Order: kind
→ trigger → folder and project (agent: agent → folder → mode) → policies.

**Help.** Every non-obvious field, policy and status carries an (i) tooltip with a one-line
example. This is a product requirement, not polish.

## Data and locations

| What | Where |
|---|---|
| Job files | `<workspace>/Apps/pomade-runner/jobs/` (synced with the workspace) |
| Workspace settings (max heavy runs 2, warm-up 2 min, long-run warning 3h, retention 30 days) | `<workspace>/Apps/pomade-runner/settings.yaml` |
| Run history, captured output (30 days), keeper state (`keeper/`), switch position, last-alive record | `<userData>/app-state/pomade-runner/` (machine-local) |
| Session records (job, run, output log, end) | `<userData>/app-state/pomade-runner/sessions.json` |
| Service supervision records (holds, crash counts, a restart due) | `<userData>/app-state/pomade-runner/services.json` |
| Run output logs | `<userData>/app-state/pomade-runner/output/<encoded job id>/<run id>.log` |
| Run history (one file per day, JSON Lines) | `<userData>/app-state/pomade-runner/history/YYYY-MM-DD.jsonl` |
| Runs going and each job's latest record | `<userData>/app-state/pomade-runner/runs.json` |
| Needs-you items, the giving-ups noticed | `<userData>/app-state/pomade-runner/needs-you.json` |
| Pomade's projects as last heard (for `POMADE_PROJECT_PATH`) | `<userData>/app-state/pomade-runner/projects.json` |
| The keeper's own state (session records, exit statuses, `keeper.log`) and its stdout and stderr (`keeper.out`) | `<userData>/app-state/pomade-runner/keeper/` |
| Scheduler log (its stdout and stderr) | `<userData>/app-logs/pomade-runner/backend.log` |
| Scheduler control socket | `<userData>/app-state/pomade-runner/scheduler.sock` |
| Keeper socket (`POMADE_KEEPER_SOCKET`) | `<userData>/run/keepers/pomade-runner.sock` |
| Installed build (the scheduler's login item path) | `<userData>/apps/pomade-runner/` |

## Interfaces

**Runner offers:**
- **`jobs.list`** through the broker, to Runner's own frames: the checked jobs (see "Job files").
  **`jobs.changed`** on the platform bus tells them to ask again.
- **`services.list`** through the broker, to Runner's own frames: every service and where it
  stands (`ServicesReport`, check `isServicesReport`); **`services.changed`** tells them to ask
  again. **`services.start`**, **`services.stop`**, **`services.restart`** with `{ job }` (its id or
  name), from Runner's own frames only, answer `ServiceActionResult` — the service's status after,
  or why it was refused. A start or restart may wait for a running session to end: callers give it
  `SERVICE_ACTION_TIMEOUT_MS` (`src/integrations/runner-api.ts`).
- **Runs**, through the broker:
  - **`runs.list`** → `RunsReport` (`isRunsReport`): the runs going (queued and running), Next up
    (every enabled scheduled job's next run), each run job's next and latest run, and Needs you;
    **`runs.changed`** tells Runner's frames to ask again — on every change, and when the scheduler
    connects.
  - **`history.list`** `{ job?, before?, limit? }` → `HistoryPage`; **`runs.get`** `{ job, run }` →
    `RunView` or `null`; **`runs.output`** `{ job, run }` → `RunOutput`: the end of its log, at
    most 1 MiB.
  - From Runner's own frames only: **`jobs.run`** `{ job }` → `RunActionResult` (Run now) ·
    **`jobs.setEnabled`** `{ job, enabled }` → `EnableResult`: writes `enabled:` into the job's file,
    field-only · **`needsYou.dismiss`** `{ id }` → `{ resolved }`.
- **`jobs.forRepo`** through the broker: the jobs that target a repo. Params `RepoJobsParams`, result
  `RepoJobsResult` with `RepoJob`s (id, name, operation, schedule in words, next run, last result,
  and `route`, Runner's tab route that opens the job) — the contract is in `pomade-kit/protocol`.
  Pomade's git repo row reads it (PLATFORM rule 7).
- **Events** on the platform bus: **`run.started`** when a run's session starts, **`run.finished`**
  when a run that started ends (a skipped run, or one that never started, publishes neither). Live
  only: published while the scheduler is connected to Pomade.
  - Payload (`RunStartedPayload`, `RunFinishedPayload`): `job` (id), `name`, `run`, `kind`,
    `folder` (workspace-relative), `project` (id or `null`), `trigger`; on run finished also
    `result` (`done` · `failed` · `stopped-by-you`) and `exitCode`.
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
| Platform (`pomade:E-034`) | attached terminals: the pane, `tabs.openAttached`, `attachedTab.action` |
| `pomade-git` (`pomade:E-042`) | git operations, structured results |
| `pomade-kit` | SDK, schedule format, date phrases, agent scanners, the keeper library and attach protocol, the git runs contract |
| `pomade-agents` | agents + modes + launch specs, projects ↔ agents, last message, session lookup, events B and C |

## Stack

TypeScript (strict) everywhere, on `pomade-kit` (`github:dd-voronov/pomade-kit#v0.9.0`).

| Part | Built with | Why |
|---|---|---|
| UI | React 19, CSS modules over `src/ui/tokens.css`, bundled by Vite | the tab grows into several views and a form with many dependent fields: component state and composition carry that; Pomade's renderer is React with CSS modules and tokens, so the look and the habits are shared; no UI framework on top |
| Scheduler, keeper, command | Node programs on Pomade's runtime (Electron in Node mode), each bundled by esbuild into one `.mjs` file with everything it imports; the four packages the keeper loads at run time ship beside them | an installed copy has no `node_modules` of the repo; one file per entry runs from the build folder alone |
| Tests | vitest for logic; Playwright for the built app — the UI in `pomade-kit`'s fake host, the scheduler and command as processes, Runner hosted by a real Pomade, the install script | the family's split: input matrices in vitest, behavior through the real thing in e2e |
| Lint | ESLint flat config, type-aware typescript-eslint with hand-picked rules, React's hook rules, Playwright's rules | the platform's approach: silent bug classes, not style |

**The build folder** (`dist/`, what `pomade apps install` copies):

| Path | What |
|---|---|
| `manifest.json`, `icon.svg` | the static files of `app/` |
| `index.html`, `assets/` | the UI — one bundle for the panel, the tab and a plain browser |
| `backend/scheduler.mjs` | the scheduler, the manifest's always-on `backend` (`restartOnUpdate`: an update restarts it) |
| `backend/keeper.mjs` | the keeper's entry, which the scheduler starts with the keeper's version as its argument |
| `node_modules/` | what the keeper loads with `require` at run time, which a bundle cannot carry: `node-pty` (`package.json`, `lib/`, `prebuilds/darwin-*` — its binary is N-API, so it loads in any Pomade runtime with no rebuild; the build sets its helper's executable bit), `@xterm/headless`, `@xterm/addon-serialize`, `@xterm/addon-unicode11` — the versions `pomade-kit` resolves |
| `cli/pomade-runner.mjs` | the `pomade-runner` command |
| `skills/pomade-runner-jobs/` | the agent skill, from `app/skills/` (the manifest's `skills`; the build checks each folder has its `SKILL.md`) |

**The agent skill reaches the agents** through `./install`, after `pomade apps install`
(`src/jobs/skill/link.ts`, run by Node from the repo): it links the skill's folder in the
installed build into `~/.claude/skills/` and into `skills/` of every agent folder under
`<workspace>/Agents/` (a folder with a `CLAUDE.md`, as Pomade's roster counts agents), creating
`skills/` where missing. A link that is there already stays; a link to another Pomade's copy is
repointed; anything else at that name is left alone. The first link drops a note for the skills
map into `<workspace>/Knowledge/00-Inbox/` (remembered in Runner's state folder). `./uninstall`
removes the links to this Pomade's copy, then the app.

**Theme.** The UI's tokens carry Pomade's names and light values; the dark values follow the
system's colour scheme (`prefers-color-scheme`).

**The scheduler's control socket.** The command reaches the scheduler over the scheduler's own
unix socket, `<userData>/app-state/pomade-runner/scheduler.sock`, so it works with Pomade closed:
- **Protocol:** one JSON object per line, request → response; `src/scheduler/control/protocol.ts`
  is the one definition both sides import. A request names the protocol version it speaks and
  every response carries the scheduler's; a mismatch is answered with an error that says both. An
  older scheduler answers a method it does not have with `unknown-method`.
- **Methods:** `status` (the scheduler: version, pid, start, last tick on its clock, Pomade link) ·
  `sessions` (the keeper's state and every session with its job, run and output log;
  `pomade-runner sessions` prints it) · `services` (the keeper's state and every service: its
  `ServiceStatus`; `pomade-runner services` prints it) · `run { job }` (Run now: a script's run,
  or a service's Start — `RunStarted`) · `stop { job }` · `restart { job }` (Stop, Restart a
  service, answering its status after) · `enable { job }` · `disable { job }` (`enabled:` written
  into the job's file) · `list` (every job: `JobListing`; `pomade-runner list`) · `history { job,
  limit }` (`HistoryPage`; `pomade-runner history`). A job is named by its id or name; what cannot
  be done is `refused`, with the reason — "Runs" and "Services" say what.
- **Location:** found from `POMADE_APP_KEY_FILE` (`<userData>/app-keys/pomade-runner`), which
  Pomade gives the scheduler and the command alike — each Pomade (dev, stable, a test run) has its
  own scheduler.
- **One scheduler per Pomade:** a second one finds the first answering on the socket and exits
  cleanly, never touching the keeper; the socket file of a killed scheduler is replaced.
- **Starting needs** `POMADE_APP_KEY_FILE` (a readable key) and `POMADE_KEEPER_SOCKET`; without
  them the scheduler logs why and exits with 1.

**Test hooks.** Every part of the scheduler reads the time from the `Clock` it is given
(`src/scheduler/clock.ts`). For a run of the real process, `POMADE_RUNNER_TICK_MS` shortens its
1 s tick, and `POMADE_RUNNER_CLOCK` (an ISO date-time; without an offset, local time) starts its
clock at another time, running `POMADE_RUNNER_CLOCK_RATE` times as fast (default 1) — so a day's
schedule plays out in seconds. Unset, empty or invalid values mean the production ones. A tick
due while the previous one still works is dropped.
