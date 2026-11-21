---
name: pomade-runner-jobs
description: Write, change or remove Pomade Runner jobs — always-on services, scheduled or hook-triggered scripts, unattended agent runs, and scheduled git commit/pull/push — as job files in <workspace>/Apps/pomade-runner/jobs/. Use when asked to keep a server running, run something on a schedule ("every morning", "daily at 13:00", "every 30 min"), run something when Pomade starts, a project opens or an agent session ends, chain one job after another, or schedule an agent prompt or a git commit-push. Always finish with `pomade-runner check`.
---

# Runner jobs

Runner (the Pomade app `pomade-runner`) runs jobs without the user: it keeps **services** up, and runs
**scripts**, **agents** and **git** operations on schedules, hooks and chains — with Pomade open or
closed. A job is one Markdown file; Runner picks up a new, changed or deleted file within a second.
You never start, restart or register anything: write the file, then check it.

## Steps

1. **Pick the kind** — `service` (keep a command running), `script` (run a command once per
   trigger), `agent` (run an agent with a prompt), `git` (commit-push, pull, push or fetch repos).
2. **Pick where it goes.** A workspace job: `Apps/pomade-runner/jobs/<slug>.md`. A project job:
   `Apps/pomade-runner/jobs/<project folder>/<slug>.md` with `project: <id>`. Get both from
   `pomade-runner projects` (it needs Pomade running): it prints each project's id and its jobs
   sub-folder. The file name is the job's slug: lower-case letters, digits and dashes. When a
   project moves in Pomade, Runner renames its sub-folder and rewrites the `folder:` paths inside
   it itself — don't.
