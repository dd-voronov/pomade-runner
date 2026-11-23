---
doc: docs/user-guide/command.md
audience: users
holds: the pomade-runner command — every subcommand, what it prints, exit codes, what needs the scheduler or Pomade running
kind: reference
---

# The `pomade-runner` command

`pomade-runner` is Runner's command line. It is on your `PATH` through Pomade's command folder
(`~/.pomade/bin`), reads your job files and settings directly and talks to the scheduler over its own
socket, so it works with Pomade closed. A job is named by its **id** (`blog/dev-server`) or its
**name**.

| Command | Does |
|---|---|
| `pomade-runner check [file…]` | checks job files and the settings file — every one in the workspace, or the files given. Prints `path:line: field — problem. Fix: …` per problem, then a summary; `no problems` when clean. Exit 1 on any problem. With Pomade closed it checks everything but project ids and says so |
| `pomade-runner projects` | Pomade's projects: the id a project job's `project:` takes and the sub-folder of `jobs/` its jobs sit in. Needs Pomade running |
| `pomade-runner list` | every job: its kind, trigger in words ("manual" for a manual job), next run and last result |
| `pomade-runner run <job>` | runs a job now: a script, agent or git job runs (or queues behind its run going, as its overlap says); a service starts — one stopped by you or failed too |
| `pomade-runner history [job]` | the latest 20 finished runs, newest first, of every job or one, each with its trigger, result, time and output log (`output not on this Mac` when the log did not come along); a git run adds a line per repo |
| `pomade-runner runs` | the switch — while it holds jobs, how many runs it has held so far ("6 runs so far") — the runs going — running, queued and what each waits for — and what needs you |
| `pomade-runner pause [low\|all]` | holds scheduled runs: of low-priority jobs, or all (the default). Run now still runs; services keep running |
| `pomade-runner resume` | lets held runs go: what the switch held is missed and follows each job's missed-run policy, once per job |
| `pomade-runner resume-job <job>` | lets hooks and chains fire a job the loop guard paused again |
| `pomade-runner missed <job> run-once\|run-all\|run-at <time>\|skip` | settles a job's missed runs as its card does: `run-once` runs it once now, `run-all` runs every missed run one after another (with no missed run waiting: the other runs of its latest caught-up run), `run-at 23:00` (or `tomorrow 9:00`, `+2h`) runs it at that time, `skip` records it `missed · skipped by you` |
| `pomade-runner enable <job>` · `disable <job>` | writes `enabled: true` or `enabled: false` into the job's file; disabling stops a running service |
| `pomade-runner services` | every service: its state, restarts and last crash |
| `pomade-runner stop <service>` | stops a service; it stays stopped until `run` |
| `pomade-runner restart <service>` | restarts a service with its job file as it is now |
| `pomade-runner sessions` | the keeper and its sessions: each one's job, state and output log |
| `pomade-runner --version` | the version, and whether the scheduler is running |
| `pomade-runner --help` | the usage |

Every command but `check` and `projects` needs the scheduler running. Exit codes: 0 done; 1 problems
found, or the scheduler or Pomade needed and not running, or a refusal (printed with its reason); 2 the
command could not run (a wrong argument, no workspace).

Agents use the same command to check the job files they write; Runner's skill tells them to finish with
`pomade-runner check`. `pomade-runner pause` and `resume` are your switch: an agent leaves them alone
unless you ask.

Tickets: T-002.
