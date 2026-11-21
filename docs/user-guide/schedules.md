---
doc: docs/user-guide/schedules.md
audience: users
holds: the schedule shapes of the job form, the weekdays filter, typing a time in words, how a schedule fires, the schedule in the job file
kind: reference
---

# Schedules

A script, agent or git job runs on a schedule when its **Trigger** is `On a schedule`. A schedule
fires at times you pick, on the Mac's local clock, following its time zone and daylight saving. There
is no cron syntax; every schedule is shown in words ("weekdays at 7:00").

## The editor

In the job form's **Trigger** section, **Repeats** picks the shape:

| Shape | Controls | Example |
|---|---|---|
| `Once` | a **Date** of the coming week and a **Time**, or **Or say it in words** | once, tomorrow at 7:00 |
| `Every…` | **Every** N `minutes` or `hours`; `Only between` two times (**From**, **To**) | every 30 min, 9:00–21:00 |
| `Daily` | **At** one or more times; **Add time** adds one | 13:00 and 20:00 |
| `Weekly` | **On** the days of the week you tick, and **At** one or more times | Mon–Fri 7:00 |
| `Monthly` | **On day**: days 1–31 and `last`; **Or on a weekday of the month**: "the [first] [Monday]"; **At** | the 1st and 15th · the last day · the first Monday |

**Days** — `Every day` · `Weekdays only` · `Weekends only` — applies to `Every…` and `Daily`. Weekdays
are Mon–Fri, weekends Sat–Sun; national holidays are not skipped. Two monthly days cover "every other
week".

**Or say it in words** (Once) reads a phrase and fills in the date and time: `tonight 23:00`,
`tomorrow 7:00`, `+2h`. A phrase it cannot read says: "Can't read that — try “tonight 23:00”,
“tomorrow 7:00” or “+2h”."

Under the editor the form shows the schedule in words and its **next three runs**, live, from what the
form would write. While the checker finds a problem it says "Fix the schedule to see it in words". A
`once` on today's or tomorrow's date reads "once, today at 23:00" / "once, tomorrow at 7:00". Each
schedule error lands on its control and shows under it.

A schedule you leave alone is never rewritten; parts of a hand-written schedule the editor has no
control for (`monthly.months`, `start`, `end`) are kept.

## How a schedule fires

Every second the scheduler looks at the occurrences since its previous look. The latest runs if it is
at most 5 minutes old; every other one is **missed** — the Mac slept through it, was off, the clock
jumped past it, or the switch held it — and goes to the job's missed-run policy
([Missed runs and load](missed-runs-and-load.md)). A `Once` job runs once, then shows **finished**
under Next run. A schedule never fires for time before Runner's first start.

## In the job file

```yaml
schedule:
  once: 2026-11-20 23:00
schedule:
  every: { minutes: 30, from: 9:00, to: 19:00 }   # or { hours: 2 }
  only: weekdays                                   # or weekends; with every and daily
schedule:
  daily: { at: [13:00, 20:00] }
schedule:
  weekly: { days: [mon, tue, wed, thu, fri], at: 7:00 }
schedule:
  monthly: { days: [1, 15, last, first mon], at: 9:00 }
```

One shape per job. Times are `H:MM`, 24-hour. Optional `start` and `end` dates (`YYYY-MM-DD`) bound a
schedule. `always` is refused: a service is always on by itself.

Tickets: T-007, T-010.
