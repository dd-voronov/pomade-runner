// The install script, into a temp user data: it builds and installs, a second run updates, and the
// installed copy — a folder with no `node_modules` — runs on Pomade's runtime. It rebuilds
// `dist/`, so the project runs after every other one.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import manifest from "../app/manifest.json" with { type: "json" };
import { REPO, cleanEnv, removeDir, run, tempDir } from "./support/env";
import { pomadeCheckout, pomadeEnv } from "./support/pomade";
import { startSchedulerProcess } from "./support/scheduler";

test("./install builds Runner and installs it; run again, it updates; the installed copy runs", async () => {
  test.setTimeout(120_000);
  const pomade = pomadeCheckout();
  const tmp = await tempDir();
  const folders = { workspace: join(tmp, "ws"), userData: join(tmp, "ud"), home: join(tmp, "home") };
  const env = pomadeEnv(folders, { POMADE_REPO: pomade.root });
  const installed = join(folders.userData, "apps", manifest.id);
  const runtimeEnv = cleanEnv({
    ELECTRON_RUN_AS_NODE: "1",
    POMADE_APP_ID: manifest.id,
    POMADE_APP_KEY_FILE: join(folders.userData, "app-keys", manifest.id),
    POMADE_HOME: folders.home,
  });
  const scheduler = { current: null as ReturnType<typeof startSchedulerProcess> | null };

  try {
    const first = await run(join(REPO, "install"), [], { env, cwd: tmp });
    expect(first.stderr + first.stdout).toContain(`Installed into ${installed}`);
    expect(first.code).toBe(0);
    expect(JSON.parse(await readFile(join(installed, "manifest.json"), "utf8"))).toEqual(manifest);
    expect((await readdir(installed)).sort()).toEqual(["assets", "backend", "cli", "icon.svg", "index.html", "manifest.json"]);
    expect((await readFile(join(folders.userData, "app-keys", manifest.id), "utf8")).trim()).not.toBe("");

    const second = await run(join(REPO, "install"), [], { env, cwd: tmp });
    expect(second.stdout).toContain(`Updated into ${installed}`);
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
    running.child.kill("SIGTERM");
    expect(await running.exited).toBe(0);
  } finally {
    await scheduler.current?.kill();
    await removeDir(tmp);
  }
});

test("./install says so when there is no Pomade checkout", async () => {
  const tmp = await tempDir();
  try {
    const result = await run(join(REPO, "install"), [], { env: cleanEnv({ POMADE_REPO: join(tmp, "nowhere"), POMADE_USER_DATA: join(tmp, "ud"), POMADE_HOME: join(tmp, "home") }), cwd: tmp });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`install: no pomade command at ${join(tmp, "nowhere")}/bin/pomade`);
  } finally {
    await removeDir(tmp);
  }
});
