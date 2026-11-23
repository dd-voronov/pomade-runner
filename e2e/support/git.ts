// Git for the git-job specs, on throwaway folders only: a bare remote, the workspace's clone of it
// and a second clone that stands for another machine, all under the spec's temp folder, with a git
// configuration of their own (`GIT_CONFIG_GLOBAL`, the system's left out — no credential helper,
// no user identity of the person's). And Pomade's `pomade-git` in the test Pomade home's command
// folder, written as Pomade writes it — a shim that sets that Pomade's home and user data — and run
// from the Pomade checkout (`POMADE_REPO`) under Node, with Pomade closed.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { cleanEnv } from "./env";
import { pomadeCheckout } from "./pomade";

/** What every git process of a spec runs with: its own configuration, never the person's. */
export function gitEnv(tmp: string): Record<string, string> {
  return { GIT_CONFIG_GLOBAL: join(tmp, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
}

export interface GitFixture {
  /** The bare remote. */
  remote: string;
  /** The workspace's clone: the repo `notes`. */
  repo: string;
  /** Another clone of the remote, for changes that come from elsewhere. */
  other: string;
  /** Run git in a folder; its output, trimmed. */
  git(cwd: string, ...args: string[]): string;
  /** HEAD, the branch, the full status of the working tree and the index, and every byte of
   *  `notes.md`. What a fetch moves — the remote-tracking branches — is not in it. */
  snapshot(): { head: string; branch: string; status: string; notes: string };
}

/** A remote with one commit (`notes.md`), cloned into `<workspace>/notes` and into another
 *  folder, with the configuration `gitEnv` names. */
export async function createGitFixture(tmp: string, workspace: string): Promise<GitFixture> {
  await writeFile(join(tmp, "gitconfig"), "[user]\n\tname = Runner Test\n\temail = runner@test.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgSign = false\n");
  const env = { ...withoutGit(cleanEnv()), ...gitEnv(tmp), HOME: join(tmp, "user") };
  const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const remote = join(tmp, "remote", "notes.git");
  const seed = join(tmp, "seed");
  const repo = join(workspace, "notes");
  const other = join(tmp, "other");
  await mkdir(remote, { recursive: true });
  git(remote, "init", "--bare", "--quiet", "--initial-branch=main");
  await mkdir(seed, { recursive: true });
  git(seed, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(seed, "notes.md"), "# Notes\n\nfirst line\n");
  git(seed, "add", "notes.md");
  git(seed, "commit", "--quiet", "-m", "First notes");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "--quiet", "-u", "origin", "main");
  git(tmp, "clone", "--quiet", remote, repo);
  git(tmp, "clone", "--quiet", remote, other);
  return {
    remote,
    repo,
    other,
    git,
    snapshot: () => ({
      head: git(repo, "rev-parse", "HEAD"),
      branch: git(repo, "symbolic-ref", "HEAD"),
      status: git(repo, "status", "--porcelain=v2"),
      notes: readFileSync(join(repo, "notes.md"), "utf8"),
    }),
  };
}

/** The environment without the person's `GIT_*` variables. */
function withoutGit(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
}

const quote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/** Write `<home>/bin/pomade-git` as a Pomade writes it at its start: its home and user data, then
 *  the built command (the checkout's `out/main/pomade-git.js`) run by Node. */
export async function writePomadeGit(home: string, userData: string): Promise<string> {
  const entry = join(pomadeCheckout().root, "out/main/pomade-git.js");
  if (!existsSync(entry)) throw new Error(`No built pomade-git at ${entry}: point POMADE_REPO at a Pomade checkout with \`npm run build\` done.`);
  const shim = join(home, "bin", "pomade-git");
  await mkdir(join(home, "bin"), { recursive: true });
  await writeFile(shim, `#!/bin/sh\nPOMADE_HOME=${quote(home)} POMADE_USER_DATA=${quote(userData)} exec ${quote(process.execPath)} ${quote(entry)} "$@"\n`);
  await chmod(shim, 0o755);
  return shim;
}

/** A program named `claude` working in `folder`, as `pomade-git`'s "agent working" check finds an
 *  agent: an executable called claude whose working directory is in the repo. */
export async function writeFakeAgent(tmp: string): Promise<string> {
  const bin = join(tmp, "agent-bin", "claude");
  await mkdir(join(tmp, "agent-bin"), { recursive: true });
  await writeFile(bin, "#!/bin/sh\nwhile true; do sleep 1; done\n");
  await chmod(bin, 0o755);
  return bin;
}
