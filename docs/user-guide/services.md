---
doc: docs/user-guide/services.md
audience: users
holds: services — creating one, when it starts and counts as up, crashes and restarts, Start, Stop and Restart, services that wait for a project or for Pomade, when Pomade quits, the Services view, the service's terminal tab
kind: reference
---

# Services

A **service** is a command Runner keeps running, like a project's web server: it starts as its **Starts** choice says,
restarts after a crash and stays up for as long as that choice says — past Pomade quitting, or
only while Pomade runs. It has no schedule: while it lives it is always on.

## Creating a service

**New job** → **Service**. The form's **Trigger** section ("always on") has:

- **Starts** — when the service starts and how long it lives:

  | Starts | Starts when | Stops when |
  |---|---|---|
  | `On Mac startup` (default) | the Mac logs in | never — it outlives Pomade |
  | `While Pomade is running` | Pomade starts | Pomade quits |
  | `On first open of a project` | you open its project for the first time since Pomade started — at once if you did already | Pomade quits |

  `On first open of a project` has a project picker beside it (the job's own project until you pick
  another; "Choose a project…" for a workspace service with none). Under the choice a line says what it
  comes to, for example "Starts when Pomade starts and stops when Pomade quits. It restarts after a
  crash; stopped by you, it stays stopped until Start or the next Pomade start." The two that stop with
  Pomade are **Pomade-bound**.
- **Counts as “up” when** — `Alive after 5 s` (default), `A port is open` (a port, 1–65535) or `A URL
  answers` (any HTTP answer counts, an error status or a redirect included). The default shows as a
  line with **Check a port or URL instead**.
- **+ Restart, start or stop it after another job** — a chain on the service
  ([Hooks and chains](hooks-and-chains.md)).

Then **Runs**: **Command** (run by your login shell, with your PATH and keys), **Folder** and
**Project**. A service's **Policies** are Low priority (off by default) and Notify me. The button reads
**Create and start** when the service starts as it is created — an enabled `On Mac startup` or `While
Pomade is running` service (the form is open in a running Pomade), or an `On first open of a project` one
whose project you opened since Pomade started — and it starts within seconds; otherwise it reads
**Create job**.

## How it starts

- A valid, enabled `On Mac startup` service runs all the time. Runner starts each one that is not
  running whenever its scheduler starts; at a Mac login that is all of them. A new or re-enabled service
  file starts the same way.
- A `While Pomade is running` service starts when Pomade starts, and at once when it is made, enabled or
  changed to that start while Pomade runs.
- Services start **one at a time**, in a stable order: workspace jobs first, then each project's, each
  by id. The next one starts when the current one is up, or after 30 seconds — one that is not up by
  then stays `starting` and keeps being checked. Restarts after a crash take their turn the same way.
  Start, Stop and Restart act at once.
- An `On first open of a project` service starts the first time you open that project after Pomade
  starts. Until then it waits — "waiting for first open · starts on first open of blog" — and
  Start runs it now, until Pomade quits. When that project was already opened since Pomade started, the
  service starts as soon as it exists: created, enabled, or changed to that start or that project. Once
  started it is kept up like any service.
- A service you stopped stays stopped, edited and saved too — a Pomade-bound one until **Start** or the
  next Pomade start; one that gave up stays failed.

## When Pomade quits

Pomade has quit when its connection to Runner is gone and no Pomade is found running for about 15
seconds; a Pomade that comes back within that, or the scheduler restarting while Pomade runs, stops
nothing. Then Runner stops every Pomade-bound service and forgets that you stopped it, that it gave up
and how often it crashed: the next Pomade start begins fresh, each service waiting for its own trigger —
a `While Pomade is running` one for Pomade, an `On first open of a project` one for the project's open.
An `On Mac startup` service is not touched; one you stopped stays stopped, over any Pomade restart,
until you press **Start**.

