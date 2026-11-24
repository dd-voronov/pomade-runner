---
doc: docs/user-guide/jobs.md
audience: users
holds: the four kinds of job, the job file (the description included), the Jobs view, creating and editing a job in the form, Enabled, Open file, Delete, policies
kind: reference
---

# Jobs and the job form

A **job** is one thing Runner does without you. It has a **kind**, a **trigger**, a **folder** and
**policies**.

| Kind | Does | Trigger |
|---|---|---|
| **Service** | keeps a command running; restarts it on a crash | always on while it lives: from Mac startup (outlives Pomade), while Pomade is running, or from the first open of a project (both stop when Pomade quits) |
| **Script** | runs a command once each time its trigger fires, as if typed in a terminal in its folder | schedule · hook · chain · manual |
| **Agent** | starts an agent with a prompt, unattended, and ends its session when its turn is done | schedule · hook · chain · manual |
| **Git** | runs a git operation on one or more repos, with Pomade's safety rails | schedule · hook · chain · manual |

A **manual job** has no trigger: it never runs by itself, only when you press **Run now** or run
`pomade-runner run <job>`, and other jobs may chain after it. In the form's **Trigger** section,
choose `Manually`; the file then has none of `schedule`, `hook` and `after`.

Runner tracks only jobs made in Runner. A terminal you open by hand is just a terminal.

## The job file

Each job is one Markdown file in `<workspace>/Apps/pomade-runner/jobs/`: the fields in its frontmatter,
notes — or an agent job's prompt — in its body. Workspace jobs sit at the top level; a project's jobs sit
in a sub-folder named after the project's folder (`Projects/blog` → `jobs/blog/`). The
file name is the job's slug: lower-case letters, digits and dashes. A job's **id** is its path inside
the jobs folder without `.md` (`blog/dev-server`); chains and the command name jobs by it. A
project job is bound to its project by the project's id, so renaming or moving the project in Pomade
keeps its jobs working: Runner renames the sub-folder and rewrites the jobs' `folder:` paths.

The file on disk is the truth. You edit it in the form or by hand, and agents write it directly; a
change applies within a second. A file with an error is shown in Runner with the error and never runs.

| Field | Kinds | Value |
|---|---|---|
| `kind` | all | `service` · `script` · `agent` · `git` |
| `name` | all | required; unique across the workspace (case ignored); a git job's at most 100 characters |
| `description` | all | optional; free text saying what the job is for, any length, line breaks kept; a job without one leaves the field out (a field with no text is an error). Jobs shows it as the tooltip on the job's name |
| `project` | all | the project's id; only in a project's sub-folder |
| `enabled` | all | `true` · `false` |
| `folder` | service · script · agent | the working folder, relative to the workspace; `.` is the root |
| `command` | service · script | what the login shell runs |
| `start`, `start-project`, `ready` | service | [Services](services.md) |
| `agent`, `mode`, body | agent | [Agent jobs](agent-jobs.md) |
| `git` | git | [Git jobs](git-jobs.md) |
| `schedule` · `hook` · `after` | script · agent · git (a service takes `after`) | at most one; none is a manual job: [Schedules](schedules.md), [Hooks and chains](hooks-and-chains.md) |
| `missed`, `worth-until`, `overlap`, `low-priority`, `time-limit`, `notify` | by kind | [Policies](#policies) |

Agents learn the format from Runner's skill, `pomade-runner-jobs`; ask one to "add a job that tidies
drafts every Sunday at 3:00". Runner keeps the skill in your workspace's skills folder (a setting,
`Knowledge/_skills/apps/` by default) and gives it to no agent — link or copy it into the skills of the
agents you want to write jobs. `pomade-runner check` validates the files ([the command](command.md)).

## The Jobs view

Jobs are grouped by project: the Workspace first (jobs that belong to no project), then each project
in Pomade's order, each group headed by its name, its jobs sub-folder and its count. The summary
reads "N jobs", plus "· N invalid" when a file has errors. Columns:

