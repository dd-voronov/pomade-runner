---
doc: docs/DESIGN.md
audience: engineers, product; every worker on a Runner ticket
holds: the living design of Runner — its parts, jobs and job files, triggers, runs, missed runs and load, settings, notifications, UI, data, interfaces and stack
kind: reference
---

# Runner — design

`pomade-runner` ("Runner" in the UI) is the Pomade app that runs things without the Owner. It runs:
- **always-on services**: from Mac startup, outliving Pomade, or only while Pomade runs;
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
| **`pomade-runner` command** | `check [file…]` validates job files and the settings file · `projects` lists the project ids and jobs sub-folders · `list` prints every job with its kind, trigger in words, next run and last result · `run <job>` runs a job now — a script's or git job's run, a service's Start · `history [job]` prints the jobs the switch holds and the latest runs · `runs` prints the switch, the runs going with what each queued one waits for, and Needs you · `pause [low\|all]` · `resume` set the switch · `resume-job <job>` lifts the loop guard's pause of a job · `missed <job> run-once|run-all|run-at <time>|skip` settles a job's missed runs · `enable <job>` · `disable <job>` · `services` shows every service and where it stands · `stop <service>` · `restart <service>` · `sessions` shows the keeper and its sessions | on `PATH` via `~/.pomade/bin`; reads the job files and the settings and talks to the scheduler directly, so it works with Pomade closed |
| **Skill** | `pomade-runner-jobs` teaches agents the job format and location | master in `app/skills/pomade-runner-jobs/SKILL.md`, shipped in the build at `skills/pomade-runner-jobs` (the manifest's `skills`); the scheduler keeps a copy in the workspace's skills folder, and gives it to no agent |

**What Runner tracks:** only jobs created in Runner. A terminal opened by hand, inside Pomade or
outside it, is just a terminal.

**Pomade is never required for a run to keep going.** Services, scripts and git jobs run while
Pomade is closed. An agent run needs Pomade to start — its launch spec comes from `pomade-agents`
through Pomade's broker: one due while Pomade is closed has Runner open Pomade first ("Agent runs",
**Pomade opened for a run**). Once started it runs in the keeper like any run.

## Jobs

A job has a **kind**, a **trigger**, a **folder** and **policies**.

| Kind | Does | Trigger |
|---|---|---|
| **Service** | keeps a command running; restarts it on crash | always on: from Mac startup; while Pomade is running; or from the first open of a project until Pomade quits |
| **Script** | runs a command once per trigger | schedule · hook · chain · manual |
| **Agent** | runs an agent with a prompt, unattended | schedule · hook · chain · manual |
| **Git** | runs `pomade-git <operation> <repo>` for one or more repos | schedule · hook · chain · manual |

### Job files

**Location.** One md file per job, in `<workspace>/Apps/pomade-runner/jobs/`:
- workspace jobs at the top level;
- project jobs in a sub-folder named after the project's folder — the last segment of its root
  (`Projects/blog` → `jobs/blog/dev-server.md`); nothing sits deeper.
- The file name is the job's slug: lower-case letters, digits and single dashes. Other files —
  not `.md`, or hidden (`.x.md`, an editor's swap file) — are not job files.
- A job's **id** is its path inside the jobs folder without `.md`: `backup`,
  `blog/dev-server`. Chains name jobs by id. It names the job's terminal sessions too (see
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
name: Dev server
project: <stable project id>     # omit for a workspace job
folder: Projects/blog     # working folder, workspace-relative
enabled: true
command: ./start.sh              # service, script
start: login                     # service: login | pomade-started | project-first-open
start-project: <project id>      # with project-first-open: whose first open; default: project
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
| `start` | service | when it starts and how long it lives: `login` — on Mac startup, outliving Pomade · `pomade-started` — when Pomade starts, until it quits · `project-first-open` — on the first open of a project since Pomade started, until Pomade quits |
| `start-project` | service | with `start: project-first-open`: the project whose first open starts it — default the job's `project`, so a workspace service needs it; refused with the other starts |
| `ready` | service | empty (alive after 5 s) · `{ port: 1–65535 }` · `{ url: http(s)://… }` |
| `schedule` | script · agent · git | a `pomade-kit` schedule-format block (schema owned by `pomade-kit:E-003`), resolution `time`; `always` is refused (a service is always on by itself) |
| `hook` | script · agent · git | `{ event, …filters }` (see Triggers) |
| `after` | script · agent · git · service | `{ job: <id>, result: done \| failed \| any }` (chains); a service also takes `action: restart \| start \| stop` |
| `agent`, `mode` | agent | `agent` (required): a roster id from `pomade-agents`; `mode`: one of that agent's modes, default `normal`; the file **body is the prompt**: not empty, at most 16,384 characters (`AGENT_PROMPT_MAX`), no NUL — its errors name the field `body` |
| `git` | git | required: `{ operation: commit-push \| pull \| push \| fetch, repos: [...] }`; repos by the name `pomade-git` accepts, each once, none starting with `-` (the command would read it as an option); one repo may be written without the list |
| `missed` | scheduled jobs only; a hook, chain or manual job refuses it | `run-on-wake` (agent, script) · `wait-for-me` · `skip` (git) — what a missed run becomes ("Missed runs and load") |
| `worth-until` | with `missed: run-on-wake` | `next-run` (default) or a time of day (`12:00`): until when a caught-up run is worth starting |
| `overlap` | non-service jobs | `skip` · `parallel` · `queue` |
| `low-priority` | all | `true` for agent and script; `false` for service and git — macOS background priority; a low-priority run takes one of the low-priority slots and is held by Pause low-priority |
| `time-limit` | non-service jobs | empty (none) or a duration: hours and/or minutes (`45m`, `2h`, `1h30m`); a run past it is stopped |
| `notify` | all | `always` for agent; `on-failure` otherwise; `never` |

**Format rules:**
- A script, agent or git job has at most one trigger: `schedule`, `hook` or `after`. One with none
  is a **manual job**: it never runs by itself — only on Run now and `pomade-runner run` — and other
  jobs may chain after it; `missed` and `worth-until` in its file are errors ("a manual job never
  misses a run"). A service has none of `schedule` and `hook`; its `after` acts on it.
- An empty field (`notify:`) means its default; in a mapping the form writes, an entry it leaves
  empty is left out.
- Values are read as YAML 1.2 core: `7:00` and `2026-11-20` are text, `yes` is not `true`.
- Hook filters by event: `project-first-open` and `project-opened` take `project` (none = any project);
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
unknown id, a project job in another project's sub-folder, a hook filter or a start project on an
unknown project.

**The jobs on the UI.** The scheduler owns the loaded jobs. It reads and watches the jobs folder
itself, from disk, so it works with Pomade closed, and follows the workspace through Pomade's
workspace pointer ("Data and locations": a new workspace starts the scheduler again on it). While connected to Pomade it serves Runner's own API method `jobs.list` (the
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
- Script, agent and git jobs fire on schedules, hooks and chains. A manual job fires on none: the
  scheduler never starts it, it has no next run and never shows in Next up; Run now runs it with
  trigger `manual`, and a run of it that ends done or failed fires its chains like any run.

**Hooks:**

| Hook | In the file | Source | Note |
|---|---|---|---|
| Mac login | `hook: { event: login }` | Runner | one-shot scripts, once per login, after the warm-up |
| Pomade started | `event: pomade-started` | platform event bus (`pomade.ready`) | once per Pomade start, when Pomade is ready (tabs restored) |
| First open of project X since Pomade started | `event: project-first-open` | platform event bus (`project.opened`) | `project` filter, none = any project; the Workspace project is no project here |
| Project X opened (every time) | `event: project-opened` | platform event bus (`project.changed`) | every time a project becomes the active one, its first open included; `project` filter as above |
| Project created | `event: project-created` | platform event bus (`project.created`) | — |
| Agent session finished | `event: session-finished` | `pomade-agents` event B | sessions started by Runner never fire it (loop guard) |
| Session status changed to X | `event: session-status` | `pomade-agents` event C | always fires: it is a user action |
| Another job finished (done / failed / any) | `after: { job, result }` | Runner | a **chain** |

**Firing hooks** (`src/scheduler/hooks.ts`, `runs.ts`):
- An event fires every valid, enabled script, agent and git job whose `hook` names it and whose filters it passes; a
  filter left out takes any value. Every event comes through one firing path, `hook()`, with the
  context its runs get in their environment and the name of its project, which the run's cause
  keeps.
- **Mac login** is a scheduler start that finds no keeper running (`startedKeeper` in
  `src/keeper/sessions.ts`): macOS ends the user's processes at log-out and shutdown, so the
  scheduler — the login item — starts the keeper itself at a login. An update of Runner or a
  restart of the scheduler after a crash finds the keeper alive and is no login. The decision is
  made once per scheduler, when it first follows the keeper; a login fires the login hooks once,
  in a known workspace. A keeper that died and the scheduler restarted after it is a login too:
  the services start again then as well. So is the first start after Runner is installed.
- **Pomade's events** (`src/integrations/pomade.ts`, `src/integrations/pomade-start.ts`,
  `scheduler.ts`) are heard while the scheduler is connected to Pomade. One that came while Pomade
  or the scheduler was not listening does not exist: nothing catches it up.
  - **Pomade started** fires on the first `pomade.ready` of a Pomade start. The event is sticky — a
    scheduler that connects, or connects again, while the same Pomade runs hears it at once — so a
    Pomade start is named by Pomade's socket: Pomade creates it at every start and removes it when it
    quits, so its inode and birth time name the start. The start each workspace fired for is kept in
    `pomade-started.json` in the state folder: a reconnect, a scheduler restarted or updated, fires
    nothing again. A workspace switch starts the scheduler again on the new workspace, which fires
    its own Pomade started hooks once for that Pomade start; switching back fires nothing. A socket
    that cannot be found fires nothing, said in the log.
  - **First open of a project** fires once per project and Pomade start, on `project.opened` for a
    project (not the Workspace project). The project in front at the first ready of a Pomade start
    counts as opened then — its own `project.opened` came right after `pomade.ready`, possibly
    before the scheduler listened; heard as well, it fires nothing twice. A project this workspace
    does not have is ignored: Pomade switched workspace and this scheduler has yet to follow. The
    projects opened are kept with the start in `pomade-started.json`: a scheduler restarted while
    the same Pomade runs fires no first open again, and a new Pomade start forgets them. An open
    heard on a connection before its ready named the Pomade start waits for it. A hook job made or
    enabled after its project's open does not run for it: it runs on the next Pomade start's first
    open. The open also starts the services that start on that project ("Services").
  - **A project opened** fires on `project.changed` (subscribed in the manifest) whenever the
    project in front becomes another project — not the Workspace project; the same project again
    (renamed or moved) fires nothing. The project in front at the first ready of a Pomade start
    counts as opened then. A ready heard again on the same Pomade start (a reconnect, a restarted
    scheduler), and a change heard before the connection's ready named the Pomade start, only set
    the project in front.
  - **Project created** fires on `project.created`, with the new project; it is this workspace's
    from then on.
  - Pomade's projects are read once Pomade is ready, and again on `project.created` and
    `project.renamed`: before it is ready, its workspace may not be loaded, and its list may miss
    projects.
- **The Agents app's events** (`src/integrations/agent-events.ts`, `pomade.ts`, `scheduler.ts`) —
  `pomade-agents:session.closed` (B) and `pomade-agents:session.statusChanged` (C), subscribed in
  the manifest, as `../pomade-agents/docs/CONTRACTS.md` "Published events" defines them. Each
  payload is checked against the contract before Runner trusts it; one that is not the contract's
  is logged and ignored. Like Pomade's, they are heard only while the scheduler is connected; the
  Agents app replays none.
  - **Agent session finished** fires on B, whatever its `reason` — one Runner does not know is an
    end too. A session with `startedByRunner: true` never fires it (the loop guard for B): its run's
    end, or its tab's when the Owner attached, would fire it, and a hook that runs an agent would
    start the next.
  - **Session status changed to X** fires on C when its `status` is the event's `to`. It always
    fires, a session Runner started too: a status change is the Owner's.
  - Both filter on the session's project (its stable id; a session in the Workspace bucket has none,
    so only a hook without a project filter takes it) and its agent (roster id).
