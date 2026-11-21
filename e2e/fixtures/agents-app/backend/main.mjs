// Runner's stand-in for `pomade-agents` in the e2e's real Pomade: a backend that answers the calls
// Runner makes, with the published contract's shapes (`../pomade-agents/docs/CONTRACTS.md`
// "Roster", "Reads for Runner") — `roster.list` (also Pomade's roster read), `roster.launchSpec`
// (the line quoted as the contract says, `--session-id` for a Claude Code agent, none for Codex),
// `roster.projectsFor`, `roster.agentsFor`, `sessions.lastMessage` and `sessions.find` — from the
// spec's configuration and the fake agent's session records under `$HOME/.fake-agents/`
// (`config.json`: `{ roster, projects }`; `sessions/<id>.json`). It records every `run.started` and
// `run.finished` Runner publishes in `events.jsonl` there, as the subscriber the contract names; on
// an agent run's `run.finished` it publishes event B `session.closed` for the run's session, with
// `startedByRunner: true` and reason `run-finished`, as the real app does ("Published events").
// `test.publish` `{ event, payload }` is the specs' test publisher: it publishes B or C
// (`session.statusChanged`) with the payload given, as the Agents app would.
// Dev-linked from the repo, so `pomade-kit` resolves from its node_modules.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { stayConnected } from "pomade-kit/node";
import { HostError } from "pomade-kit/sdk";

const dir = join(homedir(), ".fake-agents");
mkdirSync(join(dir, "sessions"), { recursive: true });
const config = () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
const roster = () => config().roster;
const sessions = () =>
  readdirSync(join(dir, "sessions"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, "sessions", name), "utf8")));

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const quote = (arg) => (SAFE.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);

function agentOf(id) {
  const agent = roster().find((candidate) => candidate.id === id);
  if (agent === undefined) throw new HostError("not-found", `no agent ${JSON.stringify(id)}`);
  return agent;
}

const handlers = {
  "roster.list": () => ({ agents: roster() }),
  "roster.launchSpec": ({ agent: id, mode, sessionId, prompt }) => {
    const agent = agentOf(id);
    const found = (agent.modes ?? []).find((candidate) => candidate.id === mode);
    if (found === undefined) throw new HostError("invalid-params", `${id} has no mode ${JSON.stringify(mode)}`);
    const pre = agent.provider === "claude" && typeof sessionId === "string";
    const args = [...found.args, ...(pre ? ["--session-id", sessionId] : []), ...(typeof prompt === "string" ? (prompt.startsWith("-") ? ["--", prompt] : [prompt]) : [])];
    return { command: agent.command, args, line: [agent.command, ...args.map(quote)].join(" "), sessionId: pre ? sessionId : null, exit: "/exit" };
  },
  "roster.projectsFor": ({ agent }) => {
    agentOf(agent);
    return { projects: config().projects?.[agent] ?? [] };
  },
  "roster.agentsFor": ({ project }) => ({ agents: roster().filter((agent) => (config().projects?.[agent.id] ?? []).includes(project)).map((agent) => agent.id) }),
  "sessions.lastMessage": ({ id }) => {
    const session = sessions().find((candidate) => candidate.id === id);
    if (session === undefined) throw new HostError("not-found", `no session ${JSON.stringify(id)}`);
    return { message: session.lastMessage === null ? null : { text: session.lastMessage, at: session.at } };
  },
  "sessions.find": ({ cwd, startedFrom, startedTo, agent }) => {
    const from = Date.parse(startedFrom);
    const to = Date.parse(startedTo);
    const real = realpathSync(cwd);
    const found = sessions()
      .filter((s) => s.cwd === real && Date.parse(s.startedAt) >= from && Date.parse(s.startedAt) <= to && (agent === undefined || s.agent === agent))
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
      .map((s) => ({ id: s.id, provider: s.provider, agent: s.agent, cwd: s.cwd, startedAt: s.startedAt, lastActiveAt: s.at ?? s.startedAt }));
    return { sessions: found };
  },
};

const record = (event) => (payload) => appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ event, payload })}\n`);

/** Event B for a Runner agent run that finished, as the real app publishes it. */
const runEnded = (host) => (payload) => {
  record("run.finished")(payload);
  if (payload?.kind !== "agent" || typeof payload.sessionId !== "string") return;
  host.events
    .publish("session.closed", {
      sessionId: payload.sessionId,
      provider: payload.agent === "codex" ? "codex" : "claude-code",
      agent: payload.agent,
      project: payload.project === null ? null : { id: payload.project, root: payload.folder },
      cwd: payload.cwd,
      transcript: join(dir, "sessions", `${payload.sessionId}.json`),
      name: null,
      status: "active",
      startedByRunner: true,
      job: payload.name,
      at: new Date().toISOString(),
      reason: "run-finished",
    })
    .catch(() => undefined);
};

const link = stayConnected(
  {},
  {
    onConnect(host) {
      const serving = {
        ...handlers,
        "test.publish": async ({ event, payload }) => {
          await host.events.publish(event, payload);
          return {};
        },
      };
      host.api
        .serve(Object.fromEntries(Object.entries(serving).map(([method, handle]) => [method, (params) => handle(params ?? {})])))
        .then(() => host.events.subscribe("pomade-runner:run.started", record("run.started")))
        .then(() => host.events.subscribe("pomade-runner:run.finished", runEnded(host)))
        .catch(() => undefined);
    },
  },
);

process.on("SIGTERM", () => {
  link.stop();
  process.exit(0);
});
