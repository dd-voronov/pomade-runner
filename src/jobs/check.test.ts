import { describe, expect, it } from "vitest";

import { checkJobs } from "./check";
import { formatJobError } from "./format";
import type { Job, JobError, JobsSnapshot, ProjectRecord } from "./model";
import { closest, parseDuration } from "./parse";

const PROJECTS: ProjectRecord[] = [
  { id: "p7Kx2_coda", name: "Coda Helper", root: "Projects/coda-helper" },
  { id: "p9Lq4_hunt", name: "Job hunt", root: "Projects/job-hunt" },
];

const file = (fields: string, body = ""): string => `---\n${fields}\n---\n${body}`;

function check(files: Record<string, string>, projects: ProjectRecord[] | null = PROJECTS): JobsSnapshot {
  return checkJobs(
    Object.entries(files).map(([path, text]) => ({ path, text })),
    { workspace: "/ws", projects },
  );
}

function errors(files: Record<string, string>, projects: ProjectRecord[] | null = PROJECTS): JobError[] {
  return check(files, projects).jobs.flatMap((entry) => (entry.valid ? [] : entry.invalid.errors));
}

function only(files: Record<string, string>, projects: ProjectRecord[] | null = PROJECTS): JobError {
  const found = errors(files, projects);
  expect(found.map((e) => formatJobError(e))).toEqual([expect.any(String)]);
  return found[0] as JobError;
}

function valid(path: string, text: string, projects: ProjectRecord[] | null = PROJECTS): Job {
  const snapshot = check({ [path]: text }, projects);
  const [entry] = snapshot.jobs;
  if (!entry?.valid) throw new Error(`invalid: ${JSON.stringify(entry?.invalid.errors.map((e) => formatJobError(e)))}`);
  return entry.job;
}

const SERVICE = "kind: service\nname: Coda web\nproject: p7Kx2_coda\nfolder: Projects/coda-helper\ncommand: ./start.sh";
const SCRIPT = "kind: script\nname: Backup\nfolder: .\ncommand: ./backup.sh\nschedule:\n  daily: { at: 13:00 }";

