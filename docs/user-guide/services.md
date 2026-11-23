---
doc: docs/user-guide/services.md
audience: users
holds: services — creating one, when it starts and counts as up, crashes and restarts, Start, Stop and Restart, services that wait for a project, the Services view, the service's terminal tab
kind: reference
---

# Services

A **service** is a command Runner keeps running, like a project's web server: it starts at login,
restarts after a crash and keeps running when Pomade quits. It has no schedule — it is always on.

## Creating a service

**New job** → **Service**. The form's **Trigger** section ("always on") has:

- **Starts** — `At login` (default) or `On first open of a project`, with a project picker beside it
  (the job's own project until you pick another; "Choose a project…" for a workspace service with
  none). Under it: "Then it stays up: restarts after a crash, keeps running when Pomade quits, stays
  stopped when you stop it."
- **Counts as “up” when** — `Alive after 5 s` (default), `A port is open` (a port, 1–65535) or `A URL
  answers` (any HTTP answer counts, an error status or a redirect included). The default shows as a
  line with **Check a port or URL instead**.
- **+ Restart, start or stop it after another job** — a chain on the service
  ([Hooks and chains](hooks-and-chains.md)).

Then **Runs**: **Command** (run by your login shell, with your PATH and keys), **Folder** and
**Project**. A service's **Policies** are Low priority (off by default) and Notify me. The button reads
**Create and start** when the service starts as it is created — an enabled `At login` service, or an
`On first open of a project` one whose project you opened since Pomade started — and it starts within
seconds; otherwise it reads **Create job**.

## How it starts

- A valid, enabled `At login` service runs all the time. Runner starts each one that is not running
  whenever its scheduler starts; at a Mac login that is all of them. A new or re-enabled service file
  starts the same way.
- Services start **one at a time**, in a stable order: workspace jobs first, then each project's, each
  by id. The next one starts when the current one is up, or after 30 seconds — one that is not up by
  then stays `starting` and keeps being checked. Restarts after a crash take their turn the same way.
  Start, Stop and Restart act at once.
- An `On first open of a project` service starts the first time you open that project after Pomade
  starts. Until then it waits — "waiting for first open · starts on first open of job-hunt" — and
  Start runs it now. When that project was already opened since Pomade started, the service starts
  as soon as it exists: created, enabled, or changed to that start or that project. After the next
  Pomade start it waits for the project's open again. Once started it is kept up like any service.
  A service you stopped stays stopped, edited and saved too; one that gave up stays failed.

## Crashes

A service is meant to stay up, so ending at all — a crash, or an exit with status 0 — is a crash. It
starts again after 1 s, 2 s, 5 s, 10 s, 30 s, then 60 s on every further crash. After **5 crashes within
1 minute** it is `failed · gave up`: no more restarts until you press **Start**. A start the keeper
refuses (a folder that does not exist) counts as a crash and its reason shows. "restarted 3× · last
crash 14:02" counts the restarts after a crash; it resets after 10 minutes up, and on Start. If
Runner's keeper itself dies, the service starts again at once and no crash is counted.

## Start, Stop and Restart

- **Start** — starts it now and clears `stopped by you` and `failed` and the crash count.
- **Stop** — stops it (SIGTERM, then SIGKILL after 3 s). It stays stopped until Start. Ctrl+C in its tab,
  or the tab's Stop, does the same.
- **Restart** — stops a running service and starts it again with its job file as it is now; one that
  is not running is started.

They are in the Services view, the service's row in Jobs (**Start service** · **Stop service**), the
panel's Needs you card (**Start**), the `pomade-runner` command
(`run`, `stop`, `restart`), a chain on the service, and the service's tab header (**Restart** while
it runs, **Start** once it ended).

## The Services view

Every service in start order; with none, "Nothing here yet" with **New job**. A row: the name over "project · folder · command", the **Status**, and
the actions: **Restart** and **Stop** while it is up or starting, **Start** otherwise (none while it
is disabled); `Open terminal` once it has run, `Edit` and `Open file`. A toast reports each action's outcome or refusal.

| Status | Under it |
|---|---|
| `running · up 3d 4h` | "no crashes", or "restarted 3× · last crash 14:02" |
| `starting` | what it waits for ("waiting for port 5173") |
| `queued` | "starts when the one before it is up" |
| `restarting` | the crash count, or "again at 14:05" |
| `failed · gave up` | "crashed 5× in 1 min · today 11:20", or why the start failed |
| `stopped by you` | when |
| `waiting for first open` | "starts on first open of job-hunt" |
| `disabled` | — |
| `invalid` | "its file has errors" |

"restart to apply its file" shows when you edited the service's `command` or `folder` while it runs:
it keeps running with what it started with until you restart it. An invalid file never stops or starts
a running service.

An invalid service file is a red row with its first error and **Open file**. The **This project** chip
keeps the open project's services. With no service files the view says what a service is.

## The terminal tab

**Open terminal** — and a click on the service's row in Running now — opens the service's session
as a Pomade terminal tab titled with its name. A service that never ran has no session, so it has no
**Open terminal**. It shows earlier and live output and takes input.
Closing the tab only detaches; the service keeps running. A stopped or failed service's tab keeps its
last output.

## Disabling and deleting

Disabling a service in its file or with the toggle stops it. Deleting its file stops it two seconds
later (an editor that saves by deleting and rewriting stops nothing). [Jobs and the job
form](jobs.md) describes Delete.

## When a service gives up

Needs you shows the service with "Crashed 5× in 1 min — gave up." and **Start** · **View output**, and
you get a notice. Fix the cause (a port clash, a start command that exits at once), then press Start.

A service whose command could not start at all — its folder does not exist — never gets a terminal.
Its card says why ("Gave up — could not start: no such folder: …") and has **Start** only; its name
opens the job in the Jobs view.

Tickets: T-006, T-013.
