---
doc: docs/user-guide/missed-runs-and-load.md
audience: users
holds: missed runs and their policies, Wait for me and Run at…, overlap, the switch, low priority and the slots, the warm-up, time limits, the long-run warning, the Settings view
kind: reference
---

# Missed runs and load

Runner keeps the Mac responsive while it works, and decides what becomes of a run that came due while
nothing could start it.

## A missed run

A scheduled run is **missed** when it did not start on time: the Mac slept or was off, the clock jumped,
or the switch held it. A run at most 5 minutes late still runs, at once — unless the switch held it.
However many runs a job missed, it gets **one** decision, about the latest missed time, by its **If a
run is missed** policy:

| Policy | What happens |
|---|---|
| `Run on wake` | one caught-up run (trigger `caught up`), once, while it is still worth it. Default for script and agent |
| `Wait for me` | the run waits in Needs you; it never starts on its own |
| `Skip` | recorded as `missed · skipped` and moved on. Default for git |

With `Run on wake`, **Still worth it until** is `the next scheduled run` (default) or `a time of day`
(`12:00`: the first 12:00 after the missed time). Past it the run is `missed · skipped · past 12:00` (or
`· past its next run`). An on-time run of the job in the same look covers the catch-up: `missed ·
skipped · the 09:00 run covers it`. A `Once` schedule has no next run, so its catch-up is always worth
it. Hook and chain jobs have no missed-run policy: a run the switch held runs late.

