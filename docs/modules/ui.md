---
doc: docs/modules/ui.md
audience: engineers, product
holds: the ui module — what it does and its rules, the file map of `src/ui/`, invariants, tests, known limits
kind: reference
---

# Module: ui

The UI is one React bundle that Pomade opens on three surfaces: the Runner side panel, the Runner
tab and — a tab kind of its own — a run's output tab. `main.tsx` connects to Pomade's Host API and
`App.tsx` picks the frame from the connection's surface: no host (a plain browser) and a refused
connection are one-screen messages. Everything the UI knows comes from Runner's API through Pomade's
broker (`jobs.list`, `services.list`, `runs.list`, `history.list`, `runs.get`, `runs.output`,
`settings.get`, `environment.get`, and the actions) and from Pomade (projects, repos, the route);
`src/ui/useRunnerApi.ts` holds the live reads, each asked again on the scheduler's change event.
The look is light only, on the tokens of the approved prototype.

The design is in [DESIGN](../DESIGN.md) "UI" (side panel, Runner tab, routes, result card, the
output tab, job form, deleting a job, help) — this page is the code map and what a change must keep true.

## What it does and its rules

- **No state of its own about jobs.** The scheduler owns the jobs and runs; the UI reads them and asks
  for actions. The job form writes job files through the Host API (`jobFiles.ts`) and re-reads the
  file on every change on disk; the file is the truth.
- **One validator.** The form checks the text it would write with `checkJobAmong` (`src/jobs/check.ts`)
  and shows each error on its field in `describeJobError`'s words. It keeps no copy of the format's rules.
- **Routes.** The tab's view is a route (`parseRoute` in `src/integrations/runner-api.ts`): Jobs, a marked
  job, History, Services, Settings, a run's card, a waiting run's prompt, a run's output, New job,
  Edit job. The tab follows Pomade's `route.changed` and tells Pomade each route it goes to by itself.
- **Every non-obvious field, policy and status carries an (i) help** with an example; the texts are in
  `help.ts`, keyed `<area>.<what>`. A new key is added there and nowhere else.
- **Tooltips** are one layer per surface: `data-tip` (a line) or `data-help` (a help key) on any element.
- **A view extends a kit primitive** (`kit/`) rather than forking it.
- **Output tab** (`OutputPage.tsx`): a keyed Pomade tab per run, "<job> · output", with Copy; it closes
  itself when its run is gone from the history.

## File map

