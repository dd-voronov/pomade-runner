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
| Scheduler | the always-on background part: a login item that keeps running when Pomade quits | `src/scheduler/` |
| `pomade-runner` | the command line, on `PATH` through Pomade's command folder | `src/jobs/cli/` |

`npm run build` puts all of it into `dist/`, the folder Pomade installs: the UI, `manifest.json`,
and the scheduler and the command each bundled into one file, so the folder runs wherever it is
copied.

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

The e2e has four parts: the UI in `pomade-kit`'s fake host · the scheduler and the command as
processes · Runner hosted by a real Pomade · the install script.

The last two need a Pomade checkout with its dependencies installed and `npm run build` done:
`POMADE_REPO`, default `../Pomade`.

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

After it:
- Pomade shows the Runner icon on its left strip; the icon fills the side panel, and "Open Runner"
  opens the Runner tab.
- The scheduler runs as a login item of that Pomade. Its log is
  `<userData>/app-logs/pomade-runner/backend.log`.
- `pomade-runner --version` prints the version and whether the scheduler is running. New terminals
  find the command once Pomade's command folder is on `PATH` (Pomade ▸ Settings ▸ General ▸
  Commands).

`./install --stable` installs into the stable Pomade. That happens only on Daniil's explicit word.

To remove Runner: `pomade apps remove pomade-runner`.

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
