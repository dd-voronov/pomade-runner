// The agents' hooks in a real Pomade (E-007 acceptance 4, 5; T-014): the Pomade checkout's built app
// (`POMADE_REPO`) in test mode on a temp workspace, user data and home, with the built `dist/` and
// the fixture Agents app (`fixtures/agents-app/`) dev-linked; the scheduler started the way the
// login item starts it (`pomade.spec.ts`). The fixture app is the test publisher: `test.publish`
// puts the Agents app's events B `session.closed` and C `session.statusChanged` on Pomade's bus,
// and it publishes B for a Runner agent run that finished, as the real app does. A session that
// ends fires "Agent session finished" with the session in the run's environment; a Runner agent
// job finishing does not; marking a session Done runs the Session Analyzer on its transcript; a
// payload that is not the contract's is ignored.

import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { connectSocket } from "pomade-kit/node";
import type { JsonValue } from "pomade-kit/protocol";

import manifest from "../app/manifest.json" with { type: "json" };
import { callScheduler } from "../src/scheduler/control/client";
import type { RunRecord } from "../src/scheduler/model";
import { runTriggerWords } from "../src/scheduler/model";
import { AGENTS_APP, fakeAgents } from "./support/agents";
import { DIST, cleanEnv, removeDir, run, tempDir } from "./support/env";
import { expectNothingLeft, stopKeeper } from "./support/keeper";
import { pomadeCheckout, pomadeEnv, type PomadeFolders } from "./support/pomade";
import { startSchedulerProcess, type SchedulerProcess } from "./support/scheduler";

const NOTES = "proj-notes";

