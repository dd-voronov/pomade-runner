---
doc: docs/DESIGN.md
audience: engineers, product; every worker on a Runner ticket
holds: the living design of Runner — its parts, jobs and job files, triggers, runs, missed runs and load, settings, notifications, UI, data, interfaces and stack
kind: reference
---

# Runner — design

`pomade-runner` ("Runner" in the UI) is the Pomade app that runs things without the Owner. It runs:
- **always-on services** that outlive Pomade;
- **scripts, git operations and unattended agent runs**, on schedules, hooks and chains.

It keeps runs going when the Mac sleeps or Pomade is closed, and keeps the Mac responsive while
they run. Every result reaches the Owner as a notification and a result card. It is a
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
| **`pomade-runner` command** | `check [file…]` validates job files and the settings file · `projects` lists the project ids and jobs sub-folders · `list` prints every job with its kind, trigger in words, next run and last result · `run <job>` runs a job now — a script's or git job's run, a service's Start · `history [job]` prints the latest runs · `runs` prints the switch, the runs going with what each queued one waits for, and Needs you · `pause [low\|all]` · `resume` set the switch · `resume-job <job>` lifts the loop guard's pause of a job · `enable <job>` · `disable <job>` · `services` shows every service and where it stands · `stop <service>` · `restart <service>` · `sessions` shows the keeper and its sessions | on `PATH` via `~/.pomade/bin`; reads the job files and the settings and talks to the scheduler directly, so it works with Pomade closed |
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

**Why md with YAML frontmatter, not JSON.** People and agents both write and read these files:
- an agent job's prompt is prose, and it is the file body: multi-line and diff-friendly, where
  JSON would hold it as one escaped string;
- YAML keeps comments (`# runs at 3:00 — after the backup`), and the form's field-only writes
  keep them in place; JSON has no comments;
- it is the Pomade family's item format (Planner, Board, the editor's properties): one parser
  and one format-preserving writer, `pomade-kit/frontmatter`, and the file opens in Pomade's
  editor or Obsidian as properties plus notes;
- agents already write md with frontmatter across the workspace, so the skill teaches fields,
  not a format.

The costs are YAML's ambiguous values, answered by reading YAML 1.2 core (see "Format rules"),
and nested fields (`git`, `hook`, `schedule`) that are plainer in JSON; Runner's own validation
stands in for an editor-side JSON Schema.

**Readers and writers.** The file is the agents' interface. The Owner edits through the form, which
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
| `name` | all | required; unique across the workspace, ignoring case — History, notices, `pomade-runner run` and git's commit wording name jobs by it; a git job's at most 100 characters, as `pomade-git --job` takes it |
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
| `git` | git | required: `{ operation: commit-push \| pull \| push \| fetch, repos: [...] }`; repos by the name `pomade-git` accepts, each once, none starting with `-` (the command would read it as an option); one repo may be written without the list |
| `missed` | scheduled jobs only | `run-on-wake` (agent, script) · `wait-for-me` · `skip` (git) — what a missed run becomes ("Missed runs and load") |
| `worth-until` | with `missed: run-on-wake` | `next-run` (default) or a time of day (`12:00`): until when a caught-up run is worth starting |
| `overlap` | non-service jobs | `skip` · `parallel` · `queue` |
| `low-priority` | all | `true` for agent and script; `false` for service and git — macOS background priority; a low-priority run takes one of the low-priority slots and is held by Pause low-priority |
| `time-limit` | non-service jobs | empty (none) or a duration: hours and/or minutes (`45m`, `2h`, `1h30m`); a run past it is stopped |
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
- the fix, worded so an agent or the Owner can act on it without the docs — a misspelled field or
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
  valid scheduled job's occurrences since its previous look (`occurrencesBetween`; a look over
  more than 1,000 keeps the earliest and always the latest):
  - the latest one runs when it is at most 5 minutes old (`ON_TIME_MS`) — a tick, a short stall or
    a wake within 5 minutes still runs it, at once;
  - every other one is **missed**: the Mac slept through it, was off, the clock jumped past it, or
    the switch held it. Missed runs go to the job's missed-run policy ("Missed runs and load");
  - the previous look is kept as the scheduler's last alive time, so a scheduler started after
    being stopped — the Mac off — sees what it missed; nothing before the scheduler's first start
    ever is due. A clock set back is a fresh start, so the next occurrence after the new time runs;
  - while the keeper is not followed nothing is due: the look waits for it, so a short keeper
    outage delays a run instead of losing it.
- **Once at** runs once; after its time it has no next run and shows as **finished**.
- Script and git jobs fire on schedules, hooks and chains; Pomade's and the agents' hook events
  (E-007) and agent jobs (E-004) come with their epics.

**Hooks:**

| Hook | In the file | Source | Note |
|---|---|---|---|
| Mac login | `hook: { event: login }` | Runner | one-shot scripts, once per login, after the warm-up |
| Pomade started | `event: pomade-started` | platform event bus | fires when Pomade is ready (tabs restored) |
| First open of project X since Pomade started | `event: project-first-open` | platform event bus | — |
| Project created | `event: project-created` | platform event bus | — |
| Agent session finished | `event: session-finished` | `pomade-agents` event B | sessions started by Runner never fire it (loop guard) |
| Session status changed to X | `event: session-status` | `pomade-agents` event C | always fires: it is a user action |
| Another job finished (done / failed / any) | `after: { job, result }` | Runner | a **chain** |

**Firing hooks** (`src/scheduler/hooks.ts`, `runs.ts`):
- An event fires every valid, enabled script and git job whose `hook` names it and whose filters it passes; a
  filter left out takes any value. Every event comes through one firing path, `hook()`, with the
  context its runs get in their environment; E-007 brings Pomade's and the agents' events to it.
- **Mac login** is a scheduler start that finds no keeper running (`startedKeeper` in
  `src/keeper/sessions.ts`): macOS ends the user's processes at log-out and shutdown, so the
  scheduler — the login item — starts the keeper itself at a login. An update of Runner or a
  restart of the scheduler after a crash finds the keeper alive and is no login. The decision is
  made once per scheduler, when it first follows the keeper; a login fires the login hooks once,
  in a known workspace. A keeper that died and the scheduler restarted after it is a login too:
  the services start again then as well. So is the first start after Runner is installed.
- A hook run has trigger `hook` and its event in `cause` (History: "hook: Mac login"). It joins the
  queue and waits for the warm-up while a staged start is under way ("Missed runs and load"). It has
  no missed-run policy: the switch holds it, and it runs late on release.

**Chains** (`src/scheduler/chains.ts`, `runs.ts`):
- A run that ends **done** or **failed** fires every valid, enabled job whose `after` names its job
  and takes its result (`any` takes both). Failed is any failure: an exit code, a signal, a time
  limit, a start the keeper refused, a lost session. A run stopped by you, skipped or missed fires
  nothing: the person stepped in, or nothing ran.
