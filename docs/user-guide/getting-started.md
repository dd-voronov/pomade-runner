---
doc: docs/user-guide/getting-started.md
audience: users
holds: installing Runner, the side panel, the Runner tab and its views, the switch, the scheduler that runs with Pomade closed
kind: reference
---

# Getting started

## What runs where

Runner has three parts. The **side panel** and the **Runner tab** are what you see in Pomade. The
**scheduler** is Runner's always-on background part: a login item that keeps running when Pomade
quits. It reads your job files, fires schedules, hooks and chains, runs the jobs and keeps the
history. With Pomade closed, services that start on Mac startup, scripts and git jobs still run (a
service that runs only while Pomade does stops with it, [Services](services.md)); an agent job needs Pomade, so
Runner opens it for the run ([Agent jobs](agent-jobs.md)).

Every run and every service is a terminal session held by Runner's own keeper. Closing a tab only
detaches from it; the process keeps running.

## Install

In Runner's repository, run `./install`. It builds Runner and installs it into the dev Pomade; Runner's
scheduler then keeps a copy of its job skill in your workspace's skills folder (`Knowledge/_skills/apps/`
unless you change it in Settings), so an agent can write jobs for you once you give it the skill.
Runner gives the skill to no agent: link or copy it into the skills of the agents you choose, by hand or
in the Agents app. `./install` is also the update step. `./install --stable` installs into the stable
Pomade. `./uninstall` removes the app and the skill copy.

Runner finds your workspace through Pomade. With no workspace recorded the scheduler waits and writes
nothing; open Pomade once.

## The side panel

The **Runner** icon on Pomade's left strip opens the panel. Top to bottom:

- **The switch** — `Running` · `Pause low-priority` · `Pause all`. In a panel narrower than 268 px the
  middle one reads `Pause low`. A pause says what it holds under the control: "Low-priority jobs are
  held. Services keep running." / "Every scheduled job is held. Services keep running." — with how
  many runs it has held so far once it has held one: "Low-priority jobs are held · 4 runs so far.
  Services keep running." See
  [Missed runs and load](missed-runs-and-load.md).
- **Needs you** — what waits for you, a card per item with its actions inline. It shows "Nothing needs
  you." when empty and a red count while anything waits. See [Results](results.md).
- **Running now** — services that are up or starting, then the runs going. A service's row opens its
  terminal tab, a running run's row its terminal, a queued run's row its result card.
- **Next up** — the next five runs, soonest first, as a countdown within the hour ("in 56 s", "in 2
  min", "in 40 min") and a time after it. A run the switch holds carries a `held` tag. A row opens the
  job in the Jobs view.
- **Open Runner** — opens the Runner tab.

With no jobs yet the panel shows "No jobs yet" and a **New job** button.

If the scheduler is not running, the panel says "Runner's scheduler is not running". Pomade starts it as
Runner's background part.

## The Runner tab

Four views, in the tab's header, with a count beside Jobs and Services: **Jobs · History · Services ·
Settings**. **New job** is at the right end of the header.

- **Jobs** — every job file, grouped by project. [Jobs and the job form](jobs.md).
- **History** — every run, newest first, with the runs going on top. [Results](results.md).
- **Services** — the services and where each stands. [Services](services.md).
- **Settings** — the workspace settings (four numbers and the skills folder), the Mac's notification
  permission and where the agent skill is.
  [Missed runs and load](missed-runs-and-load.md).

The **This project** chip in Jobs, History and Services keeps only the project Pomade has open; in Jobs
and Services it is one setting. With it on, **New job** starts in that project. Runner's version is at
the foot of Settings.

A run's result card and a run's output open over or beside the tab; the tab remembers its view, so a
reload comes back to it.

## The switch

The switch is yours: Runner never moves it. `Pause low-priority` holds the runs of low-priority jobs;
`Pause all` holds every scheduled run, hook and chain. Run now always runs, and services keep running
in every position. The Jobs view tags a held job's Next run `held`. A held run follows its job's
missed-run policy when you switch back — once per job, however many it held. The position
survives a restart of Runner and of the Mac.

## Keys

Runner has no shortcuts of its own. In Runner's controls: Esc closes a dialog, a menu and a
tooltip; arrow keys, Home and End move in a menu; the arrow keys step a Settings number; Enter or
Space opens a History row.

Tickets: T-002, T-006, T-008, T-009, T-012.
