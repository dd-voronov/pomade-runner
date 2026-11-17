// The scheduler's connection to Pomade over the Host API socket: kept up while Pomade runs,
// retried while it is closed. While connected, the scheduler serves Runner's API through the
// broker, publishes Runner's events, and follows Pomade's projects.

import { stayConnected } from "pomade-kit/node";
import type { JsonValue } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import type { JobsSnapshot, ProjectRecord } from "../jobs/model";
import { JOBS_CHANGED_EVENT, JOBS_LIST_METHOD } from "./runner-api";

export interface PomadeLinkHandlers {
  connected(host: HostClient): void;
  /** Pomade quit or restarted; a reconnect follows. */
  disconnected(): void;
  /** Pomade refused Runner (its key, or a Host API version mismatch); retried. */
  rejected(reason: string): void;
}

/** Starts the connection; `stop()` closes it and ends the retries. */
export type LinkPomade = (handlers: PomadeLinkHandlers) => { stop(): void };

export const linkPomade: LinkPomade = (handlers) =>
  stayConnected(
    { role: "backend" },
    {
      onConnect: (host) => handlers.connected(host),
      onDisconnect: () => handlers.disconnected(),
      onRejected: (reason) => handlers.rejected(reason),
    },
  );

function asJson(snapshot: JobsSnapshot): JsonValue {
  return JSON.parse(JSON.stringify(snapshot)) as JsonValue;
}

/** Pomade's projects as the job checks need them. */
async function readProjects(host: HostClient): Promise<ProjectRecord[]> {
  const { projects } = await host.project.list();
  return projects.map(({ id, name, root }) => ({ id, name, root }));
}

export interface RunnerOffer {
  /** The checked jobs now. */
  jobs(): JobsSnapshot;
  /** Pomade's projects, read on connect and again when one is created or renamed. */
  projects(projects: ProjectRecord[]): void;
  log(message: string): void;
}

/**
 * On a new connection: serve `jobs.list`, follow the projects, and announce the jobs — a frame that
 * found no scheduler before asks again when it hears `jobs.changed`.
 */
export async function offerRunner(host: HostClient, offer: RunnerOffer): Promise<void> {
  const reloadProjects = (): void => {
    readProjects(host).then(offer.projects, (err: unknown) => offer.log(`cannot read Pomade's projects: ${String(err)}`));
  };
  try {
    await host.api.serve({ [JOBS_LIST_METHOD]: () => asJson(offer.jobs()) });
    await host.events.subscribe("project.created", reloadProjects);
    await host.events.subscribe("project.renamed", reloadProjects);
    offer.projects(await readProjects(host));
    await host.events.publish(JOBS_CHANGED_EVENT);
  } catch (err) {
    offer.log(`cannot offer Runner's API to Pomade: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Tell Runner's frames the jobs changed. */
export function announceJobs(host: HostClient, log: (message: string) => void): void {
  host.events.publish(JOBS_CHANGED_EVENT).catch((err: unknown) => log(`cannot publish ${JOBS_CHANGED_EVENT}: ${String(err)}`));
}
