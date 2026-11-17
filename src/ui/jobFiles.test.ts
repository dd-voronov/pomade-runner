import { createFakeHost, type FakeHost } from "pomade-kit/fake-host";
import { connect, type HostClient } from "pomade-kit/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import manifest from "../../app/manifest.json" with { type: "json" };
import { checkJobs } from "../jobs/check";
import { createJobFile, followJobFile, updateJobFile } from "./jobFiles";

const WEB = "Apps/pomade-runner/jobs/coda-helper/coda-web.md";
const HAND_WRITTEN = "---\nkind: service # by hand\nname: Coda web\nproject: p1\nfolder: Projects/coda-helper\ncommand: ./start.sh\n---\nNotes.\n";

describe("job files through the Host API", () => {
  let fake: FakeHost;
  let host: HostClient;

  beforeEach(async () => {
    fake = createFakeHost({ manifest, files: { [WEB]: HAND_WRITTEN } });
    const result = await connect({ transport: fake.createTransport(), keySource: null });
    if (result.status !== "connected") throw new Error(result.status);
    host = result.host;
  });

  it("creates a new job in its project's sub-folder, under a free slug, as a valid job file", async () => {
    const path = await createJobFile(host, {
      folder: "coda-helper",
      fields: { kind: "service", name: "Coda web", project: "p1", folder: "Projects/coda-helper", command: "npm run dev", ready: { port: 5173 } },
      body: "",
    });
    expect(path).toBe("Apps/pomade-runner/jobs/coda-helper/coda-web-2.md");
    const text = fake.readFile(path);
    expect(text).toBe("---\nkind: service\nname: Coda web\nproject: p1\nfolder: Projects/coda-helper\ncommand: npm run dev\nready: { port: 5173 }\n---\n");
    const snapshot = checkJobs([{ path: "coda-helper/coda-web-2.md", text }], { workspace: null, projects: null });
    expect(snapshot.jobs[0]?.valid).toBe(true);
  });

  it("writes only the changed fields: comments and the body stay", async () => {
    expect(await updateJobFile(host, WEB, { command: "npm start", ready: { url: "http://localhost:5173/" } })).toBe(true);
    expect(fake.readFile(WEB)).toBe(HAND_WRITTEN.replace("./start.sh", "npm start").replace("---\nNotes", "ready: { url: http://localhost:5173/ }\n---\nNotes"));
    expect(await updateJobFile(host, WEB, { command: "npm start" })).toBe(false);
    await updateJobFile(host, WEB, {}, "New notes.\n");
    expect(fake.readFile(WEB).endsWith("---\nNew notes.\n")).toBe(true);
  });

  it("refuses to write into a file whose frontmatter is broken, and leaves it", async () => {
    fake.writeFile(WEB, "---\nkind: [service\n---\n");
    await expect(updateJobFile(host, WEB, { name: "x" })).rejects.toThrow(/not a valid YAML mapping/);
    expect(fake.readFile(WEB)).toBe("---\nkind: [service\n---\n");
  });

  it("follows the file on disk: edits by anyone, a deletion, a re-creation", async () => {
    const seen: Array<string | null> = [];
    const follow = await followJobFile(host, WEB, (text) => seen.push(text));
    expect(seen).toEqual([HAND_WRITTEN]);
    fake.writeFile(WEB, HAND_WRITTEN.replace("Coda web", "Edited"));
    await vi.waitFor(() => expect(seen.at(-1)).toContain("name: Edited"));
    fake.writeFile("Apps/pomade-runner/jobs/other.md", "x");
    fake.deleteFile(WEB);
    await vi.waitFor(() => expect(seen.at(-1)).toBeNull());
    fake.writeFile(WEB, HAND_WRITTEN);
    await vi.waitFor(() => expect(seen.at(-1)).toBe(HAND_WRITTEN));
    expect(seen).toHaveLength(4);
    await follow.close();
  });
});
