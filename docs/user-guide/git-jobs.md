---
doc: docs/user-guide/git-jobs.md
audience: users
holds: git jobs — the Git section of the job form, what a run does and how it ends, the result card, how Pomade's Git panel shows the jobs
kind: reference
---

# Git jobs

A **git job** runs a git operation on one or more repos of your workspace — for example **Commit & push**
on `notes` at 13:00 and 20:00. Pomade's `pomade-git` does the work and keeps Pomade's safety
rails. It works with Pomade open or closed, on schedules, hooks and chains.

## The Git section

**New job** → **Git**: **Trigger** (as a script's — [Schedules](schedules.md), [Hooks and
chains](hooks-and-chains.md)), then **Git**:

- **Operation** — `Commit & push` · `Pull` · `Push` · `Fetch`.
- **Repositories** — a tick per git repo of the workspace, named as Pomade's Git panel names them. A
  repo you tick runs after the ones ticked before it. A repo the file names that the workspace lacks
  stays ticked with a red line "<repo> is not in this workspace"; it does not stop you saving. With no
  repos, "The workspace has no git repos."
- **Project** — the project the job is grouped under. A git job has no folder: `pomade-git` works in the
  repos.

A git job's policies default to `Skip` if missed, normal priority (it neither takes nor waits for a
low-priority slot) and `On failure` notify. The job's name is at most 100 characters: it goes into the
commits.

## What a run does

For each repo, in order, `pomade-git` does the operation with its rails:

- A commit it makes reads `Committed automatically · job "<name>" · <date time>`, with a `Pomade-Job:`
  trailer.
- A repo where an agent is working is **skipped**, not touched.
- A conflict is aborted and the run **fails**, the repo left as it was.

The run is **done** when every repo is done or skipped, and **failed** when a repo failed (the reason is
the repo's: "notes: Their changes conflict with yours in notes.md. …"), when the command line was
wrong, or when `pomade-git` gave no result. It fails without starting when `pomade-git` is not in
Pomade's command folder; open Pomade once. A failed run is a notice and a Needs-you item as the job's
**Notify me** says.

## The result card

A git run's card lists each repo with its commit hash and its steps — a tick for done, a cross for
failed, faint for skipped: "notes · committed a1b2c3d · pulled · pushed", "skipped · agent working".
It ends with **View output** (what `pomade-git` wrote to standard error — nothing when all went well),
**Run again** and **Edit job**. In the Jobs view a done git run's Last result shows its commit in place
of the duration; `pomade-runner history` prints the result per repo.

## In Pomade's Git panel

When Runner is installed, Pomade's Git panel lists the jobs that target a repo on its row ("Scheduled:
Commit & push · 13:00, 20:00 — edit in Runner"); clicking it opens the job in Runner's Jobs view. Only
valid, enabled git jobs that name the repo count.

## The job file

```markdown
---
kind: git
name: Commit notes
git: { operation: commit-push, repos: [notes] }   # commit-push | pull | push | fetch
schedule:
  daily: { at: [13:00, 20:00] }
---
```

Repos are named as `pomade-git` accepts them, each once, none starting with `-`.

Tickets: T-011.
