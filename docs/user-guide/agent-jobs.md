---
doc: docs/user-guide/agent-jobs.md
audience: users
holds: agent jobs — the Agent section of the job form, modes and Full autonomy, how a run starts and finishes (an agent's background work, a turn without an answer), a run that waits for you (a prompt, an agent that has not started), the keeper's keychain, Open session, Pomade opened for a run, what needs the Agents app
kind: reference
---

# Agent jobs

An **agent job** starts one of your agents with a prompt, unattended, and ends its session once its turn
is done. Use it for a morning summary, a weekly review of drafts, a link check. It runs on a schedule, a
hook or a chain, like a script ([Schedules](schedules.md), [Hooks and chains](hooks-and-chains.md)).

## What needs the Agents app

Runner keeps no list of agents of its own. The agents, their modes, the command that starts one and the
session it makes all come from Pomade's **Agents app** (`pomade-agents`). Without it the job form shows a
notice in place of the **Agent** and **Mode** pickers, saying the Agents app is not running or that its
roster cannot be read, and that the job keeps the file's agent and mode; **Folder**, **Project** and
**Prompt** stay editable. A run due meanwhile fails ("cannot start — the Agents app (pomade-agents) is
not running"). An agent job's result card reads the agent's last message through the Agents app too.

## The Agent section

**New job** → **Agent**: **Trigger**, then **Agent** ("who · where · how").

- **Agent** — a choice of the Agents app's agents, by name. An agent the file names that the roster lacks
  stays, with a red line saying so.
- **Folder** and **Project** — where the agent starts. Its session is kept under this folder, and Open
  session resumes it there. **Choose…** next to the Folder box opens a menu in groups: **Workspace**
  (the workspace root), **Connected projects** (the projects connected to the chosen agent), **Other
  projects** (the rest of Pomade's projects; **Projects** when none is connected) and **Other folder…**
  (Pomade's folder picker). A project sets the folder and its project. Any workspace folder works.
- **Mode** — what the agent may do without asking. `Normal`: it asks before it edits a file or runs a
  command, and waits at the prompt. `Full autonomy`: it does both without asking. Then the agent's other
  modes. A mode the agent lacks is faded ("claude-pm has no full autonomy mode"); picking an agent that
  lacks the chosen mode goes back to `Normal`.
- **Prompt** — what the agent is asked, as its first message; "Saved as the body of the job file." At
  most 16,384 characters, not empty.

`Full autonomy` shows an amber note — "Skips every approval. The agent edits files and runs commands
without asking. The job shows a “Full autonomy” mark in the list." — and an amber **Full autonomy** tag in
the Jobs view. Choose it only for jobs that are safe with nobody watching.

An agent job's policies default to `Run on wake`, low priority on, and `Always` notify. The rest is as
for scripts ([Jobs and the job form](jobs.md), [Missed runs and load](missed-runs-and-load.md)).

## How a run goes

1. The run joins the queue like any run, then starts the agent in the job's folder, in your login-shell
   environment (your PATH and the aliases of your shell's rc files), with the job's mode and prompt.
2. The agent runs interactively, so approvals and Open session work.
3. When the agent has answered and is idle, Runner types the agent's exit command. The run is **done**
   when the agent exits; an agent still there 15 seconds later is stopped and the run is **done** all
   the same.
4. A run is **failed** when the agent exits before its turn is done ("the agent exited before its turn
   was done"), or crashes. Stop, the time limit and a lost session read as for a script.
5. A run whose turn ended without an answer — an API error such as "Not logged in" ends a turn as any
   turn — is **failed**, "the agent's turn ended without an answer", although the agent exited as it
   should. Its card shows the reason and **Last lines**, the agent's screen with the error, in place
   of the last message. When the Agents app cannot be asked, the run stays **done**.

### Background work

An agent that ends its turn with work it put in the background still going — a shell it left running —
has not finished. The run stays running and reads `running · waiting for the agent's background work`
in History, Last result and the CLI; Running now says "waiting for the agent's background work" under
the run. Its card says: "The agent’s turn is over, but work it started in the background still goes.
Runner waits for that work: the agent goes on once it ends, and the run is done when the agent is. The
time limit keeps counting." Runner types no exit command meanwhile; the run holds its low-priority slot
and is no wait for you (no Needs-you item, no notice). When the work ends and the agent is idle with
none, the turn is done and the exit command is typed.

An agent that answers the exit command with its "Background work is running" question gets Escape from
Runner, and the run goes back to waiting for the turn's end. An agent stopped after the 15 seconds
with that question still on screen makes the run **failed**, "the agent still had background work when
Runner ended it". A time limit stops a run in this state like any other.

### The keeper's keychain

Before an agent run, Runner checks that the keeper reaches the macOS keychain; an agent started where
it does not has no login. A keeper that fails is replaced with a fresh one (services started again) and
checked again. While other runs are going the agent run waits, `queued · a fresh keeper, after the runs
going`, because replacing the keeper ends them. When the fresh keeper fails too, the run fails with
"cannot start — the keeper cannot reach the macOS keychain, so the agent would have no login".

## When it waits for you

A permission or trust prompt on the agent's screen is not a finished turn: the run **waits for you**.
So does an agent that has not started working 20 seconds into its run: it stopped at a screen Runner
does not know — a consent, a login, a first-run step.

- Under Last result and in History it reads `waiting for you` (amber); Needs you shows a card "Waiting for
  approval at a permission prompt." (or "Waiting for you to trust its folder.", or "Has not started —
  look at its terminal.") with how long it has waited, and you get a notice "<job> needs your approval"
  (or "<job> has not started").
- **Open at the prompt** opens the run's terminal tab where the agent asks. Answer there and the run
  goes on — an agent that has not started goes on once it works. The notice does the same.
- While it waits, the run's **time limit pauses** and it holds no low-priority slot, so a forgotten
  prompt does not hold back other jobs. The long-run warning pauses too.
- The result card of a waiting run shows what it waits at ("Waiting at") and "The time limit is paused
  while it waits." For an agent that has not started it says "The agent has not started working: it
  stopped at a screen Runner does not know — a consent, a login, a first-run step. Look at its
  terminal."

A waiting run cannot be dismissed in Needs you; answer it or **Stop run** from its card.

## Open session

On a finished agent run's result card, **Open session** opens the agent's session in a Pomade agent tab
resumed in the job's project and folder, so you can ask follow-ups ("expand on the second point"). If a
tab is already on it, Pomade focuses that. The button shows once Runner knows the session; for a
provider that does not pre-assign the session id, Runner finds it from the folder and start time. When
it is not known the card says "Runner did not learn this run’s session, so its last message cannot be
read." A run that ended before its agent started has no session at all: its card says "The agent never
started a session." and has no **Open session**.

The card's **Last message** shows the agent's final message of the run, with paragraphs, lists, bold,
emphasis and code drawn as text.

## When Pomade is closed

An agent run starts only while Pomade is up for it. One that comes due while Pomade is closed reads
`queued · opening Pomade`, and Runner opens Pomade — it runs the launch Pomade recorded, then waits up
to 60 seconds for Pomade to be ready and the Agents app to answer. Every agent run due meanwhile waits
for the same opening, then they start in the order they queued. Scripts, git jobs and services never
wait for it. Runner leaves the Pomade it opened running.

If Pomade cannot be opened, every run waiting for it fails without starting, with the reason, and its
notice waits in Pomade's queue for your next launch: "cannot start — Pomade could not be opened: this
Pomade recorded no way to launch it (no host.json)", "…: Pomade did not become ready in time", or
"cannot start — Pomade opened, but after 60 s the Agents app (pomade-agents) is not running". The next
agent run due tries again. Pomade has to have been started at least once so it has recorded how to
launch itself.

## The job file

```markdown
---
kind: agent
name: Morning summary
description: Summarizes today's plan and what ran overnight.
folder: .
agent: claude
mode: normal              # or full-autonomy, or another mode of the agent
schedule:
  weekly: { days: [mon, tue, wed, thu, fri], at: 7:00 }
worth-until: 12:00
---
Summarize today's plan and what ran overnight. Keep it to ten lines.
```

The body is the prompt. The `session-finished` hook never fires for a session Runner started, so an
agent job on that hook cannot start itself.

Tickets: T-015, T-016, T-017, T-037, T-038, T-040, T-043, T-044.
