// The install and uninstall scripts, into a temp user data, workspace and home: install builds and
// installs; the installed scheduler — started as the login item starts it — puts the agent skill
// into the workspace's skills folder and gives it to no agent; a second run updates, and the
// restarted scheduler rewrites the skill with the new version's text; a changed skills folder moves
// it; the installed copy — a folder with no `node_modules` but what the build ships for the keeper —
// runs on Pomade's runtime, keeper and sessions included; uninstall removes the app and the skill's
// copy. It rebuilds `dist/`, so the project runs after every other one.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import manifest from "../app/manifest.json" with { type: "json" };
import { REPO, cleanEnv, removeDir, run, tempDir } from "./support/env";
import { pomadeCheckout, pomadeEnv } from "./support/pomade";
import { runningSession, expectNothingLeft, stopKeeper } from "./support/keeper";
import { startSchedulerProcess } from "./support/scheduler";

/** Every file under `folder`, relative, sorted; `[]` when it is not there. */
async function filesUnder(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder, { recursive: true })).sort();
  } catch {
    return [];
  }
}

test("./install builds and installs Runner, whose scheduler puts the skill into the skills folder and gives it to no agent; run again, it updates the skill; a changed skills folder moves it; the installed copy runs; ./uninstall removes it", async () => {
  test.setTimeout(150_000);
  const pomade = pomadeCheckout();
  const tmp = await tempDir();
  const folders = { workspace: join(tmp, "ws"), userData: join(tmp, "ud"), home: join(tmp, "home") };
  const userHome = join(tmp, "user");
  // HOME too: nothing may land in $HOME/.claude/skills.
  const env = pomadeEnv(folders, { POMADE_REPO: pomade.root, HOME: userHome });
  const agentSkills = join(folders.workspace, "Agents/claude-coder/skills");
  const userSkills = join(userHome, ".claude/skills");
  await mkdir(join(agentSkills, "another"), { recursive: true });
  await writeFile(join(folders.workspace, "Agents/claude-coder/CLAUDE.md"), "");
  await writeFile(join(agentSkills, "another/SKILL.md"), "---\nname: another\n---\n");
  await mkdir(join(userSkills, "another"), { recursive: true });
  await writeFile(join(userSkills, "another/SKILL.md"), "---\nname: another\n---\n");
  const agentsBefore = await filesUnder(join(folders.workspace, "Agents"));
  const userBefore = await filesUnder(join(userHome, ".claude"));
  const installed = join(folders.userData, "apps", manifest.id);
  const keeperSocket = join(folders.userData, "run", "keepers", `${manifest.id}.sock`);
  const runtimeEnv = cleanEnv({
    ELECTRON_RUN_AS_NODE: "1",
    POMADE_APP_ID: manifest.id,
    POMADE_APP_KEY_FILE: join(folders.userData, "app-keys", manifest.id),
    POMADE_KEEPER_SOCKET: keeperSocket,
    POMADE_HOME: folders.home,
    POMADE_WORKSPACE: folders.workspace,
    HOME: userHome,
    SHELL: "/bin/sh",
  });
  const pids: number[] = [];
  const scheduler = { current: null as ReturnType<typeof startSchedulerProcess> | null };
  const startInstalled = async (): Promise<ReturnType<typeof startSchedulerProcess>> => {
    scheduler.current = startSchedulerProcess(pomade.runtime, join(installed, manifest.backend.entry), { ...runtimeEnv, POMADE_CLIENT: "backend" });
    const started = scheduler.current;
    await expect.poll(() => started.output()).toContain(`scheduler ${manifest.version} started`);
    return started;
  };
  const stopInstalled = async (running: ReturnType<typeof startSchedulerProcess>): Promise<void> => {
    running.child.kill("SIGTERM");
    expect(await running.exited).toBe(0);
    scheduler.current = null;
  };
  const skillsFolder = join(folders.workspace, "Knowledge/_skills/apps");
  const copy = join(skillsFolder, "pomade-runner-jobs/SKILL.md");

  try {
    const first = await run(join(REPO, "install"), [], { env, cwd: tmp });
    expect(first.stderr + first.stdout).toContain(`Installed into ${installed}`);
    expect(first.code).toBe(0);
    expect(JSON.parse(await readFile(join(installed, "manifest.json"), "utf8"))).toEqual(manifest);
    expect((await readdir(installed)).sort()).toEqual(["assets", "backend", "cli", "icon.svg", "index.html", "manifest.json", "node_modules", "output.svg", "skills"]);
    const shipped = await readFile(join(installed, "skills/pomade-runner-jobs/SKILL.md"), "utf8");
    expect(shipped).toContain("name: pomade-runner-jobs");
    expect((await readFile(join(folders.userData, "app-keys", manifest.id), "utf8")).trim()).not.toBe("");

    // The scheduler's first start puts the installed skill into the default skills folder.
    const placing = await startInstalled();
    await expect.poll(() => placing.output()).toContain(`skill: placed ${copy}\n`);
    expect(await readFile(copy, "utf8")).toBe(shipped);
    await stopInstalled(placing);
    // The keeper it started goes too: this one never loaded node-pty, and the update retires its
    // build folder, which no process holds open.
    await stopKeeper(keeperSocket);

    // An older version's copy, then an update: the restarted scheduler writes the new text.
    await writeFile(copy, "---\nname: pomade-runner-jobs\n---\nThe older version's skill.\n");
    const second = await run(join(REPO, "install"), [], { env, cwd: tmp });
    expect(second.stdout).toContain(`Updated into ${installed}`);
    expect(second.code).toBe(0);
    // One app, updated in place; Pomade keeps each install's build in its own `.builds` folder.
    expect((await readdir(join(folders.userData, "apps"))).filter((name) => !name.startsWith("."))).toEqual([manifest.id]);

    const running = await startInstalled();
    await expect.poll(() => running.output()).toContain(`skill: placed ${copy}\n`);
    expect(await readFile(copy, "utf8")).toBe(shipped);
    expect(await filesUnder(join(skillsFolder, "pomade-runner-jobs"))).toEqual(["SKILL.md"]);
    // No agent's skills folder, and not the user's, gained anything.
    expect(await filesUnder(join(folders.workspace, "Agents"))).toEqual(agentsBefore);
    expect(await filesUnder(join(userHome, ".claude"))).toEqual(userBefore);
    expect(existsSync(join(folders.workspace, "Knowledge/00-Inbox"))).toBe(false);

    const version = await run(pomade.runtime, [join(installed, "cli/pomade-runner.mjs"), "--version"], {
      env: { ...runtimeEnv, POMADE_CLIENT: "command" },
      cwd: tmp,
    });
    expect(version.stdout).toContain(`pomade-runner ${manifest.version}\nscheduler: running — ${manifest.version}, pid ${running.child.pid},`);

    // A changed skills folder moves the skill; the old folder's copy goes, the folder around it stays.
    const moved = join(folders.workspace, "Apps/pomade-runner/skills-test/pomade-runner-jobs/SKILL.md");
    await mkdir(join(folders.workspace, "Apps/pomade-runner"), { recursive: true });
    await writeFile(join(folders.workspace, "Apps/pomade-runner/settings.yaml"), "skills-folder: Apps/pomade-runner/skills-test/\n");
    await expect.poll(() => running.output()).toContain(`skill: placed ${moved}\n`);
    expect(await readFile(moved, "utf8")).toBe(shipped);
    await expect.poll(() => running.output()).toContain(`skill: removed the copy at ${join(skillsFolder, "pomade-runner-jobs")}\n`);
    expect(existsSync(join(skillsFolder, "pomade-runner-jobs"))).toBe(false);
    expect(existsSync(skillsFolder)).toBe(true);

    // The installed scheduler starts a new service in the installed keeper.
    const jobs = join(folders.workspace, "Apps/pomade-runner/jobs");
    await mkdir(jobs, { recursive: true });
    await writeFile(join(jobs, "echo.md"), '---\nkind: service\nname: Echo\nfolder: .\ncommand: "echo installed keeper; exec sleep 600"\n---\n');
    await expect.poll(() => running.output()).toContain("jobs: 1 job file, 0 invalid\n");
    const started = await runningSession(join(folders.userData, "app-state", manifest.id, "scheduler.sock"), "svc:echo");
    pids.push(started.info.pid ?? 0);
    await expect.poll(() => readFile(started.log ?? "", "utf8").catch(() => "")).toContain("installed keeper");
    const sessions = await run(pomade.runtime, [join(installed, "cli/pomade-runner.mjs"), "sessions"], { env: { ...runtimeEnv, POMADE_CLIENT: "command" }, cwd: tmp });
    expect(sessions.stdout).toMatch(new RegExp(`^keeper: running — version \\w+, pid \\d+\nsvc:echo  job echo  running, pid ${started.info.pid ?? ""}, `));
    await stopInstalled(running);

    const removed = await run(join(REPO, "uninstall"), [], { env, cwd: tmp });
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain(`skill pomade-runner-jobs: removed ${join(folders.workspace, "Apps/pomade-runner/skills-test/pomade-runner-jobs")}\n`);
    expect(existsSync(join(folders.workspace, "Apps/pomade-runner/skills-test/pomade-runner-jobs"))).toBe(false);
    expect(existsSync(installed)).toBe(false);
    expect(await filesUnder(join(folders.workspace, "Agents"))).toEqual(agentsBefore);
  } finally {
    await scheduler.current?.kill();
    await stopKeeper(keeperSocket, pids);
    await expectNothingLeft(tmp);
    await removeDir(tmp);
  }
});

test("./install says so when there is no Pomade checkout", async () => {
  const tmp = await tempDir();
  try {
    const result = await run(join(REPO, "install"), [], { env: cleanEnv({ POMADE_REPO: join(tmp, "nowhere"), POMADE_USER_DATA: join(tmp, "ud"), POMADE_HOME: join(tmp, "home"), HOME: tmp }), cwd: tmp });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`install: no pomade command at ${join(tmp, "nowhere")}/bin/pomade`);
  } finally {
    await removeDir(tmp);
  }
});
