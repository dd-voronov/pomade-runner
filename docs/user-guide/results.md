---
doc: docs/user-guide/results.md
audience: users
holds: History and its filters, service events, the result card (a turn without an answer, background work, Runner's answers, Open in Git), a run's output tab, Needs you and its items, notices and the badge, Next up and Running now
kind: reference
---

# Results

Every run that ends — or never starts — is recorded and reaches you in one or more of: **History**, a
**result card**, a **notice**, a **Needs you** item. A service's starts, stops and restarts are recorded
in History too.

## History

The **History** view lists the runs going and every record, newest first by when each started — a run
that has not, by when it was due — under day heads ("Today", "Yesterday", "Sun 15 Nov"). A row shows
the **Time**, the kind icon, the **Job**, the **Result**, the **Duration** and the **Trigger**
(`scheduled` · `caught up` · `missed 4 runs, 17:40–17:46 · caught up once` · `caught up 2 of 4` (a run of
a Run all) · `manual` · `hook: Mac
login` · `chain: after Pull`). Time queued does not
count toward a duration; time waiting for you does. A run going shows how long so far, counted each
second for the first minute and then every 10 seconds ("23s", "3m"); Running now and the run's
result card show the same time at the same moment. Click a row, or press Enter or Space on it, to
open its result card.

**Service events.** Every start, stop, restart and give-up of a service is a row of its own, with no
duration and its cause as the Trigger: `Mac startup` · `Runner started` · `first open` · `Pomade started` · `Pomade quit` ·
`you` (Start, Stop or Restart, or Ctrl+C in its tab) · `chain` · `crash` · `keeper` (the keeper that held
its session ended) · `job file` (the file was made, turned on or off, deleted, or its project moved). The
Result reads `started` · `stopped` · `restarted` · `restarted 4× · exit 1, 137` (after a crash, in plain
words with an amber dot; one row for a whole crash window, which grows as the restarts add up) ·
`gave up after 5 crashes` (red); a chain's action that had nothing to do or was refused reads
`restart skipped · <why>` or `start failed · <why>`. The **Service events** chip after `This project`
is on by default; turn it off to see runs only. The tab keeps the chip as you set it while you visit
other views. Runs are never hidden. Click an event row, or press
Enter or Space on it, for its card.

While the switch holds a job, History has a row for it: the job's name, `held · 2 runs so far,
17:40–17:42` in amber as its result, `scheduled` as its trigger and no duration, counting up as runs
come due. Click it to open the job in Jobs. It is not a run: it has no card. When the switch is
released the row becomes the record of the miss (`missed 2 runs, 17:40–17:42 · caught up once`,
`· skipped`, or the waiting run's row), and a Run all or Run the other N shows its runs as
`caught up 2 of 3`. A held row makes no Needs-you item and no notice.

Every column with text can be resized: **Job**, **Result**, **Duration** and **Trigger** each have a
grip on the right edge of their header (the time and the kind icon have none). Drag one, or focus it
and press Left or Right (Shift for bigger steps), to change that column's width and no other's; a
double click puts the table back to its default layout. The table scrolls in its own area under the filter
chips: the column header stays at the top, and under it the head of the day being read, while the
runs scroll beneath; the sideways scrollbar is at the bottom of the tab. When the columns are wider than the tab, the
table scrolls sideways with its header and rows, the day heads keeping their titles at the left. A
Job, Result or Trigger too long for its column ends in "…" and shows whole in a tooltip. Runner
remembers the widths on this Mac.

With no run yet, History shows "Nothing here yet" with **New job**.

Chips filter the list: `All` · `Active` (running, waiting for you, queued) · `Failed` (a service that
gave up too) · `Skipped & missed`, each but All with its count; held rows count under `Skipped &
missed`, a chain's skipped action on a service too, and every count follows the Service events chip. The "N runs so far"
under the switch in the side panel is a link that opens History with `Skipped & missed` on. A run you
stopped shows under All only. `This project` keeps the
open project's runs. The summary says "kept 30 days": History keeps as many days as the settings say
([Missed runs and load](missed-runs-and-load.md)). It loads 100 records at a time and the next older
page when you scroll to the end; while older pages remain a count is of the runs loaded and says so
("3+").

Result wording: `done` · `failed · exit 1` · `stopped: time limit, 45 min` · `stopped by you` ·
`skipped · previous run still going` · `missed · skipped · past 12:00` · `missed 4 runs, 17:40–17:46 ·
skipped` · `done · a1b2c3d · 2 commits pulled` · `queued · 1 ahead` · `running · 3h — still expected?` · `running · waiting for the agent's
background work` · `waiting for you`. A done git run says its commit and what its pulls got — `done · 2
commits pulled`, `done · 1 commit pulled`, `done · up to date` — when Pomade reports the count; with no
pull, or no count, it says `done` (and its commit). A run that
stands for more than one missed run says how many ([Missed runs and load](missed-runs-and-load.md)). Each explains itself on hover.

## The result card

Click a run anywhere — History, a Jobs cell, a notice, a Needs-you card — to open its card, a dialog.
The head has the kind icon, the job's name, the result as a pill (`Done` · `Failed` · `Stopped: time
limit` · `Waiting for you` · `Queued` · `Missed · waiting for you` · `Skipped` · `Missed · skipped` ·
`Stopped by you`; a service event's: `Started` · `Stopped` · `Restarted` · `Restarted after a crash` ·
`Gave up`), then when it ran or was due, how long, what started it (with its help), an agent
run's agent and mode ("claude · Normal"), and a why line: a hook's event, a caught-up run's missed
time ("Missed 4 runs, 17:40–17:46 — caught up once" when it stands for more than one), or a chain's
"After Pull: done" whose name opens the parent run. A failed run's head is red, a
waiting run's amber. **Edit job** ends every card.

| Run | The card shows | Buttons |
|---|---|---|
| Script, ended | **Exit code** (red when failed), or the reason — a time limit as "Stopped: Time limit, 45 min — the job’s time limit" — and the **Last lines** | `View output` · `Run again`; a caught-up run that stood for more than one, while it is its job's latest, adds `Run the other 3` |
| Git, ended | each repo with its commit hash and steps; a failed repo's line ends with `Open in Git` | `View output` · `Run again` |
| Agent, ended | a failed run's reason; the agent's **Last message**. A run whose turn ended without an answer ("The agent's turn ended without an answer") shows **Last lines**, the agent's screen, in place of a message. A run whose agent never started a session says "The agent never started a session." In Full autonomy, a line "Runner answered: <option>" for each question form Runner answered itself | `Open session` (not for a run that never started a session) · `View output` · `Run again` |
| Running | **Latest output**, followed while it runs. An agent run waiting for its agent's background work says first: "The agent’s turn is over, but work it started in the background still goes. Runner waits for that work: the agent goes on once it ends, and the run is done when the agent is. The time limit keeps counting." Under it, "Runner answered: <option>" for each question form Runner answered in Full autonomy | `Open terminal` · `Stop run` |
| Agent, waiting for you | what it waits at — a permission prompt, the folder's trust, its question ("The agent asks you a question and waits for you to pick an option."), Claude's consent to Full autonomy for its agent profile, a screen Runner does not know — and **Waiting at**: the end of its output | `Open at the prompt` · `Stop run` |
| Queued | what it waits for, in a sentence | `Run now` |
| Missed, waiting for you | when it was due — "This job missed 4 runs, 17:40–17:46." for more than one — and that its policy is "Wait for me" | `Run now` · `Run at…` · `Skip`; for more than one `Run once` · `Run all 4` · `Run at…` · `Skip` |
| Skipped or missed | why it never started | `Run now` |
| Service event | **Cause** in a sentence, the **Exit code** of a crash, and the **Session**: "still going · up 3h 48m" while the session it started runs, else "ended 11:20 — it crashed" and how it ended; no duration, no output | `Open terminal` while that session runs; for a service that gave up and does not run, `Start` |

`Run all` and `Run the other N` ask once more above 20 runs, naming the number
([Missed runs and load](missed-runs-and-load.md) "Run all"). `Stop run` and a missed run's choices close the card and toast the outcome; `Run again` toasts
"<job> started · trigger “manual”" (or "queued"). A run no longer in History opens a card that says so.

A card's **Last lines** and **Latest output** show the same colours and bold; the notices, the
`Waiting at` lines and `pomade-runner history` show the text alone.

**Open in Git** takes you to the failed repo in Pomade's Git panel, where a conflict is resolved: in the
job's own project when its folder holds the repo, else in the first project that holds it, else in the
Workspace. The button shows only when this Pomade offers it. If Pomade no longer has the repo or the
project, a toast says "Could not open notes in Git: Pomade has no such repo or project now".

Opening the card of a failed run clears that run's Needs-you item.

## A run's output tab

`View output` opens the run's output in a Pomade tab of its own, "<job> · output", beside the Runner
tab — one per run; pressing it again focuses the tab. Its head names the job and says "Captured log ·
<when> · read-only" (plus "· still running" while it goes); **Copy** puts the log on the clipboard as plain text ("Copied
the log"). The log is shown in the colours and bold the program printed — a failing test in red, a heading in bold — followed while the run runs; a log longer than 1 MiB shows its end
under "… only the end of a longer log is shown". It reads "(no output)" for none, and "This run's
output is not on this Mac." when the record came with the workspace from another Mac — the record's last
lines still show on the card. A restored tab whose run has left History closes itself. A git run's log
holds what `pomade-git` wrote to standard error — nothing, when all went well.

Output logs live in the workspace, in `Apps/pomade-runner/records/output/`, and are kept as long as
History. A running service's output stays in its terminal tab.

## Needs you

The panel's **Needs you** lists what waits for you. A card has a status dot (red: failed run, service
gave up; amber: missed run, run waiting for you, paused job; accent: long run), the job's name — a link
to what the card is about — the time, one line of text and the actions. Every item notifies you.

| Item | Text | Actions |
|---|---|---|
| failed run | "Failed: exit 1 · 2×" (the count when more than one since the item came) | `Open` · `Run now` · `Dismiss` |
| service gave up | "Crashed 5× in 1 min — gave up."; "Gave up — could not start: <why>" when it never got a terminal | `Start` · `View output` (not without a terminal) |
| missed run waits | "Missed — it waits for you to pick a time."; "Missed 4 runs, 17:40–17:46 — …" when it stands for more than one | `Run now` · `Run at…` · `Skip`; for more than one `Run once` · `Run all 4` · `Run at…` · `Skip` (four buttons wrap to a second row) |
| agent run waits | "Waiting for approval at a permission prompt." / "Waiting for you to trust its folder." / "Waiting for your answer to its question." (in Full autonomy Runner answers the form itself, so no item — unless the form highlights no option) / "Waiting for you to accept Full autonomy for its agent profile." (Claude's consent, asked once per agent profile; Runner never answers it) / "Waiting at a screen Runner does not know." (an agent that worked; Runner never types into it) / "Has not started — look at its terminal." (an agent still not working 20 s into its run) | `Open at the prompt` |
| long run | "Running 3h — still expected?" | `Open` · `Stop` · `Dismiss` |
| job paused by the loop guard | "Paused: triggered 10× in 10 min." | `Resume` · `Edit job` |

- A failed run is its job's item, one per job. It goes when you open the run's card, press `Dismiss`, or
  the job's next run is done, or the job's file is gone. A job with Notify me `Never` makes none.
- A service that gave up stays while it is failed; `Start`, a fixed or disabled file, or removing it
  ends it.
- `Run at…` opens a field below the buttons, filled with "tonight 23:00": it shows what the text comes to
  ("→ today 23:00") or "Try: tonight 23:00 · tomorrow 7:00 · +2h". `Set` or Enter sends it; Esc closes it.
- A long-run item is a reminder: `Dismiss` says "OK — it keeps running. No more reminders for this run."
- Every outcome is a toast ("<job> started", "<job> will run today 23:00", "<job> stopped by you", "<job>
  resumed"); a refusal is "Could not <do it> <job>: <why>".

## Notices and the badge

**Notify me** is per job: `Always` notices every run that started, `On failure` a failed one, `Never`
none. A skipped or missed run never notices, except a Wait for me job's missed run. A notice names the
job and the result ("Backup failed", "exit 3 · <its last line>"); its click opens the run's card. A
`Needs you` item notices once, when it appears ("<job> asks you a question", "<job> needs your consent", "<job> waits at a screen
Runner does not know").

While Pomade runs, notices appear in Pomade and the Runner icon carries a red badge with the Needs-you
count. While Pomade is closed, notices wait in Pomade's queue and show at your next launch; Needs-you
items also post a native macOS notification, whose click opens Pomade at the item (Settings shows the
permission). A notification for a run waiting at a prompt opens its terminal tab at the prompt.

## Next up and Running now

**Next up** lists the next five runs of enabled scheduled jobs, soonest first — a job as many times as
it comes among them — as a countdown within the hour, then the time ("13:00", "tmrw 7:00", "Thu 7:00");
hover for the full moment. The countdown counts whole minutes as a clock reader does ("in 40 min", "in 2
min" until the minute turns) and seconds under a minute ("in 56 s"), then reads "now" until the run
starts; the Jobs view's Next run shows the same words. A `Run at…` run is in it; a manual job never is. A run the switch holds shows its name faint with a
`held` tag.

**Running now** lists the services that are up or starting, in start order, then the runs going. A row:
a status dot, the name and where it stands ("up 3d 4h", "starting", "running 3m", "queued · 1 ahead",
amber "waiting for you · 17m"), the project · folder below ("workspace · my-workspace" for the root), and a
third line only for news ("waiting for port 5173", "restarted 3× · last crash 14:02", "restart to apply
its file", "waiting for the agent's background work" on a run whose agent's background work goes). A queued run says what it waits for: "queued · at Wed 23:00", "queued · held · Pause all",
"queued · warm-up until 08:32", "queued · after the previous run", "queued · opening Pomade", "queued · a fresh keeper, after the runs going" (an agent run, while Runner replaces a keeper that lost the macOS keychain).

Tickets: T-008, T-012, T-016, T-037, T-038, T-040, T-044, T-045, T-047, T-050, T-051.
