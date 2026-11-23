import { describe, expect, it } from "vitest";

import { checkJobs } from "./check";
import { jobFileCandidates, jobFilePath, newJobText, setJobFields, slugify } from "./edit";

function written(text: string, changes: Parameters<typeof setJobFields>[1]): string {
  const result = setJobFields(text, changes);
  if (!result.ok) throw new Error(result.message);
  return result.text;
}

const HAND_WRITTEN = `---
kind: service   # keeps it up
name: Dev server
# the folder is the repo
folder: Projects/blog
command: ./start.sh
ready:
  port: 5173
---
Notes by hand.
`;

describe("field-only writes", () => {
  it("changes one scalar and leaves every other byte", () => {
    expect(written(HAND_WRITTEN, { command: "npm run dev" })).toBe(HAND_WRITTEN.replace("./start.sh", "npm run dev"));
  });

  it("keeps an inline comment on the changed line", () => {
    expect(written(HAND_WRITTEN, { kind: "script" })).toContain("kind: script   # keeps it up\n");
  });

  it("keeps the comment of a mapping field on one flow line while it stays on one line", () => {
    const text = "---\nkind: service\nready: { port: 5173 }   # vite, {dev}\nafter: { job: pull } # nightly\n---\n";
    expect(written(text, { ready: { port: 5174 } })).toBe(text.replace("5173", "5174"));
    expect(written(text, { after: { job: "pull", result: "any" } })).toBe(text.replace("{ job: pull }", "{ job: pull, result: any }"));
    expect(written(text, { ready: { port: { x: { y: 1 } } } })).not.toContain("# vite");
    expect(written("---\nhook: { event: login }\n---\n", { hook: { event: "login" } })).toBe("---\nhook: { event: login }\n---\n");
  });

  it("replaces a mapping field's lines and keeps the rest", () => {
    const next = written(HAND_WRITTEN, { ready: { url: "http://localhost:5173/" } });
    expect(next).toBe(HAND_WRITTEN.replace("ready:\n  port: 5173\n", "ready: { url: http://localhost:5173/ }\n"));
  });

  it("appends a missing field at the end of the block", () => {
    expect(written(HAND_WRITTEN, { "low-priority": true, after: { job: "pull", result: "done", action: "restart" } })).toBe(
      HAND_WRITTEN.replace("---\nNotes", "low-priority: true\nafter: { job: pull, result: done, action: restart }\n---\nNotes"),
    );
  });

  it("removes a field", () => {
    expect(written(HAND_WRITTEN, { ready: undefined })).toBe(HAND_WRITTEN.replace("ready:\n  port: 5173\n", ""));
  });

  it("writes a schedule as a block with flow entries, leaving out entries set to null", () => {
    const next = written(HAND_WRITTEN, { schedule: { every: { minutes: 30, from: "9:00", to: null }, only: "weekdays", start: null } });
    expect(next).toContain("schedule:\n  every: { minutes: 30, from: 9:00 }\n  only: weekdays\n---");
  });

  it("quotes values that would not read back as themselves", () => {
    const next = written("", { git: { operation: "pull", repos: ["notes", "a, b", "true", "x: y"] }, name: "true" });
    expect(next).toContain('git: { operation: pull, repos: [notes, "a, b", "true", "x: y"] }');
    expect(next).toContain('name: "true"');
  });

  it("keeps CRLF line endings", () => {
    const crlf = HAND_WRITTEN.replace(/\n/g, "\r\n");
    expect(written(crlf, { ready: { port: 3000 } })).toBe(crlf.replace("ready:\r\n  port: 5173\r\n", "ready: { port: 3000 }\r\n"));
  });

  it("refuses a file whose frontmatter is not readable", () => {
    expect(setJobFields("---\nkind: [x\n---\n", { name: "x" })).toMatchObject({ ok: false, reason: "unreadable-frontmatter" });
  });

  it("says when nothing changed", () => {
    expect(setJobFields(HAND_WRITTEN, { name: "Dev server" })).toEqual({ ok: true, text: HAND_WRITTEN, changed: false });
  });
});

describe("new job files", () => {
  it("writes the fields in the form's order, then the body, and the result is a valid job", () => {
    const text = newJobText(
      {
        notify: "always",
        schedule: { daily: { at: ["7:00", "13:00"] } },
        agent: "claude",
        folder: ".",
        name: "Morning summary",
        kind: "agent",
      },
      "Summarize today.\n",
    );
    expect(text).toBe("---\nkind: agent\nname: Morning summary\nfolder: .\nagent: claude\nschedule:\n  daily: { at: [7:00, 13:00] }\nnotify: always\n---\nSummarize today.\n");
    const snapshot = checkJobs([{ path: "morning-summary.md", text }], { workspace: null, projects: null });
    expect(snapshot.jobs[0]?.valid).toBe(true);
  });

  it("names the file after the job: a slug, a project's sub-folder, a free name", () => {
    expect([slugify("Dev server"), slugify("  Ünïcode — job!  "), slugify("!!!")]).toEqual(["dev-server", "unicode-job", "job"]);
    expect(jobFilePath(null, "backup")).toBe("Apps/pomade-runner/jobs/backup.md");
    expect(jobFilePath("blog", "dev-server")).toBe("Apps/pomade-runner/jobs/blog/dev-server.md");
    const candidates = jobFileCandidates("blog", "Dev server");
    expect([candidates.next().value, candidates.next().value, candidates.next().value]).toEqual([
      "Apps/pomade-runner/jobs/blog/dev-server.md",
      "Apps/pomade-runner/jobs/blog/dev-server-2.md",
      "Apps/pomade-runner/jobs/blog/dev-server-3.md",
    ]);
  });
});