describe("valid job files", () => {
  it("reads a service with its defaults", () => {
    expect(valid("coda-helper/coda-web.md", file(SERVICE, "Notes.\n"))).toEqual({
      id: "coda-helper/coda-web",
      path: "Apps/pomade-runner/jobs/coda-helper/coda-web.md",
      kind: "service",
      name: "Coda web",
      project: "p7Kx2_coda",
      enabled: true,
      notify: "on-failure",
      lowPriority: false,
      body: "Notes.\n",
      folder: "Projects/coda-helper",
      command: "./start.sh",
      start: "login",
      ready: { kind: "alive" },
      after: null,
    });
  });

  it("reads a service's readiness, start and chain", () => {
    const pull = file("kind: git\nname: Pull\ngit: { operation: pull, repos: [coda-helper] }\nschedule:\n  every: { hours: 1 }");
    const withPull = (service: string): JobsSnapshot => check({ "coda-helper/coda-web.md": service, "pull.md": pull });
    expect(withPull(file(`${SERVICE}\nstart: project-first-open\nready: { port: 5173 }\nafter: { job: pull, result: any, action: stop }`)).jobs[0]).toMatchObject({
      valid: true,
      job: { start: "project-first-open", ready: { kind: "port", port: 5173 }, after: { job: "pull", result: "any", action: "stop" } },
    });
    expect(withPull(file(`${SERVICE}\nafter: { job: pull }`)).jobs[0]).toMatchObject({ valid: true, job: { after: { job: "pull", result: "done", action: "restart" } } });
    expect(valid("coda-helper/coda-web.md", file(`${SERVICE}\nready: { url: http://localhost:5173/ }`))).toMatchObject({ ready: { kind: "url", url: "http://localhost:5173/" } });
  });

  it("reads a scheduled script with its defaults and the schedule in words", () => {
    expect(valid("backup.md", file(SCRIPT))).toMatchObject({
      kind: "script",
      folder: "",
      notify: "on-failure",
      lowPriority: true,
      missed: "run-on-wake",
      worthUntil: "next-run",
      overlap: "skip",
      timeLimitMinutes: null,
      trigger: { kind: "schedule", words: "daily at 13:00" },
    });
  });

  it("reads every policy", () => {
    const job = valid(
      "backup.md",
      file(`${SCRIPT}\nmissed: run-on-wake\nworth-until: 12:00\noverlap: queue\ntime-limit: 1h30m\nlow-priority: false\nnotify: always\nenabled: false`),
    );
    expect(job).toMatchObject({ missed: "run-on-wake", worthUntil: "12:00", overlap: "queue", timeLimitMinutes: 90, lowPriority: false, notify: "always", enabled: false });
    expect(valid("backup.md", file(`${SCRIPT}\nmissed: wait-for-me`))).toMatchObject({ missed: "wait-for-me", worthUntil: null });
  });

  it("reads an agent job: the body is its prompt, mode defaults to normal, notify to always", () => {
    const job = valid("summary.md", file("kind: agent\nname: Morning summary\nfolder: .\nagent: claude\nschedule:\n  weekly: { days: [mon, tue, wed, thu, fri], at: 7:00 }", "\nSummarize today.\n"));
    expect(job).toMatchObject({ kind: "agent", agent: "claude", mode: "normal", prompt: "Summarize today.", notify: "always", lowPriority: true, missed: "run-on-wake" });
  });

  it("reads a git job, which has no folder, misses with skip and runs at normal priority", () => {
    const job = valid("knowledge.md", file("kind: git\nname: Knowledge commit\ngit: { operation: commit-push, repos: [Knowledge] }\nschedule:\n  daily: { at: [13:00, 20:00] }"));
    expect(job).toMatchObject({ kind: "git", git: { operation: "commit-push", repos: ["Knowledge"] }, missed: "skip", worthUntil: null, lowPriority: false });
    expect(valid("pull.md", file("kind: git\nname: Pull\ngit: { operation: pull, repos: coda-helper }\nhook: { event: pomade-started }"))).toMatchObject({ git: { repos: ["coda-helper"] } });
  });

  it("reads every hook, with its filters", () => {
    const hooks: Array<[string, object]> = [
      ["{ event: login }", { event: "login", project: null, agent: null, status: null }],
      ["{ event: pomade-started }", { event: "pomade-started" }],
      ["{ event: project-first-open, project: p9Lq4_hunt }", { event: "project-first-open", project: "p9Lq4_hunt" }],
      ["{ event: project-first-open }", { event: "project-first-open", project: null }],
      ["{ event: project-created }", { event: "project-created" }],
      ["{ event: session-finished, agent: claude, project: p9Lq4_hunt }", { event: "session-finished", agent: "claude", project: "p9Lq4_hunt" }],
      ["{ event: session-status, status: done }", { event: "session-status", status: "done" }],
    ];
    for (const [hook, expected] of hooks) {
      const job = valid("hooked.md", file(`kind: script\nname: Hooked\nfolder: .\ncommand: ./x.sh\nhook: ${hook}`));
      expect(job).toMatchObject({ trigger: { kind: "hook", hook: expected }, missed: null, worthUntil: null });
    }
  });

  it("reads a chain as a trigger", () => {
    const snapshot = check({ "a.md": file(SCRIPT), "b.md": file("kind: script\nname: B\nfolder: .\ncommand: ./b.sh\nafter: { job: a, result: failed }") });
    expect(snapshot.jobs[1]).toMatchObject({ valid: true, job: { trigger: { kind: "chain", chain: { job: "a", result: "failed" } }, missed: null } });
  });

  it("takes CRLF line endings, comments, quoted values and an empty field as its default", () => {
    const text = "---\r\nkind: script # what it is\r\nname: \"Backup\"\r\nfolder: '.'\r\ncommand: ./backup.sh\r\nnotify:\r\nschedule:\r\n  daily: { at: 13:00 }\r\n---\r\nBody\r\n";
    expect(valid("backup.md", text)).toMatchObject({ name: "Backup", notify: "on-failure", body: "Body\r\n" });
  });

  it("normalizes the folder: . is the workspace root, ./x and x/ are x", () => {
    for (const [folder, expected] of [[".", ""], ["./Projects/x", "Projects/x"], ["Projects/x/", "Projects/x"], ["Projects/./x", "Projects/x"]]) {
      expect(valid("backup.md", file(SCRIPT.replace("folder: .", `folder: ${folder}`)))).toMatchObject({ folder: expected });
    }
  });
});

