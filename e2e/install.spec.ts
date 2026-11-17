// The install and uninstall scripts, into a temp user data, workspace and home: install builds and
// installs, links the agent skill and drops the skills-map note; a second run updates; the
// installed copy — a folder with no `node_modules` but what the build ships for the keeper — runs
// on Pomade's runtime, keeper and sessions included; uninstall removes the links and the app. It
// rebuilds `dist/`, so the project runs after every other one.

import { mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import manifest from "../app/manifest.json" with { type: "json" };
import { REPO, cleanEnv, removeDir, run, tempDir } from "./support/env";
import { pomadeCheckout, pomadeEnv } from "./support/pomade";
import { startService, stopKeeper } from "./support/keeper";
import { startSchedulerProcess } from "./support/scheduler";

test("./install builds Runner, installs it and links its skill; run again, it updates; the installed copy runs; ./uninstall removes it", async () => {
  test.setTimeout(120_000);
  const pomade = pomadeCheckout();
  const tmp = await tempDir();
  const folders = { workspace: join(tmp, "ws"), userData: join(tmp, "ud"), home: join(tmp, "home") };
  const userHome = join(tmp, "user");
  // HOME too: the skill is linked into $HOME/.claude/skills.
  const env = pomadeEnv(folders, { POMADE_REPO: pomade.root, HOME: userHome });
  await mkdir(join(folders.workspace, "Agents/claude-coder"), { recursive: true });
  await writeFile(join(folders.workspace, "Agents/claude-coder/CLAUDE.md"), "");
  await mkdir(join(folders.workspace, "Knowledge/00-Inbox"), { recursive: true });
  await mkdir(userHome);
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

  try {
    const first = await run(join(REPO, "install"), [], { env, cwd: tmp });
    expect(first.stderr + first.stdout).toContain(`Installed into ${installed}`);
    expect(first.code).toBe(0);
    expect(JSON.parse(await readFile(join(installed, "manifest.json"), "utf8"))).toEqual(manifest);
    expect((await readdir(installed)).sort()).toEqual(["assets", "backend", "cli", "icon.svg", "index.html", "manifest.json", "node_modules", "skills"]);
    const skill = join(installed, "skills/pomade-runner-jobs");
    const links = [join(userHome, ".claude/skills/pomade-runner-jobs"), join(folders.workspace, "Agents/claude-coder/skills/pomade-runner-jobs")];
    for (const link of links) {
      expect(first.stdout).toContain(`skill pomade-runner-jobs: linked ${link}\n`);
      expect(await readlink(link)).toBe(skill);
      expect(await readFile(join(link, "SKILL.md"), "utf8")).toContain("name: pomade-runner-jobs");
    }
    const notes = await readdir(join(folders.workspace, "Knowledge/00-Inbox"));
    expect(notes).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}-pomade-runner-jobs-skill\.md$/)]);
    expect((await readFile(join(folders.userData, "app-keys", manifest.id), "utf8")).trim()).not.toBe("");

    const second = await run(join(REPO, "install"), [], { env, cwd: tmp });
    expect(second.stdout).toContain(`Updated into ${installed}`);
    expect(second.stdout).toContain(`skill pomade-runner-jobs: already linked ${links[1] ?? ""}\n`);
    expect(second.stdout).not.toContain("note for the skills map");
    expect(second.code).toBe(0);
    expect(await readdir(join(folders.userData, "apps"))).toEqual([manifest.id]);

    scheduler.current = startSchedulerProcess(pomade.runtime, join(installed, manifest.backend.entry), { ...runtimeEnv, POMADE_CLIENT: "backend" });
    const running = scheduler.current;
    await expect.poll(() => running.output()).toContain(`scheduler ${manifest.version} started`);
    const version = await run(pomade.runtime, [join(installed, "cli/pomade-runner.mjs"), "--version"], {
      env: { ...runtimeEnv, POMADE_CLIENT: "command" },
      cwd: tmp,
    });
    expect(version.stdout).toContain(`pomade-runner ${manifest.version}\nscheduler: running — ${manifest.version}, pid ${running.child.pid},`);

    // The installed keeper runs a service.
    const jobs = join(folders.workspace, "Apps/pomade-runner/jobs");
    await mkdir(jobs, { recursive: true });
    await writeFile(join(jobs, "echo.md"), '---\nkind: service\nname: Echo\nfolder: .\ncommand: "echo installed keeper; exec sleep 600"\n---\n');
    await expect.poll(() => running.output()).toContain("jobs: 1 job file, 0 invalid\n");
    const started = await startService(join(folders.userData, "app-state", manifest.id, "scheduler.sock"), "echo");
    pids.push(started.info.pid ?? 0);
    await expect.poll(() => readFile(started.log ?? "", "utf8").catch(() => "")).toContain("installed keeper");
    const sessions = await run(pomade.runtime, [join(installed, "cli/pomade-runner.mjs"), "sessions"], { env: { ...runtimeEnv, POMADE_CLIENT: "command" }, cwd: tmp });
    expect(sessions.stdout).toMatch(new RegExp(`^keeper: running — version \\w+, pid \\d+\nsvc:echo  job echo  running, pid ${started.info.pid ?? ""}, `));
    running.child.kill("SIGTERM");
    expect(await running.exited).toBe(0);

    const removed = await run(join(REPO, "uninstall"), [], { env, cwd: tmp });
    expect(removed.code).toBe(0);
    for (const link of links) {
      expect(removed.stdout).toContain(`skill pomade-runner-jobs: unlinked ${link}\n`);
      expect(existsSync(link)).toBe(false);
    }
    expect(existsSync(installed)).toBe(false);
  } finally {
    await scheduler.current?.kill();
    await stopKeeper(keeperSocket, pids);
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
