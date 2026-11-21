// A scripted stand-in for an agent CLI, run in a terminal as Claude Code or Codex would be: it puts
// up the provider's idle title, works on the prompt (the provider's working title, a few lines of
// output), goes idle again with its answer on screen, and ends on the exit command typed into it
// (`/exit`, then Enter) — or on Ctrl+C. Words in the prompt script it: `[exit-early]` ends it with
// status 0 while it works; `[slow]` makes the turn last 4 s. `--provider claude|codex` picks the
// titles the kit's scanner reads (`pomade-kit/scanners`). It keeps, under `$HOME/.fake-agents/`,
// each session's record — the id (`--session-id`'s, else one of its own, as Codex), the agent, the
// start folder and time, its arguments and its last message — which the fixture Agents app answers
// `sessions.find` and `sessions.lastMessage` from; and, as Claude Code does, a transcript at
// `$HOME/.claude/projects/<folder>/<id>.jsonl`, which Pomade's resume looks for. `--resume <id>`
// shows that session again and waits for the exit command.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const option = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
};
const provider = option("--provider") ?? "claude";
const agent = option("--agent") ?? provider;
const resume = option("--resume");
const takes = new Set(["--provider", "--agent", "--resume", "--session-id"]);
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (takes.has(argv[i])) i++;
  else if (argv[i] !== "--") rest.push(argv[i]);
}
const prompt = rest.filter((arg) => !arg.startsWith("--")).at(-1) ?? "";
const args = argv.filter((arg, i) => !(arg === "--provider" || arg === "--agent" || argv[i - 1] === "--provider" || argv[i - 1] === "--agent"));
const id = resume ?? option("--session-id") ?? `019a${randomUUID().slice(4)}`;
const cwd = realpathSync(process.cwd());
const home = homedir();
const records = join(home, ".fake-agents", "sessions");
mkdirSync(records, { recursive: true });
const recordFile = join(records, `${id}.json`);

const IDLE = provider === "claude" ? "✳ Fake agent" : "fake-agent";
const WORKING = provider === "claude" ? ["◐", "◓", "◑", "◒"] : ["⠋", "⠙", "⠹", "⠸"];
const title = (text) => process.stdout.write(`\x1b]0;${text}\x07`);
const save = (record) => writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);

let input = "";
const listen = () => {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data) => {
    for (const ch of data) {
      if (ch === "\x03") process.exit(130);
      if (ch === "\r" || ch === "\n") {
        const line = input.trim();
        input = "";
        process.stdout.write("\r\n");
        if (line === "/exit") {
          process.stdout.write("Bye.\r\n");
          process.exit(0);
        }
        process.stdout.write("> ");
      } else {
        input += ch;
        process.stdout.write(ch);
      }
    }
  });
};

if (resume !== null) {
  const record = JSON.parse(readFileSync(recordFile, "utf8"));
  title(IDLE);
  process.stdout.write(`resumed session ${id}\r\n● ${record.lastMessage}\r\n> `);
  listen();
} else {
  const startedAt = new Date().toISOString();
  const record = { id, provider: provider === "claude" ? "claude-code" : "codex", agent, cwd, startedAt, args, prompt, lastMessage: null, at: null };
  save(record);
  if (provider === "claude") {
    const transcripts = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(transcripts, `${id}.jsonl`), `${JSON.stringify({ type: "user", sessionId: id, cwd, timestamp: startedAt, message: { role: "user", content: prompt } })}\n`);
  }
  title(IDLE);
  listen();
  let frame = 0;
  setTimeout(() => {
    const spin = setInterval(() => title(`${WORKING[frame++ % WORKING.length]} Working`), 100);
    process.stdout.write(`● Working on: ${prompt}\r\n`);
    if (prompt.includes("[exit-early]")) {
      setTimeout(() => process.exit(0), 400);
      return;
    }
    setTimeout(
      () => {
        clearInterval(spin);
        const answer = `**Done.** ${prompt.split("\n")[0]}`;
        save({ ...record, lastMessage: answer, at: new Date().toISOString() });
        process.stdout.write(`● ${answer}\r\n> `);
        title(IDLE);
      },
      prompt.includes("[slow]") ? 4000 : 1200,
    );
  }, 300);
}