- Every follower fires, in id order. A script's or git job's run has trigger `chain` and its parent in `cause` —
  the parent's job, name, run and result — so History shows "chain: after Pull" and its card opens
  the parent's run; `POMADE_PARENT_*` are in its environment. It joins the queue like any run: its
  overlap applies, the switch holds it and it runs late on release, and it never waits for the
  warm-up — it follows a run that already ran.
- A **service** follows with its `action`, through the supervisor, at once — the switch and the
  warm-up never hold a service:
  - `restart` (default) restarts a running service with its job file as it is now, and skips one
    that is not running;
  - `start` starts one that is not running — clearing stopped by you or failed, as Start does —
    and skips a running one;
  - `stop` stops it as Stop does: it stays stopped until Start.
  - Each action is a History record of the service, with trigger `chain`, its parent in `cause`
    and its `action`: **done** ("restarted"), **skipped** with the reason ("it is not running"), or
    **failed** with the keeper's. A failed one is noticed and is a Needs-you item as the service's
    `notify` says. An action is no run: it never started (`startedAt` is `null`), publishes no
    `run.started` or `run.finished`, and fires no chain.
- A run that ended while the scheduler was down fires its chains when the next scheduler records
  it. A record already in the history fired them then, and fires nothing again.
- Agent jobs fire on hooks and chains with their epic (E-004).

**Context for scripts.** Scripts receive the context as environment variables:
- `POMADE_JOB` (the job's id: `backup`, `coda-helper/nightly`), `POMADE_RUN_ID`, `POMADE_TRIGGER`
  (`scheduled` · `caught-up` · `manual` · `hook` · `chain`)
- `POMADE_PROJECT` (a project job's stable id), `POMADE_PROJECT_PATH` (its project's folder,
  absolute — from Pomade's projects as the scheduler last heard them, `projects.json`; absent until
  it has heard them once)
- a hook's context: `POMADE_PROJECT`, `POMADE_PROJECT_PATH`, `POMADE_SESSION_ID`, `POMADE_AGENT`,
  `POMADE_SESSION_STATUS` as its event gives them (E-007; none for `login`)
- `POMADE_PARENT_JOB` (the parent's id), `POMADE_PARENT_RUN_ID`, `POMADE_PARENT_RESULT` (`done` ·
  `failed`) (chains)
- a git run gets the same, and `POMADE_WORKSPACE`: `pomade-git` resolves repo names in the
  workspace whose jobs these are

**Loop guards** (`src/jobs/check.ts`, `src/scheduler/loop-guard.ts`):
- **Cycle refusal.** The validator refuses a chain that leads back to itself on every job in the
  loop, naming it: "the chain loops back: a → b → a". A service is never followed, so no loop
  passes through one.
- **Safety net.** A job fired more than 10 times in 10 minutes by hooks or chains — counted per job
  on the scheduler's clock, whatever became of each firing: a run, a skipped run, a service's
  action — is **paused**: that firing and every later one by a hook or a chain is dropped, and
  logged. It is a Needs-you item, *"Paused: triggered 10× in 10 min — looks like a loop"*, with
  Resume, and is noticed once. Run now still runs it, and never counts.
- **Resume** lifts the pause with a fresh count: from Runner's frames (`jobs.resume`), the control
  method `resumeJob`, and `pomade-runner resume-job <job>` — `resume` alone is the switch's.
- The pause and the firings within the window are kept in `runs.json`: a restart neither forgets
  a pause nor starts the count over. A paused job's item shows while its file is there; the pause
  lasts until Resume.
- Every firing passes the guard, so the platform's hooks (E-007) are covered too.

## Runs

**States:** `missed · waiting for you` (a `wait-for-me` job's missed run) → `queued` → `running` ⇄
`waiting for you` → `done` · `failed` (a time limit too: "stopped: ran over 45 min") · `stopped by
you`. A run that never started is `skipped` or `missed`, with a reason ("missed · skipped").

**Execution:**
- Every run and every service is a keeper session, in the job's folder — a git run's in the
  workspace root — in the user's login-shell environment (same PATH and keys as the Owner's
  terminals).
- Low-priority runs start with macOS background priority (`taskpolicy -b`).

**A script's run** (`src/scheduler/runs.ts`, the model in `model.ts`):
- **Start.** A due run, a hook or chain run, or Run now, joins the queue ("Missed runs and load"),
  and when the queue lets it start, starts the session `run:<job>:<run id>`: the job's `command` by the login shell, in
  its `folder`, with low priority as the job says and the context above in its environment. Its run
  id is made from the time it was due, so ids sort by due time.
- **End.** The keeper's exit reason says how it ended: `exited` (status 0) → **done**; `crashed`
  (any other status, or a signal) → **failed**; `stopped-by-you` (Ctrl+C or Stop in its tab) →
  **stopped by you**; `lost-in-keeper-crash`, `stopped` (by Runner) and `time-limit` → **failed**
  with the reason. A session gone from the keeper is **failed** ("its session is gone"); a start
  the keeper refuses is **failed** ("cannot start — …") and never started. Past the job's
  `time-limit` Runner stops the run (reason `time-limit`): **failed**, "stopped: ran over 45 min".
  Once its record is written the session is forgotten.
- **Overlap**, when the job has a run going or queued: `skip` (default) records the new one
  **skipped · previous run still going** · `parallel` queues it too · `queue` holds one **queued**
  run that starts when the job has none running; while one is held, a further one is **skipped · a
  run is already queued**. A queued run whose job meanwhile is disabled, invalid or gone is skipped
  when its turn comes. An on-time run covers a caught-up run of its job still queued: that one is
  **missed · skipped · the 09:00 run covers it**.
- **Run now** runs a script or git job now, trigger `manual`, under the same overlap: refused with `skip`
  while a run goes and with `queue` while one is held, as it is for a disabled, invalid or unknown
  job and for agent jobs. The switch never holds it; it takes a low-priority slot like any
  run, so it may wait as `queued · 1 ahead`. For a service it is Start.
- **Attach.** A running run opens as an attached tab like a service
  (`tabs.openAttached({ session: { app: "pomade-runner", session: "run:…" } })`).
- **Records.** The runs going (missed runs waiting for you, queued and running), each job's latest
  record, the last look and the looks the switch holds are in `runs.json` in Runner's state
  folder, written on every change and at least once a minute (`ALIVE_EVERY_MS`). A restarted
  scheduler picks the runs going up from it, records the ends that came while it was down, and
  never writes a record twice.

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
  `background` for low priority. A service's session carries its header actions (below).
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
- a stopped or failed service's tab keeps its last output, with **Start** as its header action;
- a service's header actions are set by Runner on its session (`RESTART_ACTION`, `START_ACTION`,
  `src/keeper/services.ts`): **Restart** while it runs — Pomade adds its own **Stop** beside it —
  and **Start** once it ended, when Start would start it (its file valid and enabled); none
  otherwise. Supervision keeps them in step every tick (the keeper's `update`), so an open tab
  changes with the service. A click arrives as the platform event `attachedTab.action`, delivered
  to Runner only — the scheduler subscribes while connected to Pomade and restarts or starts the
  service, as Restart and Start do;
- a service's ended session stays in the keeper until the service is removed, so its tab, opened
  again, shows its last output.

**Services** (`src/keeper/supervisor.ts`). The scheduler supervises every service job: each tick,
after it follows the keeper, it compares each service with its session and acts; each session end
the keeper reports updates the service's record.
- **What keeps running.** A valid, enabled service with `start: login` runs all the time. Every
  scheduler start — the scheduler is the login item — starts each such service that is not
  running: at a login (no keeper running, "Firing hooks") that is all of them; a scheduler
  restarted after a crash or an update reattaches the running ones and never restarts one. A new service file, or one
  enabled again, starts the same way within a tick.
- **`start: project-first-open`** services start on the first open of their project, a trigger
  that comes with the platform's event bus (E-007). Until it fires they
  are `waiting`, and Start runs them. Once started, a crash restarts them like any service; an end
  that is not their own fault (`lost-in-keeper-crash`) leaves them waiting again.
- **Staged start.** Services start one at a time, in a stable order: workspace jobs first, then
  each project's (by sub-folder), each by id. The next starts when the current one is up, or after
  30 s; one not up by then stays `starting` and keeps being checked. Restarts after a crash take
  their turn the same way. Start, Stop and Restart act at once, out of turn.
- **One timebase.** Supervision measures every age, back-off and crash window on the scheduler's
  clock. The keeper stamps a session's start and end on the system clock; each stamp is taken onto
  the scheduler's clock once, when supervision first hears of it — the clock's now, less how long
  ago it was on the system clock. In production both are the system clock and a stamp stays as it
  is; under a test clock a session started a moment ago is a moment old, whatever the real date. A
  session found running by a restarted scheduler keeps its age, so it is up at once.
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
  Runner's frames through the broker, from a chain on the service (`after`, "Chains") and —
  Restart and Start — from an attached tab's header.
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

**Git runs** (`src/scheduler/git-runs.ts`, `runs.ts`) run Pomade's `pomade-git` and keep its
structured result. Everything else about the run is a script run's: run id, queue (a git job is
not low priority by default, so it neither takes nor waits for a slot), overlap, switch, time
limit, Run now, hooks, chains, History, notices and Needs you.
- **The command** is `<POMADE_HOME>/bin/pomade-git`: the shim the Pomade Runner belongs to writes
  into its command folder at every start (`pomadeGitPath`, `src/locations.ts`; the always-on
  scheduler gets `POMADE_HOME`). It runs with Pomade closed. Missing there, the run fails without
  starting: "cannot start — pomade-git is not in Pomade's command folder (…)".