- A hook run has trigger `hook` and its event in `cause` (History: "hook: Mac login", "hook: first
  open of blog", "hook: agent session finished", "hook: session marked Done"; its card: "First
  open of blog"). It joins the queue and waits for the
  warm-up while a staged start is under way ("Missed runs and load"). It has no missed-run policy:
  the switch holds it, and it runs late on release.

**Chains** (`src/scheduler/chains.ts`, `runs.ts`):
- A run that ends **done** or **failed** fires every valid, enabled job whose `after` names its job
  and takes its result (`any` takes both). Failed is any failure: an exit code, a signal, a time
  limit, a start the keeper refused, a lost session. A run stopped by you, skipped or missed fires
  nothing: the person stepped in, or nothing ran.
- Every follower fires, in id order. A script's, agent's or git job's run has trigger `chain` and its parent in `cause` —
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

**Context for scripts.** Scripts receive the context as environment variables:
- `POMADE_JOB` (the job's id: `backup`, `blog/nightly`), `POMADE_RUN_ID`, `POMADE_TRIGGER`
  (`scheduled` · `caught-up` · `manual` · `hook` · `chain`)
- `POMADE_PROJECT` (a project job's stable id), `POMADE_PROJECT_PATH` (its project's folder,
  absolute — from Pomade's projects as the scheduler last heard them, `projects.json`; absent until
  it has heard them once)
- a hook's context, as its event gives it: `project-first-open`, `project-opened` and `project-created` give
  `POMADE_PROJECT` and `POMADE_PROJECT_PATH` of the event's project (over a project job's own);
  `login` and `pomade-started` give none; the agents' events give `POMADE_SESSION_ID`,
  `POMADE_AGENT` (roster id), `POMADE_SESSION_STATUS` (the session's status then — for a status
  change, the new one), `POMADE_SESSION_TRANSCRIPT` (the session's latest transcript file,
  absolute) and, for a session in a project, `POMADE_PROJECT` and `POMADE_PROJECT_PATH` of its
  project (over a project job's own)
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
- Every firing passes the guard, Pomade's hooks included. A service's start — at login, with
  Pomade, on a project's first open — is the service's own, and is no firing.

## Runs

**States:** `missed · waiting for you` (a `wait-for-me` job's missed run) → `queued` → `running` ⇄
`waiting for you` → `done` · `failed` (a time limit too: "stopped: time limit, 45 min") · `stopped by
you`. A run that never started is `skipped` or `missed`, with a reason ("missed · skipped"). A run
that stands for more than one missed run says how many ("Missed runs and load", **Counted**); a run
of a Run all says which of them it is ("Missed runs and load", **Run all**).

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
  `time-limit` Runner stops the run (reason `time-limit`): **failed**, "stopped: time limit, 45 min"
  — the job's limit, which the record keeps (`limitHit`, minutes). A run is recorded once its
  session's end is half a second old (`LOG_SETTLE_MS`): the keeper reports an exit while its last
  output may still be on its way into the log.
  Once its record is written the session is forgotten.
- **Overlap**, when the job has a run going or queued: `skip` (default) records the new one
  **skipped · previous run still going** · `parallel` queues it too · `queue` holds one **queued**
  run that starts when the job has none running; while one is held, a further one is **skipped · a
  run is already queued**. A queued run whose job meanwhile is disabled, invalid or gone is skipped
  when its turn comes. An on-time run covers a caught-up run of its job still queued: that one is
  **missed · skipped · the 09:00 run covers it**.
- **Run now** runs a script, agent or git job now, trigger `manual`, under the same overlap: refused with `skip`
  while a run goes and with `queue` while one is held, as it is for a disabled, invalid or unknown
  job. The switch never holds it; it takes a low-priority slot like any
  run, so it may wait as `queued · 1 ahead`. For a service it is Start.
- **Attach.** A running run opens as an attached tab like a service
  (`tabs.openAttached({ session: { app: "pomade-runner", session: "run:…" } })`).
- **Records.** The runs going (missed runs waiting for you, queued and running), each job's latest
  record, the last look and the looks the switch holds are in `runs.json` in Runner's records
  folder in the workspace, written on every change and at least once a minute (`ALIVE_EVERY_MS`). A restarted
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
  - a service's one session: `svc:<job>`, the same across restarts (`svc:blog.dev-server`);
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
  `sessions.json` in Runner's state folder (machine-local), with the session's end (code, signal, reason, time)
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
  output log, which the keeper appends to: `output/<encoded job id>/<run id>.log` in Runner's state
  folder, while the run goes — nothing under the workspace grows with a run's output. When the
  scheduler records a run's end (an end that came while it was down too), it first moves the log
  into the records folder beside the record: one rename (across volumes a copy, flushed, then the
  source removed), safe to repeat after an interruption; a log that cannot move stays where it is,
  said in the scheduler's log. A service never ends as a run: its output stays in the state folder.
- **Keeper updates.** The keeper's version is a digest of its bundled entry and the versions of the
  packages it loads (`src/keeper/version.ts`); the build computes it and builds the scheduler with
  it. When the running keeper reports another version — older or newer — the scheduler calls
  `upgrade` with the shipped entry, once per scheduler start: the keeper hands its PTYs to the new
  process and the sessions keep running, with the same pids. While a hand-off may be under way
  (20 s) the scheduler only reconnects and never starts a keeper, which would take the socket from
  the one holding the sessions. A hand-off that fails leaves the old keeper running, and the
  scheduler works with it.
- **Keychain check** (`src/keeper/keychain.ts`, `checkKeychain` and `replaceKeeper` in
  `sessions.ts`). A keeper can lose its reach to the macOS login keychain while it runs: every
  process it starts then fails `security list-keychains`, and an agent started there has no login.
  Before an agent run starts, the scheduler runs `/usr/bin/security list-keychains` as a short
  session in the keeper (`check:keychain-<6 hex>`, an id Runner makes for no job, so it is in no
  view or record), reads it by its exit status — 0 reachable, any other end not — and forgets it.
  It knows no provider and no credential's name. A check that cannot run — no keeper connected, the
  session refused, no end within 5 s — counts as passed: the run goes on and says for itself what it
  lacks. Each failed check and each one that could not run is a line in the scheduler's log with the
  keeper's pid and start time (`keeper: the keychain check failed in keeper pid 16722, started
  2026-11-23T12:46:05.000Z — exit 50`). `POMADE_RUNNER_KEYCHAIN_CHECK` names a command line that runs
  by `/bin/sh -c` in its place: the e2e's stand-in for a keeper that lost the keychain.
- **Keeper replacement.** A keeper that failed the check is replaced: the scheduler sends SIGTERM
  to the pid the keeper reported in its hello (the kit has no request to end a keeper), SIGKILL
  after 5 s, waits for the process to be gone, and then starts a fresh keeper the way a tick starts
  one that died (`startKeeper`) — never by the keeper's own update hand-off, whose successor the
  old keeper spawns and which would inherit the fault. The fresh keeper reports what the old one
  held as `lost-in-keeper-crash`, so the services start again with no crash counted ("Services").
  The scheduler logs the replacement with both keepers' pids and start times
  (`keeper: replacing pid …, started … — it cannot reach the macOS keychain`, `keeper: replaced pid …
  with pid …, started …`).

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
- **Starts and lifetimes.** A service's `start` says both when it starts and how long it lives:

  | Starts (form) | `start:` | Starts when | Stops when |
  |---|---|---|---|
  | **On Mac startup** (default) | `login` | Mac login | never — it outlives Pomade |
  | **While Pomade is running** | `pomade-started` | Pomade starts | Pomade quits |
  | **On first open of a project** | `project-first-open` | its project's first open since Pomade started — at once when the project was opened already | Pomade quits |

  The two later ones are **Pomade-bound** (`pomadeBound` in `src/jobs/model.ts`).
- **What keeps running.** A valid, enabled `login` service runs all the time. Every scheduler
  start — the scheduler is the login item — starts each such service that is not running: at a
  login (no keeper running, "Firing hooks") that is all of them; a scheduler restarted after a
  crash or an update reattaches the running ones and never restarts one. A new service file, or
  one enabled again, starts the same way within a tick.
- **Where Pomade stands** (`PomadeState` in `supervisor.ts`, told by the scheduler): `running` once
  Pomade is ready on the current connection and its start is known; `closed` once Pomade quit;
  `unsure` in between — the scheduler just started, Pomade is starting, or the link dropped and the
  quit grace is not over. **Pomade quit** = the link to Pomade dropped and no Pomade start is found
  (`pomadeStartOf`: its socket gone, or nothing listening on it — a crashed Pomade's) for the quit
  grace, 15 s on the scheduler's clock (`QUIT_GRACE_MS`, `POMADE_RUNNER_QUIT_GRACE_MS` in tests).
  A reconnect within it, to the same Pomade start, stops nothing. A scheduler starts with the link
  down: started while Pomade is closed, it finds Pomade quit after the grace; started while Pomade
  runs, it connects first and stops nothing.
- **A Pomade-bound service** runs only while Pomade is `running`. A `pomade-started` one is due
  then; a `project-first-open` one once its start project is among the projects opened since
  Pomade started too (the scheduler's, kept with the Pomade start). Due, a valid, enabled one that
  is not running joins the staged start at once: at Pomade's start or at the open, and one made,
  enabled, or changed to that start or that project afterwards within a tick. While Pomade is not
  running it is `waiting-for-pomade` ("waiting for Pomade · starts when Pomade starts" or "· starts
  on first open of blog") and Start is refused ("starts with Pomade; Pomade is not running") — its rows offer none;
  with Pomade running, a first-open one before its project's open is `waiting` ("waiting for first
  open · starts on first open of blog"), and Start runs it until Pomade quits. **When Pomade
  quits** (`pomadeEnded`), every Pomade-bound service is stopped (reason `stopped`) and its record
  starts fresh: no `stopped by you`, no `failed`, no crash count — the next Pomade start begins
  fresh, each waiting for its trigger. While Pomade is closed, supervision stops any bound service
  it finds running — one a scheduler started while Pomade is closed finds left over. A new Pomade
  start found while a service of an earlier start still runs (its quit unheard, the scheduler down
  then) ends that start the same way first. A `login` service is untouched by all this: stopped by
  you, it stays stopped over any Pomade restart until Start. An end that is not its own fault
  (`lost-in-keeper-crash`) starts a service again when it is due, and leaves it waiting otherwise.
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
  | `stopped-by-you` (Ctrl+C in its tab, its tab's Stop, Stop) | stays stopped until Start (a Pomade-bound one: until Start or the next Pomade start); an end heard after Pomade quit holds nothing |
  | `lost-in-keeper-crash` | not its fault: it starts again at once, through the staged start, and no crash is counted |
  | `stopped` (Runner's own: disable, removal, Restart), `time-limit` | nothing of its own |

  A start the keeper refuses (a folder that does not exist…) counts as a crash, and the reason
  shows as the service's `problem`.
- **"restarted 3× · last crash 14:02"** counts the restarts after a crash. It resets after 10
  minutes of uptime, and on Start; Restart is not counted.
- **Start** starts a service now: it clears `stopped by you` or `failed` and the crash count. It is
  refused for a running, disabled, invalid or unknown service, for a job of another kind, and for a
  Pomade-bound service while Pomade is not running; a chain's `start` or `restart` on such a
  service is skipped for the same reason.
  **Stop** stops it as stopped by you (SIGTERM, then SIGKILL after 3 s): it stays stopped, and a
  restart due is called off. **Restart** stops a running service (reason `stopped`) and starts it
  again with its job file as it is now, keeping the crash count; one that does not run is started.
  They reach the scheduler from the `pomade-runner` command (`run`, `stop`, `restart`), from
  Runner's frames through the broker, from a chain on the service (`after`, "Chains") and —
  Restart and Start — from an attached tab's header.
- **Job file changes:**
  - disabled (`enabled: false`) → a running service is stopped (reason `stopped`), and its
    `stopped by you`, `failed` and crash count are cleared, in every start mode: enabled again, it
    follows its trigger — it starts when the trigger already happened (login; Pomade runs; its
    project opened since Pomade started), else it waits;
  - the file deleted, or no longer a service → stopped once it has been gone 2 s, then dropped with
    its session and record (an editor that saves by deleting and writing again stops nothing);
  - its `command` or `folder` edited → it keeps running with what it started with and says it
    needs a restart (`needsRestart`); a restart applies the file;
  - the file invalid → nothing starts or stops it until the file is fixed: a half-written edit
    never takes a running server down.
- **States** (`ServiceState` in `src/keeper/model.ts`, the one model of the services view, the
  broker API and the command): `queued` · `starting` · `running` · `restarting` · `failed` ·
  `stopped-by-you` · `waiting` · `waiting-for-pomade` · `disabled` · `invalid` · `removed`.
- **Records.** What the keeper does not know is written on every change, so a restarted scheduler
  carries on where the last one stopped, in two files by what each field describes:
  - the services the Owner stopped (`stopped by you`) — an intent, which holds on any Mac — in
    `services.json` in the records folder (`{ "stoppedByYou": [...] }`), written only when that
    list changes;
  - what describes this Mac's processes — crash counts, a restart due, a service given up on
    (`failed`), the last start's problem — in `services.json` in the state folder. A service that
    crash-looped on one Mac is started afresh on another.
- Without a known workspace, or while the scheduler does not follow the keeper, supervision does
  nothing.

**Agent runs** (`src/scheduler/runs.ts`, the rules in `agent-runs.ts`, the turns in
`src/keeper/agent-turns.ts`, the client of `pomade-agents` in `src/integrations/agents.ts`). Runner
keeps no table of providers: what runs, the session id and how to end the agent come from
`pomade-agents`' published API (`../pomade-agents/docs/CONTRACTS.md` "Roster", "Reads for Runner"),
through Pomade's broker (the manifest's `calls: ["pomade-agents"]`). Everything else is a script
run's: run id, queue (an agent job is low priority by default), overlap, switch, time limit, Run now,
hooks, chains, History, notices and Needs you.
- **Pomade opened for a run** (`src/integrations/pomade-open.ts`). An agent run starts only while
  Pomade is up for it: Runner connected, Pomade ready (`pomade.ready`) and no opening under way.
  Until then it is **queued · opening Pomade** (the queue's wait `pomade`) and Runner opens Pomade:
  when Runner is not connected, `pomade-kit/node`'s `launchPomade()` runs the launch Pomade recorded
  in `host.json` and waits for its socket to answer (60 s); Runner closes that probe connection and
  reconnects at once; then it waits, at most 60 s, until its connection is back, Pomade is ready and
  the Agents app answers `roster.list`. One opening at a time: every agent run due meanwhile — or
  Run now — waits for the same one, and once Pomade is up they start in the order they queued, as
  the slots let them. Scripts, git runs and services never wait for it. An opening that fails fails
  every run waiting for it, without starting, with why — "cannot start — Pomade could not be
  opened: this Pomade recorded no way to launch it (no host.json)", "…: Pomade did not become ready
  in time", "cannot start — Pomade opened, but after 60 s the Agents app (pomade-agents) is not
  running" — and each failure's notice goes where every notice goes: into Pomade's closed-Pomade
  queue while it is not connected, shown at its next start. The next agent run due opens Pomade
  again. Runner leaves the Pomade it opened running. A scheduler restarted while a run waits finds
  it queued in `runs.json` and opens Pomade again.
- **The keeper's reach to the keychain.** Before the launch the run's keeper passes the keychain
  check ("Sessions", **Keychain check**); script, git and service runs are not checked. A keeper
  that fails it with no run going is replaced ("Sessions", **Keeper replacement**) and checked
  again, and the run starts. With runs going — replacing the keeper would end them — the agent run
  stays **queued · a fresh keeper, after the runs going** (the queue's wait `keeper`), and so does
  every agent run due meanwhile; scripts and git runs go on. Once no run is going, the next agent
  run checks again and, still failing, replaces the keeper. A fresh keeper that fails the check too
  fails the run without starting: "cannot start — the keeper cannot reach the macOS keychain, so the
  agent would have no login". A keeper replaced meanwhile some other way (it crashed) is checked
  afresh.
- **Launch.** With Pomade up: the agent from `roster.list` (its name, provider and
  modes; none listed are the provider's — Normal, Full autonomy), the job's mode among them, then
  `roster.launchSpec({ agent, mode, sessionId, prompt })` — `mode` always, a UUID Runner makes as
  `sessionId`, the job's prompt. The session `run:<job>:<run id>` runs the spec's `line` — one
  POSIX-shell line, the profile's command (maybe an alias) and its quoted arguments — as
  `$SHELL -l -i -c <line>`: a login shell for the user's `PATH`, interactive for the aliases of the
  rc files; in the job's folder, its realpath kept as the run's `cwd`. It fails without starting,
  with the reason: Runner not connected to Pomade (it went away between the queue and the launch); the Agents app absent or not answering ("the Agents app
  (pomade-agents) is not running"); an agent not in the roster; a mode the agent lacks ("claude-pm
  has no Full autonomy mode"); a folder that does not exist.
- **The run's agent** (`AgentRun` on the run and its record): the agent's id and name, provider,
  mode and its name, the session id, `cwd`, `startedAt` — the session's start on this Mac's clock,
  ISO 8601 — the spec's `exit`, and when Runner typed it.
- **Session id.** The spec's `sessionId`: the one Runner made, when the provider pre-assigns it; when
  it is `null` (Codex) the run's session is looked up with `sessions.find` — `cwd`, the agent, and
  10 s around `startedAt` — every 5 s while it runs and once more at its end; of several, the one
  started nearest it. Kept on the run.
- **Finishing.** The agent runs interactively, so approvals and Open session work. The scheduler
  attaches to the session as a viewer and replays its output into the kit's agent-state scanner
  (`AgentStateScanner`, the provider's screen and window title), afresh on every snapshot — an
  attach, a reconnect after a keeper update, a scheduler restart. When the turn completes — working,
  then idle with no prompt pending — Runner types the spec's `exit` and, 300 ms later, Enter (a CLI
  reads text and Enter in one chunk as a paste). The agent's exit then is **done**; an agent still
  there 15 s later is stopped (reason `stopped`) and the run is **done** all the same. An end before
  the exit was typed is **failed**, "the agent exited before its turn was done", a status 0
  included; a crash after it **failed** with its exit code; Stop, the time limit and a lost session
  read as a script's. A permission or trust prompt is no finished turn: the run waits for you.
- **A turn without an answer.** A turn can end with no answer: an API error ("Not logged in ·
  Please run /login") ends it as any turn, and the Agents app leaves the error out of the session's
  messages. So a run read **done** is checked as it is recorded — the agent has exited by then, its
  transcript whole: Runner asks `sessions.lastMessage` for the run's session, and no message makes
  the run **failed**, "the agent's turn ended without an answer" (`answeredEnd`, `agent-runs.ts`).
  The agent got its exit command and ended as any agent; its last lines keep its screen, which shows
  the error; notices, Needs you, chains and hooks take it as any failed run. When the Agents app
  cannot be asked — not answering, Pomade gone — or the run has no session id, the answer is unknown,
  not missing: the run is recorded **done**, the reason in the scheduler's log. The result card of
  such a run shows the reason and the last lines in place of the last message.
- **Waiting for you.** A permission or trust prompt on the agent's screen (the scanner's
  `waiting`) makes the running run wait for you: `waiting` on its `AgentRun` — the prompt and since
  when — a Needs-you item and a notice. It holds no low-priority slot and its time limit pauses:
  `waitedMs` adds up its waits, which `ranFor` leaves out. Answered — the agent works or idles
  again — the wait ends, the item goes, and the turn finishes as any turn. A prompt that turns into
  another is one wait, noticed once. A fresh snapshot — an attach, a reconnect, a scheduler
  restart — draws the screen without a window title: a prompt on it is a wait (noticed when the
  run had none), a screen without one ends the wait the run had. Whether the agent is idle is
  read from the title alone, so a restarted scheduler learns a turn is done only from the next
  title the agent sets. A run that ends while it waits keeps the wait in `waitedMs`. A record or a
  run going of an older build reads as one that never waited.

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
  | exit 1 | a `GitRunOutput` | **failed**, reason each failed repo's: "notes: Their changes conflict with yours in notes.md. …" |
  | exit 2 | — | **failed**: "the command line was wrong — <what the command said>"; nothing ran |
  | any other exit, a signal, or exit 0 / 1 | missing or not a `GitRunOutput` | **failed**: "pomade-git gave no result (exit 127)" |
  | Stop, time limit, a lost session | either | as for a script |

- **The record** keeps the `GitRunOutput` whole (`git`): per repo done / skipped / failed and the
  reason, the steps, the commit hash. Its last lines are one line per repo: "notes · committed
  a1b2c3d · pulled · pushed", "notes · skipped · agent working", "notes · failed · <the
  reason>"; without a result, the output log's last lines. The result file goes once the record
  holds it. The run's folder is the workspace root (`""`).
- A failed run is noticed by Runner as its job's `notify` says (default on failure), the notice's
  body the reason, and is its job's Needs-you item.

The command decides the "agent working" skip and appends every run to Pomade's git run log, which
the Git panel's failure mark reads. It posts no notice: Runner notifies about a failed run.

**Result card** (`src/ui/RunCard.tsx`, its look in `src/ui/runLook.ts`). One per run, a dialog
over History. Its head: the kind icon, the job's name, the result as a pill with its help
("Done", "Failed", "Stopped: time limit", "Waiting for you", "Missed · waiting for you"), then when it ran (or was due), how long and what
started it — with its help — an agent run's agent and mode ("claude · Normal"), and a why line: a hook's event ("Mac login"), a caught-up run's
missed time ("Missed 7:00 — caught up after wake"; for more than one, "Missed 4 runs, 17:40–17:46 —
caught up once"; a run of a Run all "… — caught up 2 of 4"), a chain's "After Pull: done" whose name opens the run it followed. A failed run's
head is red, a run that waits for you amber. Its body, by what the run left:

| Run | Card body | Card foot |
|---|---|---|
| Script, ended | exit code (red when failed) or the reason it failed — a time limit as "Stopped: Time limit, 45 min — the job's time limit" — and the last lines | **View output** · **Run again**; a caught-up run that ran for more than one missed run, while it is its job's latest and no Run all of the job goes (`otherMissedRuns`), **Run the other N** between them — on every ended run's card |
| Git, ended | each repo: its commit hash and its steps (✓ done, ✗ failed, faint skipped), and a reason a step does not say | **View output** · **Run again** |
| Agent, ended | a failed run's reason in red; the agent's last message (`sessions.lastMessage` by the run's session, its Markdown drawn as text: paragraphs, lists, bold, emphasis, code), or why it cannot be read — no session known, none written yet, the Agents app not running; a run whose turn ended without an answer: the last lines in its place | **Open session** (a Pomade agent tab resuming the session — `agentTabs.resume` in the job's project and folder — or the live tab already on it) · **View output** · **Run again** |
| Running | the latest output, followed while it runs | **Open terminal** · **Stop run** |
| Agent, waiting for you | what it waits at ("The agent stopped at a permission prompt and waits for your answer."), **Waiting at**: the end of its output from the step that asks (`promptLines`), and that the time limit is paused | **Open at the prompt** (its terminal tab) · **Stop run** |
| Queued | what it waits for, in a sentence — waiting for a slot, the low-priority runs holding the slots by name ("Two low-priority runs are going (Wiki lint, Photo backup). This one starts when one of them finishes.") | **Run now** |
| Missed, waiting for you | when it was due — for more than one missed run, "This job missed 4 runs, 17:40–17:46." — and that its policy waits for you; **Run at…** opens a field that reads the time as it is typed | **Run now** · **Run at…** · **Skip**; for more than one **Run once** · **Run all N** · **Run at…** · **Skip** |
| Skipped or missed; a chain's action on a service | why it never started ("Missed 4 runs, 17:40–17:46 · skipped." for more than one), or what the chain did | **Run now** (scripts and git jobs) |

Every card ends with **Edit job**. **View output** opens the run's **output tab** beside the
Runner tab — a Pomade tab of its own, one per run — with the full captured log (a git run's holds
what `pomade-git` wrote to its standard error — nothing, when all went well). Stop and the missed
run's choices close the card and toast the outcome ("Weekly 3 runs queued, one after another"); Run
again toasts it. Run all and Run the other N above 20 runs (`RUN_ALL_CONFIRM_ABOVE`) first open the
confirm "Run 25 runs?" — Runner runs the job 25 times, one after another; stopping one drops the rest
— whose button is the one clicked; Cancel or Esc closes it alone and runs nothing.

**History** (`src/scheduler/history.ts`). One record per run that ended or never started
(`RunRecord`), and per chain's action on a service: the job's id, name and kind, project, folder,
run id, trigger and — a hook or chain run — its cause, a service's chain `action`, when it was due,
started and ended, how long it ran, the result and its reason, exit code and signal, the output
log, the last 20 lines of the output as plain text, a git run's result (`git`), and — a run
stopped at its time limit — that limit in minutes (`limitHit`). A record of an older build reads with the
fields it lacks at their defaults.
- **The output log** is named in a record by job and run (`output/<encoded job id>/<run id>.log`),
  never by a path on a Mac. Read back, a record names it where it is found (`findOutputLog`): in
  the records folder, else still in the state folder (before its move, or after one that did not
  finish). A log in neither — removed, or a record whose log stayed on another Mac — reads as
  missing: the output tab says "This run's output is not on this Mac." and `pomade-runner history`
  says `output not on this Mac`; the record's last lines still show.
- **Format:** append-only JSON Lines, one file per day of the runs' ends (UTC):
  `history/YYYY-MM-DD.jsonl`. A record is one line, written once, when the run ends; nothing is
  rewritten, so a crash can at worst leave a half line at a file's end. A reader skips a line that
  is not a record, and the first append to a file that ends mid-line starts a new line, so a half
  line never swallows the next record. A restarted scheduler reads it as it is.
- **Reading:** newest first, a page at a time (at most 200); a page ends at a cursor
  (`<day>:<line>`) the next page starts before, valid while new runs land.
- **Retention:** whole days, as many as the settings keep (`history-days`, default 30): a day's file
  and the output logs of the runs that started that day — in the records folder, and any left in
  the state folder — go once the day is that many days behind,
  checked at the scheduler's start and every hour; a log a session still writes stays, and so does
  a git result a running run still writes.

## Project renamed

A project renamed or moved in Pomade (`project.renamed`; `src/scheduler/project-moves.ts`): its jobs
are bound to it by the stable id, so they keep working, and what names its folder follows it. The
scheduler compares Pomade's projects as it reads them with the ones it read before — on
`project.renamed`, and on every connection, so a move made while it was down is followed too — and
for each project whose folder changed, one after another:
- every job file whose `folder` is the project's folder or inside it gets the new one, field-only;
- its jobs' sub-folder is renamed after the folder's new last segment, when that changed. A
  sub-folder of that name already there keeps the jobs where they are, said in the log. A new
  name alone changes nothing on disk.
- The sub-folder's jobs change id with it (`blog/scrape` → `blog-2/scrape`); their state goes with
  them. Each running service of them is stopped and its session forgotten before its file moves,
  and starts again under its new id in the new folder — a first-open one too. Their supervision
  records, latest runs, runs not started yet, looks the switch holds and the loop guard's counts
  take the new id; a run going keeps its old id until it ends, and is the new id's latest then.
  History is never rewritten: the old id → new id is kept in `renamed.json` in the records folder,
  and a job's history takes in every id it had.

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
  time), after a clock jump — and so is every occurrence the switch held, however recent. However
  many, a job gets one decision, about the latest missed time, by its `missed` policy:
  - **`run-on-wake`** (agent, script): one **caught-up** run (trigger `caught-up`, due at the latest
    missed time) while it is still worth it — until the job's next occurrence after that time
    (`worth-until: next-run`, the default), or until a time of day (`worth-until: 12:00`: the first
    12:00 after it). Past that it is **missed · skipped · past 12:00** (or **· past its next run**);
    a caught-up run still queued when its moment passes goes the same way. An on-time run of the
    job in the same look covers it: **missed · skipped · the 09:00 run covers it**. A `once`
    schedule has no next run: its catch-up is always worth it.
  - **`wait-for-me`**: the run waits as **missed · waiting for you**, a Needs-you item *"Tidy drafts
    · missed Sun 3:00"* with a notice; one per job — a later miss moves it to the later time and
    adds to its count. It never starts on its own:
    - **Run now** — a run of yours (trigger `manual`) takes its place, under the job's overlap; for
      a run that stands for more than one it reads **Run once**, and the others are not run;
    - **Run all N** — for a run that stands for more than one: **Run all**, below;
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
  - **Run all** — the person's choice, never a policy's: **Run all N** on a missed run waiting for
    them (`runs.missed` choice `run-all`), **Run the other N** on a caught-up run that ran for more
    than one, while it is its job's latest run and no Run all of the job goes (`run-others`;
    `otherMissedRuns`), and `pomade-runner missed <job> run-all` (the waiting run's, else the
    latest caught-up run's others). Its runs are a **series** (`series`: the n-th of N; the Run the
    other N series starts at 2), trigger `caught-up`, each carrying the job's `missed`:
    - one run of the series is active at a time — the waiting run itself becomes run 1; when a run
      that ran ends `done` or `failed`, the next joins the queue in the same save that records it
      (`carryOn`, `runs.ts`), so the series lives in `runs.json`: a scheduler restarted mid-series —
      the Mac off, an update — finds the run going or queued, records an end that came while it was
      down, and goes on;
    - a series run waits for the job's previous run whatever its overlap, so the runs never go at
      once; otherwise it waits like any caught-up run — the switch, the warm-up, a slot. The
      switch's release leaves it queued (the person decided already); an on-time run never covers
      it;
    - a run stopped by you, a run that never started (its job disabled, invalid or gone, a start
      refused) or a job gone after a run drops the rest: one `skipped` record, "2 dropped: you
      stopped run 2 of 4" ("… run 2 of 4 did not start", "… its job file is gone or invalid"),
      trigger `caught-up`, no `missed` or `series`. Its run id is made from the run it follows, so a
      scheduler that died after writing it writes it once;
    - words: a series run's trigger is "caught up 2 of 4" (`caughtUpWords`) — it stands for one of
      the missed runs; its card's why line keeps the span ("Missed 4 runs, 17:40–17:46 — caught up 2
      of 4").
    - Above `RUN_ALL_CONFIRM_ABOVE` (20) runs the UI asks once more; the command does not.
  - **Counted.** The occurrences are counted, every one, however long the absence
    (`passedOccurrences`, `triggers.ts`). The decision keeps the count and the first and last missed
    time (`MissedRuns`: `count`, `first`, `last`), and the run or record it makes carries them as
    `missed` — the caught-up run (in `runs.json` while it goes, then its history record), the missed
    run waiting for you (and its Needs-you item, `missed`), the missed record. A later miss adds to
    a caught-up run still queued or a missed run still waiting (`addMissed`). The words
    (`missedRunsWords`, `model.ts`) are one function: "missed 4 runs, 17:40–17:46" ("missed 2 runs,
    Sun 23:00–Mon 07:00" across days) — a caught-up run's trigger "missed 4 runs, 17:40–17:46 ·
    caught up once", a record "missed 4 runs, 17:40–17:46 · skipped", a run waiting "missed 4 runs,
    17:40–17:46 · waiting for you"; one missed run reads "caught up", "missed · skipped", "missed ·
    waiting for you". History, the result card, the missed-run card, Needs you, the notice and
    `pomade-runner history` and `runs` say them.
- **The queue** (`queue.ts`). Every run joins it, oldest first, and starts when nothing holds it;
  each queued run waits for the first of:
  1. its **time** — Run at…;
  2. the **switch**;
  3. the **warm-up**, for a caught-up run — a Run at… one included — and a hook run;
  4. the job's **previous run**, unless its overlap is `parallel` — a run of a Run all waits for it whatever the overlap;
  5. **Pomade**, for an agent run, while Pomade is not up for it — Runner opens it ("Agent runs",
     **Pomade opened for a run**); such a run holds no slot;
  6. a **fresh keeper**, for an agent run, while the keeper failed the keychain check and runs are
     going ("Agent runs", **The keeper's reach to the keychain**); such a run holds no slot;
  7. a **slot**: at most `max-low-priority-runs` (default 2) low-priority runs run at once.
  - **What takes a slot:** a running run of a low-priority job. A job with `low-priority: false` —
    git, by default — neither takes nor waits for one; neither does a missed run waiting for you.
    An agent run waiting for you at a permission prompt holds no slot: it is idle, and a
    forgotten prompt must not hold back every low-priority job; once answered it goes on, past the
    cap if need be.
  - **"queued · N ahead"**: N runs have to end before it starts — the slot-waiting runs ahead of it
    and the one whose slot it takes. Three low-priority runs due at once: two run, the third is
    "queued · 1 ahead", a fourth would be "2 ahead". The others: "queued · at Wed 23:00", "queued ·
    held · Pause all", "queued · warm-up until 08:32", "queued · after the previous run", "queued ·
    opening Pomade", "queued · a fresh keeper, after the runs going".
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
  - A held job's look stays where the switch caught it (`held` in `runs.json`). While it holds a
    job, nothing is decided for it — no record, no Needs-you item, no notice — and the report counts
    its occurrences since then (`RunsReport.heldRuns`: the note under the switch, `pomade-runner
    runs`) and marks it held (`JobRuns.held`: the Jobs view). History shows each held job with a
    run held so far as one **held row** (`HeldRun`: "held · 2 runs so far, 17:40–17:42"; the rows'
    counts add up to `heldRuns`), under **Skipped & missed** and in `pomade-runner history`. A held
    row is derived — from the job's look in `runs.json`, its schedule and the clock — never
    written to the history, so a restarted scheduler, or one on another Mac reading the same
    records folder, shows the same row; it makes no Needs-you item and no notice. On release it is
    gone, and what the job's policy makes takes its place: the record ("missed 3 runs, … · caught
    up once", "… · skipped") or the missed run that waits for you — and, run with Run all or Run
    the other N, the runs they became ("caught up 2 of 3"). On release every occurrence it held is
    missed, the latest too however recent, and goes, counted, to the job's policy: one decision. A
    queued run the switch held goes to its job's policy on release when it is more than 5 minutes
    late, or a caught-up one: a `run-on-wake` job keeps it while it is worth it, a `wait-for-me` one
    waits for you, a `skip` one records it missed. A release is no wake: no warm-up.
  - Kept in `switch.json` in Runner's records folder, written before the switch answers; it
    survives restarts and goes with the workspace.
  - Set from the panel (`switch.set`, Runner's frames only), by `pomade-runner pause [low|all]`
    (`all` when left out) and `pomade-runner resume`, and the control method `switch`.
- **Time limit**, per job (`time-limit`), none by default. A run counts from its start
  (`ranFor`); at the limit Runner stops it, once (SIGTERM, then SIGKILL after 3 s; reason
  `time-limit`): **failed**, and it reads **stopped: time limit, 45 min** — the job's limit — in
  History, on its card, in its notice and in `pomade-runner history`; red, and noticed as a failure.
  The job file as it is now sets the limit. An agent run's waits for you are left out of
  `ranFor`, so the limit pauses while it waits; so does the long-run warning.
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
skills-folder: Knowledge/_skills/apps/   # where Runner keeps its agent skill
```

| Field | Value | Default |
|---|---|---|
| `max-low-priority-runs` | a whole number, 1–16 | 2 |
| `warm-up` | a duration, `0m`–`1h` | `2m` |
| `long-run-warning` | a duration, `1m`–`24h` | `3h` |
| `history-days` | a whole number, 1–365 | 30 |
| `skills-folder` | a folder inside the workspace, relative to its root (an absolute path, `~` or one that climbs out with `..` is a problem) | `Knowledge/_skills/apps/` |

- A missing file, a field left out or an empty one means its default.
- **Checked like a job file** (`src/scheduler/settings.ts`, with the job files' YAML reader): every
  problem is one line, `path:line: field — problem. Fix: …`, a misspelled field gets the closest
  one; a field with a problem counts as its default until it is fixed. `pomade-runner check` checks
  it with the job files, or alone when it is the file named.
- **Followed live:** the scheduler reads it on every tick, so an edit applies within a second, and
  tells Runner's frames (`settings.changed`); `settings.get` answers what applies and the problems.
- **Written field-only** by the scheduler (`settings.set { field, value }`: a count, a duration in
  minutes, a folder, or `null` for the default): only the field's line changes, comments and the rest stay
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
    fixed or disabled file, or its removal end it. It is noticed once per giving-up. It carries why
    its last start failed (`problem`: the keeper refused it — a folder that does not exist) and
    whether the service has a session (`session`). Actions: Start · View output (the service's
    attached tab with its last output) — View output only with a session; a service that never got
    one (its command could not start) has Start alone, its name opens the job in Jobs, and the card
    and the notice say why it could not start.
  - **A missed run that waits for you** (`missed:<job>`, one per job) is an item while it waits;
    noticed when it comes ("Tidy drafts · missed Sun 03:00"), its click opening the run's card.
    Actions: Run now · Run at… · Skip (`runs.missed`); for more than one missed run Run once · Run
    all N · Run at… · Skip. Its notice's body names them: "It waits for you: Run once, Run all 4,
    Run at… or Skip."
  - **An agent run waiting for you** (`waiting:<job>:<run>`) at a permission or trust prompt is an
    item while it waits; it cannot be dismissed. Noticed when the wait begins: "<job> needs your
    approval", what it waits at and that the time limit is paused; the notice opens the Runner tab
    at `prompt/<job>/<run>`, which opens the run's terminal tab at the prompt. Action: Open at the
    prompt (its terminal tab).
  - **A long-run warning** (`long-run:<job>:<run>`) is an item while its run runs, until dismissed;
    noticed once. Actions: Open · Stop (`runs.stop`) · Dismiss (`needsYou.dismiss`).
  - **A job the loop guard paused** (`loop-paused:<job>`) is an item while it is paused and its file
    is there: *"Paused: triggered 10× in 10 min — looks like a loop"*; noticed once, when it
    pauses. Actions: Resume (`jobs.resume`) · Edit job (its form). It cannot be dismissed.
  - The failed runs' items, and the giving-ups already noticed, are in `needs-you.json` in Runner's
    records folder; the missed runs, the waits, the warnings and the loop guard's pauses are the runs' own, in
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
   keep running." — and, once it has held a run, how many so far ("Low-priority jobs are held · 4
   runs so far. Services keep running.", `heldRunsWords`), with the (i) of what becomes of a held run.
   The count is a link: it opens the Runner tab on History with **Skipped & missed** on
   (`history/missed`), where each held job has its held row;
2. **Needs you** (`src/ui/NeedsYou.tsx`): a card per item (`PanelCard`) — the status dot (red: a failed
   run, a service that gave up · amber: a missed run, a run waiting for you, a paused job · accent: a long run), the
   job's name, the (i) help of that kind, the time at the card's end, one line of text, and the
   actions inline, the first one primary (`needLook`, `src/ui/panelWords.ts`):

   | Item | Time | Text | Actions |
   |---|---|---|---|
   | failed run | when it failed | "Failed: exit 1 · 2×" (the count when more than one) | Open · Run now · Dismiss |
   | service gave up | its last crash | "Crashed 5× in 1 min — gave up."; when its last start failed, "Gave up — could not start: <why>" | Start · View output (only when the service has a terminal session) |
   | missed run waits | when it was missed | "Missed — it waits for you to pick a time." ("Missed 4 runs, 17:40–17:46 — …" for more than one) | Run now · Run at… · Skip; for more than one Run once · Run all N · Run at… · Skip, wrapping to a second row in the panel |
   | agent run waits for you | how long it has waited ("17m") | "Waiting for approval at a permission prompt." / "Waiting for you to trust its folder." | Open at the prompt |
   | long run | how long it has gone ("3h 02m") | "Running 3h — still expected?" | Open (its terminal) · Stop · Dismiss |
   | job paused by the loop guard | when it paused | "Paused: triggered 10× in 10 min." | Resume · Edit job |

   The time reads "11:20" today, "yesterday", "Sun 3:00" within the week, else "13 Nov". The
   job's name is a link to what the card is about: the run's result card (a failed run, a missed
   run, a run waiting for you, a long run), the service's terminal tab (the job in the Jobs view when the service never got a session), the job in the Jobs view (a paused job). **Run
   at…** opens a field below the buttons, filled with "tonight 23:00" and focused; under it what the
   text comes to ("→ today 23:00") or "Try: tonight 23:00 · tomorrow 7:00 · +2h"; Set (or Enter)
   sends it as typed, Esc closes it. Every outcome is a toast ("<job> started", "<job> will run
   today 23:00", "<job> stopped by you", "<job> resumed"); a refusal is "Could not <do it> <job>:
   <why>". The section's count is a red badge while any item waits, a grey 0 and "Nothing needs
   you." otherwise;
3. **Running now** (`src/ui/RunningNow.tsx`): the services that are up or starting, in start
   order, then the runs going, as one list of rows (`PanelRow`): the status dot, the name and at
   its end where it stands with its help ("up 3d 4h", "starting", "running 3m", "queued · 1
   ahead", an agent run at a prompt amber "waiting for you · 17m"); project · folder below ("workspace · my-workspace" for the workspace root); a third line
   only for news ("waiting for port 5173", "restarted 3× · last crash 14:02", "restart to apply
   its file"). A row's status words explain themselves on hover (no (i) in rows). A service's row
   opens its attached tab, titled with its name; a running run's row its terminal (the run's
   attached session); a queued run's row — it has no session yet — its result card;
4. **Next up** (`src/ui/NextUp.tsx`): the next five runs (`NEXT_UP_RUNS`), soonest first — a job
   as many times as it comes among them — "in 40 min" within the hour ("in 56 s" under a minute,
   "now" from the run's moment; the countdown below), then the time ("13:00",
   "tmrw 7:00", "Thu 7:00", a later date cut short with "…"; the full moment on hover), the job's kind icon and its name, and on a
   run the switch holds (`held`) its name faint and the amber **held** tag with the switch's help;
   a row opens the job in the Jobs view (`jobs/<encoded job id>`); "Nothing is scheduled." when
   none;
5. **Open Runner**.

**Runner tab:**
- **Jobs** (`src/ui/JobsView.tsx`): the job files grouped by project — workspace jobs first, then each
  project in Pomade's order — each group headed by its name (the Workspace's with its help), its
  jobs sub-folder (`jobs/blog/`) and its count; the files of a group by path. The filter row
  has the "This project" chip with its help and the "N jobs" summary ("· N invalid" when a file is
  invalid); the table head carries the helps on **Last result** and **Next run**. The chip is the
  tab's: on in Jobs, it is on in Services; it keeps the open project's jobs ("No jobs in <project>"
  and **New job** when none), and **New job** then starts in that project (`new/<encoded project
  id>`, `newJobRoute`).
  - **A row:** the kind icon (the kind as its tooltip), the name — an agent job in Full autonomy with
    the amber **Full autonomy** tag and its help beside it — over the trigger in words
    (`jobTriggerWords`, a chain's job and a hook's project by name, "manual" for a manual job; the tooltip is the full text, and
    a git job's adds its operation and repos — a repo the workspace lacks is said in red), **Last
    result**, **Next run**, the actions, and the **Disable** toggle. A disabled row is dimmed.
  - **Last result** (`lastLook`, `src/ui/jobWords.ts`): a chip with the status's help over a sub line.
    A service shows its state as the Services view does (`serviceLook`). Any other job shows the run
    going — "running" over how long so far ("3m", "3h 02m · manual"), amber "waiting for you" over
    "started 12:31 · 17m" for an agent run at a prompt, "queued · 1 ahead" over "since 12:46",
    "missed · waiting for you" over when it was due — else the loop guard's pause, amber "paused ·
    looks like a loop" over "yesterday 18:40 · 10× in 10 min" — else its latest finished one:
    "done", "failed · exit 1", "stopped: time limit, 45 min", "skipped · …", "missed · …", "stopped
    by you", over when it started (or, one that never did, was due) and how long it took, "today
    8:32 · 4m 12s" — a done git run's commit in place of the duration, "yesterday 20:00 · a1b2c3d" —
    and a trigger that is not the job's own, "· caught up" or "· manual"; "never ran" for none. A
    click on a job's cell opens that run's result card (`run/<job>/<run>`); a service's, a paused
    job's and a never-ran job's cell has none.
  - **Next run** (`nextLook`): "disabled", "paused" (the loop guard's), "always on" (a service on Mac startup), "with Pomade" (a Pomade-bound one), "on
    event" (a hook or a chain), "not scheduled" (a manual job), "finished" (a schedule with nothing ahead), else the next time —
    "Today 13:00", "Tomorrow 7:00", "Wed 7:00", "Wed 25 Nov 7:00" — with the countdown under it
    within the hour. A job the switch holds (`JobRuns.held`) shows its time faint and Next up's
    amber **held** tag, with the switch's help, under it after the countdown.
  - **The countdown** (`soonWords`, `src/ui/runWords.ts`): one function, read by Next run and by the
    panel's Next up, so the two always say the same. Minutes are counted as a clock reader does —
    at 17:49:10 a run at 17:51:00 is "in 2 min" until 17:50:00 — under a minute it counts whole
    seconds ("in 56 s"), and "now" shows from the run's moment until the row turns to running.
    The view reads the clock again the moment the words change (`useCountdownNow`): each second
    while a shown run is under a minute away, else each minute; with none under a minute nothing
    redraws per second.
  - **Actions**, always visible icon buttons, right-aligned: **Run now**, **Edit**
    (`edit/<encoded job id>`), **Delete** — the bin in the row's icon colour, red under the pointer
    and on focus — which opens the confirm of "Deleting a job". A service's row has in Run now's place
    **Stop service** (the stop square) while it is running or starting, **Start service** (the play
    triangle) while it does not run and Start would start it, and neither while it is disabled,
    invalid or gone (`serviceActions`, `src/ui/serviceWords.ts`); before it, **Open terminal** (its
    attached tab) once it has a session — the running one, or the last that ended with its output.
    Start and Stop call `services.start` and `services.stop` as the Services view does
    (`useServiceAction`). Run now, Start, Stop, a refused one or toggle and Delete report as toasts —
    Run now's "<job> started · trigger “manual”". The toggle writes `enabled:` (`jobs.setEnabled`).
    A script, agent or git job with a run going has, before Run now, **Open terminal** (the run's
    attached tab) and **Stop run** (`runs.stop`, "<job> stopped by you"), the same actions as the
    run's result card (`useOpenRunTerminal`, `useStopRun`); with several runs going they act on the
    latest started (`latestGoing`, `src/ui/rowRun.ts`); a run waiting at a prompt names its terminal
    **Open at the prompt**, as the card does. Run now stays. A queued run has no terminal and nothing
    to stop, so it adds neither. The two icons' places stay empty while the job has no run going,
    so the row's other icons keep their columns (the actions column is five icons wide).
  - **An invalid file** is a red row with its file name, its help, its first error and **Open file**.
  - **The route `jobs/<job>`** marks that job's row — the accent bar and wash — and scrolls to it.
- **History** (`src/ui/HistoryView.tsx`): the runs going (`runs.list`'s `active`: running — an
  agent run at a prompt amber, "waiting for you" — queued with what they wait for, missed and
  waiting for you), the held rows (`history.list`'s `held`: amber, "held · 2 runs so far,
  17:40–17:42", at the latest held run, no duration, trigger "scheduled", kept by **Skipped &
  missed**; one opens its job in Jobs) and every record, one list newest
  first by when each started — or, one that has not, was due — under day heads (Today, Yesterday,
  "Sun 15 Nov"). Each row: the time, the kind icon, the job, the result (`runLook`: dot and words
  — "failed · exit 1", "done · restarted", "queued · 1 ahead", "running · 3h — still expected?",
  "waiting for you" —
  explaining itself on hover), the duration (a running run's so far) and what started it
  (scheduled · caught up · "missed 4 runs, 17:40–17:46 · caught up once" · manual · hook: Mac
  login · chain: after Pull), with its help. The
  result chips — All · Active · Failed · Skipped & missed, each but All with its count — and
  "This project" filter the list; the summary says how many days History keeps. History loads a
  page of 100 records, the newest page again on every `runs.changed`, and the next older page
  each time the list's end comes into sight (`useHistoryPages`); while older pages remain, a
  count is of the runs loaded and says so ("3+"). A row — click, Enter or Space — opens the run's
  result card. The route `history/missed` turns **Skipped & missed** on, then goes back to
  `history`, so the next ask turns it on again. With no runs at all, the view says "Nothing here yet" with **New job**.
  - **The columns** are resized as Services' are ("Resizable tables"): a grip on the head of Job,
    Result, Duration and Trigger; the Time and the kind icon are fixed. At the default layout the
    Job, Result and Trigger columns share the tab (0.8 : 1.1 : 1, Trigger at least 86 px) and
    Duration is 62 px. A Job, Result or Trigger a column cuts with "…" shows whole in its tooltip —
    above the help the Result and Trigger carry — on hover. A day head spans the whole table and
    keeps its title at the left edge while the table is scrolled sideways.
- **Services** (`src/ui/ServicesView.tsx`): the "This project" chip (the tab's, as in Jobs) with
  the open project's name, and the summary "Services on Mac startup outlive Pomade · the switch
  never pauses them"; the table head **Service · project · folder**, **Command** and **Status**, each with a grip; then
  every service file in start order — a valid one's row: the kind icon, the name over project ·
  folder, the command, the status (`serviceLook`, `src/ui/serviceWords.ts`) — "running · up 3d 4h" over "no
  crashes" or "restarted 3× · last crash 14:02" (and "restart to apply its file" after an edit of
  its command or folder), "starting" over what it waits for ("waiting for port 4000", "up once it
  has run 5 s"), "failed · gave up" over "crashed 5× in 1 min · today 11:20", "stopped by you" over
  when, "queued" over "starts when the one before it is up", "restarting" over its crashes or
  "again at 14:03", "waiting for first open" over "starts on first open of blog", "waiting for
  Pomade" over "starts when Pomade starts" or "starts on first open of blog", "disabled",
  "stopping" over "its file is gone" — each with its help; **Restart · Stop** while it is up or
  starting, **Start** while Start would start it (its job enabled — the file's word, so a report a
  tick behind never offers it — and not invalid or gone; a service waiting for Pomade has none, since
  Start would be refused); then the icon
  buttons **Open terminal** (its attached tab, once it has a session; its place kept empty
  otherwise), **Edit** (the `edit/<encoded job id>` route) and **Open file**. Each action toasts its outcome or
  why it was refused. An invalid service file is a red row with its file name, its help, "Invalid:
  line N: …" and **Open file**. The chip keeps the open project's services ("No services in this
  project." when none); with no service files, the view says what a service is and offers **New
  job**, as History does with no runs.
  - **The Command column** (`CommandCell.tsx`): the command in the mono type, one line cut with
    "…", on the name's line; 260 px by default. A command that is cut is focusable and shows whole,
    wrapped in the mono type, in the tooltip on hover and on keyboard focus; one that fits has no
    tooltip — measured, and again on every resize of the column or the tab. The column's width is
    changed as every column's ("Resizable tables"). In a tab narrower than 800 px the column gives
    way: the head drops Command, the command goes under the name across the Service and Status
    columns (same cut and tooltip), Service and Status share what the actions leave, no grips show
    and the table does not scroll sideways whatever widths are kept. An invalid file's row spans the
    middle columns in both.
- **Resizable tables** (`src/ui/kit/ResizableTable.tsx`, `columnWidths.ts`): the Services and
  History tables, and no other. A view lists its columns once — a fixed one (the kind icon, the
  Services actions, History's time) has its px width, a sized one its least width (`min`) and its
  default CSS track — and wraps its head and rows in `ResizableTable`. Every sized column's head
  cell has a grip on its right edge, in the gap before the next column: a faint line while the head
  cell is hovered, the accent while the grip is hovered or dragged, a ring while it is focused (the
  grip is a focusable `separator`, `col-resize` cursor, and nothing moves for hover or focus).
  Dragging it changes that column's width and no other column's; Left and Right on the focused grip
  do the same by 16 px, with Shift by 64 px; a double click puts the table back to its default
  layout. A column is never narrower than its `min` (Service, Command and Status 120 px; Job and
  Result 80; Duration 62; Trigger 86) nor wider than 2000 px.
  - **Default and resized layouts.** Until a column is resized, the table lays out by the columns'
    default tracks, flexible ones included, and fits the tab. The first resize fixes every sized
    column at the width it has that moment (whole px), then changes the dragged one; from then on
    every column has its own width, no column gives room to another, and what is left of the tab is
    empty at the table's right while the columns are narrower than the tab.
  - **Scrolling.** When the columns, the gaps between them and the row padding together are wider
    than the tab, the table scrolls sideways inside its view — head, rows, invalid rows and day heads
    together, so every cell stays under its head cell at every scroll position; the page itself
    never scrolls sideways. A day head's title stays at the table's left edge.
  - **Kept widths.** Each table's widths are kept on this Mac per viewer (`localStorage`: Services
    under `pomade-runner.services.column-widths`, History under `pomade-runner.history.column-widths`,
    one JSON object of column id to px) and are the same after the tab is closed and opened again.
    Widths that miss a sized column or do not read leave the default layout; without storage the
    table renders at the default layout and still resizes for the view's life.
  - **Cut text.** `data-tip-cut` on an element tells the tooltip that its text may be cut with "…":
    while it is cut, its whole text leads the tip, above the element's own help or line;
    while it fits, the tip is as without it. (The Services command has its own measuring, since a
    cut one is also a tab stop.)
- **Settings** (`src/ui/SettingsView.tsx`): cards of rows — a name with its (i), a line under it, the
  control at the end.
  - **Load** and **History:** the four settings ("Settings"), each a stepper (− number +, its unit
    beside it) over the engine's whole range. A step shows at once; once the steps stop
    (`STEPPER_SETTLED_MS`, a held button's run included) it is written field-only (`settings.set`),
    even when the person has left the view meanwhile. The long-run warning steps by whole hours and reads
    in minutes under an hour. A refusal puts the value back and says why under the row. The
    settings file's own problems are listed over the cards.
  - **Notifications:** a read-only row with a status (`environment.get`) — the macOS notification
    permission.
  - **Agents:** **Skills folder** — the `skills-folder` setting in a one-line text field, written
    field-only (`settings.set`) on Enter or when the field is left; Escape puts the file's value
    back, empty writes the default, a refusal puts the value back and says why under the row.
    **Job skill for agents** — where the skill's file is (`environment.get`), that Runner gives it
    to no agent, a status ("In place", or "Not written" with the reason under the row) and **Show in
    Files**, which shows the file in Pomade's Files panel.
  - **Files:** `settings.yaml` with Open file (once it exists), and the jobs folder with Show in
    Files, which shows it in Pomade's Files panel (`files.reveal`).

**Routes of the Runner tab** (`parseRoute`, `src/integrations/runner-api.ts`): `""` Jobs ·
`jobs/<encoded job id>` Jobs at one job, its row marked and scrolled to (what a repo row's Scheduled
line opens) · `history` · `history/missed` History with **Skipped & missed** on (what the count
under the switch opens; `HISTORY_MISSED_ROUTE`) · `services` · `settings` · `run/<encoded job id>/<run id>` a run's result
card, a dialog over History (what a run's notice opens) · `prompt/<encoded job id>/<run id>` a
waiting run's notice: the run's terminal tab opens at the prompt, and the Runner tab goes to its
card · `output/<encoded job id>/<run id>` its
full output — the route of the run's output tab (below) · `new` the job form for a new job (what
**New job** opens; `newRoute`), `new/<encoded project id>` for one that starts in that project · `edit/<encoded job id>` the job form editing a job (`editRoute`).
An unknown route is Jobs. The tab follows Pomade's `route.changed`, and tells Pomade each route it
goes to by itself — a view picked, a card closed — with `tabs.setRoute`, so a reload opens there and
the same notice clicked again opens its card again.

**A run's output tab** (`src/ui/OutputPage.tsx`): a keyed Pomade tab (`tabs.openApp` with `key`,
`title`, `kind`) of the manifest's tab kind `output` (title "Output", a terminal icon), one per run —
key `out:<encoded job id>:<run id>` (`outputTab`, `src/integrations/runner-api.ts`) — titled
"<job> · output", at the run's `output/…` route. **View output** opens it, or focuses it when it is
open. A head with the job's name, "Captured log · <when> · read-only" and **Copy**, which puts the
log on the clipboard (`navigator.clipboard.writeText`); then the log as plain text, followed while
the run runs. A tab Pomade restores whose run is gone from the history (pruned) closes itself
(`tabs.close`).

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
  `data-help` (a key of `src/ui/help.ts`) shows it on hover and on keyboard focus; `data-tip-cut`
  adds an element's whole text to its tip while a column cuts it ("Resizable tables"). A tip is as wide
  as its text up to 280 px (480 px for a command); a text wider wraps onto further lines, and a word
  wider than the tip breaks, so no text leaves the box.

**Job form** (`src/ui/form/`). Creating and editing a job happens in a form, never by hand-editing
md. A full page in the Runner tab: its head (back to Jobs, "Jobs / <name>", **Enabled**, and —
editing — **Open file** and **Delete**), the sections, and the Save bar ("Saves to <path>",
**Cancel**, **Create and start** for a service that starts as it is created (`startsOnCreate` in
`state.ts`: enabled, and On Mac startup, While Pomade is running — the form is in a running
Pomade — or on the first open of a project in `ServicesReport`'s `openedProjects`) / **Create job** / **Save**, **Saved** while nothing changed; the toast after a
create says "· started" on the same test). Order: kind → trigger → folder and project (agent: agent → folder → mode; git: operation →
repositories → project) → policies; the
policies show as one sentence, non-defaults in bold, until **Change**.
- **State** (`state.ts`, pure): the values the form shows, the fields the person set (`touched`),
  and the file as last read (`base`). Switching kind keeps what the person set and resets the
  kind-dependent defaults they left alone (missed-run policy, overlap, low priority, notify). A folder inside a project
  fills in that project.
- **Kinds**: each kind is registered in `FORM_KINDS` (`state.ts`: the file's fields — and the body,
  for an agent job — from the values, and which form field each file field's errors belong to) and
  in `KIND_UI` (`kinds.tsx`: its sections between Kind and Policies, its policy rows, its Create
  button). A file the form cannot read — broken frontmatter, a kind Runner does not have — opens a
  page saying so, with **Open file**.
- **Trigger** (script, agent and git; `TriggerSection.tsx`, the values in `schedule.ts` and `state.ts`, the words
  in `triggerWords.ts`, pure). A choice of **On a schedule** · **When something happens** ·
  **Manually**; back to When something happens, the hook or the chain shown last returns. A file
  with none of `schedule`, `hook` and `after` opens on Manually. **Manually** has one line under it,
  "It runs only when you press Run now — never by itself.", and no controls; it removes `schedule`,
  `hook`, `after` and the missed-run policy from the file, field-only. A schedule has the schedule editor:
  - **Repeats**: Once (a date of the coming week and a time, or a phrase typed in words — `tonight
    23:00`, `tomorrow 7:00`, `+2h` — read by `pomade-kit/dates`, which fills in the date and time) ·
    Every N minutes or hours, optionally only between two times · Daily at one or more times ·
    Weekly on chosen days · Monthly on days of the 1–31 grid, the last day, and nth weekdays added
    as "the [first] [Monday]";
  - **Days**: Every day · Weekdays only · Weekends only, for every and daily (the format's `only:`);
  - the schedule in words (`scheduleWords`: the kit's, except a once on today's or tomorrow's date,
    which reads "once, today at 23:00" / "once, tomorrow at 7:00"; the Jobs view says it the same way)
    and its next three runs (`nextOccurrence`), live, from
    the text the form would write; "Fix the schedule to see it in words" while the checker finds a
    problem with it.

  The editor's values are kept as typed and written as the format's canonical lines (`schedule:` one
  entry per line, a shape's mapping in flow style); what the file's schedule has that the editor has
  no control for (`monthly.months`, `start`, `end`, an unknown key) is kept. A schedule the person
  left alone is never written. Each schedule error the checker names lands on its control by its
  path (`schedule.daily.at[1]` → the second time), and the error shows under the box.

  When something happens has the **Event** list — the seven hooks the engine fires (`EVENT_CHOICES`:
  Mac login, Pomade started, First open of a project since Pomade started, Project opened (every
  time), Project created, Agent session finished, Session status changed to…), then **Another job
  finished**, a chain, always last — its (i) following the event. The first open and Project
  opened pick, in a box under them, the **Project**:
  Any project, then Pomade's projects by name (one the file names that Pomade lacks stays, by its
  id). The two agent session hooks pick, in a box under them, a status change's **Status** (the
  Agents app's statuses by its names, Done for a new hook), then **Only in project** (Any project
  first) and **Only agent** (Any agent first, then the roster's ids; one the roster lacks stays,
  with a red line under it); without the Agents app the box says so. A chain picks, in a box under
  it, the **Job** (every valid job but services and the job itself, by name; one the file names
  that is not among them stays, by its id) and **When it**: Is done · Fails · Either. Under them,
  the trigger in words: "Runs at Mac login · Once per login, after the 2-minute warm-up" (the
  warm-up as the settings say it); "Runs when Pomade starts", "Runs on first open of blog", "Runs whenever blog is opened",
  "Runs when a project is created", "Runs after a claude session finishes in Pomade", "Runs when a
  session is marked Done" · "Fires only while Pomade is running, so there are no missed runs."; or
  "Runs after Pull is done · A chain. History will show “chain: after Pull”". The file gets
  `hook: { event: login }`, `hook: { event: project-first-open, project: <id> }` (no `project` for
  any), `hook: { event: session-status, status: done, project: <id>, agent: <id> }` (a filter left
  at Any is not written) or `after: { job, result }`, as a hand-written one has them; the filters the form does not
  edit are not the form's, so an edit that keeps the hook writes no hook. A chain's errors show under its picker in the
  checker's words — a chain that leads back to itself names the loop's jobs ("the chain loops
  back: a → b → a"), with the (i) on why — and keep Save from writing. A hook on an event the form
  does not offer is said in words (`jobTriggerWords`) with **Open file**, and stays as the file
  has it.
- **A service's Trigger** (`ServiceSections` in `kinds.tsx`), always on: **Starts** — On Mac
  startup (default) · While Pomade is running · On first open of a project, with its project
  picker beside it (Pomade's projects by name; the job's own project until another is picked;
  "Choose a project…" for a workspace service with none) and under it the chosen start's lifetime
  in a line (`STARTS_HINT`: "Up before you open Pomade, and it outlives Pomade. …", "Starts when
  Pomade starts and stops when Pomade quits. …", "Starts on the project's first open since Pomade
  started — at once if it is open already — and stops when Pomade quits. …"); then when it counts
  as up, and its chain line.
  A picked project is `start-project:`; errors on either show under Starts.
- **Git** (`GitSections` in `kinds.tsx`): the Trigger section as a script's, then **Git** —
  **Operation** (Commit & push · Pull · Push · Fetch), **Repositories** and **Project**, no folder
  (`pomade-git` works in the repos). Repositories has a tick per repo of the workspace, in the order
  Pomade's git state lists them (`git.read`, followed live), named as its Git panel names them; a
  repo the file names that the workspace lacks stays, ticked, after them, with a red line saying so
  that does not keep Save from writing. The file gets `git: { operation, repos }`, the repos in the
  order they were ticked — the order `pomade-git` runs them in. Its policies are a script's, with
  the kind's defaults (Skip, normal priority, On failure).
- **Agent** (`AgentSections` in `kinds.tsx`, `pomade-agents` read through `src/ui/useAgents.ts`): the
  Trigger section as a script's, then **Agent** — who · where · how:
  - **Agent**: a choice of the roster's agents (`roster.list`), by name; one the file names that the
    roster lacks stays, with a red line saying so that does not keep Save from writing;
  - **Folder** and **Project** as a script's, the Folder's (i) its own, and under the input "Connected
    to <agent>:" with a chip per project connected to it (`roster.projectsFor`, in the Projects
    panel's order), then the workspace root — a chip sets the folder, and its project;
  - **Mode**: Normal and Full autonomy, then the agent's other modes; one the agent lacks is faded,
    its tooltip "claude-pm has no full autonomy mode"; Normal tagged default. Picking an agent that
    lacks the mode set goes back to Normal. Full autonomy shows the amber warning under it: "Skips
    every approval. … The job shows a “Full autonomy” mark in the list.";
  - **Prompt**: a text area, "Saved as the body of the job file." — the file's body, trimmed, with
    a closing line break. An edit writes it only when it changed (`bodyChange`), the fields
    field-only as for every kind; the checker's errors on the body (`body`) show on it.
  - Without the Agents app — absent, not answering, or answering what Runner cannot read — a notice
    stands in place of the Agent and Mode pickers, saying so and that the job keeps the file's
    agent and mode; a run due meanwhile fails. Folder, Project and Prompt stay.

  Its policies are a script's, with the kind's defaults (Run on wake, low priority, Always).
- **A service's chain** (`ServiceChainLine` in `TriggerSection.tsx`) ends the service's Trigger
  section: **+ Restart, start or stop it after another job**, then the line "**Also** [restart it ·
  start it · stop it] after [job] [is done · fails · finishes]" with **×** to remove it; the file
  gets `after: { job, result, action }`.
- **Policies** (`policies.ts` their words, pure; `kinds.tsx` their rows). Each kind lists its
  policies in the sentence's order; a policy's words come from the values, a non-default's in bold.
  A script's, in that order:
  - **If a run is missed**: Run on wake · Wait for me · Skip, each with its own help; with Run on
    wake, **Still worth it until** the next scheduled run or a time of day (`worth-until`, the time
    typed). For a script whose trigger is a hook, a chain or Manually the row says it does not apply
    ("Doesn’t apply — a manual job runs only when you start it."), and the sentence leaves it out. `worth-until` is written only with Run on wake and a time; choosing
    another policy takes it out of the file.
  - **If still running**: Skip · Run in parallel · Queue after;
  - **Low priority**: a switch;
  - **Time limit**: a duration typed (`45m`, `2h`, `1h30m`), empty for none;
  - **Notify me**.

  A git job's are a script's. A service's are low priority and notify: the engine applies a missed-run policy, an overlap and
  a time limit to jobs that run once per trigger only. A policy at its default is left out of the
  file. Each policy's error lands on its row; an error about a control the form does not draw
  (`worth-until` beside another policy, a missed-run policy on a hook) shows in the note about the
  file's problems and does not keep Save from writing.
- **The file it writes.** A new job: its kind's fields, defaults left out (`enabled` always
  written), in the project's sub-folder (`projectJobsFolder`) or at the top for the Workspace,
  under the first free slug of its name (`createJobFile`). An edit writes only the fields whose
  value differs from the file as last read (`fieldChanges` → `updateJobFile`), so comments,
  unknown fields and the body stay — a mapping on one flow line (`after: { job: pull } # nightly`)
  keeps its comment while it stays on one line; a field the file lacked is added at the end of its block. A
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
  changed it too a note says so — Save writes theirs. The file gone: the form says so, Save and
  Open file are off, and the file coming back lifts the note. Open file, from the form, the
  Trigger section or the page of a job the form cannot edit, toasts a refusal.

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

Runner writes in two folders, both named only in `src/locations.ts`, each with its own type
(`RecordsFolder`, `StateFolder`) so a path in one is never taken for the other:

- **The records folder**, `<workspace>/Apps/pomade-runner/records/` (`RECORDS_FOLDER`): what is part
  of the Owner's working process — what ran, what failed, what waits, where the switch stands — so
  a copy of the workspace carries it to another Mac. It sits beside the Owner's `jobs/` and
  `settings.yaml`, never inside `jobs/`, so the jobs watcher and `pomade-runner check` never read a
  record as a job. Nothing in it grows while a run goes: a run's output log moves in at the run's
  end.
- **The state folder**, `<userData>/app-state/pomade-runner/` of the Pomade that hosts Runner: what
  describes this Mac's processes — the control socket, the keeper, the output being written, crash
  counts, Pomade's projects as last heard.

| What | Where |
|---|---|
| Job files | `<workspace>/Apps/pomade-runner/jobs/` (synced with the workspace) |
| Workspace settings (max low-priority runs 2, warm-up 2 min, long-run warning 3h, history 30 days, skills folder `Knowledge/_skills/apps/`) | `<workspace>/Apps/pomade-runner/settings.yaml` |
| The agent skill's copy | `<workspace>/<skills-folder>/pomade-runner-jobs/SKILL.md` |
| Run history (one file per day, JSON Lines) | `<workspace>/Apps/pomade-runner/records/history/YYYY-MM-DD.jsonl` |
| A finished run's output log, moved in when the run ends | `<workspace>/Apps/pomade-runner/records/output/<encoded job id>/<run id>.log` |
| Runs going (missed runs waiting for you, queued, running), each job's latest record, the last alive time, the looks the switch holds, the loop guard's firings and pauses | `<workspace>/Apps/pomade-runner/records/runs.json` |
| The switch's position | `<workspace>/Apps/pomade-runner/records/switch.json` |
| Needs-you items, the giving-ups noticed | `<workspace>/Apps/pomade-runner/records/needs-you.json` |
| The services the Owner stopped | `<workspace>/Apps/pomade-runner/records/services.json` |
| Jobs whose id changed when their project moved (old id → new id) | `<workspace>/Apps/pomade-runner/records/renamed.json` |
| The output a live run or a service is writing | `<userData>/app-state/pomade-runner/output/<encoded job id>/<run id>.log` |
| A git run's result while it runs (`pomade-git --json`'s output) | `<userData>/app-state/pomade-runner/output/<encoded job id>/<run id>.json` |
| Session records (job, run, output log, end) | `<userData>/app-state/pomade-runner/sessions.json` |
| Service supervision on this Mac (crash counts, a restart due, a service given up on, the last start's problem) | `<userData>/app-state/pomade-runner/services.json` |
| Pomade's projects as last heard (for `POMADE_PROJECT_PATH`, and to tell a project moved) | `<userData>/app-state/pomade-runner/projects.json` |
| The Pomade start each workspace's Pomade started hooks fired for, and the projects opened in it | `<userData>/app-state/pomade-runner/pomade-started.json` |
| Where this Mac put the agent skill's copy last | `<userData>/app-state/pomade-runner/skill.json` |
| The keeper's own state (session records, exit statuses, `keeper.log`) and its stdout and stderr (`keeper.out`) | `<userData>/app-state/pomade-runner/keeper/` |
| Scheduler log (its stdout and stderr) | `<userData>/app-logs/pomade-runner/backend.log` |
| Scheduler control socket | `<userData>/app-state/pomade-runner/scheduler.sock` |
| Keeper socket (`POMADE_KEEPER_SOCKET`) | `<userData>/run/keepers/pomade-runner.sock` |
| Installed build (the scheduler's login item path) | `<userData>/apps/pomade-runner/` |

**The workspace.** The scheduler, the keeper it starts and the command learn the workspace the one
way the platform gives: `POMADE_WORKSPACE`, else the workspace pointer in Pomade's home
(`pomade-kit`'s `resolveWorkspace()`). The scheduler runs on one workspace at a time
(`src/scheduler/workspace-follow.ts`), looking again every tick:
- **None known** — Pomade never recorded one: the scheduler waits. It serves no control socket,
  starts no keeper and writes nothing anywhere; its log says once that it waits. With no workspace
  there are no jobs, so waiting loses nothing. It starts once one is recorded.
- **Another one recorded:** the scheduler stops — the keeper and its sessions keep running — and
  starts again on the new workspace, with that workspace's records; the time since that
  workspace's last alive time is missed and goes to each job's policy. A pointer that goes away
  leaves the scheduler where it is.

**The one-time move** (`src/scheduler/records-move.ts`). At every start, before its records load,
the scheduler moves what the state folder still holds of the records — history, `runs.json`,
`switch.json`, `needs-you.json`, the services the Owner stopped, and the output logs of the runs
already finished — into the workspace's records folder:
- every file reaches its place whole (a temporary file renamed, a log renamed) before its source
  goes, so a move stopped at any point loses nothing and the next start finishes it; with nothing
  left to move it only looks;
- a moved record names its log by job and run; a run going at that moment keeps writing its log in
  the state folder and moves it at its end; services' logs and git results stay;
- what the workspace already holds stays: a day of history both have gets the lines it lacks; a
  `runs.json`, `switch.json` or `needs-you.json` already there is the workspace's own, and this
  Mac's is left in the state folder, unread; the stopped services are read out of the state
  folder's `services.json`, which stays for its crash counts, unless the workspace has its list;
- a file that cannot move is said in the scheduler's log and tried again at the next start.

Two Macs running the same workspace at once is not handled here (`P-008-multi-device-double-fire`).

## Interfaces

**Runner offers:**
- **`jobs.list`** through the broker, to Runner's own frames: the checked jobs (see "Job files").
  **`jobs.changed`** on the platform bus tells them to ask again.
- **`services.list`** through the broker, to Runner's own frames: every service and where it
  stands, and the projects opened since Pomade started (`ServicesReport`, check
  `isServicesReport`); **`services.changed`** tells them to ask again. **`services.start`**, **`services.stop`**, **`services.restart`** with `{ job }` (its id or
  name), from Runner's own frames only, answer `ServiceActionResult` — the service's status after,
  or why it was refused. A start or restart may wait for a running session to end: callers give it
  `SERVICE_ACTION_TIMEOUT_MS` (`src/integrations/runner-api.ts`).
- **Runs**, through the broker:
  - **`runs.list`** → `RunsReport` (`isRunsReport`): the runs going (missed runs waiting for you,
    queued ones with what each waits for, running ones), Next up (`NextRun`: the next
    `NEXT_UP_RUNS` runs of the enabled scheduled jobs and the Run at… ones, soonest first, each
    `held` when the switch's position holds it), each run job's next and latest run and whether
    the switch holds it (`JobRuns.held`), Needs you, the switch, and how many scheduled runs it has
    held so far (`heldRuns`); every run and record carries the missed runs it stands for (`missed`);
    **`runs.changed`** tells Runner's frames to ask again — on every change, and when the scheduler
    connects.
  - **`history.list`** `{ job?, before?, limit? }` → `HistoryPage` (`isHistoryPage`): the records,
    newest first, and the cursor of the next older page; the newest page (no `before`) leads with
    the held rows (`held: HeldRun[]` — of `job` when one is asked for; `[]` on older pages); **`runs.get`** `{ job, run }` →
    `RunView` or `null`; **`runs.output`** `{ job, run }` → `RunOutput`: the end of its log, at
    most 1 MiB.
  - From Runner's own frames only: **`jobs.run`** `{ job }` → `RunActionResult` (Run now) ·
    **`jobs.setEnabled`** `{ job, enabled }` → `EnableResult`: writes `enabled:` into the job's file,
    field-only · **`needsYou.dismiss`** `{ id }` → `{ resolved }` · **`runs.missed`** `{ job, choice:
    "run-now" | "run-at" | "skip" | "run-all" | "run-others", at?, run? }` → `MissedChoiceResult`
    (when it runs and how many runs it made, or why not; `run-others` names the caught-up `run`) ·
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
  `unavailable`: the scheduler posts no native notification) and `skill` (`folder`: the skill's
  copy, workspace-relative, `<skills-folder>/pomade-runner-jobs`; `problem`: why it could not be
  written there, or `null`).
- **`jobs.forRepo`** through the broker, to any caller — Pomade's Git panel asks as `pomade`
  (PLATFORM rule 7): the jobs that target a repo (`repoJobs`, `src/scheduler/git-runs.ts`). The
  contract is `pomade-kit/protocol`'s (`REPO_JOBS_METHOD`, `RepoJobsParams`, `RepoJobsResult`,
  `RepoJob`). Params `{ repo: { name, path } }`; a job targets the repo when one of its `repos` is
  the name, or the absolute path. The answer, by id: every valid, enabled git job that targets it,
  with its operation, `schedule` — its trigger in words, as the Jobs view shows it ("daily at 13:00
  and 20:00", "at Mac login", "manual") — `nextRun` (ISO 8601, or `null`), `lastResult` (the repo's own
  result in the latest run when it has one, else the run's: a missed run is `skipped`, one stopped
  by you `failed`; `at` its end) and `route` (`jobs/<encoded job id>`). Answered from the snapshot
  in memory, in milliseconds.
- **Events** on the platform bus: **`run.started`** when a run's session starts, **`run.finished`**
  when a run that started ends (a skipped run, or one that never started, publishes neither). Live
  only: published while the scheduler is connected to Pomade.
  - Payload (`RunStartedPayload`, `RunFinishedPayload`): `job` (id), `name`, `run`, `kind`,
    `folder` (workspace-relative), `project` (id or `null`), `trigger`; on run finished also
    `result` (`done` · `failed` · `stopped-by-you`) and `exitCode`.
  - An agent run's also carry what `pomade-agents` reads them by (`../pomade-agents/docs/CONTRACTS.md`
    "Subscribed events"; `src/scheduler/run-events.ts`): `sessionId` (`null` while not known —
    `run.finished` carries one found after the start), `agent`, `mode`, `cwd` (absolute, symlinks
    resolved), `startedByRunner: true`, `startedAt` (ISO 8601 with a zone: the session's start,
    at or before the transcript's first record) and `terminal` (the run's session in Runner's
    keeper, `run:<encoded job id>:<run id>`, or `null` when the run has no keeper session: what
    the Agents app's Live now row and **Open run terminal** attach to with `tabs.openAttached`).
    A script, git or service run's events carry none of these. `run.finished` repeats every field
    of `run.started` for the same `job` and `run`.
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
| Platform (`pomade:E-031`) | events: `pomade.ready`, `project.opened`, `project.created`, `project.renamed` (hooks, projects) |
| Platform (`pomade:E-032`) | notices and the closed-Pomade queue |
| Platform (`pomade:E-033`) | Open session |
| Platform (`pomade:E-034`) | attached terminals: the pane, `tabs.openAttached`, `attachedTab.action` |
| `pomade-git` (`pomade:E-042`) | git operations, structured results |
| `pomade-kit` | SDK, schedule format, date phrases, agent scanners, the keeper library and attach protocol, the git runs contract |
| `pomade-agents` (`calls`) | `roster.list`, `roster.launchSpec`, `roster.projectsFor`, `sessions.lastMessage`, `sessions.find` (`src/integrations/agents.ts`); events B `session.closed` and C `session.statusChanged` (`src/integrations/agent-events.ts`, the agents' hooks) |

## Stack

TypeScript (strict) everywhere, on `pomade-kit` (`github:dd-voronov/pomade-kit#v0.14.0`).

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

**The agent skill** (`src/jobs/skill/place.ts`). Runner keeps a copy of its build's skill at
`<workspace>/<skills-folder>/pomade-runner-jobs/SKILL.md` — a real file, not a link, since the
skills folder may be its own git repository synced to other Macs — and gives it to no agent:
which agents get it is the person's choice, made by hand or in the Agents app.
- **When:** the scheduler places it at every start — an install, a bundled install and an update
  all start or restart it (`restartOnUpdate`) — when `skills-folder` changes, and when Settings asks
  (`environment.get`). The file is written (a temporary file renamed) only when its text differs
  from the installed one.
- **Moving:** where this Mac placed it last is recorded in the state folder (`skill.json`); once the
  copy is written in a new folder, the old `pomade-runner-jobs/` folder is removed.
- **Only its own copy:** Runner writes into or removes a `pomade-runner-jobs/` folder only when it
  is missing, empty, or Runner's copy — a real folder holding just a `SKILL.md` whose frontmatter
  names `pomade-runner-jobs` (Finder's `.DS_Store` aside). Anything else at that name is left, and
  said.
- **A problem** — a skills folder Runner cannot write, the name taken by something else — is one
  line in the scheduler's log (once, until it changes) and the reason in Settings' skill row,
  never a crash; the copy placed before stays until a new one is written.
- **Uninstall:** `./uninstall` removes the app, then the copy recorded in that Pomade's state
  folder (`node src/jobs/skill/place.ts remove [--stable]`) — an uninstalled app's skill would
  describe a command that is gone. Links someone made to the copy are theirs and stay.

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
  `JobResumed`; `pomade-runner resume-job`) · `missed { job, choice }` (a missed-run choice —
  `MissedChoice`: `run-now`, `run-at` with `at`, `skip`, `run-all`, `run-others` with `run` — answered
  `MissedSettled`: the job, when it runs and how many runs; `pomade-runner missed`). A job is named by its id or name; what cannot be done is
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