- **Job · trigger** — the kind icon, the name (with the job's description, when it has one, as its
  tooltip, line breaks kept) over the trigger in words ("weekdays at 7:00", "at Mac
  login", "after Pull is done", "manual"; a service: "always on · starts on Mac startup", "while Pomade
  is running", "from first open of blog while Pomade is running"). An agent job in Full autonomy carries an amber `Full autonomy` tag. A
  git job's tooltip adds its operation and repos; a repo the workspace lacks is said in red.
- **Last result** — the run going ("running", "running · waiting for the agent's background work",
  "waiting for you", "queued", "missed · waiting for you")
  or the latest finished one ("done", "failed · exit 1", "stopped: time limit, 45 min", "skipped · …",
  "missed · …", "stopped by you") over when it started and how long it took, with "· caught up" or
  "· manual" where that is how it started ("today 8:32 · 4m 12s · caught up") — a done git run shows
  its commit instead. A run going shows how long so far, counted each second for the first minute; a queued run reads "queued · 1 ahead" over
  "since 12:46"; a job the loop guard paused reads amber "paused · looks like a loop" over when and
  "10× in 10 min". "never ran" for none. Click it to open the run's result card. A service shows its
  state as the Services view does.
- **Next run** — "disabled", "paused" (the loop guard's), "always on" (a service that starts on Mac
  startup), "with Pomade" (a service bound to Pomade), "on event" (a hook or a chain), "not scheduled" (a
  manual job), "finished" (a schedule with nothing ahead), else the next time ("Today 13:00", "Wed
  7:00"), with the countdown under it within the hour ("in 56 s", "in 2 min", "in 40 min" — the same
  words as the panel's Next up). While the switch holds the job, the time is faint and an amber `held`
  tag sits under it ([Missed runs and load](missed-runs-and-load.md)).
- **Row actions** — `Run now`, `Edit`, `Delete`, and the `Enabled` toggle. While a script, agent or
  git job has a run going (a queued run does not count), `Open terminal` and `Stop run` come before
  `Run now` and act on the latest run — the same two as on the run's card; for an agent run waiting for
  you the first reads `Open at the prompt`. `Stop run` toasts "<job> stopped by you". They leave when
  the run ends; the other icons do not move. `Run now` stays while the job runs. A service has, in Run
  now's place, `Stop service` while it runs or starts and `Start service` while it does not (none
  while it is disabled — the toggle enables it — or while it waits for Pomade); before it, `Open terminal` once the service has run
  — its tab shows its output, the last output once it ended. A refused action reports as a toast
  ("Could not run <job>: <why>", "Could not start <service>: <why>"). A disabled row is dimmed.

An **invalid file** is a red row: its file name, its first error ("Invalid: line 4: …", "· N more") and
**Open file**. `pomade-runner check` prints the same errors.

## Creating and editing a job

**New job** opens the form as a full page in the tab; **Edit** opens it on an existing job. The page
head has a back arrow to Jobs, "Jobs / <name>", **Enabled** and — editing — **Open file** and
**Delete**. Sections, in order:

1. **Kind** — four cards: Service "Keeps a command running, always"; Script "Runs a command on a
   trigger"; Agent "Runs an agent with a prompt"; Git "Git operation on your repos". Then **Name**.
   Switching kind keeps what you set and resets the kind's defaults you left alone. Under Name a
   link, "Add a description (optional)", opens the **Description** box ("What this job is for — shown
   when you hover its name in Jobs"); a job that has a description shows the box filled. Emptying it keeps the
   box open; an empty description leaves the field out of the file.
2. The kind's own sections — **Trigger** and **Runs** for a service and a script, **Trigger** and
   **Agent** for an agent, **Trigger** and **Git** for a git job.
3. **Policies** — a one-sentence summary, the non-defaults in bold, until you press **Change**.

**Folder** is typed or chosen with **Choose…**: a menu of **Workspace** (the workspace root), the
projects (an agent job groups the agent's **Connected projects** first, then **Other projects**) and
**Other folder…** (Pomade's folder picker); a folder inside a project fills in that project. **Project** is the Workspace ("Workspace (no
project)") or one of Pomade's projects.

The bottom bar says "Saves to <path>", with **Cancel** and the save button: **Create and start**
(a new, enabled service that starts as it is created — [Services](services.md)) · **Create job** · **Save** · **Saved** while nothing changed. A new job's
file is written to the project's sub-folder under the first free slug of its name; an edit writes only
the fields you changed, so comments, other fields and the body stay. A new name keeps the file name.
With errors, the bar says "N things to fix before saving" and focuses the first field; each error
shows under its field in the words `pomade-runner check` uses.

While you edit, the form follows its file: a field you left alone takes the file's new value; one you
set keeps your edit, with a note that the file changed too. If the file is deleted or moved the form
says so and Save is off. A job file the form cannot read (broken frontmatter, an unknown kind) opens a
page that says so, with **Open file**.

## Enabled, Open file, Delete

- **Enabled** — in the Jobs row and the form's head. A disabled job is kept and never runs; a running
  service is stopped, and its `stopped by you` and `failed` marks are cleared.
- **Open file** — opens the job's file in a Pomade tab. In the form, a refusal is a toast.
- **Delete** — in the Jobs row and the form. The confirm reads `Delete “<name>”?`, names the file and says
  "This can't be undone."; its button is **Delete job**. A running service is stopped first ("The
  service is running: Runner stops it first, then removes the file."). A run of the job that is going
  refuses the delete: stop it first. Queued runs and missed runs waiting for you settle as "its job
  file is gone". The toast says "Deleted <path>", plus "· stopped first".

## Policies

Each job that runs once per trigger carries these; each has an (i) help.

| Policy | Values (default per kind) | See |
|---|---|---|
| **If a run is missed** | `Run on wake` (script, agent) · `Wait for me` · `Skip` (git); with Run on wake, **Still worth it until** `the next scheduled run` or `a time of day`. Not offered for a hook, a chain or a manual job; in a manual job's file it is an error | [Missed runs and load](missed-runs-and-load.md) |
| **If still running** | `Skip` · `Run in parallel` · `Queue after` | same |
| **Low priority** | on for script and agent, off for git and service | same |
| **Time limit** | `45m`, `2h`, `1h30m`; empty for none | same |
| **Notify me** | `On failure` (script, git, service) · `Always` (agent) · `Never` | [Results](results.md) |

A service's policies are Low priority and Notify me; a missed-run policy, overlap and a time limit
apply to jobs that run once per trigger. A policy at its default is left out of the file.

Tickets: T-007, T-009, T-041, T-043, T-044.
