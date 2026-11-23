# pomade-runner

Runner is the Pomade app that runs things without you: always-on services — from Mac startup, or only
while Pomade runs — and scripts, git operations and unattended agent runs on schedules, hooks, chains,
or by hand.

It is one piece of the Pomade family. The platform and its rules live in the sibling repo `Pomade`
(`docs/PLATFORM.md`); the shared library is `pomade-kit`. The design is `docs/DESIGN.md`, the
plan `docs/PLAN.md`.

## What is in the box

| Part | What it is | Source |
|---|---|---|
| UI | the Runner side panel and the Runner tab inside Pomade | `src/ui/` |
| Scheduler | the always-on background part: a login item that keeps running when Pomade quits. It runs the scheduled scripts and git jobs — catching up what the Mac slept through as each job's missed-run policy says, a few low-priority runs at a time, held by the switch, stopped at their time limit — and those on hooks and chains: after each Mac login, when Pomade starts or a project is opened, and when another job is done or fails, restarting a service after it too; it pauses a job that fires in a runaway loop. A git job runs Pomade's `pomade-git` and keeps its result per repo. It keeps their history and output, posts the notices, and tells Pomade's Git panel which jobs target a repo | `src/scheduler/` |
| Keeper | holds every service's terminal session, so it outlives Pomade and the scheduler; Pomade's tabs attach to it. The scheduler starts and owns it, and supervises the services in it: starts them one by one — at Mac login, with Pomade, or on a project's first open, as each says — restarts a crashed one, gives up on a crash loop, leaves one you stopped stopped, and stops the ones bound to Pomade when it quits | `src/keeper/` |
| `pomade-runner` | the command line, on `PATH` through Pomade's command folder: `check` job files and the settings, list `projects`, `list` the jobs, `run` one now, show its `history`, show the `runs` going, `pause` and `resume`, `resume-job` one the loop guard paused, settle a job's `missed` runs, `enable` or `disable` one, show `services` and `stop` or `restart` one, show `sessions` | `src/jobs/cli/` |
| Skill `pomade-runner-jobs` | teaches agents to write job files; the scheduler keeps a copy in the workspace's skills folder and gives it to no agent | `app/skills/pomade-runner-jobs/`, `src/jobs/skill/` |

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

The e2e has these parts (the spec list is in `docs/modules/index.md` "The e2e specs"): the UI in
`pomade-kit`'s fake host · the scheduler and the command as processes · the keeper and its sessions
as processes · service supervision as processes · scheduled scripts as processes, on a set clock ·
missed runs and load as processes, on a set clock (sleep simulated by stopping the scheduler process
while its clock runs on) · chains and login hooks as processes (a login simulated by starting the
scheduler again) · git jobs as processes, through the Pomade checkout's real `pomade-git` with
Pomade closed, on throwaway repos (a bare remote and its clones, their own git configuration; an
agent at work simulated by a program named `claude` running in the repo) · Runner hosted by a real
Pomade, attached tabs, notices and the badge included · a missed run that waits for you in a real
Pomade · git jobs in a real Pomade, the Git panel's Scheduled line included · Pomade's hooks and
agent hooks in a real Pomade · services that run with Pomade over a Pomade quit and restart · agent
jobs against the fixture Agents app and the scripted fake agent · Pomade opened for an agent run ·
the install and uninstall scripts.

The git jobs and every part that runs a real Pomade need a Pomade checkout with its dependencies
installed and `npm run build` done: `POMADE_REPO`, default `../Pomade`.

```sh
POMADE_REPO=/path/to/Pomade npm run gate
```

That Pomade runs in test mode — an invisible window, no login items — on a temp workspace, user
data and home. A Pomade you are using is never touched.

`RUNNER_SHOTS=<folder> npm run test:e2e` also saves screenshots of every UI state.

## Install

```sh
./install
```

It builds Runner and runs `pomade apps install dist` (the `pomade` command of `POMADE_REPO`). The
target is the **dev** Pomade. Updating Runner is the same command: Pomade swaps the installed copy
and restarts the scheduler.

The install restarts the scheduler, which keeps a copy of the agent skill at
`<workspace>/<skills folder>/pomade-runner-jobs/SKILL.md` (the `skills-folder` setting, default
`Knowledge/_skills/apps/`; Settings shows it). Runner gives the skill to no agent: link or copy it into
the skills of the agents you choose, by hand or in the Agents app. Running the install again changes
nothing.

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

`./install --stable` installs into the stable Pomade. That happens only on the Owner's explicit word.

To remove Runner: `./uninstall` — it removes the app (`pomade apps remove pomade-runner`), then the
skill copy this Mac placed. `./uninstall --stable` is for the stable Pomade.

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