Runner counts the runs a job missed, and the run or record of its decision says how many and when:
`missed 4 runs, 17:40–17:46 · caught up once` (the caught-up run's trigger), `missed 4 runs,
17:40–17:46 · skipped`, `missed 4 runs, 17:40–17:46 · waiting for you` — `Sun 23:00–Mon 07:00` when the
runs span days. A single missed run reads as `caught up`, `missed · skipped`, `missed · waiting for
you`. History, the result card, Needs you, the notice and `pomade-runner history` say the same.

No policy runs every missed run by itself; **Run all** does, when you ask (below).

### Wait for me

The missed run is a Needs-you item, "Tidy drafts · missed Sun 3:00", and a notice; one per job (a later
miss moves it to the later time and adds to its count: "missed 4 runs, …"). Its card offers:

- **Run now** — runs it now as a run of yours (trigger `manual`). When it stands for more than one
  missed run the button reads **Run once**: one run, and the card is gone.
- **Run all N** — only when it stands for more than one: runs the job N times, one after another.
  See **Run all** below.
- **Run at…** — waits, queued, until the time you type, and shows in Next up. Type a time (`23:00`: the
  next one), a day and a time (`tomorrow 9:00`, `2026-11-20 23:00`), or elapsed time (`+2h`). A time that
  has passed, or a day without a time, is refused with the reason. It survives a restart of Runner.
- **Skip** — `missed · skipped by you`.

A job disabled, invalid or deleted while its run waits settles as `missed · skipped · its job is
disabled` (or why else).

### Run all

**Run all N** on a missed run that waits for you, or **Run the other N** on the result card of a
caught-up run that stood for more than one (`missed 4 runs, … · caught up once`: the other 3), runs every
missed run:

- The runs go **one after another**, never two at once, whatever the job's overlap. Only the next one is
  in the queue at a time, and it waits like any run — for the switch, the warm-up after login or wake, a
  low-priority slot.
- Each is a History row, trigger `caught up 2 of 4`; its card's line says which missed runs it is part of
  ("Missed 4 runs, 17:40–17:46 — caught up 2 of 4").
- A run that fails does not stop the rest. **Stopping one by hand drops the rest**, with one skipped row
  that says so: `skipped · 2 dropped: you stopped run 2 of 4`. So does a run that cannot start — its job
  disabled, invalid or deleted meanwhile (`2 dropped: run 2 of 4 did not start`).
- More than 20 runs ask once more, naming the number; **Cancel** runs nothing.
- The switch holds the next run like any other; back to **Running**, the rest go on. Runner restarted —
  or the Mac off — in the middle, the rest go on when it is back.
- **Run the other N** shows while that caught-up run is the job's latest run and no Run all of the job is
  going.
- From the command line: `pomade-runner missed <job> run-all`.

## If still running

**If still running** says what happens when the previous run of a job is still going at the next start:
`Skip` (default) records `skipped · previous run still going`; `Run in parallel` starts it anyway;
`Queue after` holds one run that starts when the job has none running, and a further one is `skipped · a
run is already queued`.

## Low priority and the slots

A **Low priority** run goes at macOS background priority: slower, never in your way. At most
**2 low-priority runs go at once** (Settings); the rest wait as `queued · N ahead` — three due at once:
two run, one is "queued · 1 ahead". Low priority is on for script and agent jobs, off for git jobs and
services; a job with it off neither takes nor waits for a slot. A missed run waiting for you takes none,
and an agent run waiting for you at a prompt gives its slot back. **Run now** is never held by the switch
but may wait for a slot.

A queued run waits for the first of: its time (Run at…), the switch, the warm-up, the job's previous run,
Pomade (an agent run — [Agent jobs](agent-jobs.md)), a slot.

## The warm-up

After a Mac login or a wake, services start first, one by one. Once none is waiting or starting, the
**warm-up** pause begins (2 minutes by default); then caught-up runs and hook runs — the login hooks
among them — go through the queue. Chain runs never wait for it. A run due on time during the warm-up
runs on time. A wake during a warm-up starts it over. A Runner restart with its keeper alive begins no
warm-up. A wake is any gap of more than a minute between two ticks of the scheduler.

## The switch

`Running` · `Pause low-priority` · `Pause all` ([Getting started](getting-started.md)). While held, a
job's schedule stays where the switch caught it, and nothing is decided for it: no record, no Needs-you
item. Its **Next run** in Jobs carries the amber `held` tag, as Next up does, and the note under the
switch counts the runs held so far: "Low-priority jobs are held · 4 runs so far". On release every
run the switch held is missed — the latest too, however recent — and the job gets one decision by its
policy, counted: "missed 3 runs, 17:40–17:44 · caught up once". A queued run the switch held that is
more than 5 minutes late, or a caught-up one, follows the policy too. A release is no wake: no
warm-up. Set it from the panel or with `pomade-runner pause [low|all]` and `resume`.

## Time limits

**Time limit** stops a run that takes longer: `45m`, `2h`, `1h30m`; empty for none. Runner stops it
(SIGTERM, then SIGKILL after 3 s), it is **failed**, and it reads **stopped: time limit, 45 min** in
History, on its card, in its notice and in `pomade-runner history`. The job file as it is now sets
the limit. An agent run's time waiting for you is left out of the count.

## The long-run warning

A run going longer than the **long-run warning** (3 hours by default) becomes a Needs-you item, "Wiki
lint has been running 3 h — still expected?", with `Open` · `Stop` · `Dismiss`, noticed once. It never
stops a run.

## Settings

**Settings** in the Runner tab edits the workspace settings in
`<workspace>/Apps/pomade-runner/settings.yaml`. Each number has a stepper (− number +, its unit beside
it); a change applies at once and is written when the steps stop. The skills folder is a text field:
a change is written when you leave the field or press Enter, Esc puts the saved value back, and empty
means the default.

| Card | Row | Range | Default |
|---|---|---|---|
| Load | **Low-priority runs at once** | 1–16 runs | 2 |
| Load | **Warm-up after login or wake** | 0–60 min | 2 min |
| Load | **Long-run warning** | steps by hour: 1–24 hours | 3 hours |
| History | **Keep history and output** | 1–365 days | 30 |
| Notifications | **macOS notifications while Pomade is closed** | read-only: `Allowed` · `Blocked` · `Not asked yet` · `Not available yet` | — |
| Agents | **Skills folder** | a folder inside the workspace, relative to its root; changing it moves Runner's skill there | `Knowledge/_skills/apps/` |
| Agents | **Job skill for agents** | read-only: `In place` · `Not written`, with where the skill's file is and **Show in Files**; Runner gives it to no agent — which agents get it is your choice | — |
| Files | **Workspace settings** · **Job files** | **Open file** (once the file exists) · **Show in Files** | — |

A missing file, a field left out or an empty one means the default. A problem in the file is listed
at the top of the view ("Line 3: …"); a field with a problem counts as its default until fixed. The
file can also be edited by hand; a change applies within a second.

Tickets: T-009, T-012.
