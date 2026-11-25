---
doc: docs/user-guide/git-jobs.md
audience: users
holds: git jobs — the Git section of the job form and its repository list, what a run does and how it ends, what a pull got, the result card and Open in Git, how Pomade's Git panel shows the jobs
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
- **Repositories** — the workspace's git repos as a list of checkboxes, named as Pomade's Git panel names
  them. The list is grouped by top folder: **Top level** first (the repos directly under the workspace
  root; the root's own repo reads "workspace root"), then the folders by name; each group has a head
  with a checkbox for the whole group (mixed while some of it is picked) and "n of m", each repo its
  name and path. Above the list: "N of M selected", **Select all** and **Clear**, and, from 10 repos up,
  a filter by name or path — with it, the actions read **Select N shown** and **Clear shown**. A repo
  the file names that the workspace lacks stays picked in a red **Not in this workspace** group at the
  bottom, with a red line under the list; it does not stop you saving. With no repos, "The workspace has
  no git repos."
- **Order** — a run goes through the picked repos one at a time, top to bottom in the list, whatever
  order you ticked them in: the form writes them into the file in the list's order. The line under the
  list says so ("Runs one repo at a time, top to bottom in this list."). A file that names its repos in
  another order says "Runs one repo at a time, in the job file's order" and lists them, with **Use this
  list's order** to rewrite them.
- **Project** — the project the job is grouped under. A git job has no folder: `pomade-git` works in the
  repos.

A git job's policies default to `Skip` if missed, normal priority (it neither takes nor waits for a
low-priority slot) and `On failure` notify. The job's name is at most 100 characters: it goes into the
commits.

## What a run does

For each repo, in the job file's order, `pomade-git` does the operation with its rails:

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
A failed repo's line ends with **Open in Git**: it takes you to that repo in Pomade's Git panel, where
you resolve the conflict — in the job's project when its folder holds the repo, else the first project
whose folder holds it, else the Workspace. The button shows only when your Pomade supports it; if
Pomade has no such repo or project any more, a toast says "Could not open notes in Git: Pomade has no
such repo or project now". The card ends with **View output** (what `pomade-git` wrote to standard error — nothing when all went well),
**Run again** and **Edit job**. In the Jobs view a done git run's Last result shows its commit in place
of the duration; `pomade-runner history` prints the result per repo.

## What a pull got

A done pull says how many commits it got when the Pomade that ran it reports it: "done · 2 commits
pulled", "done · 1 commit pulled", "done · up to date" for none — summed over the run's repos. A run
that committed adds its commit: "done · a1b2c3d · 2 commits pulled". The words are in the job's Last
result, History's result column and `pomade-runner list` and `history`. When any repo's count is
unknown — an older Pomade, or no pull step done — the run reads plain "done" (a commit still shows).

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

Tickets: T-011, T-049, T-050, T-051.
