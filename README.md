# pomade-runner

Runner is the Pomade app that runs things without you: always-on services that outlive Pomade, and
scripts, git operations and unattended agent runs on schedules, hooks and chains.

It is one piece of the Pomade family. The platform and its rules live in the sibling repo `Pomade`
(`docs/PLATFORM.md`); the shared library is `pomade-kit`. The design is `docs/DESIGN.md`, the
backlog `docs/BACKLOG.md`.

## What is in the box

| Part | What it is | Source |
|---|---|---|
| UI | the Runner side panel and the Runner tab inside Pomade | `src/ui/` |
| Scheduler | the always-on background part: a login item that keeps running when Pomade quits. It runs the scheduled scripts and git jobs — catching up what the Mac slept through as each job's missed-run policy says, a few low-priority runs at a time, held by the switch, stopped at their time limit — and those on hooks and chains: once after each Mac login, and when another job is done or fails, restarting a service after it too; it pauses a job that fires in a runaway loop. A git job runs Pomade's `pomade-git` and keeps its result per repo. It keeps their history and output, posts the notices, and tells Pomade's Git panel which jobs target a repo | `src/scheduler/` |
| Keeper | holds every service's terminal session, so it outlives Pomade and the scheduler; Pomade's tabs attach to it. The scheduler starts and owns it, and supervises the services in it: starts them at login one by one, restarts a crashed one, gives up on a crash loop, leaves one you stopped stopped | `src/keeper/` |
| `pomade-runner` | the command line, on `PATH` through Pomade's command folder: `check` job files and the settings, list `projects`, `list` the jobs, `run` one now, show its `history`, show the `runs` going, `pause` and `resume`, `resume-job` one the loop guard paused, `enable` or `disable` one, show `services` and `stop` or `restart` one, show `sessions` | `src/jobs/cli/` |
| Skill `pomade-runner-jobs` | teaches agents to write job files | `app/skills/pomade-runner-jobs/` |

`npm run build` puts all of it into `dist/`, the folder Pomade installs: the UI, `manifest.json`,
the skill, the scheduler, the keeper and the command each bundled into one file, and the four
packages the keeper loads at run time in `dist/node_modules/`, so the folder runs wherever it is
copied.

Jobs are Markdown files in `<workspace>/Apps/pomade-runner/jobs/` — the format is in
`docs/DESIGN.md` "Job files" and, for agents, in the skill. Runner's workspace settings are
`<workspace>/Apps/pomade-runner/settings.yaml` (`docs/DESIGN.md` "Settings"). `pomade-runner check`
validates both.

## Develop

Needs Node 22.18 or newer.

```sh
npm install
npm run dev        # the UI on http://localhost:5273
npm run build      # dist/
```

Opened in a browser, the UI says it has no Pomade host; inside Pomade it gets its data through the
Host API. To work on it inside a dev Pomade, use a dev link (below).

## Test

```sh
npm run gate       # lint, typecheck, unit tests, e2e
```

| Step | Command | Covers |
|---|---|---|
| Lint | `npm run lint` | ESLint, type-aware, no warnings allowed |
| Types | `npm run typecheck` | the Node code, the UI and the e2e specs |
| Unit | `npm run test:unit` | vitest: the logic, with every edge case |
| E2E | `npm run test:e2e` | Playwright, on the built `dist/` |

The e2e has twelve parts: the UI in `pomade-kit`'s fake host · the scheduler and the command as
processes · the keeper and its sessions as processes · service supervision as processes ·
scheduled scripts as processes, on a set clock · missed runs and load as processes, on a set clock
(sleep simulated by stopping the scheduler process while its clock runs on) · chains and login
hooks as processes (a login simulated by starting the scheduler again) · git jobs as processes,
through the Pomade checkout's real `pomade-git` with Pomade closed, on throwaway repos (a bare
remote and its clones, their own git configuration; an agent at work simulated by a program named
`claude` running in the repo) · Runner hosted by a real Pomade, attached tabs, notices and the
badge included · a missed run that waits for you in a real Pomade · git jobs in a real Pomade,
the Git panel's Scheduled line included · the install and uninstall scripts.

The git jobs and the last four need a Pomade checkout with its dependencies installed and `npm run
build` done: `POMADE_REPO`, default `../Pomade`.

```sh
POMADE_REPO=/path/to/Pomade npm run gate
```

That Pomade runs in test mode — an invisible window, no login items — on a temp workspace, user
data and home. A Pomade you are using is never touched.

`RUNNER_SHOTS=<folder> npm run test:e2e` also saves screenshots of every UI state, light and dark.

## Install

```sh
./install
```

It builds Runner and runs `pomade apps install dist` (the `pomade` command of `POMADE_REPO`). The
target is the **dev** Pomade. Updating Runner is the same command: Pomade swaps the installed copy
and restarts the scheduler.

Then it gives the agents the skill: it links the installed `skills/pomade-runner-jobs` into
`~/.claude/skills/` and into `skills/` of every agent under `<workspace>/Agents/`. Running it again
changes nothing. The first time, it drops a note for the skills map into
`<workspace>/Knowledge/00-Inbox/`.

After it:
- Pomade shows the Runner icon on its left strip; the icon fills the side panel, and "Open Runner"
  opens the Runner tab.
- The scheduler runs as a login item of that Pomade. Its log is
  `<userData>/app-logs/pomade-runner/backend.log`. It starts Runner's keeper, which holds the
  services' sessions; an update of Runner leaves them running, and hands them to a new keeper when
  the update ships one.
- `pomade-runner --version` prints the version and whether the scheduler is running;
  `pomade-runner check` checks the job files and the settings; `pomade-runner list` prints every
  job with its trigger, next run and last result; `pomade-runner run <job>` runs a script or git job now (or
  starts a service), `pomade-runner history [job]` prints the latest runs, `pomade-runner runs`
  the runs going — queued ones with what they wait for — the switch and what needs you,
  `pomade-runner pause [low|all]` and `pomade-runner resume` set the switch, `pomade-runner
  resume-job <job>` lets hooks and chains fire a job the loop guard paused, and `pomade-runner
  enable|disable <job>` writes `enabled:` into a job's file; `pomade-runner services` shows every
  service and where it stands, and `pomade-runner stop|restart <service>` stops or restarts one;
  `pomade-runner sessions` shows the keeper and its sessions. New terminals
  find the command once Pomade's command folder is on `PATH` (Pomade ▸ Settings ▸ General ▸
  Commands).

`./install --stable` installs into the stable Pomade. That happens only on Daniil's explicit word.

To remove Runner: `./uninstall` — it removes the skill links, then the app
(`pomade apps remove pomade-runner`). `./uninstall --stable` is for the stable Pomade.

## Dev link

A dev link makes Pomade load Runner straight from this repo instead of an installed copy:

```sh
npm run build
"$POMADE_REPO/bin/pomade" apps link "$PWD/dist"      # the whole app from dist/
"$POMADE_REPO/bin/pomade" apps unlink pomade-runner  # back to the installed copy
```

Rebuild after a change; Pomade reloads Runner's frames.

For the UI alone, with hot reload, link the dev server instead:

```sh
npm run dev
"$POMADE_REPO/bin/pomade" apps link http://localhost:5273
```

A dev-server link has no scheduler and no command — Pomade runs those only from a folder.
