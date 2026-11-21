---
doc: docs/modules/index.md
audience: engineers, product
holds: the module map — each module's scope and where it lives in code, with every non-test file under `src/`, the e2e support and the build accounted for
kind: reference
---

# Modules

A module is a real area of Runner with a home in the code. Tickets name one in `module:`
(`../Pomade/docs/process/backlog.md`); process and project-management items use `meta`. A new area
gets its row here first. Every non-test file under `src/` belongs to exactly one row; a test sits
beside the file it tests (`<file>.test.ts`). The two large modules have a page of their own: a
summary here, the file-by-file map, rules, invariants, tests and limits there.

| Module | Covers | Where in code |
|---|---|---|
| `keeper` | Runner's side of the keeper (`pomade-kit/keeper`): its entry, starting and owning it from the scheduler, run and service sessions, per-run output logs, header actions, service supervision, following an agent run's turns, process priority | `src/keeper/`: the entry `entry.ts` (the keeper's own process, started with the keeper version as its argument); the scheduler's hold on the keeper in `sessions.ts` (start, follow, upgrade, spawn, stop, restart, forget); session and run ids in `ids.ts`; the keeper version digest in `version.ts`; a service as a session — its header actions, finding it by name — in `services.ts`; service supervision (staged start, crash back-off, records) in `supervisor.ts`, its port and URL checks in `readiness.ts`; the shared model of sessions, services and their states in `model.ts`; an agent run's turns — the scheduler attached as a viewer, the kit's agent-state scanner, waiting for you — in `agent-turns.ts`. The build ships the keeper's run-time packages (`scripts/build.mjs`) |
| `scheduler` | the always-on backend (login item): triggers (schedules, hooks, chains), the loop guard, missed-run policies, the start queue and load control, the run lifecycle for scripts, agents and git, history and captured output, Needs you, the workspace settings, project moves, deleting a job, the control socket | `src/scheduler/` — file map, rules, invariants, tests and limits in [`scheduler.md`](scheduler.md). Entry `main.ts`, wiring in `scheduler.ts`, the run lifecycle in `runs.ts`, the command's control protocol in `control/` |
| `jobs` | the job file format, loading and watching the jobs folder, validation, writing job files field-only, a trigger in words, the `pomade-runner` command, the agent skill | `src/jobs/`: the model of a checked job in `model.ts`; one file read against the format in `parse.ts`, its frontmatter with the line of every field in `document.ts`; every file checked together — chains, loops, names, project ids — in `check.ts`; an error as one line in `format.ts`; reading the jobs folder in `folder.ts`, watching it in `loader.ts`; field-only writes and new files in `edit.ts`; a trigger in words in `words.ts`; the command in `cli/` (`main.ts` the entry, `cli.ts` what each command prints and its exit codes); skill linking in `skill/link.ts`. The skill's master copy is `app/skills/pomade-runner-jobs/SKILL.md` |
| `ui` | the side panel, the Runner tab (Jobs · History · Services · Settings), the job form, result cards, the output tab, the help tooltips, the design-system kit | `src/ui/` — file map, rules, invariants, tests and limits in [`ui.md`](ui.md). Entry `main.tsx` and `App.tsx`; the panel in `Panel.tsx`, the tab in `RunnerTab.tsx`, the job form in `form/`, the primitives in `kit/`, every help text in `help.ts` |
| `integrations` | everything that crosses the app boundary: agent jobs (`pomade-agents`), git jobs (`pomade-git`), platform events and notifications, Runner's published API and events, Pomade opened for an agent run, native macOS notifications | `src/integrations/`: Runner's API names, checks, events and tab routes (the output tab's key included) in `runner-api.ts`; the connection to Pomade and the API it serves — `jobs.forRepo` to Pomade's Git panel included — in `pomade.ts`; notices and the badge in `notices.ts`; the client of the Agents app (roster, launch spec, projects, session lookup, last message) in `agents.ts`; the Agents app's events `session.closed` and `session.statusChanged`, checked against the contract, in `agent-events.ts`; which Pomade start a workspace's Pomade-started hooks fired for in `pomade-start.ts`; opening Pomade for an agent run — one opening at a time, until Pomade is ready and the Agents app answers — in `pomade-open.ts` |
| `meta` | process, docs, repo setup, the test suites | `app/` (`manifest.json`, `icon.svg`, `output.svg` the output tab's icon, the skill); `scripts/` (`build.mjs`, `shots.mjs`); `install`, `uninstall`; `prototype/` (the approved prototype); the configs at the root. Shared by every module: `src/app.ts` (Runner's name and version, read from the manifest), `src/locations.ts` (Runner's two folders — the records folder in the workspace and the machine-local state folder — the paths in each, where a run's output log is found, and where `pomade-git` is). The e2e: `e2e/*.spec.ts` (below); `e2e/support/` — `env.ts` (the built app folder, throwaway folders, a clean environment, running a program to its end), `runner.ts` (Runner as processes with Pomade closed), `scheduler.ts` (a scheduler process under test), `keeper.ts` (asking the keeper over its socket, stopping it in teardown, and failing the teardown — killing the process group — when a process of the test world outlived it), `pomade.ts` (the Pomade checkout, `POMADE_REPO`), `frames.ts` (app frames in a real Pomade), `git.ts` (throwaway repos), `agents.ts` (the scripted fake agent CLI and the fixture Agents app), `ports.ts` (the two e2e ports, `RUNNER_E2E_PORT_BASE`); `e2e/harness/` (the fake-host page the UI specs open, with stand-ins for the scheduler and the Agents app); `e2e/fixtures/` (`fake-agent.mjs`, `agents-app/`); `e2e/vite.config.ts` |

## The e2e specs

| Spec | Shows |
|---|---|
| `background.spec.ts` | the scheduler and the `pomade-runner` command as processes, Pomade closed |
| `keeper.spec.ts` | the keeper as its own detached process owning the sessions |
| `services.spec.ts` | service supervision, and the command's `run`, `stop`, `restart` |
| `runs.spec.ts` | scheduled scripts, history and output, overlap, notices queued while Pomade is closed, the records the workspace carries |
| `load.spec.ts` | missed runs, the queue, warm-up and the switch, on the injected clock |
| `chains.spec.ts` | chains and the Mac login hook |
| `git.spec.ts` | git jobs through the real `pomade-git`, Pomade closed |
| `install.spec.ts` | `./install` and `./uninstall`, the installed copy; rebuilds `dist/`, so it runs last |
| `pomade.spec.ts` | Runner hosted by a real Pomade (the scheduler started the way the login item starts it) |
| `pomade-git.spec.ts` | a git job made in the form, and Pomade's Git panel showing it |
| `pomade-load.spec.ts` | a missed run that waits for you, in a real Pomade |
| `pomade-hooks.spec.ts` | Pomade started, first open of a project, project created, services starting on first open, a project moved |
| `pomade-agents.spec.ts` | agent runs against the fixture Agents app and the scripted fake agent |
| `pomade-agent-hooks.spec.ts` | session finished and status changed hooks, with the loop guard for Runner's own sessions |
| `pomade-agents-real.spec.ts` | the same against the real Agents app (opt-in: skipped unless `AGENTS_APP_DIST` names its built `dist/`) |
| `pomade-open.spec.ts` | Pomade opened for an agent run, from closed |
| `ui.spec.ts` | the UI in the fake host and in a plain browser; `RUNNER_SHOTS=<dir>` saves a screenshot of every state |

Every spec that starts processes tears down through `e2e/support/keeper.ts`: a process of the test
world that outlives its teardown fails the run, naming it.