- **Execution: a keeper session, its JSON into a file.** The session runs, by the login shell in
  the workspace root, `pomade-git <operation> <repo…> --json --job "<job name>" > <run id>.json`
  (every word shell-quoted), with `POMADE_WORKSPACE` set. The command's standard output — the
  `GitRunOutput` — goes to a file beside the run's output log
  (`output/<encoded job id>/<run id>.json`) and never through the terminal, so nothing a terminal
  does to text (a profile's greeting, escape sequences, line wrapping, CRLF) can garble it; its
  standard error stays the run's output log. The keeper holds the run like any other: a scheduler
  restarted or updated mid-run (`restartOnUpdate`) finds the session in the keeper's list, reads the
  result file when it ends and records the run once, as for scripts — a child process of the
  scheduler would die with it, and could leave a rebase half done. A run is attachable and
  stoppable like a script's.
- **The end.** The keeper's end, read with the result file (`isGitRunOutput` from
  `pomade-kit/protocol`):

  | Session ends | Result file | Run |
  |---|---|---|
  | exit 0 | a `GitRunOutput` | **done** — every repo done or skipped |
  | exit 1 | a `GitRunOutput` | **failed**, reason each failed repo's: "Knowledge: Their changes conflict with yours in notes.md. …" |
  | exit 2 | — | **failed**: "the command line was wrong — <what the command said>"; nothing ran |
  | any other exit, a signal, or exit 0 / 1 | missing or not a `GitRunOutput` | **failed**: "pomade-git gave no result (exit 127)" |
  | Stop, time limit, a lost session | either | as for a script |

- **The record** keeps the `GitRunOutput` whole (`git`): per repo done / skipped / failed and the
  reason, the steps, the commit hash. Its last lines are one line per repo: "Knowledge · committed
  a1b2c3d · pulled · pushed", "Knowledge · skipped · agent working", "Knowledge · failed · <the
  reason>"; without a result, the output log's last lines. The result file goes once the record
  holds it. The run's folder is the workspace root (`""`).
- A failed run is noticed by Runner as its job's `notify` says (default on failure), the notice's
  body the reason, and is its job's Needs-you item.

The command decides the "agent working" skip and appends every run to Pomade's git run log, which
the Git panel's failure mark reads. It posts no notice: Runner notifies about a failed run.

**Result card** (`src/ui/RunCard.tsx`, its look in `src/ui/runLook.ts`). One per run, a dialog
over History. Its head: the kind icon, the job's name, the result as a pill with its help
("Done", "Failed", "Missed · waiting for you"), then when it ran (or was due), how long and what
started it — with its help — and a why line: a hook's event ("Mac login"), a caught-up run's
missed time, a chain's "After Pull: done" whose name opens the run it followed. A failed run's
head is red, a missed run that waits for you amber. Its body, by what the run left:

| Run | Card body | Card foot |
|---|---|---|
| Script, ended | exit code (red when failed) or the reason it failed, and the last lines | **View output** · **Run again** |
| Git, ended | each repo: its commit hash and its steps (✓ done, ✗ failed, faint skipped), and a reason a step does not say | **View output** · **Run again** |
| Agent, ended | the agent's last message | **Open session** · **View output** |
| Running | the latest output, followed while it runs | **Open terminal** · **Stop run** |
| Queued | what it waits for, in a sentence | **Run now** |
| Missed, waiting for you | when it was due, and that its policy waits for you; **Run at…** opens a field that reads the time as it is typed | **Run now** · **Run at…** · **Skip** |
| Skipped or missed; a chain's action on a service | why it never started, or what the chain did | **Run now** (scripts and git jobs) |

Every card ends with **Edit job**. **View output** shows the full captured log (a git run's holds
what `pomade-git` wrote to its standard error — nothing, when all went well). Stop and the missed
run's choices close the card and toast the outcome; Run again toasts it.