test.describe("the agents' hooks in Pomade", () => {
  test.describe.configure({ mode: "serial" });

  const pomade = pomadeCheckout();
  let tmp: string;
  let user: string;
  let folders: PomadeFolders;
  let jobs: string;
  let notes: string;
  let app: ElectronApplication | null = null;
  let scheduler: SchedulerProcess | null = null;
  let keeperSocket: string;
  const socket = (): string => join(folders.userData, "app-state", manifest.id, "scheduler.sock");

  const script = (name: string, command: string, hook: string): string => `---\nkind: script\nname: ${name}\nfolder: .\ncommand: ${JSON.stringify(command)}\nhook: ${hook}\nlow-priority: false\noverlap: parallel\n---\n`;

  test.beforeAll(async () => {
    tmp = await tempDir();
    user = join(tmp, "user");
    folders = { workspace: join(tmp, "ws"), userData: join(tmp, "ud"), home: join(tmp, "home") };
    keeperSocket = join(folders.userData, "run", "keepers", `${manifest.id}.sock`);
    jobs = join(folders.workspace, "Apps/pomade-runner/jobs");
    await mkdir(jobs, { recursive: true });
    await mkdir(join(folders.workspace, "Projects/notes"), { recursive: true });
    notes = await realpath(join(folders.workspace, "Projects/notes"));
    await fakeAgents(user, join(tmp, "bin"));
    // No warm-up: the hook runs start as soon as the services are up.
    await writeFile(join(folders.workspace, "Apps/pomade-runner/settings.yaml"), "warm-up: 0m\n");
    await writeFile(join(jobs, "lint.md"), script("Lint after session", 'echo "lint $POMADE_SESSION_ID $POMADE_AGENT $POMADE_PROJECT $POMADE_PROJECT_PATH $POMADE_SESSION_STATUS $POMADE_SESSION_TRANSCRIPT"', "{ event: session-finished, agent: claude }"));
    await writeFile(join(jobs, "analyzer.md"), script("Session Analyzer", 'echo "analyzing $POMADE_SESSION_ID"; cat "$POMADE_SESSION_TRANSCRIPT"', "{ event: session-status, status: done }"));
    await writeFile(join(jobs, "nightly.md"), `---\nkind: agent\nname: Nightly\nfolder: Projects/notes\nagent: claude\nschedule:\n  once: 2099-01-01 7:00\n---\nTidy the notes.\n`);
    app = await electron.launch({ executablePath: pomade.runtime, args: [pomade.main], env: pomadeEnv(folders, { POMADE_DEV_APPS: `${DIST};${AGENTS_APP}`, HOME: user }) });
    const page = await app.firstWindow();
    await page.waitForURL("**/index.html");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    // Pomade's projects: notes, so the session's project has a name and a folder.
    await page.evaluate(
      ([id, path]) => {
        const state = (window as unknown as { __pomadeStores: { useWorkspaceStore: { getState(): Record<string, (...args: unknown[]) => void> } } }).__pomadeStores.useWorkspaceStore.getState();
        state.addProject?.({ id, name: "Notes", rootPath: path, visibleAgents: ["*"], order: 0 });
      },
      [NOTES, "Projects/notes"] as const,
    );
    const host = JSON.parse(await readFile(join(folders.home, "host.json"), "utf8")) as { socket: string };
    scheduler = startSchedulerProcess(
      pomade.runtime,
      join(DIST, manifest.backend.entry),
      cleanEnv({
        ELECTRON_RUN_AS_NODE: "1",
        POMADE_APP_ID: manifest.id,
        POMADE_APP_KEY_FILE: join(folders.userData, "app-keys", manifest.id),
        POMADE_CLIENT: "backend",
        POMADE_SOCKET: host.socket,
        POMADE_KEEPER_SOCKET: keeperSocket,
        POMADE_HOME: folders.home,
        POMADE_RUNNER_TICK_MS: "50",
        HOME: user,
        SHELL: "/bin/sh",
      }),
    );
    const started = scheduler;
    await expect.poll(() => started.output()).toContain("connected to Pomade");
  });

  test.afterAll(async () => {
    await scheduler?.kill();
    await app?.close();
    await stopKeeper(keeperSocket);
    await expectNothingLeft(tmp);
    await removeDir(tmp);
  });

  async function history(job: string): Promise<RunRecord[]> {
    const result = await callScheduler(socket(), "history", { job, limit: 50 });
    return result.status === "ok" ? result.value.records : [];
  }

  /** The Agents app's test publisher: puts `event` on Pomade's bus with `payload`, as the app would. */
  async function publish(event: "session.closed" | "session.statusChanged", payload: Record<string, JsonValue>): Promise<void> {
    const host = JSON.parse(await readFile(join(folders.home, "host.json"), "utf8")) as { socket: string };
    const result = await connectSocket({ socketPath: host.socket, appId: manifest.id, keyFile: join(folders.userData, "app-keys", manifest.id), role: "backend" });
    if (result.status !== "connected") throw new Error(`Runner's connection to Pomade: ${result.status}`);
    try {
      await result.host.apps.call("pomade-agents", "test.publish", { event, payload });
    } finally {
      result.host.close();
    }
  }

  /** A session event's payload (`../pomade-agents/docs/CONTRACTS.md` "Published events"). */
  const session = (more: Record<string, JsonValue>): Record<string, JsonValue> => ({
    sessionId: "s-tab",
    provider: "claude-code",
    agent: "claude",
    project: { id: NOTES, root: "Projects/notes" },
    cwd: notes,
    transcript: join(user, ".claude/projects/notes/s-tab.jsonl"),
    name: null,
    status: "active",
    startedByRunner: false,
    job: null,
    at: new Date().toISOString(),
    ...more,
  });

  test("4 · an interactive claude session that ends fires Agent session finished, with the session in the run's environment; a Runner agent job finishing does not", async () => {
    await publish("session.closed", session({ reason: "exit" }));
    await expect.poll(async () => (await history("lint")).length, { timeout: 30_000 }).toBe(1);
    const [record] = await history("lint");
    expect(record?.lastLines.join("\n")).toContain(`lint s-tab claude ${NOTES} ${join(folders.workspace, "Projects/notes")} active ${join(user, ".claude/projects/notes/s-tab.jsonl")}`);
    expect(record && runTriggerWords(record)).toBe("hook: agent session finished");
    expect(record?.cause).toMatchObject({ kind: "hook", event: "session-finished", projectName: "Notes" });

    // A Runner agent run: its end makes the Agents app publish B with the started-by-Runner flag.
    const ran = await run(join(folders.home, "bin", "pomade-runner"), ["run", "nightly"], { env: cleanEnv({ HOME: user }), cwd: tmp });
    expect(ran.stderr).toBe("");
    await expect.poll(async () => (await history("nightly")).length, { timeout: 30_000 }).toBe(1);
    const [nightly] = await history("nightly");
    expect(nightly?.state).toBe("done");
    const sessionId = nightly?.agent?.sessionId ?? "";
    await expect.poll(() => scheduler?.output() ?? "", { timeout: 10_000 }).toContain(`agent session ${sessionId} (claude) finished: run-finished, started by Runner (Nightly)`);
    // Another session's end still fires: the hook is alive, Runner's run fired nothing.
    await publish("session.closed", session({ sessionId: "s-tab-2", reason: "tab-closed" }));
    await expect.poll(async () => (await history("lint")).length, { timeout: 30_000 }).toBe(2);
    expect((await history("lint")).map((each) => each.lastLines.join("\n").match(/lint (\S+)/)?.[1])).toEqual(["s-tab-2", "s-tab"]);
  });

  test("5 · marking a session Done runs the Session Analyzer on its transcript; another status, or a payload that is not the contract's, fires nothing", async () => {
    const transcript = join(user, ".claude/projects/notes/s-done.jsonl");
    await mkdir(join(user, ".claude/projects/notes"), { recursive: true });
    await writeFile(transcript, '{"type":"user","message":"fix the build"}\n');
    await publish("session.statusChanged", session({ sessionId: "s-hold", status: "on-hold", from: "active", to: "on-hold" }));
    await publish("session.statusChanged", session({ sessionId: "s-bad", status: "active", from: "active", to: "done" }));
    await expect.poll(() => scheduler?.output() ?? "").toContain("ignored a pomade-agents:session.statusChanged that is not the Agents app's contract");
    await publish("session.statusChanged", session({ sessionId: "s-done", transcript, status: "done", from: "active", to: "done", startedByRunner: true, job: "Nightly" }));
    await expect.poll(async () => (await history("analyzer")).length, { timeout: 30_000 }).toBe(1);
    const [record] = await history("analyzer");
    expect(record?.lastLines.join("\n")).toContain('analyzing s-done\n{"type":"user","message":"fix the build"}');
    expect(record && runTriggerWords(record)).toBe("hook: session marked Done");
    expect(record?.state).toBe("done");
  });
});