describe("one file's problems: each names its line, its field and the fix", () => {
  interface Expected {
    line?: number;
    field?: string;
    problem?: RegExp | string;
    fix?: RegExp | string;
  }
  const matches = (actual: string, expected: RegExp | string | undefined): void => {
    if (typeof expected === "string") expect(actual).toBe(expected);
    else if (expected !== undefined) expect(actual).toMatch(expected);
  };
  const cases: Array<[string, string, Expected]> = [
    ["no frontmatter", "Just text\n", { line: 1, field: "", problem: "the file has no frontmatter block", fix: /start the file with a line ---/ }],
    ["an unclosed block", "---\nkind: script\n", { line: 1, problem: /never closed/, fix: /add a line ---/ }],
    ["invalid YAML", file("kind: script\nname: [Backup"), { line: 3, problem: /not valid YAML/, fix: /fix the YAML/ }],
    ["a field twice", file(`${SCRIPT}\nname: Again`), { line: 8, problem: "this field appears twice", fix: /keep one/ }],
    ["no fields", file("# only a comment"), { line: 2, problem: "the frontmatter holds no fields", fix: /kind:/ }],
    ["no kind", file("name: Backup"), { line: 2, field: "kind", problem: "the file says no kind", fix: /service, script, agent or git/ }],
    ["a bad kind", file("kind: scirpt\nname: Backup"), { line: 2, field: "kind", problem: '"scirpt" is not allowed', fix: "write script" }],
    ["no name", file("kind: script\nfolder: .\ncommand: ./x.sh\nhook: { event: login }"), { line: 2, field: "name", problem: "the job has no name", fix: /name: Coda web/ }],
    ["an empty name", file('kind: script\nname: " "\nfolder: .\ncommand: ./x.sh\nhook: { event: login }'), { line: 3, field: "name", problem: "is empty" }],
    ["a name that is a number", file("kind: script\nname: 2024\nfolder: .\ncommand: ./x.sh\nhook: { event: login }"), { line: 3, problem: "2024 reads as a number, not text", fix: 'put it in quotes: name: "2024"' }],
    ["an unknown field", file(`${SCRIPT}\ncolor: red`), { line: 8, field: "color", problem: "color is not a job field", fix: /remove it/ }],
    ["a misspelled field", file(`${SCRIPT}\nlow_priority: true`), { line: 8, field: "low_priority", problem: /not a job field/, fix: "rename it to low-priority" }],
    ["a camelCase field", file(`${SCRIPT}\ntimeLimit: 5m`), { fix: "rename it to time-limit" }],
    ["a field of another kind", file(`${SCRIPT}\nready: { port: 1 }`), { line: 8, field: "ready", problem: "a script job has no ready", fix: "remove it — ready is for service jobs" }],
    ["a git job with a folder", file("kind: git\nname: G\nfolder: .\ngit: { operation: pull, repos: [K] }\nhook: { event: login }"), { line: 4, field: "folder", problem: "a git job has no folder" }],
    ["a missing folder", file("kind: script\nname: B\ncommand: ./x.sh\nhook: { event: login }"), { line: 2, field: "folder", problem: "a script job needs folder", fix: "add folder: Projects/my-project" }],
    ["a folder outside the workspace", file(SCRIPT.replace("folder: .", "folder: ../elsewhere")), { line: 4, field: "folder", problem: /outside the workspace/ }],
    ["an absolute folder", file(SCRIPT.replace("folder: .", "folder: /Users/me")), { problem: /outside the workspace/ }],
    ["a folder with backslashes", file(SCRIPT.replace("folder: .", "folder: Projects\\x")), { problem: /backslashes/ }],
    ["a folder in .pomade", file(SCRIPT.replace("folder: .", "folder: .Pomade/state")), { problem: /inside .pomade/ }],
    ["a missing command", file("kind: script\nname: B\nfolder: .\nhook: { event: login }"), { field: "command", problem: "a script job needs command" }],
    ["a bad notify", file(`${SCRIPT}\nnotify: sometimes`), { line: 8, field: "notify", problem: '"sometimes" is not allowed', fix: "use one of always, on-failure or never" }],
    ["a misspelled notify", file(`${SCRIPT}\nnotify: on-failur`), { fix: "write on-failure" }],
    ["enabled that is not a flag", file(`${SCRIPT}\nenabled: yes`), { field: "enabled", problem: '"yes" is not true or false', fix: "write enabled: true or enabled: false" }],
    ["low-priority that is not a flag", file(`${SCRIPT}\nlow-priority: 1`), { field: "low-priority" }],
    ["no trigger", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh"), { line: 2, field: "kind", problem: "a script job needs a trigger", fix: /schedule:.*hook:.*after:/ }],
    ["two triggers", file(`${SCRIPT}\nhook: { event: login }`), { line: 8, field: "hook", problem: "a job has one trigger, and this one has schedule and hook", fix: "keep one of them" }],
    ["a schedule with a bad weekday", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nschedule:\n  weekly:\n    days: [mon, fry]\n    at: 7:00"), { line: 8, field: "schedule.weekly.days[1]", problem: '"fry" is not a weekday', fix: /mon, tue/ }],
    ["a schedule with a bad time", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nschedule:\n  daily: { at: 25:00 }"), { line: 7, field: "schedule.daily.at", problem: /"25:00" is not a time/ }],
    ["a schedule with no shape", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nschedule:\n  only: weekdays"), { line: 6, field: "schedule", problem: "no schedule shape" }],
    ["a schedule that is not a mapping", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nschedule: every day"), { line: 6, field: "schedule", problem: /expected a mapping/ }],
    ["a schedule with a key it does not take", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nschedule:\n  daily: { at: 7:00 }\n  cron: 0 7 * * *"), { line: 8, field: "schedule.cron", problem: "unknown key", fix: /a schedule takes one of once, every/ }],
    ["a schedule with no time", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nschedule:\n  weekly: { days: [mon] }"), { field: "schedule.weekly.at" }],
    ["a schedule that is always", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nschedule:\n  always: true"), { line: 7, field: "schedule.always", problem: "always is for services", fix: /kind: service/ }],
    ["a schedule with lead-days", file(`${SCRIPT}\n  lead-days: 2`), { field: "schedule.lead-days", problem: "only for Planner items" }],
    ["a hook that is not a mapping", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nhook: login"), { line: 6, field: "hook", problem: '"login" is not a hook', fix: /hook: \{ event: login \}/ }],
    ["a hook with no event", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nhook: { agent: claude }"), { field: "hook", problem: "names no event" }],
    ["a hook with a bad event", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nhook: { event: logon }"), { field: "hook.event", fix: "write login" }],
    ["a hook filter its event does not take", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nhook: { event: login, project: p9Lq4_hunt }"), { field: "hook.project", problem: "the login hook has no project filter", fix: "remove it" }],
    ["a status filter on session-finished", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nhook: { event: session-finished, status: done }"), { field: "hook.status", fix: "remove it — this hook filters by project or agent" }],
    ["an unknown hook key", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nhook: { event: login, when: now }"), { field: "hook.when", problem: "the login hook does not take when" }],
    ["session-status with no status", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nhook: { event: session-status }"), { field: "hook", problem: "the session-status hook needs a status" }],
    ["session-status with a bad status", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nhook: { event: session-status, status: Done }"), { field: "hook.status", fix: "write done" }],
    ["an empty hook agent", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nhook: { event: session-finished, agent: '' }"), { field: "hook.agent", problem: "is empty" }],
    ["missed on a hook job", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nhook: { event: login }\nmissed: skip"), { line: 7, field: "missed", problem: "only a scheduled job can miss a run" }],
    ["a bad missed", file(`${SCRIPT}\nmissed: later`), { field: "missed", fix: "use one of run-on-wake, wait-for-me or skip" }],
    ["worth-until without run-on-wake", file(`${SCRIPT}\nmissed: skip\nworth-until: 12:00`), { line: 9, field: "worth-until", problem: "only applies with missed: run-on-wake", fix: /set missed: run-on-wake/ }],
    ["worth-until that is no time", file(`${SCRIPT}\nworth-until: noon`), { field: "worth-until", problem: '"noon" is not a time of day' }],
    ["a git job's default skip with worth-until", file("kind: git\nname: G\ngit: { operation: pull, repos: [K] }\nschedule:\n  daily: { at: 13:00 }\nworth-until: 12:00"), { field: "worth-until" }],
    ["a bad overlap", file(`${SCRIPT}\noverlap: wait`), { field: "overlap", fix: "use one of skip, parallel or queue" }],
    ["a time limit with no unit", file(`${SCRIPT}\ntime-limit: 45`), { field: "time-limit", problem: "45 has no unit", fix: /45m.*45h/ }],
    ["a time limit that is no duration", file(`${SCRIPT}\ntime-limit: soon`), { field: "time-limit", problem: '"soon" is not a duration' }],
    ["a zero time limit", file(`${SCRIPT}\ntime-limit: 0m`), { field: "time-limit" }],
    ["a service with a schedule", file(`${SCRIPT.replace("kind: script", "kind: service")}`), { field: "schedule", problem: "a service job has no schedule" }],
    ["a bad start", file(`${SERVICE}\nstart: boot`), { field: "start", fix: "use one of login or project-first-open" }],
    ["project-first-open without a project", file("kind: service\nname: W\nfolder: .\ncommand: ./w.sh\nstart: project-first-open"), { field: "start", problem: /has no project/ }],
    ["ready that is not a mapping", file(`${SERVICE}\nready: 5173`), { field: "ready", problem: "5173 is not a readiness check" }],
    ["ready with both checks", file(`${SERVICE}\nready: { port: 1, url: http://x/ }`), { field: "ready", problem: "has both port and url" }],
    ["ready with no check", file(`${SERVICE}\nready: {}`), { field: "ready", problem: "names no check" }],
    ["ready with a bad port", file(`${SERVICE}\nready: { port: 70000 }`), { line: 7, field: "ready.port", problem: "70000 is not a port" }],
    ["ready with a bad url", file(`${SERVICE}\nready: { url: localhost:5173 }`), { field: "ready.url", problem: /not a web address/ }],
    ["ready with an unknown check", file(`${SERVICE}\nready:\n  port: 5173\n  tcp: true`), { line: 9, field: "ready.tcp", problem: "ready does not take tcp" }],
    ["a chain that is not a mapping", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nafter: backup"), { field: "after", problem: '"backup" is not a chain', fix: /after: \{ job: backup/ }],
    ["a chain with no job", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nafter: { result: done }"), { field: "after", problem: "names no job" }],
    ["a chain naming a file", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nafter: { job: backup.md }"), { field: "after.job", problem: '"backup.md" is a file name', fix: /without .md: backup/ }],
    ["a chain naming no job id", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nafter: { job: My Backup }"), { field: "after.job", problem: /is not a job id/ }],
    ["a chain with a bad result", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nafter: { job: x, result: ok }"), { field: "after.result", fix: "use one of done, failed or any" }],
    ["a non-service chain with an action", file("kind: script\nname: B\nfolder: .\ncommand: ./x.sh\nafter: { job: x, action: restart }"), { field: "after.action", problem: "after does not take action" }],
    ["a service chain with a bad action", file(`${SERVICE}\nafter: { job: x, action: reboot }`), { field: "after.action", fix: "use one of restart, start or stop" }],
    ["an agent job with no agent", file("kind: agent\nname: A\nfolder: .\nhook: { event: login }", "Do it."), { field: "agent", problem: "an agent job needs agent" }],
    ["an agent id with a slash", file("kind: agent\nname: A\nfolder: .\nagent: x/y\nhook: { event: login }", "Do it."), { field: "agent", problem: '"x/y" is not an agent id' }],
    ["an agent job with an empty prompt", file("kind: agent\nname: A\nfolder: .\nagent: claude\nhook: { event: login }", "\n  \n"), { line: 2, field: "", problem: /the body is empty/, fix: /below the closing ---/ }],
    ["an empty mode", file("kind: agent\nname: A\nfolder: .\nagent: claude\nmode: ''\nhook: { event: login }", "Do it."), { field: "mode", problem: "is empty" }],
    ["a git job with no git", file("kind: git\nname: G\nhook: { event: login }"), { field: "git", problem: "a git job needs git" }],
    ["git that is not a mapping", file("kind: git\nname: G\ngit: pull\nhook: { event: login }"), { field: "git", problem: '"pull" is not a git operation' }],
    ["git with no operation", file("kind: git\nname: G\ngit: { repos: [K] }\nhook: { event: login }"), { field: "git", problem: "names no operation" }],
    ["git with a bad operation", file("kind: git\nname: G\ngit: { operation: sync, repos: [K] }\nhook: { event: login }"), { field: "git.operation", fix: "use one of commit-push, pull, push or fetch" }],
    ["git with no repos", file("kind: git\nname: G\ngit: { operation: pull }\nhook: { event: login }"), { field: "git", problem: "names no repos" }],
    ["git with an empty repo list", file("kind: git\nname: G\ngit: { operation: pull, repos: [] }\nhook: { event: login }"), { field: "git.repos", problem: "names no repos" }],
    ["git with a repo twice", file("kind: git\nname: G\ngit:\n  operation: pull\n  repos:\n    - K\n    - K\nhook: { event: login }"), { line: 8, field: "git.repos[1]", problem: "K is listed twice" }],
    ["git with a bad repo", file("kind: git\nname: G\ngit: { operation: pull, repos: [K, 3] }\nhook: { event: login }"), { field: "git.repos[1]", problem: "3 is not a repo name" }],
    ["git with an unknown key", file("kind: git\nname: G\ngit: { operation: pull, repos: [K], branch: main }\nhook: { event: login }"), { field: "git.branch", problem: "git does not take branch" }],
    ["git with a repo pomade-git would read as an option", file("kind: git\nname: G\ngit: { operation: pull, repos: [K, --force] }\nhook: { event: login }"), { field: "git.repos[1]", problem: '"--force" starts with -, which pomade-git reads as an option' }],
    ["git with one repo pomade-git would read as an option", file("kind: git\nname: G\ngit: { operation: pull, repos: -x }\nhook: { event: login }"), { field: "git.repos", problem: '"-x" starts with -, which pomade-git reads as an option' }],
    ["a git job's name longer than its commits take", file(`kind: git\nname: ${"n".repeat(101)}\ngit: { operation: pull, repos: [K] }\nhook: { event: login }`), { line: 3, field: "name", problem: "a git job's name is at most 100 characters — its commits name the job — and this one has 101" }],
  ];

  for (const [what, text, expected] of cases) {
    it(what, () => {
      const path = text.includes("project: p7Kx2_coda") ? "coda-helper/job.md" : "job.md";
      // `x` is a job a chain may name.
      const error = only({ [path]: text, "x.md": file("kind: script\nname: X\nfolder: .\ncommand: ./x.sh\nhook: { event: login }") });
      const { problem, fix, ...rest } = expected;
      expect(error).toMatchObject(rest);
      matches(error.problem, problem);
      matches(error.fix, fix);
    });
  }

  it("reports every problem of a file, in line order", () => {
    const found = errors({ "job.md": file("kind: script\nname: B\nfolder: /abs\ncommand: ''\nhook: { event: logon }\nnotify: loud") });
    expect(found.map((e) => [e.line, e.field])).toEqual([
      [4, "folder"],
      [5, "command"],
      [6, "hook.event"],
      [7, "notify"],
    ]);
  });

  it("a file with an unknown kind still reports its unknown fields and its name", () => {
    const found = errors({ "job.md": file("kind: cron\ncolour: red") });
    expect(found.map((e) => e.field)).toEqual(["kind", "name", "colour"]);
  });
});

describe("where a file sits", () => {
  it("a file name that is not a slug", () => {
    const error = only({ "My Backup.md": file(SCRIPT) });
    expect(error).toMatchObject({ path: "Apps/pomade-runner/jobs/My Backup.md", line: 1, field: "", problem: 'the file name is the job\'s slug, and "My Backup" is not one', fix: "rename the file to my-backup.md — lower-case letters, digits and dashes" });
  });

  it("a job id too long to name its terminal session", () => {
    const longest = "a".repeat(101);
    expect(valid(`${longest}.md`, file(SCRIPT)).id).toBe(longest);
    expect(only({ [`${longest}b.md`]: file(SCRIPT) })).toMatchObject({
      line: 1,
      field: "",
      problem: `the job's id "${longest}b" is too long to name its terminal session (102 characters; 101 at most, a character other than a letter, a digit or - counting 3 or more)`,
      fix: "rename the file to a shorter slug",
    });
  });

  it("a file two sub-folders deep", () => {
    const error = only({ "coda-helper/old/web.md": file(SERVICE) }, null);
    expect(error).toMatchObject({ line: 1, problem: /one sub-folder deep/, fix: "move it to Apps/pomade-runner/jobs/coda-helper/web.md" });
  });

  it("a project job outside its sub-folder, a workspace job inside one", () => {
    expect(only({ "web.md": file(SERVICE) })).toMatchObject({ line: 4, field: "project", problem: /at the top of the jobs folder/ });
    expect(only({ "coda-helper/backup.md": file(SCRIPT) }, null)).toMatchObject({ line: 2, field: "project", problem: /coda-helper\/ sub-folder, which holds project jobs, and says no project/, fix: /pomade-runner projects/ });
  });

  it("a file that cannot be read", () => {
    const snapshot = checkJobs([{ path: "x.md", readError: "EACCES: permission denied" }], { workspace: null, projects: null });
    expect(snapshot.jobs[0]).toMatchObject({ valid: false, invalid: { id: "x", errors: [{ line: 1, problem: "the file cannot be read: EACCES: permission denied" }] } });
  });
});

describe("projects", () => {
  it("an unknown project id, with the project its sub-folder belongs to as the fix", () => {
    expect(only({ "coda-helper/web.md": file(SERVICE.replace("p7Kx2_coda", "nope")) })).toMatchObject({
      line: 4,
      field: "project",
      problem: "Pomade has no project with the id nope",
      fix: "write project: p7Kx2_coda (Coda Helper)",
    });
    expect(only({ "elsewhere/web.md": file(SERVICE.replace("p7Kx2_coda", "nope")) }).fix).toMatch(/pomade-runner projects/);
  });

  it("a project job in another project's sub-folder", () => {
    expect(only({ "job-hunt/web.md": file(SERVICE) })).toMatchObject({
      field: "project",
      problem: "the job belongs to Coda Helper, whose jobs sit in Apps/pomade-runner/jobs/coda-helper/",
      fix: "move the file to Apps/pomade-runner/jobs/coda-helper/web.md, or fix project:",
    });
  });

  it("an unknown project in a hook", () => {
    expect(only({ "x.md": file("kind: script\nname: X\nfolder: .\ncommand: ./x.sh\nhook: { event: project-first-open, project: gone }") })).toMatchObject({ line: 6, field: "hook.project" });
  });

  it("goes unchecked while Pomade's projects are not known, and says so", () => {
    const snapshot = check({ "elsewhere/web.md": file(SERVICE.replace("p7Kx2_coda", "nope")) }, null);
    expect(snapshot.projectsChecked).toBe(false);
    expect(snapshot.jobs[0]?.valid).toBe(true);
    expect(check({}).projectsChecked).toBe(true);
  });
});

describe("across files", () => {
  const chained = (id: string, after: string): string => file(`kind: script\nname: ${id.toUpperCase()}\nfolder: .\ncommand: ./${id}.sh\nafter: { job: ${after} }`);

  it("a chain to a job that does not exist, with the closest id as the fix", () => {
    expect(only({ "backup.md": file(SCRIPT), "b.md": chained("b", "bakup") })).toMatchObject({ path: "Apps/pomade-runner/jobs/b.md", line: 6, field: "after.job", problem: "no job has the id bakup", fix: "write backup" });
  });

  it("a chain that follows a service", () => {
    expect(only({ "coda-helper/web.md": file(SERVICE), "b.md": chained("b", "coda-helper/web") })).toMatchObject({ field: "after.job", problem: /is a service/ });
  });

  it("a job that follows itself", () => {
    expect(only({ "a.md": chained("a", "a") })).toMatchObject({ field: "after.job", problem: "the job follows itself, so it would run forever" });
  });

  it("a chain that loops back, reported on every job in the loop", () => {
    const found = errors({ "a.md": chained("a", "b"), "b.md": chained("b", "c"), "c.md": chained("c", "a"), "d.md": chained("d", "a") });
    expect(found.map((e) => `${e.path} ${e.problem}`)).toEqual([
      "Apps/pomade-runner/jobs/a.md the chain loops back: a → b → c → a",
      "Apps/pomade-runner/jobs/b.md the chain loops back: a → b → c → a",
      "Apps/pomade-runner/jobs/c.md the chain loops back: a → b → c → a",
    ]);
    expect(errors({ "a.md": chained("a", "b"), "b.md": chained("b", "a") })).toHaveLength(2);
  });

  it("a loop a service chain cannot be part of: a service is never followed", () => {
    const found = errors({ "coda-helper/web.md": file(`${SERVICE}\nafter: { job: a }`), "a.md": chained("a", "coda-helper/web") });
    expect(found.map((e) => e.problem)).toEqual(["coda-helper/web is a service, and a service never finishes"]);
  });

  it("two jobs with the same name, case aside", () => {
    const found = errors({ "a.md": file(SCRIPT), "b.md": file(SCRIPT.replace("Backup", "backup")) });
    expect(found.map((e) => e.problem)).toEqual(["Backup is also the name of Apps/pomade-runner/jobs/b.md", "backup is also the name of Apps/pomade-runner/jobs/a.md"]);
  });

  it("lists files by path, invalid ones kept with what is known of them", () => {
    const snapshot = check({ "z.md": file(SCRIPT.replace("Backup", "Z")), "coda-helper/web.md": file(`${SERVICE}\nready: nope`) });
    expect(snapshot.jobs.map((e) => (e.valid ? e.job.id : e.invalid.id))).toEqual(["coda-helper/web", "z"]);
    expect(snapshot.jobs[0]).toMatchObject({ valid: false, invalid: { name: "Coda web", kind: "service", project: "p7Kx2_coda" } });
  });
});

describe("helpers", () => {
  it("parses durations", () => {
    expect([parseDuration("45m"), parseDuration("2h"), parseDuration("1h30m"), parseDuration(" 1h 5m "), parseDuration("0h"), parseDuration("m"), parseDuration("5s")]).toEqual([45, 120, 90, 65, null, null, null]);
  });

  it("finds the closest name", () => {
    expect([closest("comand", ["command", "folder"]), closest("timeLimit", ["time-limit"]), closest("xyz", ["command"])]).toEqual(["command", "time-limit", null]);
  });
});

it("formats an error as one line an agent can act on", () => {
  const error: JobError = { path: "Apps/pomade-runner/jobs/a.md", line: 7, field: "schedule.daily.at", problem: '"25:00" is not a time', fix: "write a time like 7:00" };
  expect(formatJobError(error)).toBe('Apps/pomade-runner/jobs/a.md:7: schedule.daily.at — "25:00" is not a time. Fix: write a time like 7:00.');
  expect(formatJobError({ ...error, field: "" }, "a.md")).toBe('a.md:7: "25:00" is not a time. Fix: write a time like 7:00.');
});
