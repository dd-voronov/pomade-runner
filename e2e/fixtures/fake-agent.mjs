// A scripted stand-in for an agent CLI, run in a terminal as Claude Code or Codex would be: it puts
// up the provider's idle title, works on the prompt (the provider's working title, a few lines of
// output), goes idle again with its answer on screen, and ends on the exit command typed into it
// (`/exit`, then Enter) — or on Ctrl+C. Words in the prompt script it: `[exit-early]` ends it with
// status 0 while it works; `[slow]` makes the turn last 4 s, `[long]` 15 s; `[ask]` puts up a permission prompt
// midway — the provider's dialog, as the kit's scanner reads it — and waits for the answer: `1` or
// Enter allows it and the turn goes on, Esc (or the provider's "No") denies it and the turn ends
// there; `[ask-late]` puts it up 5 s into the turn.
// `--provider claude|codex` picks the titles and the dialog the kit's scanner reads
// (`pomade-kit/scanners`). It keeps, under `$HOME/.fake-agents/`,
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

/** The permission dialog, as each provider draws it: the question, the options, the footer last. */
const DIALOG =
  provider === "claude"
    ? ["", "  Bash command", "    git mv 00-Inbox/2026-11-16-*.md 01-Raw/Notes/", "", "  Do you want to proceed?", "  ❯ 1. Yes", "    2. Yes, and don't ask again for git mv", "    3. No, tell Claude what to do differently", "", "  Esc to cancel"]
    : ["", "  Would you like to run the following command?", "    $ git mv 00-Inbox/2026-11-16-*.md 01-Raw/Notes/", "", "  › 1. Yes, proceed", "    2. No, and tell Codex what to do differently", "", "  Press enter to confirm or esc to cancel"];

let input = "";
/** While a permission prompt is up: what answering it does. */
let answer = null;
const listen = () => {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data) => {
    if (answer !== null) {
      if (data === "\x03") process.exit(130);
      // claude: 1 and 2 allow, 3 denies; codex: 1 allows, 2 denies; Enter takes the first, Esc denies.
      const denies = provider === "claude" ? ["3", "\x1b"] : ["2", "\x1b"];
      const key = data[0] ?? "";
      const choice = denies.includes(key) ? "deny" : ["1", "2", "\r"].includes(key) ? "allow" : null;
      if (choice === null) return;
      const then = answer;
      answer = null;
      then(choice);
      return;
    }
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
  let spin = null;
  const work = () => {
    spin = setInterval(() => title(`${WORKING[frame++ % WORKING.length]} Working`), 100);
  };
  const finish = (message) => {
    clearInterval(spin);
    save({ ...record, lastMessage: message, at: new Date().toISOString() });
    process.stdout.write(`● ${message}\r\n> `);
    title(IDLE);
  };
  const turn = () =>
    setTimeout(() => finish(`**Done.** ${prompt.split("\n")[0]}`), prompt.includes("[long]") ? 15000 : prompt.includes("[slow]") ? 4000 : 1200);
  setTimeout(() => {
    work();
    process.stdout.write(`● Working on: ${prompt}\r\n`);
    if (prompt.includes("[exit-early]")) {
      setTimeout(() => process.exit(0), 400);
      return;
    }
    const late = prompt.includes("[ask-late]");
    if (!late && !prompt.includes("[ask]")) {
      turn();
      return;
    }
    setTimeout(() => {
      // As the real CLIs do: the spinner stops, the dialog is drawn, the title shows idle.
      clearInterval(spin);
      process.stdout.write(`● Moving 14 notes out of 00-Inbox/ into 01-Raw/Notes/\r\n${DIALOG.join("\r\n")}`);
      title(provider === "claude" ? IDLE : "[ ! ] Action Required | fake-agent");
      answer = (choice) => {
        process.stdout.write("\r\n\r\n");
        if (choice === "deny") {
          finish("Left the notes where they are: you said no.");
          return;
        }
        process.stdout.write("● Moved 14 notes.\r\n");
        work();
        turn();
      };
    }, late ? 5000 : 400);
  }, 300);
}
