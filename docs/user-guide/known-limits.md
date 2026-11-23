---
doc: docs/user-guide/known-limits.md
audience: users
holds: what Runner does not do or does only in part
kind: reference
---

# Known limits

- **Only jobs made in Runner.** A terminal you open by hand, in Pomade or outside it, is just a terminal.
- **Events are not caught up.** `Pomade started`, `First open of a project…`, `Project opened`, `Project
  created`, `Agent session finished` and `Session status changed to…` fire only while Pomade runs and Runner's scheduler
  is connected to it. One that happens while either is not listening is lost. A `Mac login` hook does
  not need Pomade.
- **One Mac per workspace.** Two Macs running the same workspace at once both fire the jobs.
- **Agent jobs need Pomade and the Agents app.** Runner opens a closed Pomade for a run and leaves it
  running; with no Agents app the run fails. Runner restarted mid-run learns an agent's turn is done only
  from the agent's next window title.
- **Weekdays are Mon–Fri.** National holidays are not skipped.
- **No cron syntax.** A schedule is one of the five shapes; a job that runs once per trigger has at most
  one trigger — a schedule, a hook or a chain; with none it is a manual job.
- **Services have no schedule and are never followed.** A chain can act on a service (restart, start,
  stop) but cannot start from one finishing. Missed-run policy, overlap and time limit apply to jobs
  that run once per trigger only.
- **A run you stop fires no chain.** A skipped or missed run fires none either.
- **The switch is the only hold.** Runner does not hold runs while the Mac is on battery or in Do Not
  Disturb.
- **Light theme only,** whatever the system's colour scheme.
- **History days are UTC.** Each day's file is named by the UTC date the runs ended; a schedule's times
  are always the Mac's local time.
- **A session the provider does not number** (Codex) is found by its folder and start time, so it is
  looked up every 5 seconds while the run goes; until it is found, Open session is absent.
- **Job names and ids are bounded.** A git job's name is at most 100 characters; a job's id at most 101
  characters once encoded; an agent prompt at most 16,384 characters.
