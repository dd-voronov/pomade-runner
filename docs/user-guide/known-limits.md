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
  from the agent's next turn.
- **Background work is read from the agent's footer.** The reading that keeps a run waiting for its
  agent's background work counts background shells only. A background sub-agent is not counted: its
  turn looks done, and Runner notices it only when the agent answers the exit command with its
  "Background work is running" question — Runner declines it and waits for the turn's end, and a
  run still stopped at the question after 15 seconds is failed.
- **Runner answers a question form only in Full autonomy, and only with the option the agent
  highlights.** A form with no option highlighted, or at its free-text rows ("Type something.", "Chat
  about this"), waits for you; so does every question in any other mode. Runner never types into a
  screen it does not know, so an agent at a plan approval or a new dialog waits for you in every mode.
- **A Mac login is read from the Mac's login session.** Runner tells a new login by the user's
  `loginwindow` process. When it cannot be read — or on the first start after Runner is installed —
  Runner falls back to the keeper: a start that had to start the keeper is a login, one that found it
  running is none.
- **A pull's commit count needs a Pomade that reports it.** With an older Pomade the run reads plain
  "done", and Open in Git shows only where Pomade supports it.
- **The keeper's loss of the keychain is not explained.** Runner detects a keeper that cannot reach the
  macOS keychain and replaces it before an agent run, but what cuts a keeper off from the keychain is
  not known, so it can happen again. The replacement waits for the runs going to end, because it ends
  them.
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
