---
doc: docs/user-guide/hooks-and-chains.md
audience: users
holds: every hook event and its filters, chains, the environment a run gets, the loop guard and Resume
kind: reference
---

# Hooks and chains

A job starts on a **schedule**, a **hook** or a **chain**. A hook fires when something happens in
Pomade or on the Mac; a chain fires when another job finishes. In the job form's **Trigger** section,
choose `When something happens`, then pick from the **Event** list.

## Events

| Event (the list's label) | Fires | Filters in the form |
|---|---|---|
| `Mac login` | once after you log in to the Mac, after the warm-up | none |
| `Pomade started` | when Pomade is ready (tabs restored), once per Pomade start | none |
| `First open of a project since Pomade started` | the first time you open the project after Pomade starts; later opens do not. A job made after that open waits for the next Pomade start | **Project**: `Any project`, or one of Pomade's projects |
| `Project created` | when you create a project in Pomade | none |
| `Agent session finished` | when an agent session you ran ends. A session Runner started never fires it | **Only in project**, **Only agent** |
| `Session status changed to…` | when you change a session's status in the Agents app | **Status** — `Active` · `On hold` · `Done` · `Done–skip/Failed` — **Only in project**, **Only agent** |
| `Another job finished` | a chain: when another job finishes with the result you pick | **Job**, **When it** |

Under the picker the form says what the trigger comes to, e.g. "Runs at Mac login · Once per login,
after the 2-minute warm-up.", "Runs when Pomade starts", "Runs on first open of job-hunt", "Runs when
a project is created", "Runs after Pull is done · A chain. History will show “chain: after Pull”".

- Pomade's and the Agents app's events fire only while Pomade runs. One that happens while Pomade or
  Runner is not listening is not caught up. The form says so: "Fires only while Pomade is running, so
  there are no missed runs."
- `Mac login` is a login, not an update or restart of Runner. It fires the login hooks once, after
  the services are up and the warm-up has passed.
- `Pomade started` fires once for each Pomade start; a restart of Pomade fires it again, a restart of
  the scheduler does not.
- A session in the Workspace bucket has no project, so only a hook without a project filter takes it.
- A hook run has no missed-run policy: while the switch holds it, it waits and runs late.

History shows a hook run as "hook: Mac login", "hook: Pomade started", "hook: first open of job-hunt",
"hook: project <name> created", "hook: agent session finished", "hook: session marked Done".

## Chains

`Another job finished` picks a **Job** — any valid job but a service and the job itself — and **When
it**: `Is done` · `Fails` · `Either`. A failure is any failure: an exit code, a signal, a time limit.
A run you stopped, skipped or missed fires nothing.

- Every follower fires, in id order, and joins the queue like any run: overlap applies and the switch
  holds it. A chain run never waits for the warm-up.
- History shows "chain: after Pull"; its result card names the parent run and opens it.
- A chain that leads back to itself is refused when you save ("the chain loops back: a → b → a"),
  with an (i) on why.
- A **service** can follow a job: **+ Restart, start or stop it after another job** adds the line
  "**Also** [restart it · start it · stop it] after [job] [is done · fails · finishes]". Restart
  restarts a running service and leaves one that is not running alone; start starts one that is not
  running; stop stops it until you Start it. A service acts at once: the switch and the warm-up never
  hold it. Each action is a History record of the service. A service is never followed.

## What a run gets

A script or git job's run has these in its environment:

| Variable | When |
|---|---|
| `POMADE_JOB` | always — the job's id (`backup`, `coda-helper/nightly`) |
| `POMADE_RUN_ID` | always |
| `POMADE_TRIGGER` | always — `scheduled` · `caught-up` · `manual` · `hook` · `chain` |
| `POMADE_PROJECT`, `POMADE_PROJECT_PATH` | a project job: its project's id and absolute folder. A `First open` or `Project created` hook gives the event's project; a session hook gives the session's project, if it has one |
| `POMADE_SESSION_ID`, `POMADE_AGENT`, `POMADE_SESSION_STATUS`, `POMADE_SESSION_TRANSCRIPT` | `Agent session finished` and `Session status changed to…`: the session, its agent's id, its status then (for a change, the new one) and the session's transcript file, absolute |
| `POMADE_PARENT_JOB`, `POMADE_PARENT_RUN_ID`, `POMADE_PARENT_RESULT` | a chain: the parent job's id and run, and `done` or `failed` |
| `POMADE_WORKSPACE` | a git job: the workspace whose repos it names |

`Mac login` and `Pomade started` give no extra variables. `POMADE_PROJECT_PATH` is known once Runner has
heard Pomade's projects.

## The loop guard

A job that hooks or chains fire **more than 10 times in 10 minutes** is paused — almost always a loop,
such as a `Session status changed` hook whose script changes a session's status. The firing and every
later one by a hook or chain is dropped. The job shows `Paused` under Next run, and Needs you shows
"Paused: triggered 10× in 10 min" with **Resume** and **Edit job**; it is noticed once. **Resume**
lifts the pause with a fresh count; so does `pomade-runner resume-job <job>`. **Run now** still runs a
paused job and never counts. A pause survives a restart of Runner.

A hook on `Agent session finished` never fires for a session Runner started, so an agent job on that
hook cannot start itself. A `Session status changed to…` hook does fire for Runner's own sessions: a
status change is yours.

## In the job file

```yaml
hook: { event: login }
hook: { event: project-first-open, project: <project id> }     # no project = any
hook: { event: session-finished, project: <id>, agent: claude }
hook: { event: session-status, status: done }                  # active · on-hold · done · done-skip
after: { job: photo-backup, result: failed }                   # done · failed · any
after: { job: coda-helper/git-pull, result: done, action: restart }   # on a service
```

Events are `login`, `pomade-started`, `project-first-open`, `project-created`, `session-finished`
and `session-status`. The form writes the filters it offers and leaves the others as the file has them.

Tickets: T-010, T-013, T-014.