3. **Write the file** — frontmatter fields below, the body after the closing `---` (notes, or an
   agent job's prompt). To change a job, edit only the fields you mean to change; keep the rest,
   comments included. To remove a job, delete its file.
4. **Run `pomade-runner check <file>`** and fix every line it prints until it says `no problems`.
   Each line is `path:line: field — problem. Fix: what to do.` Exit code 0 = valid, 1 = problems.
   An invalid job is listed in Runner with its error and never runs.

## Fields

Every job:

| Field | Value | Default |
|---|---|---|
| `kind` | `service` · `script` · `agent` · `git` | required |
| `name` | what Runner shows; unique across the workspace | required |
| `project` | the project's id (`pomade-runner projects`); only in a project's sub-folder | none = workspace job |
| `enabled` | `true` · `false` | `true` |
| `notify` | `always` · `on-failure` · `never` | `always` for agent, else `on-failure` |
| `low-priority` | `true` · `false` — macOS background priority | `true` for script and agent, `false` for service and git |

By kind:

| Field | Kinds | Value |
|---|---|---|
| `folder` | service · script · agent (required) | working folder, relative to the workspace root; `.` is the root |
| `command` | service · script (required) | what the login shell runs, e.g. `./start.sh` |
| `start` | service | `login` (default) · `project-first-open`: on the first open of a project since Pomade started |
| `start-project` | service, with `start: project-first-open` | the project whose first open starts it; default: the job's own `project` (a workspace service needs it) |
| `ready` | service | `{ port: 5173 }` or `{ url: http://localhost:5173/ }`; default: up = alive after 5 s |
| `agent` | agent (required) | the agent's id, e.g. `claude` |
| `mode` | agent | one of the agent's modes; default `normal` (`full-autonomy` skips every approval) |
| `git` | git (required) | `{ operation: commit-push \| pull \| push \| fetch, repos: [Knowledge, …] }` — repos by the name Pomade's Git panel shows; a git job's `name` is at most 100 characters (its commits carry it) |

An agent job's **body is its prompt** — it must not be empty.

## Triggers

A service runs all the time (`start`). Every script, agent and git job has **exactly one** of:

- **`schedule`** — when, on the Mac's local clock. One shape, plus `only: weekdays | weekends` with
  `every` and `daily`, and optional `start` / `end` dates (`YYYY-MM-DD`):

  ```yaml
  # one of these shapes per job
  schedule:
    once: 2026-11-20 23:00
  schedule:
    every: { minutes: 30, from: 9:00, to: 19:00 }   # or { hours: 2 }; from/to optional
    only: weekdays
  schedule:
    daily: { at: [13:00, 20:00] }                   # one time or a list
  schedule:
    weekly: { days: [mon, tue, wed, thu, fri], at: 7:00 }
  schedule:
    monthly: { days: [1, 15, last, first mon], at: 9:00 }
  ```

  Times are `H:MM`, 24-hour. No cron syntax.
- **`hook`** — on an event: `{ event: <event>, …filters }`. Pomade's and the Agents app's events
  fire only while Pomade runs; one that happened while it or Runner was not listening is not caught
  up.

  | Event | Fires | Filters |
  |---|---|---|
  | `login` | once after Mac login, after a warm-up | — |
  | `pomade-started` | when Pomade is ready (tabs restored) | — |
  | `project-first-open` | the first open of a project since Pomade started | `project` (none = any project) |
  | `project-created` | a project is created in Pomade | — |
  | `session-finished` | an agent session the user ran ends (never one Runner started, so it can't loop) | `project`, `agent` (a roster id) |
  | `session-status` | the user changes a session's status to `status` in the Agents app (Runner's sessions too) | `status` (required: `active` · `on-hold` · `done` · `done-skip`), `project`, `agent` |
- **`after`** — a chain: `{ job: <id>, result: done | failed | any }` (default `done`). `<id>` is
  the other job's path inside the jobs folder without `.md`: `backup`, `coda-helper/git-pull`.
  `failed` is any failure — an exit code, a signal, a time limit; a run the user stopped fires no
  chain. A service can also have `after:`, with `action: restart | start | stop` (default
  `restart`; `restart` leaves a service that is not running alone). Chains must not loop back
  (A → B → A), and a service is never followed. A job fired more than 10 times in 10 minutes by
  hooks or chains is paused as a loop until the user resumes it.

## Policies (script, agent, git)

| Field | Value | Default |
|---|---|---|
| `missed` | scheduled jobs only — a run the Mac slept through, was off for, or Runner's switch held: `run-on-wake` (one catch-up run after wake, however many were missed) · `wait-for-me` (the user picks Run now, Run at… or Skip) · `skip` (recorded missed) | `run-on-wake` for script and agent, `skip` for git |
| `worth-until` | with `run-on-wake`: a time (`12:00`) after which a catch-up is skipped, or `next-run` (skipped once the next run is due) | `next-run` |
| `overlap` | the previous run is still going: `skip` · `parallel` · `queue` | `skip` |
| `time-limit` | `45m`, `2h`, `1h30m`; a run past it is stopped and fails; empty = no limit | none |

Low-priority runs share slots: at most 2 run at once (a workspace setting), the rest wait "queued ·
N ahead". A job with `low-priority: false` neither waits for nor takes a slot.

## Examples

One complete file per kind, plus a chain and three hooks. They form one valid jobs folder.

A **service** — a project's web server, restarted after its repo is pulled.
File: `Apps/pomade-runner/jobs/coda-helper/coda-web.md`

```markdown
---
kind: service
name: Coda web
project: V1StGXR8_Z5jdHi6B-myT   # the id from `pomade-runner projects`
folder: Projects/coda-helper
command: ./start.sh
start: login
ready: { port: 5173 }
after: { job: coda-helper/git-pull, result: done, action: restart }
---
The local web server of Coda Helper.
```

A **git** job — pull the project's repo every hour on weekdays.
File: `Apps/pomade-runner/jobs/coda-helper/git-pull.md`

```markdown
---
kind: git
name: Pull coda-helper
project: V1StGXR8_Z5jdHi6B-myT
git: { operation: pull, repos: [coda-helper] }
schedule:
  every: { hours: 1, from: 8:00, to: 20:00 }
  only: weekdays
---
```

A **git** job — commit and push the Knowledge repo at 13:00 and 20:00.
File: `Apps/pomade-runner/jobs/knowledge-commit.md`

```markdown
---
kind: git
name: Knowledge twice daily
git: { operation: commit-push, repos: [Knowledge] }
schedule:
  daily: { at: [13:00, 20:00] }
---
```

A **script** — a daily backup with a time limit.
File: `Apps/pomade-runner/jobs/photo-backup.md`

```markdown
---
kind: script
name: Photo backup
folder: .
command: ./scripts/backup-photos.sh
schedule:
  daily: { at: 12:45 }
missed: run-on-wake
worth-until: 18:00
time-limit: 45m
---
```

An **agent** job — a morning summary on weekdays; the body is the prompt.
File: `Apps/pomade-runner/jobs/morning-summary.md`

```markdown
---
kind: agent
name: Morning summary
folder: .
agent: claude
mode: normal
schedule:
  weekly: { days: [mon, tue, wed, thu, fri], at: 7:00 }
worth-until: 12:00
---
Summarize today's plan and what ran overnight. Keep it to ten lines.
```

A **chain** — clean up when the backup fails.
File: `Apps/pomade-runner/jobs/backup-cleanup.md`

```markdown
---
kind: script
name: Backup cleanup
folder: .
command: ./scripts/cleanup-backup.sh
after: { job: photo-backup, result: failed }
---
```

A **hook** — prepare every new project.
File: `Apps/pomade-runner/jobs/init-project.md`

```markdown
---
kind: script
name: Init new project
folder: .
command: ./scripts/init-project.sh
hook: { event: project-created }
---
The script gets POMADE_PROJECT and POMADE_PROJECT_PATH.
```

An **agent session** hook — analyze a session once the user marks it Done.
File: `Apps/pomade-runner/jobs/session-analyzer.md`

```markdown
---
kind: script
name: Session Analyzer
folder: .
command: ./scripts/analyze-session.sh "$POMADE_SESSION_TRANSCRIPT"
hook: { event: session-status, status: done }
---
The script gets POMADE_SESSION_ID, POMADE_AGENT, POMADE_SESSION_STATUS, POMADE_SESSION_TRANSCRIPT
and, for a session in a project, POMADE_PROJECT and POMADE_PROJECT_PATH.
```

A **login** one-shot — mount a drive once after each Mac login.
File: `Apps/pomade-runner/jobs/mount-drive.md`

```markdown
---
kind: script
name: Mount drive
folder: .
command: ./scripts/mount-drive.sh
hook: { event: login }
low-priority: false
---
```

## Then

Run `pomade-runner check` (all files) or `pomade-runner check <file>` and fix what it prints. With
Pomade closed it checks everything but project ids, and says so.

A script runs in its folder, by the login shell, with `POMADE_JOB` (its id), `POMADE_RUN_ID`,
`POMADE_TRIGGER` (`scheduled`, `caught-up` for a missed run run late, `manual`, `hook` or `chain`)
and, for a project job, `POMADE_PROJECT` and `POMADE_PROJECT_PATH` in its environment — on a
`project-first-open` or `project-created` hook, the event's project's; a `session-finished` or
`session-status` hook's run also gets `POMADE_SESSION_ID`, `POMADE_AGENT`, `POMADE_SESSION_STATUS`
and `POMADE_SESSION_TRANSCRIPT` (the session's transcript file, absolute), and the session's
project, if it has one, as `POMADE_PROJECT` and `POMADE_PROJECT_PATH`; a chain's
run also gets `POMADE_PARENT_JOB`, `POMADE_PARENT_RUN_ID` and `POMADE_PARENT_RESULT` (`done` or
`failed`). Exit 0 is done, anything else failed. A git job runs Pomade's `pomade-git` on its repos,
with Pomade open or closed: a commit it makes reads `Committed automatically · job "<name>" · <date
time>`, with a `Pomade-Job:` trailer; a repo where an agent is working is skipped; a conflict is aborted and the
run fails, the repo left as it was. `pomade-runner history` prints a git run's result per repo.
A `login` hook runs once after each Mac login,
after a short warm-up; an update or restart of Runner is no login. `pomade-runner list` prints every job with its trigger in
words, next run and last result; `pomade-runner run <job>` runs one now; `pomade-runner history
[job]` prints the latest runs with their output log; `pomade-runner runs` prints the runs going,
queued ones with what they wait for, and what needs the user; `pomade-runner enable|disable <job>`
writes `enabled:` into its file. `pomade-runner pause [low|all]` holds scheduled runs — of
low-priority jobs, or all — and `pomade-runner resume` lets them go; that switch is the user's, so
leave it alone unless asked. `pomade-runner resume-job <job>` lets hooks and chains fire a job the
loop guard paused again — fix the loop first, and resume only when asked.

Runner's workspace settings live in `Apps/pomade-runner/settings.yaml` — `max-low-priority-runs: 2`,
`warm-up: 2m`, `long-run-warning: 3h`, `history-days: 30`, each optional; change one only when
asked, then run `pomade-runner check`.

A valid, enabled `start: login` service starts within seconds of being written (services start one
at a time); a `start: project-first-open` one waits for that project's first open since Pomade
started, then stays up like any service. `pomade-runner services` shows every service and where it stands — running,
restarting, failed after a crash loop, stopped by you; `pomade-runner run|stop|restart <service>`
(its id or name) starts, stops or restarts one. Disabling a service in its file or deleting the
file stops it; an edited `command` or `folder` applies on its next restart.
