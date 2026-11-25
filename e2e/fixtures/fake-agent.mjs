// A scripted stand-in for an agent CLI, run in a terminal as Claude Code or Codex would be: it puts
// up the provider's idle title, works on the prompt (the provider's working title, a few lines of
// output), goes idle again with its answer on screen above its empty prompt — Claude's composer, a
// "❯" row between two rules over its footer; Codex's "›" row with its faint placeholder over its
// footer — and ends on the exit command typed into it (`/exit`, then Enter) — or on Ctrl+C. Words in the prompt script it: `[exit-early]` ends it with
// status 0 while it works; `[slow]` makes the turn last 4 s, `[long]` 15 s; `[ask]` puts up a permission prompt
// midway — the provider's dialog, as the kit's scanner reads it — and waits for the answer: `1` or
// Enter allows it and the turn goes on, Esc (or the provider's "No") denies it and the turn ends
// there; `[ask-late]` puts it up 5 s into the turn; `[no-answer]` ends the turn on an API error
// ("Not logged in · Please run /login") with no answer — the record's last message stays `null`,
// and the transcript's assistant record is the error one Claude Code writes (`isApiErrorMessage`);
// `[stuck]` stops at a screen no scanner names before it starts (Claude's login method choice)
// under the idle title, with no session made: `1`, `2` or Enter picks a method and the agent starts
// as with no word, Esc ends it with status 1. `[consent]` stops at Claude's Bypass Permissions
// consent screen before it sets any title, with no session made — the screen as Claude drew it,
// from a real run's output log (`claude-bypass-consent.txt`, its trailing terminal queries left
// out) — "❯ No, exit" highlighted: ↓/↑ move the highlight, Enter picks it — "Yes, I accept" clears
// the screen and the agent starts as with no word, "No, exit" ends it with status 1, leaving the
// screen as drawn; Esc ends it so too. `[question]` puts up Claude's question form midway (its
// AskUserQuestion tool: "☐ Format", options, footer "Enter to select · ↑/↓ to navigate · Esc to
// cancel") under the idle title: Enter picks the highlighted option, `1`/`2` theirs, ↓/↑ move the
// highlight, Esc declines; the turn goes on and its answer names the pick. `[unknown-dialog]` puts
// up a dialog no scanner names midway (Claude's plan approval: "Ready to code?", "❯ 1. Yes…",
// "ctrl-g to edit in Vim") under the idle title: Enter or `1` goes on, `2` or Esc stops the turn
// there. `[works-again]`: the first exit command does not end it — it works 18 s more and ends that
// turn again; the next exit command ends it.
// Background work, as Claude Code shows it: `[background]` ends the turn with a background shell
// going — the footer under the composer, the last row on screen, counts it ("· 1 shell") — which
// ends 3 s later (`[background-long]`: 120 s); the footer's count goes and the agent takes a
// further turn by itself, which ends without background work. `[background-hidden]` leaves work
// the footer does not count (as a background sub-agent): its turn ends idle without it, and the
// work ends 4 s later with the same further turn. While background work goes, the exit command is
// answered by a moment of work (the working title for ~15 ms) and then the "Background work is
// running" dialog — its rule, question, "❯ 1. Exit and stop tasks", "2. Stay", footer "Enter to
// confirm · Esc to cancel" last; Esc or `2` closes it and the agent stays, `1` or Enter exits.
// `[esc-ignored]` keeps the dialog up on Esc, and the hidden work going 60 s.
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

/** Claude Code's consent screen for Bypass Permissions mode, as a profile that never accepted it
 *  shows it: "No, exit" highlighted, and the same screen with "Yes, I accept" highlighted. */
const CONSENT = readFileSync(new URL("claude-bypass-consent.txt", import.meta.url), "utf8");
const NO_HIGHLIGHTED = "\x1b[3G\x1b[38;5;105m❯\x1b[5GNo,\x1b[9Gexit\x1b[39m\r\r\n\x1b[5GYes,\x1b[10GI\x1b[12Gaccept\r\r\n";
if (!CONSENT.includes(NO_HIGHLIGHTED)) throw new Error("fake-agent: the consent capture's option rows changed");
const CONSENT_ACCEPT = CONSENT.replace(NO_HIGHLIGHTED, "\x1b[5GNo,\x1b[9Gexit\r\r\n\x1b[3G\x1b[38;5;105m❯\x1b[5GYes,\x1b[10GI\x1b[12Gaccept\x1b[39m\r\r\n");
/** A screen no scanner names, before the agent starts: Claude's login method choice. */
const LOGIN = ["", " Claude Code can be used with your Claude subscription or billed based on API usage", " through your Console account.", "", " Select login method:", "", " ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise", "", "   2. Anthropic Console account · API usage billing"];

/** Claude Code's footer while a background shell goes: the last row on screen, under the composer. */
const SHELL_FOOTER = "  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage";
/** Its dialog answering an exit command while background work goes. */
const BACKGROUND_DIALOG = ["▔".repeat(40), "  Background work is running", "  The following will stop when you exit:", "", "  shell · sleep", "", "  ❯ 1. Exit and stop tasks", "    2. Stay", "", "  Enter to confirm · Esc to cancel"];

