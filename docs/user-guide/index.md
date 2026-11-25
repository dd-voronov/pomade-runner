---
doc: docs/user-guide/index.md
audience: users
holds: the Runner user guide's map — what Runner is for and a summary of each guide page
kind: reference
---

# Runner user guide

Runner is the Pomade app that runs things without you. It keeps **services** running, and runs
**scripts**, **agents** and **git operations** on schedules, on hooks (something happens in Pomade or
on the Mac) and in chains (one job after another). It keeps going when the Mac sleeps or Pomade is
closed, keeps the Mac responsive while it works, and tells you the result in Pomade's notices and on a
result card. This guide describes how to use it. How it is built is in
[`modules/`](../modules/index.md); the design is in [DESIGN](../DESIGN.md).

- **[Getting started](getting-started.md)** — installing Runner, the side panel (the switch, Needs you,
  Running now, Next up), the Runner tab with its four views, and the scheduler that keeps working when
  Pomade is closed.
- **[Jobs and the job form](jobs.md)** — the four kinds of job, the job file that holds each one (a
  description shown on the job's name included), the Jobs view and its row actions, creating and editing
  a job in the form, Enabled, Open file, Delete, and the policies every job carries.
- **[Schedules](schedules.md)** — the five shapes (Once, Every…, Daily, Weekly, Monthly), the weekdays
  filter, typing a time in words, and the schedule in words with its next three runs.
- **[Hooks and chains](hooks-and-chains.md)** — every event a job can start on and its filters, chains
  that start a job when another finishes, the environment a run gets, and the loop guard with Resume.
- **[Services](services.md)** — commands Runner keeps running: when they start, when they count as up,
  crashes and restarts, Start, Stop and Restart, services that wait for a project to open or for Pomade,
and what happens to them when Pomade quits.
- **[Agent jobs](agent-jobs.md)** — running an agent with a prompt unattended: agent, folder (and its
  picker of connected projects), mode, Full autonomy, the prompt, how a run ends (a turn without an
  answer, an agent's background work), the keeper's keychain check, a run that waits for you (a prompt,
  Claude's consent to Full autonomy, an agent that has not started), Open session, Pomade opened for a run, and what needs the Agents app.
- **[Git jobs](git-jobs.md)** — commit and push, pull, push or fetch on one or more repos, with
  Pomade's safety rails, and how Pomade's Git panel shows them.
- **[Results](results.md)** — History and its filters, the result card for every kind of run (a turn
  without an answer, a run waiting for background work included), a run's output tab, Needs you and
  what each item offers, notices and the badge, Next up and Running now.
- **[Missed runs and load](missed-runs-and-load.md)** — what happens to a run the Mac slept through,
  Wait for me and Run at…, the switch, low priority and the slots, the warm-up, time limits, the
  long-run warning, and the Settings view.
- **[The `pomade-runner` command](command.md)** — checking job files, listing and running jobs, history,
  the switch, services; it works with Pomade closed.
- **[Known limits](known-limits.md)** — what Runner does not do, including how far its reading of an
  agent's background work goes and the keeper's unexplained loss of the keychain.

Runner has no keyboard shortcuts of its own; Pomade's are in
[Pomade's keyboard shortcuts](../../../Pomade/docs/user-guide/keyboard-shortcuts.md).