**History** (`src/scheduler/history.ts`). One record per run that ended or never started
(`RunRecord`), and per chain's action on a service: the job's id, name and kind, project, folder,
run id, trigger and — a hook or chain run — its cause, a service's chain `action`, when it was due,
started and ended, how long it ran, the result and its reason, exit code and signal, the output
log, the last 20 lines of the output as plain text, and a git run's result (`git`). A record of an older build reads with the
fields it lacks at their defaults.
- **Format:** append-only JSON Lines, one file per day of the runs' ends (UTC):
  `history/YYYY-MM-DD.jsonl`. A record is one line, written once, when the run ends; nothing is
  rewritten, so a crash can at worst leave a half line at a file's end. A reader skips a line that
  is not a record, and the first append to a file that ends mid-line starts a new line, so a half
  line never swallows the next record. A restarted scheduler reads it as it is.
- **Reading:** newest first, a page at a time (at most 200); a page ends at a cursor
  (`<day>:<line>`) the next page starts before, valid while new runs land.
- **Retention:** whole days, as many as the settings keep (`history-days`, default 30): a day's file
  and the output logs of the runs that started that day go once the day is that many days behind,
  checked at the scheduler's start and every hour; a log a session still writes stays, and so does
  a git result a running run still writes.

## Missed runs and load

The run lifecycle (`src/scheduler/runs.ts`) with what it hands to: the missed-run policies
(`missed.ts`), the queue (`queue.ts`), the switch (`switch.ts`), the settings (`settings.ts`).

- **Last alive.** The scheduler keeps its latest look at the schedules — its last alive time — in
  `runs.json`: at once when a look fires, misses or holds something, otherwise at least every
  minute (`ALIVE_EVERY_MS`). Started after a power-off, it knows within a minute since when it
  missed, and never runs again what it fired before.
- **Wake.** A gap of more than a minute between two ticks on the scheduler's clock (`WAKE_GAP_MS`;
  a tick is a second) is a wake: the Mac slept — the scheduler did not run while time went on — or
  the clock jumped ahead. The gap needs no system API and sees every way the scheduler stops
  running while time passes; a stall of a busy Mac is far shorter, and a wake that was none only
  starts a warm-up, which holds nothing but missed runs.
