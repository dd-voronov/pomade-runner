---
doc: docs/user-guide/results.md
audience: users
holds: History and its filters, the result card, a run's output tab, Needs you and its items, notices and the badge, Next up and Running now
kind: reference
---

# Results

Every run that ends — or never starts — is recorded and reaches you in one or more of: **History**, a
**result card**, a **notice**, a **Needs you** item.

## History

The **History** view lists the runs going and every record, newest first by when each started — a run
that has not, by when it was due — under day heads ("Today", "Yesterday", "Sun 15 Nov"). A row shows
the **Time**, the kind icon, the **Job**, the **Result**, the **Duration** and the **Trigger**
(`scheduled` · `caught up` · `missed 4 runs, 17:40–17:46 · caught up once` · `manual` · `hook: Mac
login` · `chain: after Pull`). Time queued does not
count toward a duration; time waiting for you does. Click a row, or press Enter or Space on it, to
open its result card.

With no run yet, History shows "Nothing here yet" with **New job**.

Chips filter the list: `All` · `Active` (running, waiting for you, queued) · `Failed` · `Skipped &
missed`, each but All with its count. A run you stopped shows under All only. `This project` keeps the
open project's runs. The summary says "kept 30 days": History keeps as many days as the settings say
([Missed runs and load](missed-runs-and-load.md)). It loads 100 records at a time and the next older
page when you scroll to the end; while older pages remain a count is of the runs loaded and says so
("3+").

Result wording: `done` · `failed · exit 1` · `stopped: time limit, 45 min` · `stopped by you` ·
`skipped · previous run still going` · `missed · skipped · past 12:00` · `missed 4 runs, 17:40–17:46 ·
skipped` · `queued · 1 ahead` · `running · 3h — still expected?` · `waiting for you`. A run that
stands for more than one missed run says how many ([Missed runs and load](missed-runs-and-load.md)). Each explains itself on hover. A chain's action on a
service is a record too: `done · restarted`.

## The result card

Click a run anywhere — History, a Jobs cell, a notice, a Needs-you card — to open its card, a dialog.
The head has the kind icon, the job's name, the result as a pill (`Done` · `Failed` · `Stopped: time
limit` · `Waiting for you` · `Queued` · `Missed · waiting for you` · `Skipped` · `Missed · skipped` ·
`Stopped by you`), then when it ran or was due, how long, what started it (with its help), an agent
run's agent and mode ("claude · Normal"), and a why line: a hook's event, a caught-up run's missed
time ("Missed 4 runs, 17:40–17:46 — caught up once" when it stands for more than one), or a chain's
"After Pull: done" whose name opens the parent run. A failed run's head is red, a
waiting run's amber. **Edit job** ends every card.

| Run | The card shows | Buttons |
|---|---|---|
| Script, ended | **Exit code** (red when failed), or the reason — a time limit as "Stopped: Time limit, 45 min — the job’s time limit" — and the **Last lines** | `View output` · `Run again` |
| Git, ended | each repo with its commit hash and steps | `View output` · `Run again` |
| Agent, ended | a failed run's reason; the agent's **Last message** | `Open session` · `View output` · `Run again` |
| Running | **Latest output**, followed while it runs | `Open terminal` · `Stop run` |
| Agent, waiting for you | what it waits at and **Waiting at**: the end of its output | `Open at the prompt` · `Stop run` |
| Queued | what it waits for, in a sentence | `Run now` |
| Missed, waiting for you | when it was due and that its policy is "Wait for me" | `Run now` · `Run at…` · `Skip` |
| Skipped or missed; a chain's action on a service | why it never started, or what the chain did | `Run now` |

`Stop run` and a missed run's choices close the card and toast the outcome; `Run again` toasts
"<job> started · trigger “manual”" (or "queued"). A run no longer in History opens a card that says so.

Opening the card of a failed run clears that run's Needs-you item.

## A run's output tab

`View output` opens the run's output in a Pomade tab of its own, "<job> · output", beside the Runner
tab — one per run; pressing it again focuses the tab. Its head names the job and says "Captured log ·
<when> · read-only" (plus "· still running" while it goes); **Copy** puts the log on the clipboard ("Copied
the log"). The log is plain text, followed while the run runs; a log longer than 1 MiB shows its end
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
| missed run waits | "Missed — it waits for you to pick a time."; "Missed 4 runs, 17:40–17:46 — …" when it stands for more than one | `Run now` · `Run at…` · `Skip` |
| agent run waits | "Waiting for approval at a permission prompt." / "Waiting for you to trust its folder." | `Open at the prompt` |
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
`Needs you` item notices once, when it appears.

While Pomade runs, notices appear in Pomade and the Runner icon carries a red badge with the Needs-you
count. While Pomade is closed, notices wait in Pomade's queue and show at your next launch; Needs-you
items also post a native macOS notification, whose click opens Pomade at the item (Settings shows the
permission). A notification for a run waiting at a prompt opens its terminal tab at the prompt.

## Next up and Running now

**Next up** lists the next five runs of enabled scheduled jobs, soonest first — a job as many times as
it comes among them — as "in 40 min" within the hour, then the time ("13:00", "tmrw 7:00", "Thu 7:00");
hover for the full moment. A `Run at…` run is in it; a manual job never is. A run the switch holds shows its name faint with a
`held` tag.

**Running now** lists the services that are up or starting, in start order, then the runs going. A row:
a status dot, the name and where it stands ("up 3d 4h", "starting", "running 3m", "queued · 1 ahead",
amber "waiting for you · 17m"), the project · folder below ("workspace · git-base" for the root), and a
third line only for news ("waiting for port 5173", "restarted 3× · last crash 14:02", "restart to apply
its file"). A queued run says what it waits for: "queued · at Wed 23:00", "queued · held · Pause all",
"queued · warm-up until 08:32", "queued · after the previous run", "queued · opening Pomade".

Tickets: T-008, T-012, T-016.