/** The rules of Claude's composer. */
const RULE = "─".repeat(40);
/** Claude's question form: the rule over it, the header, the question, the options, the footer last. */
const QUESTION_OPTIONS = ["Markdown (Recommended)", "Plain text"];
const questionForm = (highlighted) => [
  RULE,
  " ☐ Format",
  "",
  "Which format should the notes use?",
  "",
  ...QUESTION_OPTIONS.flatMap((option, i) => [`${i === highlighted ? "❯" : " "} ${i + 1}. ${option}`, i === 0 ? "     Headings and lists" : "     No markup"]),
  "  3. Type something.",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
];
/** A dialog no scanner names: Claude's plan approval. */
const UNNAMED_DIALOG = [RULE, " Ready to code?", "", " Here is Claude's plan: tidy the notes.", "", " ❯ 1. Yes, auto-accept edits", "   2. No, keep planning", "", " ctrl-g to edit in Vim"];

let input = "";
/** The background work going: whether the footer counts it; `null` for none. */
let background = null;
/** While the background-work dialog is up: what a key does to it. */
let exitQuestion = null;
/** Whether the composer is on screen, the cursor in it. */
let composed = false;
/** The empty prompt, the footer under it — counting a background shell while one goes — the last
 *  row; the cursor after the prompt mark. */
const composer = () => {
  composed = true;
  if (provider === "claude") {
    const footer = background?.counted === true ? SHELL_FOOTER : "  ⏵⏵ bypass permissions on (shift+tab to cycle)";
    process.stdout.write(`${RULE}\r\n❯ \r\n${RULE}\r\n${footer}\x1b[2A\r\x1b[2C`);
  } else {
    process.stdout.write(`› \x1b[2mAsk Codex to do anything\x1b[22m\r\n\r\n  fake-model · ~/notes\x1b[2A\r\x1b[2C`);
  }
};
/** The composer goes — output takes its place, from its first row down. */
const leaveComposer = () => {
  if (!composed) return;
  composed = false;
  process.stdout.write(provider === "claude" ? "\x1b[1A\r\x1b[J" : "\r\x1b[J");
};
/** An exit command while background work goes: a moment of work, then the dialog under the idle title. */
const askOnExit = () => {
  title(`${WORKING[0]} Working`);
  setTimeout(() => {
    process.stdout.write(`\x1b[J${BACKGROUND_DIALOG.join("\r\n")}`);
    title(IDLE);
    exitQuestion = (key) => {
      if (key === "1" || key === "\r") {
        process.stdout.write("\r\nBye.\r\n");
        process.exit(0);
      }
      if (key !== "2" && (key !== "\x1b" || prompt.includes("[esc-ignored]"))) return;
      exitQuestion = null;
      // The dialog goes: back to the composer where its first row was.
      process.stdout.write(`\x1b[${BACKGROUND_DIALOG.length - 1}A\r\x1b[J`);
      composer();
    };
  }, 15);
};
/** Whether the session has begun: a `[stuck]` agent's begins once a login method is picked, a
 *  `[consent]` agent's once its consent is accepted. */