- **Missed runs.** Each look takes every job's occurrences since its previous look; those more than
  5 minutes old are missed — after sleep, after power-off (the look starts at the last alive
  time), after a clock jump, or held by the switch. However many, a job gets one decision, about the
  latest missed time, by its `missed` policy:
  - **`run-on-wake`** (agent, script): one **caught-up** run (trigger `caught-up`, due at the latest
    missed time) while it is still worth it — until the job's next occurrence after that time
    (`worth-until: next-run`, the default), or until a time of day (`worth-until: 12:00`: the first
    12:00 after it). Past that it is **missed · skipped · past 12:00** (or **· past its next run**);
    a caught-up run still queued when its moment passes goes the same way. An on-time run of the
    job in the same look covers it: **missed · skipped · the 09:00 run covers it**. A `once`
    schedule has no next run: its catch-up is always worth it.
  - **`wait-for-me`**: the run waits as **missed · waiting for you**, a Needs-you item *"Inbox triage
    · missed Sun 3:00"* with a notice; one per job — a later miss moves it to the later time. It
    never starts on its own:
    - **Run now** — a run of yours (trigger `manual`) takes its place, under the job's overlap;
    - **Run at…** — it waits, queued, until that time (trigger `caught-up`) and shows in Next up. The
      time is typed as a time (`23:00`: the next one), a day and a time (`tomorrow 9:00`,
      `2026-11-20 23:00`, or a date-time picker's `2026-11-20T23:00`) or elapsed time (`+2h`) —
      `pomade-kit`'s date phrases, read on the scheduler's clock. A time that has passed, or a day
      without a time, is refused with the reason. It is kept in `runs.json`, so it survives restarts;
    - **Skip** — **missed · skipped by you**.
    - A job disabled, invalid or gone while its run waits: **missed · skipped · its job is
      disabled** (or why else).
  - **`skip`** (git): **missed · skipped**.
  - Hook and chain jobs have no missed-run policy: a run the switch held runs late.
  - Missed runs are history records (state `missed`), never noticed but a `wait-for-me` one.
- **The queue** (`queue.ts`). Every run joins it, oldest first, and starts when nothing holds it;
  each queued run waits for the first of:
  1. its **time** — Run at…;
  2. the **switch**;
  3. the **warm-up**, for a caught-up run — a Run at… one included — and a hook run;
  4. the job's **previous run**, unless its overlap is `parallel`;
  5. a **slot**: at most `max-low-priority-runs` (default 2) low-priority runs run at once.
  - **What takes a slot:** a running run of a low-priority job. A job with `low-priority: false` —
    git, by default — neither takes nor waits for one; neither does a missed run waiting for you.
    An agent run waiting for you at a permission prompt (E-004) holds no slot: it is idle, and a
    forgotten prompt must not hold back every low-priority job; once answered it goes on, past the
    cap if need be.
  - **"queued · N ahead"**: N runs have to end before it starts — the slot-waiting runs ahead of it
    and the one whose slot it takes. Three low-priority runs due at once: two run, the third is
    "queued · 1 ahead", a fourth would be "2 ahead". The others: "queued · at Wed 23:00", "queued ·
    held · Pause all", "queued · warm-up until 08:32", "queued · after the previous run".
  - Run now joins the queue too: the switch never holds it, a slot may.
- **Staged start after login or wake.** A login — a scheduler start that finds no keeper running
  ("Firing hooks") — and every wake begin a staged start; a scheduler restarted with its keeper
  alive begins none, so its caught-up runs need no warm-up:
  1. the services start one by one (the supervisor's staged start, "Services"; at a wake they run
     already);
  2. once no service waits for its turn or is starting (`servicesSettled`), the **warm-up**
     (`warm-up`, default 2 minutes);
  3. then the caught-up runs and the hook runs — the login hooks among them — go through the
     queue; chain runs never wait for it.
  - A scheduled run due on time during the warm-up runs on time: it is what was asked for at that
    time, and the slots keep it from storming the Mac. A wake during a warm-up starts it over.
- **The switch**, three positions: **Running · Pause low-priority · Pause all**.
  - Pause all holds every run but Run now; Pause low-priority holds the runs of low-priority jobs.
    Running runs go on; services keep running in every position.
  - A held job's look stays where the switch caught it: on release its occurrences come due — the
    latest on time when within 5 minutes, the others missed and to the job's policy. A queued run
    the switch held goes to its job's policy on release when it is more than 5 minutes late, or a
    caught-up one: a `run-on-wake` job keeps it while it is worth it, a `wait-for-me` one waits for
    you, a `skip` one records it missed. A release is no wake: no warm-up.
  - Machine-local: `switch.json` in Runner's state folder, written before the switch answers; it
    survives restarts.
  - Set from the panel (`switch.set`, Runner's frames only), by `pomade-runner pause [low|all]`
    (`all` when left out) and `pomade-runner resume`, and the control method `switch`.
- **Time limit**, per job (`time-limit`), none by default. A run counts from its start
  (`ranFor`); at the limit Runner stops it, once (SIGTERM, then SIGKILL after 3 s; reason
  `time-limit`): **failed · stopped: ran over 45 min**, red on its card, and noticed as a failure.
  The job file as it is now sets the limit. An agent run's wait for you (E-004) is left out of
  `ranFor`, so the limit pauses while it waits.
- **Long-run warning**, always on, never stops a run. A run going longer than `long-run-warning`
  (default 3h) becomes a Needs-you item *"Wiki lint has been running 3 h — still expected?"* with
  Open (its attached tab) · Stop (stopped by you) · Dismiss (gone for this run), noticed once. Its
  warning is kept with the run in `runs.json`: a restart neither forgets nor notices it again.

## Settings

The workspace's Runner settings, in `<workspace>/Apps/pomade-runner/settings.yaml` (synced with the
workspace): plain YAML, one field per setting.

```yaml
max-low-priority-runs: 2   # low-priority runs at once; the rest wait "queued · N ahead"
warm-up: 2m                # after login or wake, before caught-up runs
long-run-warning: 3h       # a run going this long asks "still expected?"
history-days: 30           # run history and output logs kept
```

| Field | Value | Default |
|---|---|---|
| `max-low-priority-runs` | a whole number, 1–16 | 2 |
| `warm-up` | a duration, `0m`–`1h` | `2m` |
| `long-run-warning` | a duration, `1m`–`24h` | `3h` |
| `history-days` | a whole number, 1–365 | 30 |

- A missing file, a field left out or an empty one means its default.
- **Checked like a job file** (`src/scheduler/settings.ts`, with the job files' YAML reader): every
  problem is one line, `path:line: field — problem. Fix: …`, a misspelled field gets the closest
  one; a field with a problem counts as its default until it is fixed. `pomade-runner check` checks
  it with the job files, or alone when it is the file named.
- **Followed live:** the scheduler reads it on every tick, so an edit applies within a second, and
  tells Runner's frames (`settings.changed`); `settings.get` answers what applies and the problems.
- **Written field-only** by the scheduler (`settings.set { field, value }`: a count, a duration in
  minutes, or `null` for the default): only the field's line changes, comments and the rest stay
  byte for byte. A value out of range, or a file that is not readable YAML, is refused with the
  reason. The scheduler is the one writer, with the one validator, Pomade open or closed.

## Notifications

- **Notify me** per job: always · on failure · never. A run that ended is noticed as its job says:
  `always` every run that started, `on-failure` a failed one, `never` none; a skipped or missed run
  never.
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
    is gone. Actions: Open (its result card) · Run now · Dismiss.
  - **A service that gave up** after a crash loop is an item while it stays `failed`; Start, a
    fixed or disabled file, or its removal end it. It is noticed once per giving-up. Actions: Start ·
    View output (the service's attached tab with its last output).
  - **A missed run that waits for you** (`missed:<job>`, one per job) is an item while it waits;
    noticed when it comes ("Inbox triage · missed Sun 03:00"), its click opening the run's card.
    Actions: Run now · Run at… · Skip (`runs.missed`).
  - **A long-run warning** (`long-run:<job>:<run>`) is an item while its run runs, until dismissed;
    noticed once. Actions: Open · Stop (`runs.stop`) · Dismiss (`needsYou.dismiss`).
  - **A job the loop guard paused** (`loop-paused:<job>`) is an item while it is paused and its file
    is there: *"Paused: triggered 10× in 10 min — looks like a loop"*; noticed once, when it
    pauses. Actions: Resume (`jobs.resume`) · Edit job (its form). It cannot be dismissed.
  - The failed runs' items, and the giving-ups already noticed, are in `needs-you.json` in Runner's
    state folder; the missed runs, the warnings and the loop guard's pauses are the runs' own, in
    `runs.json`: a restarted scheduler neither forgets an item nor notices one twice.
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

**Design source:** the approved clickable prototype, `prototype/index.html`; the real UI is built
to it, light theme only.

**Side panel** (the Runner icon on the left strip):
1. the three-position switch (`src/ui/SwitchControl.tsx`), pinned above the scroll: Running · Pause
   low-priority · Pause all, the chosen one with its dot (green, amber) and, in a panel narrower
   than 268 px, the middle one reading "Pause low". A pause says what it holds under the control —
   "Low-priority jobs are held. Services keep running." / "Every scheduled job is held. Services
   keep running." — with the (i) of what becomes of a held run;
2. **Needs you** (`src/ui/NeedsYou.tsx`): a card per item (`PanelCard`) — the status dot (red: a failed
   run, a service that gave up · amber: a missed run, a paused job · accent: a long run), the
   job's name, the (i) help of that kind, the time at the card's end, one line of text, and the
   actions inline, the first one primary (`needLook`, `src/ui/panelWords.ts`):

   | Item | Time | Text | Actions |
   |---|---|---|---|
   | failed run | when it failed | "Failed: exit 1 · 2×" (the count when more than one) | Open · Run now · Dismiss |
   | service gave up | its last crash | "Crashed 5× in 1 min — gave up." | Start · View output |
   | missed run waits | when it was missed | "Missed — it waits for you to pick a time." | Run now · Run at… · Skip |
   | long run | how long it has gone ("3h 02m") | "Running 3h — still expected?" | Open (its terminal) · Stop · Dismiss |
   | job paused by the loop guard | when it paused | "Paused: triggered 10× in 10 min." | Resume · Edit job |

   The time reads "11:20" today, "yesterday", "Sun 3:00" within the week, else "13 Nov". The
   job's name is a link to what the card is about: the run's result card (a failed run, a missed
   run, a long run), the service's terminal tab, the job in the Jobs view (a paused job). **Run
   at…** opens a field below the buttons, filled with "tonight 23:00" and focused; under it what the
   text comes to ("→ today 23:00") or "Try: tonight 23:00 · tomorrow 7:00 · +2h"; Set (or Enter)
   sends it as typed, Esc closes it. Every outcome is a toast ("<job> started", "<job> will run
   today 23:00", "<job> stopped by you", "<job> resumed"); a refusal is "Could not <do it> <job>:
   <why>". The section's count is a red badge while any item waits, a grey 0 and "Nothing needs
   you." otherwise;
3. **Running now** (`src/ui/RunningNow.tsx`): the services that are up or starting, in start
   order, then the runs going, as one list of rows (`PanelRow`): the status dot, the name and at
   its end where it stands with its help ("up 3d 4h", "starting", "running 3m", "queued · 1
   ahead"); project · folder below ("workspace · git-base" for the workspace root); a third line
   only for news ("waiting for port 5173", "restarted 3× · last crash 14:02", "restart to apply
   its file"). A row's status words explain themselves on hover (no (i) in rows). A service's row
   opens its attached tab, titled with its name; a running run's row its terminal (the run's
   attached session); a queued run's row — it has no session yet — its result card;
4. **Next up** (`src/ui/NextUp.tsx`): the next five runs, soonest first — "in 40 min" within the
   hour, then the time ("13:00", "tmrw 7:00", "Thu 7:00"; the full moment on hover), the job's
   kind icon and its name; a row opens the job in the Jobs view (`jobs/<encoded job id>`);
   "Nothing is scheduled." when none;
5. **Open Runner**.

**Runner tab:**
- **Jobs** (`src/ui/JobsView.tsx`): the job files grouped by project — workspace jobs first, then each
  project in Pomade's order — each group headed by its name (the Workspace's with its help), its
  jobs sub-folder (`jobs/coda-helper/`) and its count; the files of a group by path. The filter row
  has the "This project" chip with its help and the "N jobs" summary ("· N invalid" when a file is
  invalid); the table head carries the helps on **Last result** and **Next run**. The chip is the
  tab's: on in Jobs, it is on in Services; it keeps the open project's jobs ("No jobs in <project>"
  and **New job** when none), and **New job** then starts in that project (`new/<encoded project
  id>`, `newJobRoute`).
  - **A row:** the kind icon (the kind as its tooltip), the name over the trigger in words
    (`jobTriggerWords`, a chain's job and a hook's project by name; the tooltip is the full text, and
    a git job's adds its operation and repos — a repo the workspace lacks is said in red), **Last
    result**, **Next run**, the actions, and the **Disable** toggle. A disabled row is dimmed.
  - **Last result** (`lastLook`, `src/ui/jobWords.ts`): a chip with the status's help over a sub line.
    A service shows its state as the Services view does (`serviceLook`). Any other job shows the run
    going — "running" over "started 12:31 · 17m", "queued" over what it waits for, "missed · waiting
    for you" — else its latest finished one: "done", "failed · exit 1", "stopped: ran over 45 min",
    "skipped · …", "missed · …", "stopped by you", over "today 11:20 · 3s"; "never ran" for none. A
    click on a job's cell opens that run's result card (`run/<job>/<run>`); a service's and a
    never-ran job's cell has none.
  - **Next run** (`nextLook`): "disabled", "paused" (the loop guard's), "always on" (a service), "on
    event" (a hook or a chain), "finished" (a schedule with nothing ahead), else the next time —
    "Today 13:00", "Tomorrow 7:00", "Wed 7:00", "Wed 25 Nov 7:00" — with "in N min" under it within the
    hour.
  - **Actions**, always visible icon buttons: **Run now** (a service: **Open terminal**, its attached
    tab), **Edit** (`edit/<encoded job id>`), **Delete** — the bin in the row's icon colour, red under
    the pointer and on focus — which opens the confirm of "Deleting a job". Run now, a refused Run now
    or toggle and Delete report as toasts. The toggle writes `enabled:` (`jobs.setEnabled`).
  - **An invalid file** is a red row with its file name, its help, its first error and **Open file**.
  - **The route `jobs/<job>`** marks that job's row — the accent bar and wash — and scrolls to it.
- **History** (`src/ui/HistoryView.tsx`): the runs going (`runs.list`'s `active`: running,
  queued with what they wait for, missed and waiting for you) and every record, one list newest
  first by when each started — or, one that has not, was due — under day heads (Today, Yesterday,
  "Sun 15 Nov"). Each row: the time, the kind icon, the job, the result (`runLook`: dot and words
  — "failed · exit 1", "done · restarted", "queued · 1 ahead", "running · 3h — still expected?" —
  explaining itself on hover), the duration (a running run's so far) and what started it
  (scheduled · caught up · manual · hook: Mac login · chain: after Pull), with its help. The
  result chips — All · Active · Failed · Skipped & missed, each but All with its count — and
  "This project" filter the list; the summary says how many days History keeps. History loads a
  page of 100 records, the newest page again on every `runs.changed`, and the next older page
  each time the list's end comes into sight (`useHistoryPages`); while older pages remain, a
  count is of the runs loaded and says so ("3+"). A row — click, Enter or Space — opens the run's
  result card.
- **Services** (`src/ui/ServicesView.tsx`): every service file in start order — a valid one's row:
  the kind icon, the name, project · folder · command; the status (`serviceLook`,
  `src/ui/serviceWords.ts`) — "running · up 3d 4h" over "no crashes" or "restarted 3× · last
  crash 14:02", "starting" over what it waits for, "failed · gave up" over "crashed 5× in 1 min ·
  today 11:20", "stopped by you" over when, and "queued", "restarting", "waiting for its project",
  "disabled" — each with its help; **Restart · Stop** while it is up or starting, **Start**
  otherwise; then Open terminal (its attached tab), Edit (the `edit/<encoded job id>` route) and
  Open file. Each action toasts its outcome or why it was refused. An invalid service file is a red
  row with its first error, its help and Open file. The "This project" chip (the tab's, as in Jobs), with the open
  project's name, keeps that project's services ("No services in this project." when none); with
  no service files, the view says what a service is.
- **Settings** (`src/ui/SettingsView.tsx`): cards of rows — a name with its (i), a line under it, the
  control at the end.
  - **Load** and **History:** the four settings ("Settings"), each a stepper (− number +, its unit
    beside it) over the engine's whole range. A step shows at once; once the steps stop
    (`STEPPER_SETTLED_MS`, a held button's run included) it is written field-only (`settings.set`),
    even when the person has left the view meanwhile. The long-run warning steps by whole hours and reads
    in minutes under an hour. A refusal puts the value back and says why under the row. The
    settings file's own problems are listed over the cards.
  - **Notifications** and **Agents:** read-only rows with a status (`environment.get`) — the
    macOS notification permission, and the agent skill's links into the skills folders.
  - **Files:** `settings.yaml` with Open file (once it exists) and the jobs folder.

**Routes of the Runner tab** (`parseRoute`, `src/integrations/runner-api.ts`): `""` Jobs ·
`jobs/<encoded job id>` Jobs at one job, its row marked and scrolled to (what a repo row's Scheduled
line opens) · `history` · `services` · `settings` · `run/<encoded job id>/<run id>` a run's result
card, a dialog over History (what a run's notice opens) · `output/<encoded job id>/<run id>` its
full output, the whole tab (`src/ui/OutputPage.tsx`): a head with the way back to the card, the
job's name and "Captured log · <when> · read-only", then the log as plain text, followed while the
run runs · `new` the job form for a new job (what
**New job** opens; `newRoute`), `new/<encoded project id>` for one that starts in that project · `edit/<encoded job id>` the job form editing a job (`editRoute`).
An unknown route is Jobs. The tab follows Pomade's `route.changed`.

**Frames and the design system.** Runner draws only inside the two frames Pomade hosts; Pomade's
chrome around them (the panel's header with its title and collapse, the tab bar) is Pomade's.
- **Runner tab shell** (`src/ui/shell/TabShell.tsx`): a 44 px header — the views Jobs · History ·
  Services · Settings, a count beside Jobs and Services, the current one underlined in the accent;
  the view's actions ("New job") at its right end — then the page in its own scroll region, 1040 px
  at most. A view opens with its filter row (chips, a faint summary at the right). Runner's version
  is at the foot of Settings.
- **Side panel shell** (`src/ui/shell/PanelShell.tsx`): the switch pinned on top; Needs you ·
  Running now · Next up in the scroll region, each a collapsible section with its count (Needs
  you's a red badge while anything waits); Open Runner pinned at the bottom. With no jobs it says
  what a service is. The panel is the switch's container: below 268 px it takes the short labels.
- **The kit** (`src/ui/kit/`): the shared primitives every surface is built from, each a React
  component over a CSS module and the tokens — icons, buttons, chips, tags and pills, status dots,
  the toggle, the segmented control and the switch, inputs and fields with inline errors, the
  tooltip, the (i) Help, dialogs and the confirm, menus, toasts, panel sections, cards and Running now's rows, group
  heads, the empty block, the view table. A view extends one rather than forking it.
- **Tooltips:** one per surface (`TooltipLayer`): any element with `data-tip` (a plain line) or
  `data-help` (a key of `src/ui/help.ts`) shows it on hover and on keyboard focus.

**Job form** (`src/ui/form/`). Creating and editing a job happens in a form, never by hand-editing
md. A full page in the Runner tab: its head (back to Jobs, "Jobs / <name>", **Enabled**, and —
editing — **Open file** and **Delete**), the sections, and the Save bar ("Saves to <path>",
**Cancel**, **Create and start** for a service / **Create job** / **Save**, **Saved** while nothing
changed). Order: kind → trigger → folder and project (agent: agent → folder → mode) → policies; the
policies show as one sentence, non-defaults in bold, until **Change**.
- **State** (`state.ts`, pure): the values the form shows, the fields the person set (`touched`),
  and the file as last read (`base`). Switching kind keeps what the person set and resets the
  kind-dependent defaults they left alone (overlap, low priority, notify). A folder inside a project
  fills in that project.
- **Kinds**: a kind the form builds is registered in `FORM_KINDS` (`state.ts`: the file's fields
  from the values, and which form field each file field's errors belong to) and in `KIND_UI`
  (`kinds.tsx`: its sections between Kind and Policies, its policy rows, its Create button). The
  picker shows every kind; the ones not registered are shown faded, with their help, and cannot be
  chosen. A job of such a kind opens a page saying so, with **Open file**.
- **Trigger** (script; `TriggerSection.tsx`, the values in `schedule.ts`, pure). A choice of **On a
  schedule** · **When something happens**, then the schedule editor:
  - **Repeats**: Once (a date of the coming week and a time, or a phrase typed in words — `tonight
    23:00`, `tomorrow 7:00`, `+2h` — read by `pomade-kit/dates`, which fills in the date and time) ·
    Every N minutes or hours, optionally only between two times · Daily at one or more times ·
    Weekly on chosen days · Monthly on days of the 1–31 grid, the last day, and nth weekdays added
    as "the [first] [Monday]";
  - **Days**: Every day · Weekdays only · Weekends only, for every and daily (the format's `only:`);
  - the schedule in words (`describeSchedule`) and its next three runs (`nextOccurrence`), live, from
    the text the form would write; "Fix the schedule to see it in words" while the checker finds a
    problem with it.

  The editor's values are kept as typed and written as the format's canonical lines (`schedule:` one
  entry per line, a shape's mapping in flow style); what the file's schedule has that the editor has
  no control for (`monthly.months`, `start`, `end`, an unknown key) is kept. A schedule the person
  left alone is never written. Each schedule error the checker names lands on its control by its
  path (`schedule.daily.at[1]` → the second time), and the error shows under the box. A script
  whose file has a hook or a chain keeps it: the section says it in words (`jobTriggerWords`), that
  it is changed in the job file, with **Open file**; its errors — a chain that loops back — show
  there and keep Save from writing. The choice the form does not make is shown faded, with a tip.
- **Policies** (`policies.ts` their words, pure; `kinds.tsx` their rows). Each kind lists its
  policies in the sentence's order; a policy's words come from the values, a non-default's in bold.
  A script's: overlap (**If still running**: Skip · Run in parallel · Queue after), low priority,
  notify — and its missed-run policy and time limit, shown from the file (in the sentence and as
  a row "· changed in the job file") only when the file sets them.
- **The file it writes.** A new job: its kind's fields, defaults left out (`enabled` always
  written), in the project's sub-folder (`projectJobsFolder`) or at the top for the Workspace,
  under the first free slug of its name (`createJobFile`). An edit writes only the fields whose
  value differs from the file as last read (`fieldChanges` → `updateJobFile`), so comments,
  unknown fields and the body stay; a field the file lacked is added at the end of its block. A
  new name keeps the file name (the id stays). A new project moves the file to that project's
  sub-folder under the same file name (`files.move`), after writing the fields.
- **Validation.** The text the form would write is checked by the one validator, among the other
  jobs (`checkJobAmong`, `src/jobs/check.ts`): the file on its own, names and chains against the
  snapshot, project ids against Pomade's projects. Each error shows on its field in
  `describeJobError`'s words — `pomade-runner check`'s — the field in bold; one the form has no
  field for shows in a note at the top with its line. An invalid job in the snapshot still names the
  job it follows (`InvalidJob.after`), so a chain loop the snapshot already refused is seen. A new job's errors show once Save was
  pressed, or at once on a field the person filled in; an edit's, at once. Save with errors shows
  "N things to fix before saving" and focuses the first field in error. A new job's errors all
  block Save; an edit's block it only on the form's fields — the file's own other problems stay
  as they are.
- **Following the file.** Editing, the form follows its file on disk (`followJobFile`): a field
  the person left alone takes the file's value; one they set keeps their edit, and when the file
  changed it too a note says so — Save writes theirs. The file gone: the form says so and Save is
  off.

**Deleting a job.** Delete is on a job's row in the Jobs view and in the form, next to Open file.
One confirm (`DeleteJobDialog`, `src/ui/DeleteJobDialog.tsx`) serves both; it names the file; on it the scheduler's `jobs.delete` (`src/scheduler/delete.ts`):
- a running service is stopped first, as Stop does, and its session's end waited for (up to
  `STOP_WAIT_MS`, 8 s); one that does not end keeps its file, and the confirm says why;
- a run of the job that is going refuses the delete — stop it first — so a run is never cut off
  and its result never lost; queued runs and missed runs waiting for you settle as "its job file
  is gone";
- then the file is removed — a linked one's link, never its target — and the jobs are read again.
  The service's supervision record goes with the file, after its 2 s grace.

**Help.** Every non-obvious field, policy and status carries an (i) tooltip with a one-line
example. This is a product requirement, not polish. Every text is in `src/ui/help.ts`, keyed
`<area>.<what>` (`st.*` statuses, `f.*` form fields, `p.*` policies, `s.*` settings, `c.*` result
cards, `need.*` Needs-you cards); `Help` shows one by its key.

## Data and locations

| What | Where |
|---|---|
| Job files | `<workspace>/Apps/pomade-runner/jobs/` (synced with the workspace) |
| Workspace settings (max low-priority runs 2, warm-up 2 min, long-run warning 3h, history 30 days) | `<workspace>/Apps/pomade-runner/settings.yaml` |
| Run history, captured output, keeper state (`keeper/`), the switch's position, the last alive time | `<userData>/app-state/pomade-runner/` (machine-local) |
| Session records (job, run, output log, end) | `<userData>/app-state/pomade-runner/sessions.json` |
| Service supervision records (holds, crash counts, a restart due) | `<userData>/app-state/pomade-runner/services.json` |
| Run output logs | `<userData>/app-state/pomade-runner/output/<encoded job id>/<run id>.log` |
| A git run's result while it runs (`pomade-git --json`'s output) | `<userData>/app-state/pomade-runner/output/<encoded job id>/<run id>.json` |
| Run history (one file per day, JSON Lines) | `<userData>/app-state/pomade-runner/history/YYYY-MM-DD.jsonl` |
| Runs going (missed runs waiting for you, queued, running), each job's latest record, the last alive time, the looks the switch holds, the loop guard's firings and pauses | `<userData>/app-state/pomade-runner/runs.json` |
| The switch's position | `<userData>/app-state/pomade-runner/switch.json` |
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
  - **`runs.list`** → `RunsReport` (`isRunsReport`): the runs going (missed runs waiting for you,
    queued ones with what each waits for, running ones), Next up (every enabled scheduled job's
    next run, and the Run at… ones), each run job's next and latest run, Needs you, and the switch;
    **`runs.changed`** tells Runner's frames to ask again — on every change, and when the scheduler
    connects.
  - **`history.list`** `{ job?, before?, limit? }` → `HistoryPage`; **`runs.get`** `{ job, run }` →
    `RunView` or `null`; **`runs.output`** `{ job, run }` → `RunOutput`: the end of its log, at
    most 1 MiB.
  - From Runner's own frames only: **`jobs.run`** `{ job }` → `RunActionResult` (Run now) ·
    **`jobs.setEnabled`** `{ job, enabled }` → `EnableResult`: writes `enabled:` into the job's file,
    field-only · **`needsYou.dismiss`** `{ id }` → `{ resolved }` · **`runs.missed`** `{ job, choice:
    "run-now" | "run-at" | "skip", at? }` → `MissedChoiceResult` (when it runs, or why not) ·
    **`runs.stop`** `{ job, run }` → `RunStopResult` · **`switch.set`** `{ position }` →
    `SwitchState` · **`jobs.resume`** `{ job }` → `ResumeResult`: the loop guard's pause lifted, or
    why not. · **`jobs.delete`** `{ job }` → `DeleteResult` (`isDeleteResult`): the job
    deleted as "Deleting a job" says — its id, its file's path, and whether its service was stopped
    first — or why not; callers give it `DELETE_JOB_TIMEOUT_MS`.
- **Settings**, through the broker: **`settings.get`** → `SettingsReport` (`isSettingsReport`);
  from Runner's own frames only **`settings.set`** `{ field, value }` → `SettingsWriteResult`;
  **`settings.changed`** tells Runner's frames to ask again. **`environment.get`** →
  `EnvironmentReport` (`isEnvironmentReport`, `src/scheduler/environment.ts`): what the Settings
  view shows read-only about the Mac — `notifications` (`allowed`, `denied`, `not-asked`, or
  `unavailable`: the scheduler posts no native notification) and `skill` (`linked` of `folders`
  skills folders — `~/.claude/skills` and each agent's — hold a link to Runner's skill).
- **`jobs.forRepo`** through the broker, to any caller — Pomade's Git panel asks as `pomade`
  (PLATFORM rule 7): the jobs that target a repo (`repoJobs`, `src/scheduler/git-runs.ts`). The
  contract is `pomade-kit/protocol`'s (`REPO_JOBS_METHOD`, `RepoJobsParams`, `RepoJobsResult`,
  `RepoJob`). Params `{ repo: { name, path } }`; a job targets the repo when one of its `repos` is
  the name, or the absolute path. The answer, by id: every valid, enabled git job that targets it,
  with its operation, `schedule` — its trigger in words, as the Jobs view shows it ("daily at 13:00
  and 20:00", "at Mac login") — `nextRun` (ISO 8601, or `null`), `lastResult` (the repo's own
  result in the latest run when it has one, else the run's: a missed run is `skipped`, one stopped
  by you `failed`; `at` its end) and `route` (`jobs/<encoded job id>`). Answered from the snapshot
  in memory, in milliseconds.
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
| Platform (`pomade:E-030`) | projects, stable ids, repos (`git.read`: the names git jobs take), open file, folder picker |
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

**Theme.** Light only: `src/ui/tokens.css` carries the approved prototype's light token set —
Pomade's names and light values — and `color-scheme: light`, whatever the system's colour scheme.

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
  limit }` (`HistoryPage`; `pomade-runner history`) · `runs` (`RunsReport`; `pomade-runner runs`) ·
  `switch { position }` (sets the switch, or — `position: null` — reads it: `SwitchState`;
  `pomade-runner pause`, `resume`) · `resumeJob { job }` (lifts the loop guard's pause of a job:
  `JobResumed`; `pomade-runner resume-job`). A job is named by its id or name; what cannot be done is
  `refused`, with the reason — "Runs" and "Services" say what.
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
due while the previous one still works is dropped. A wake is simulated the way it is detected:
the scheduler process stopped (`SIGSTOP`) while its clock runs on, then continued — its next tick
comes after a gap. A login is simulated the way it is detected too: the scheduler and its keeper
stopped, then the scheduler started. On a clock many times as fast a short stall of the machine is
a gap of minutes too; the specs with caught-up runs, which a wake holds for the warm-up, run their
clock at most 60 times as fast.
