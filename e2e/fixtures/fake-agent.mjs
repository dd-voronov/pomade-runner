// A scripted stand-in for an agent CLI, run in a terminal as Claude Code or Codex would be: it puts
// up the provider's idle title, works on the prompt (the provider's working title, a few lines of
// output), goes idle again with its answer on screen, and ends on the exit command typed into it
// (`/exit`, then Enter) — or on Ctrl+C. Words in the prompt script it: `[exit-early]` ends it with
// status 0 while it works; `[slow]` makes the turn last 4 s, `[long]` 15 s; `[ask]` puts up a permission prompt
// midway — the provider's dialog, as the kit's scanner reads it — and waits for the answer: `1` or
// Enter allows it and the turn goes on, Esc (or the provider's "No") denies it and the turn ends
// there; `[ask-late]` puts it up 5 s into the turn; `[no-answer]` ends the turn on an API error
// ("Not logged in · Please run /login") with no answer — the record's last message stays `null`,
// and the transcript's assistant record is the error one Claude Code writes (`isApiErrorMessage`);
// `[stuck]` stops at a consent screen no scanner names before it starts (Claude's Bypass
// Permissions one), with no session made: `2` accepts it and the agent starts as with no word,
// `1` or Esc ends it with status 1.
// `--provider claude|codex` picks the titles and the dialog the kit's scanner reads
// (`pomade-kit/scanners`). It keeps, under `$HOME/.fake-agents/`,
// each session's record — the id (`--session-id`'s, else one of its own, as Codex), the agent, the
// start folder and time, its arguments and its last message — which the fixture Agents app answers
// `sessions.find` and `sessions.lastMessage` from; and, as Claude Code does, a transcript at
// `$HOME/.claude/projects/<folder>/<id>.jsonl` — the prompt, then each answer — which Pomade's
// resume looks for and the real Agents app reads. `--resume <id>`
// shows that session again and waits for the exit command.

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
    ? ["", "  Bash command", "    git mv drafts/2026-11-16-*.md published/", "", "  Do you want to proceed?", "  ❯ 1. Yes", "    2. Yes, and don't ask again for git mv", "    3. No, tell Claude what to do differently", "", "  Esc to cancel"]
    : ["", "  Would you like to run the following command?", "    $ git mv drafts/2026-11-16-*.md published/", "", "  › 1. Yes, proceed", "    2. No, and tell Codex what to do differently", "", "  Press enter to confirm or esc to cancel"];

/** Claude Code's consent screen for Bypass Permissions mode, as a profile that never accepted it shows it. */
const CONSENT = ["", "  WARNING: Claude Code running in Bypass Permissions mode", "", "  In Bypass Permissions mode, Claude Code will not ask for your approval before running", "  potentially dangerous commands.", "", "  ❯ 1. No, exit", "    2. Yes, I accept", "", "  Enter to confirm · Esc to exit"];

let input = "";
/** Whether the session has begun: a `[stuck]` agent's begins once its consent is accepted. */
let begun = false;
/** While a permission prompt is up: what answering it does. */
let answer = null;
const listen = () => {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data) => {
    if (answer !== null && prompt.includes("[stuck]") && !begun) {
      if (data === "\x03") process.exit(130);
      const key = data[0] ?? "";
      const choice = key === "2" ? "accept" : ["1", "\x1b"].includes(key) ? "exit" : null;
      if (choice === null) return;
      const then = answer;
      answer = null;
      then(choice);
      return;
    }
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
} else if (prompt.includes("[stuck]")) {
  title(IDLE);
  process.stdout.write(`${CONSENT.join("\r\n")}`);
  answer = (choice) => {
    if (choice !== "accept") process.exit(1);
    process.stdout.write("\r\n\r\n");
    begin();
  };
  listen();
} else {
  begin();
  listen();
}

/** The session starts: its record and transcript are made, and the turn goes. */
function begin() {
  begun = true;
  const startedAt = new Date().toISOString();
  const record = { id, provider: provider === "claude" ? "claude-code" : "codex", agent, cwd, startedAt, args, prompt, lastMessage: null, at: null };
  save(record);
  const transcript = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
  if (provider === "claude") {
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, `${JSON.stringify({ type: "user", sessionId: id, cwd, timestamp: startedAt, message: { role: "user", content: prompt } })}\n`);
  }
  title(IDLE);
  let frame = 0;
  let spin = null;
  const work = () => {
    spin = setInterval(() => title(`${WORKING[frame++ % WORKING.length]} Working`), 100);
  };
  const finish = (message) => {
    clearInterval(spin);
    const at = new Date().toISOString();
    save({ ...record, lastMessage: message, at });
    if (provider === "claude") {
      const usage = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 };
      appendFileSync(transcript, `${JSON.stringify({ type: "assistant", sessionId: id, cwd, timestamp: at, message: { model: "claude-fake", id: `msg_${id}`, type: "message", role: "assistant", content: [{ type: "text", text: message }], stop_reason: "end_turn", usage } })}\n`);
    }
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
    if (prompt.includes("[no-answer]")) {
      setTimeout(() => {
        clearInterval(spin);
        const error = "API Error: Not logged in · Please run /login";
        if (provider === "claude") {
          appendFileSync(transcript, `${JSON.stringify({ type: "assistant", sessionId: id, cwd, timestamp: new Date().toISOString(), isApiErrorMessage: true, message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: error }] } })}\n`);
        }
        process.stdout.write(`  ⎿  ${error}\r\n> `);
        title(IDLE);
      }, 1200);
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
      process.stdout.write(`● Moving 14 notes out of drafts/ into published/\r\n${DIALOG.join("\r\n")}`);
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
