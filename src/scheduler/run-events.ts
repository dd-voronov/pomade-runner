// The payloads of Runner's run events on the platform bus (docs/ARCHITECTURE.md "Interfaces"): `run.started`
// when a run's session starts, `run.finished` when it ends — the same job and run, `run.finished`
// repeating every field of `run.started` with how it ended. An agent run's add its session, agent,
// mode, start folder, that Runner started it, when, and its terminal (its session in the keeper): the
// shape `pomade-agents` reads (`../pomade-agents/docs/CONTRACTS.md` "Subscribed events"). Pure.

import type { RunFinishedPayload, RunStartedPayload } from "../integrations/runner-api";
import { sessionIdOf } from "../keeper/ids";
import type { ActiveRun, RunRecord } from "./model";

export function runStartedPayload(run: ActiveRun | RunRecord): RunStartedPayload {
  const payload: RunStartedPayload = { job: run.job, name: run.name, run: run.run, kind: run.kind, folder: run.folder, project: run.project, trigger: run.trigger };
  const { agent } = run;
  if (agent === null) return payload;
  // The session is on `run.finished` once it is known — found after the start, too.
  return { ...payload, sessionId: agent.sessionId, agent: agent.agent, mode: agent.mode, cwd: agent.cwd, startedByRunner: true, startedAt: agent.startedAt, terminal: sessionIdOf({ kind: "run", job: run.job, run: run.run }) };
}

export function runFinishedPayload(record: RunRecord): RunFinishedPayload {
  return { ...runStartedPayload(record), result: record.state, exitCode: record.exitCode };
}