let begun = false;
/** While a permission prompt is up: what answering it does. */
let answer = null;
/** While the question form or the unnamed dialog is up: what a key does to it. */
let form = null;
/** Exit commands `[works-again]` has not taken yet. */
let notTaken = prompt.includes("[works-again]") ? 1 : 0;
/** `[works-again]`'s further work after an exit command it did not take: set by `begin`. */
let again = () => {};
const listen = () => {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data) => {
    if (exitQuestion !== null) {
      if (data === "\x03") process.exit(130);
      exitQuestion(data[0] ?? "");
      return;
    }
    if (form !== null) {
      if (data === "\x03") process.exit(130);
      // Key by key: an arrow and Enter can arrive in one read.
      for (const key of data.match(/\x1b\[[AB]|[\s\S]/g) ?? []) if (form !== null) form(key);
      return;
    }
    if (answer !== null && prompt.includes("[consent]") && !begun) {
      if (data === "\x03") process.exit(130);
      // Key by key, a sequence whole: an arrow in either cursor-key mode (`ESC [ B`, `ESC O B`); the
      // focus reports the screen turned on (`ESC [ I`, `ESC [ O`) are no keys.
      for (const key of data.match(/\x1b\[[0-?]*[ -/]*[@-~]|\x1bO[A-D]|[\s\S]/g) ?? []) if (answer !== null) answer(key.replace("\x1bO", "\x1b["));
      return;
    }
    if (answer !== null && prompt.includes("[stuck]") && !begun) {
      if (data === "\x03") process.exit(130);
      const key = data[0] ?? "";
      const choice = ["1", "2", "\r"].includes(key) ? "accept" : key === "\x1b" ? "exit" : null;
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
        leaveComposer();
        if (line === "/exit") {
          if (background !== null) {
            askOnExit();
            continue;
          }
          if (notTaken > 0) {
            notTaken--;
            process.stdout.write("● Not yet: one more pass over the notes.\r\n");
            again();
            continue;
          }
          process.stdout.write("Bye.\r\n");
          process.exit(0);
        }
        composer();
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
  process.stdout.write(`resumed session ${id}\r\n● ${record.lastMessage}\r\n`);
  composer();
  listen();
} else if (prompt.includes("[stuck]")) {
  title(IDLE);
  process.stdout.write(LOGIN.join("\r\n"));
  answer = (choice) => {
    if (choice !== "accept") process.exit(1);
    process.stdout.write("\r\n\r\n");
    begin();
  };
  listen();
} else if (prompt.includes("[consent]")) {
  process.stdout.write(CONSENT);
  let accept = false;
  answer = (key) => {
    if (key === "\x1b[A" || key === "\x1b[B") {
      accept = !accept;
      process.stdout.write(`\x1b[2J\x1b[H${accept ? CONSENT_ACCEPT : CONSENT}`);
      return;
    }
    if (key === "\x1b" || (key === "\r" && !accept)) process.exit(1);
    // Any other sequence — a focus report — is no key.
    if (key !== "\r") return;
    answer = null;
    process.stdout.write("\x1b[2J\x1b[H");
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
    process.stdout.write(`● ${message}\r\n`);
    composer();
    title(IDLE);
  };
  /** The turn ends with background work going, which ends `ms` later: the agent takes a further
   *  turn by itself then. */
  const leave = (counted, ms) => {
    background = { counted };
    finish(`Started the background work. ${prompt.split("\n")[0]}`);
    setTimeout(() => {
      // The footer's count goes; the agent goes on — unless its dialog is up, until it closes.
      const goOn = () => {
        if (exitQuestion !== null) return setTimeout(goOn, 100);
        background = null;
        leaveComposer();
        process.stdout.write("● The background work ended.\r\n");
        work();
        setTimeout(() => finish(`**Done.** After the background work: ${prompt.split("\n")[0]}`), 1200);
      };
      goOn();
    }, ms);
  };
  const turn = () =>
    setTimeout(() => {
      if (prompt.includes("[background]")) return leave(true, 3000);
      if (prompt.includes("[background-long]")) return leave(true, 120_000);
      if (prompt.includes("[background-hidden]")) return leave(false, prompt.includes("[esc-ignored]") ? 60_000 : 4000);
      finish(`**Done.** ${prompt.split("\n")[0]}`);
    }, prompt.includes("[long]") ? 15000 : prompt.includes("[slow]") ? 4000 : 1200);
  again = () => {
    work();
    setTimeout(() => finish(`**Done.** After the exit command: ${prompt.split("\n")[0]}`), 18_000);
  };
  /** Claude's question form, under the idle title: a pick goes on with the turn. */
  const ask = () => {
    clearInterval(spin);
    let highlighted = 0;
    const rows = questionForm(0).length;
    process.stdout.write(`● Asking which format to use\r\n${questionForm(highlighted).join("\r\n")}`);
    title(IDLE);
    const redraw = () => process.stdout.write(`\x1b[${rows - 1}A\r\x1b[J${questionForm(highlighted).join("\r\n")}`);
    form = (data) => {
      if (data === "\x1b[B" || data === "\x1b[A") {
        highlighted = (highlighted + 1) % QUESTION_OPTIONS.length;
        return redraw();
      }
      const pick = data === "\r" ? highlighted : data === "1" ? 0 : data === "2" ? 1 : data === "\x1b" ? null : undefined;
      if (pick === undefined) return;
      form = null;
      process.stdout.write(`\x1b[${rows - 1}A\r\x1b[J`);
      if (pick === null) return finish("You declined to pick a format.");
      process.stdout.write(`● Answered: ${QUESTION_OPTIONS[pick]}\r\n`);
      work();
      setTimeout(() => finish(`**Done.** Picked ${QUESTION_OPTIONS[pick]}: ${prompt.split("\n")[0]}`), 1200);
    };
  };
  /** A dialog no scanner names, under the idle title: Enter or 1 goes on, 2 or Esc stops there. */
  const planApproval = () => {
    clearInterval(spin);
    process.stdout.write(`● Planned the tidy-up\r\n${UNNAMED_DIALOG.join("\r\n")}`);
    title(IDLE);
    form = (data) => {
      const key = data[0] ?? "";
      if (!["\r", "1", "2", "\x1b"].includes(key)) return;
      form = null;
      process.stdout.write(`\x1b[${UNNAMED_DIALOG.length - 1}A\r\x1b[J`);
      if (key === "2" || key === "\x1b") return finish("Kept planning, as you said.");
      process.stdout.write("● Going ahead with the plan\r\n");
      work();
      setTimeout(() => finish(`**Done.** After the plan: ${prompt.split("\n")[0]}`), 1200);
    };
  };
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
        process.stdout.write(`  ⎿  ${error}\r\n`);
        composer();
        title(IDLE);
      }, 1200);
      return;
    }
    if (prompt.includes("[question]")) {
      setTimeout(ask, 400);
      return;
    }
    if (prompt.includes("[unknown-dialog]")) {
      setTimeout(planApproval, 400);
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
