// A stand-in for Runner's scheduler in the fake host: another client of the app that serves
// `jobs.list` and announces `jobs.changed`, as the real scheduler does through Pomade. It reads the
// fake workspace's jobs folder through the Host API and checks it with the real validator, so the
// UI specs drive it by writing files (`fakeHost.writeFile`).

import type { FakeHost } from "pomade-kit/fake-host";
import type { JsonValue } from "pomade-kit/protocol";
import { connect } from "pomade-kit/sdk";

import { JOBS_CHANGED_EVENT, JOBS_LIST_METHOD } from "../../src/integrations/runner-api";
import { checkJobs } from "../../src/jobs/check";
import { JOBS_FOLDER, type JobsSnapshot } from "../../src/jobs/model";

export async function startFakeScheduler(fake: FakeHost): Promise<void> {
  const result = await connect({ transport: fake.createTransport({ surface: "backend" }), keySource: null });
  if (result.status !== "connected") throw new Error(`fake scheduler: ${result.status}`);
  const { host } = result;

  const read = async (): Promise<JobsSnapshot> => {
    const { entries } = await host.files.readFolder({ path: "", recursive: true });
    const paths = entries.filter((e) => e.kind === "file" && e.path.startsWith(`${JOBS_FOLDER}/`) && e.path.endsWith(".md")).map((e) => e.path);
    const files = await Promise.all(paths.map(async (path) => ({ path: path.slice(JOBS_FOLDER.length + 1), text: (await host.files.readFile({ path })).content })));
    const { projects } = await host.project.list();
    return checkJobs(files, { workspace: "/fake/workspace", projects: projects.map(({ id, name, root }) => ({ id, name, root })) });
  };

  let snapshot = await read();
  await host.api.serve({ [JOBS_LIST_METHOD]: () => JSON.parse(JSON.stringify(snapshot)) as JsonValue });
  await host.files.watch({ path: "", recursive: true }, () => {
    void read().then((next) => {
      snapshot = next;
      return host.events.publish(JOBS_CHANGED_EVENT);
    });
  });
  await host.events.publish(JOBS_CHANGED_EVENT);
}
