// Agent runs under test: the scripted fake agent CLI (`fixtures/fake-agent.mjs`) as two commands —
// one that plays Claude Code, one that plays Codex — and the fixture Agents app
// (`fixtures/agents-app/`) whose roster names them, both reading and writing under the test user's
// home (`$HOME/.fake-agents/`).

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RosterAgent } from "pomade-kit/protocol";

import type { RunFinishedPayload, RunStartedPayload } from "../../src/integrations/runner-api";
import { REPO } from "./env";

/** The fixture Agents app's folder: dev-linked into the test Pomade beside Runner's build. */
export const AGENTS_APP = join(REPO, "e2e/fixtures/agents-app");

const FAKE_AGENT = join(REPO, "e2e/fixtures/fake-agent.mjs");

/** A fake agent session's record, as the fake CLI keeps it. */
export interface FakeSession {
  id: string;
  provider: string;
  agent: string;
  cwd: string;
  startedAt: string;
  args: string[];
  prompt: string;
  lastMessage: string | null;
}

export interface FakeAgents {
  /** The roster the fixture app answers. */
  roster: RosterAgent[];
  /** The sessions the fake CLI ran, by id. */
  session(id: string): Promise<FakeSession>;
  /** The run events the fixture app heard, in order. */
  events(): Promise<{ event: "run.started" | "run.finished"; payload: RunStartedPayload & Partial<RunFinishedPayload> }[]>;
}

/** Install the fake CLI's commands under `bin` and the fixture app's configuration in `home`. */
export async function fakeAgents(home: string, bin: string, projects: Record<string, string[]> = {}): Promise<FakeAgents> {
  await mkdir(bin, { recursive: true });
  const command = async (name: string, provider: string): Promise<string> => {
    const path = join(bin, name);
    await writeFile(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGENT}" --provider ${provider} --agent ${name === "fake-claude" ? "claude" : "codex"} "$@"\n`);
    await chmod(path, 0o755);
    return path;
  };
  const roster: RosterAgent[] = [
    {
      id: "claude",
      name: "Claude",
      command: await command("fake-claude", "claude"),
      provider: "claude",
      configDir: join(home, ".claude"),
      modes: [
        { id: "normal", name: "Normal", args: [] },
        { id: "full-autonomy", name: "Full autonomy", args: ["--dangerously-skip-permissions"] },
      ],
    },
    { id: "codex", name: "Codex", command: await command("fake-codex", "codex"), provider: "codex", configDir: join(home, ".codex"), modes: [{ id: "normal", name: "Normal", args: [] }] },
  ];
  const dir = join(home, ".fake-agents");
  await mkdir(join(dir, "sessions"), { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify({ roster, projects }));
  return {
    roster,
    session: async (id) => JSON.parse(await readFile(join(dir, "sessions", `${id}.json`), "utf8")) as FakeSession,
    async events() {
      const text = await readFile(join(dir, "events.jsonl"), "utf8").catch(() => "");
      return text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Awaited<ReturnType<FakeAgents["events"]>>[number]);
    },
  };
}