| File | Holds |
|---|---|
| `main.tsx`, `App.tsx`, `index.html` | the entry, the frame choice, the page |
| `Panel.tsx`, `shell/PanelShell.tsx` | the side panel and its frame: the switch pinned on top, sections, Open Runner at the foot |
| `SwitchControl.tsx` | the three-position switch |
| `NeedsYou.tsx` | Needs you's cards and their actions |
| `RunningNow.tsx`, `ActiveRunsList.tsx` | Running now: services and runs going; a row opens its tab, terminal or card |
| `NextUp.tsx`, `runWords.ts` | Next up and "in 40 min" |
| `panelWords.ts` | the panel's words: a Needs-you card's look, a moment ahead or past, a run's age |
| `RunnerTab.tsx`, `shell/TabShell.tsx` | the Runner tab and its frame: the four views, the route, the "This project" chip, New job |
| `JobsView.tsx`, `jobWords.ts`, `JobsProblem.tsx` | the Jobs view; its Last result and Next run cells; the scheduler-not-running and unreadable-jobs messages |
| `DeleteJobDialog.tsx` | the Delete confirm, shared by the row and the form |
| `ServicesView.tsx`, `serviceWords.ts` | the Services view; a service's state in words |
| `HistoryView.tsx`, `useHistoryPages.ts`, `runLook.ts` | History: filters, day heads, pages of 100; a run's look (dot, words, pill, filter, duration) |
| `RunCard.tsx`, `MessageText.tsx`, `RunAtField.tsx` | the result card for every run state; an agent's message drawn as text, never as HTML; Run at…'s field |
| `OutputPage.tsx`, `useRunOutput.ts` | a run's output tab; a run's output, followed while it runs |
| `SettingsView.tsx` | Settings: the four steppers, the read-only rows, the files |
| `form/JobForm.tsx` | the form's page: head, Kind, kind sections, Policies, the Save bar, following the file |
| `form/state.ts` | the form's state (pure): values, what the person set, the file as last read, the fields each kind writes (`FORM_KINDS`) |
| `form/kinds.tsx` | each kind's card, sections, policy rows and Create button (`KIND_UI`) |
| `form/TriggerSection.tsx` | On a schedule / When something happens: the schedule editor, the Event list and its filters, a service's chain line |
| `form/schedule.ts` | the schedule editor's values and their canonical lines (pure) |
| `form/triggerWords.ts` | the Event list (`EVENT_CHOICES`), the pickers (jobs, projects, statuses, agents) and the trigger in words under the editor (pure) |
| `form/policies.ts` | the policies' words in the one-sentence summary (pure) |
| `form/FolderField.tsx`, `form/FormSection.tsx` | the Folder field and picker; a form section |
| `jobFiles.ts` | the form's job-file writes through the Host API: create under a free slug, field-only changes, follow the file |
| `useRunnerApi.ts` | Runner's API, live; Pomade's projects, repos (`git.read`), the open project, the tab's route |
| `useAgents.ts` | the Agents app through the broker: the roster, the projects connected to an agent, a session's last message |
| `useAction.ts`, `useNow.ts` | the latest failure of a click; the Mac's clock, read again |
| `help.ts` | every help text |
| `EmptyState.tsx` | a centred message for a surface with nothing to list |
| `tokens.css`, `base.css`, `*.module.css` | the design tokens (light only), base styles, each component's styles |
| `kit/` | the primitives: `Button`, `Check`, `Chip`, `DayButton`, `Dialog` (with the confirm), `EmptyBlock`, `Field`, `Help`, `Icon` and `icons.ts`, `IconButton`, `Menu`, `PanelCard`, `PanelRow`, `Section`, `Segmented` (the switch included), `Status`, `Stepper`, `Table`, `Tag`, `Toast`, `Toggle`, `Tooltip`, `useFocusTrap`; `index.ts` exports them |

## Keys

The kit gives these keyboard behaviours: Esc closes a dialog, a menu and a tooltip (a dialog traps
Tab and Shift+Tab); Run at…'s field closes on Esc without closing the dialog around it; a menu moves
with the arrow keys, Home and End; a stepper changes by arrow up and down; a History row and a
clickable table cell open on Enter or Space. There are no app-wide shortcuts.

## Invariants

- A form change writes only the fields whose value differs from the file as last read; comments, unknown
  fields and the body stay. A schedule the person left alone is never written.
- Switching kind keeps what the person set and resets the kind-dependent defaults they left alone.
- A job file the form cannot read (broken frontmatter, an unknown kind) opens a page that says so, with Open file.
- A refused action shows the scheduler's `reason` ("Could not <do it> <job>: <why>"); a missing scheduler
  is said on the surface ("Runner's scheduler is not running").
- The Delete confirm names the file and says what happens to a running service before it acts.

## Tests

Unit (vitest) for the pure parts: `form/policies`, `form/schedule`, `form/state`, `form/triggers`,
`help`, `jobFiles`, `jobWords`, `panelWords`, `runLook`, `runWords`, `serviceWords`. E2E: `ui.spec.ts` drives
the built page in pomade-kit's fake host (`e2e/harness/`) and in a plain browser, `RUNNER_SHOTS=<dir>`
saves a screenshot of every state; `pomade.spec.ts`, `pomade-git.spec.ts`, `pomade-hooks.spec.ts`
and `pomade-agents.spec.ts` drive it inside a real Pomade.

## Known limits

- Light theme only, whatever the system's colour scheme.
- A long-run warning set under an hour in the file shows in minutes and the stepper starts at one hour.
- History counts under a filter are of the runs loaded so far while older pages remain ("3+").
- Without the Agents app, the job form cannot offer agents or modes: it keeps the file's and says so.