While Pomade is closed a Pomade-bound service shows `waiting for Pomade`. **Start** is refused ("starts
with Pomade; Pomade is not running") — the views offer none, the command is refused, and a chain's start
or restart of it is skipped. A `While Pomade is running` service shows `waiting for Pomade` also between
Pomade launching and being ready.

## Crashes

A service is meant to stay up, so ending at all — a crash, or an exit with status 0 — is a crash. It
starts again after 1 s, 2 s, 5 s, 10 s, 30 s, then 60 s on every further crash. After **5 crashes within
1 minute** it is `failed · gave up`: no more restarts until you press **Start**. A start the keeper
refuses (a folder that does not exist) counts as a crash and its reason shows. "restarted 3× · last
crash 14:02" counts the restarts after a crash; it resets after 10 minutes up, and on Start. If
Runner's keeper itself dies, the service starts again at once and no crash is counted.

## Start, Stop and Restart

- **Start** — starts it now and clears `stopped by you` and `failed` and the crash count. A disabled
  service has no Start, and neither has a Pomade-bound one while Pomade is closed.
- **Stop** — stops it (SIGTERM, then SIGKILL after 3 s). It stays stopped until Start — for a
  Pomade-bound service, until Start or the next Pomade start. Ctrl+C in its tab, or the tab's Stop, does
  the same.
- **Restart** — stops a running service and starts it again with its job file as it is now; one that
  is not running is started.

They are in the Services view, the service's row in Jobs (**Start service** · **Stop service**), the
panel's Needs you card (**Start**), the `pomade-runner` command
(`run`, `stop`, `restart`), a chain on the service, and the service's tab header (**Restart** while
it runs, **Start** once it ended).

## The Services view

Every service in start order; with none, "Nothing here yet" with **New job**. A row: the name over
"project · folder", the **Command** in a column of its own, the **Status**, and the actions:
**Restart** and **Stop** while it is up or starting, **Start** otherwise (none while it is disabled or
waiting for Pomade); `Open terminal` once it has run, `Edit` and `Open file`. A toast reports each
action's outcome or refusal.

The Command column is in the monospace type. A command too long for it ends in "…" and shows whole in a
tooltip on hover and on keyboard focus; one that fits has none.

**Service**, **Command** and **Status** each have a grip on the right edge of their header. Drag one —
or focus it and press Left or Right, Shift for bigger steps — to change that column's width and no
other's; none goes under 120 px. A double click on a grip puts the table back to its default layout.
When the columns together are wider than the tab, the table scrolls sideways, header and rows together.
Runner remembers the widths on this Mac, for the next time the tab opens. In a tab narrower than 800 px
there is no Command column: each command sits under its service's name, and nothing is resized or
scrolled (the widths you set return in a wider tab).

| Status | Under it |
|---|---|
| `running · up 3d 4h` | "no crashes", or "restarted 3× · last crash 14:02" |
| `starting` | what it waits for ("waiting for port 5173") |
| `queued` | "starts when the one before it is up" |
| `restarting` | the crash count, or "again at 14:05" |
| `failed · gave up` | "crashed 5× in 1 min · today 11:20", or why the start failed |
| `stopped by you` | when |
| `waiting for first open` | "starts on first open of blog" |
| `waiting for Pomade` | "starts when Pomade starts", or "starts on first open of blog" |
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

Disabling a service in its file or with the toggle stops it and clears `stopped by you`, `failed` and the
crash count in every mode: enabled again, it follows its trigger — it starts when the trigger already
happened (a Mac login; Pomade running; its project opened since Pomade started), else it waits.
Deleting its file stops it two seconds
later (an editor that saves by deleting and rewriting stops nothing). [Jobs and the job
form](jobs.md) describes Delete.

## When a service gives up

Needs you shows the service with "Crashed 5× in 1 min — gave up." and **Start** · **View output**, and
you get a notice. Fix the cause (a port clash, a start command that exits at once), then press Start.
A Pomade quit ends the item of a Pomade-bound service: the next Pomade start begins fresh.

A service whose command could not start at all — its folder does not exist — never gets a terminal.
Its card says why ("Gave up — could not start: no such folder: …") and has **Start** only, no **View
output**; its name opens the job in the Jobs view.

Tickets: T-006, T-013.
