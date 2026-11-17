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
   sub-folder. The file name is the job's slug: lower-case letters, digits and dashes.
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
| `start` | service | `login` (default) · `project-first-open` (needs `project`) |
| `ready` | service | `{ port: 5173 }` or `{ url: http://localhost:5173/ }`; default: up = alive after 5 s |
| `agent` | agent (required) | the agent's id, e.g. `claude` |
| `mode` | agent | one of the agent's modes; default `normal` (`full-autonomy` skips every approval) |
| `git` | git (required) | `{ operation: commit-push \| pull \| push \| fetch, repos: [Knowledge, …] }` — repos by the name Pomade's Git panel shows |

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
- **`hook`** — on an event: `{ event: <event>, …filters }`.

  | Event | Fires | Filters |
  |---|---|---|
  | `login` | once after Mac login, after a warm-up | — |
  | `pomade-started` | when Pomade is ready (tabs restored) | — |
  | `project-first-open` | the first open of a project since Pomade started | `project` (none = any project) |
  | `project-created` | a project is created in Pomade | — |
  | `session-finished` | an agent session the user ran ends (never Runner's own runs) | `project`, `agent` |
  | `session-status` | a session's status changes to `status` | `status` (required: `active` · `on-hold` · `done` · `done-skip`), `project`, `agent` |
- **`after`** — a chain: `{ job: <id>, result: done | failed | any }` (default `done`). `<id>` is
  the other job's path inside the jobs folder without `.md`: `backup`, `coda-helper/git-pull`. A
  service can also have `after:`, with `action: restart | start | stop` (default `restart`). Chains
  must not loop back (A → B → A), and a service is never followed.

## Policies (script, agent, git)

| Field | Value | Default |
|---|---|---|
| `missed` | scheduled jobs only: `run-on-wake` (once, after the Mac wakes) · `wait-for-me` (asks the user) · `skip` | `run-on-wake` for script and agent, `skip` for git |
| `worth-until` | with `run-on-wake`: a time (`12:00`) after which a catch-up is skipped, or `next-run` | `next-run` |
| `overlap` | the previous run is still going: `skip` · `parallel` · `queue` | `skip` |
| `time-limit` | `45m`, `2h`, `1h30m`; empty = no limit | none |

## Examples

One complete file per kind, plus a chain and a hook. They form one valid jobs folder.

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

## Then

Run `pomade-runner check` (all files) or `pomade-runner check <file>` and fix what it prints. With
Pomade closed it checks everything but project ids, and says so.

A valid, enabled `start: login` service starts within seconds of being written (services start one
at a time). `pomade-runner services` shows every service and where it stands — running,
restarting, failed after a crash loop, stopped by you; `pomade-runner run|stop|restart <service>`
(its id or name) starts, stops or restarts one. Disabling a service in its file or deleting the
file stops it; an edited `command` or `folder` applies on its next restart.
