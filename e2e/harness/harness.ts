// pomade-kit's fake host as the parent window of a Runner frame: the page the UI specs open
// instead of Pomade. `?app=<url>` is the Runner page to load; `?surface=panel` opens it as the
// side panel of the strip icon, otherwise as a tab, at `?route=<route>` when given;
// `?agents=none` leaves out the stand-in Agents app (`agents.ts`), `?agents=silent` keeps it from answering;
// `?hostApi=<n>` makes the host speak another Host API version, so the handshake is refused;
// `?scheduler=none` leaves out the stand-in scheduler that serves Runner's API; `?projects=prototype`
// gives Pomade the prototype's projects and groups, `?projects=<json>` other projects
// (`[{ id, name, root }]`), `?active=<id>` the one open, and `?repos=a,b` more git repos. The fake host is
// on `window.fakeHost` for the specs to read what the app did and to write job files, the mounted
// frame on `window.mounted` to navigate it. A tab is one of the app's tabs in the fake tab strip;
// each keyed tab the app opens gets a frame of its own, shown while that tab is focused. Frames are
// `iframe[data-frame]`: `main` for the one opened, the key for a keyed tab's.

import { createFakeHost, mountApp, type MountedApp } from "pomade-kit/fake-host";

import manifest from "../../app/manifest.json" with { type: "json" };
import { STRIP_ICON } from "../../src/app";
import { agentsStandIn, HARNESS_ROSTER } from "./agents";
import { startFakeScheduler } from "./scheduler";

const query = new URLSearchParams(location.search);
const app = query.get("app");
if (!app) throw new Error("harness: missing ?app=<url>");
const hostApi = query.get("hostApi");
const projects = query.get("projects");

// `?projects=prototype` gives the host the approved prototype's projects and groups, for the
// screenshots that compare with it (`scripts/shots.mjs`).
const PROTOTYPE_PROJECTS = {
  groups: [
    { id: "g-os", name: "Personal" },
    { id: "g-pomade", name: "Pomade" },
    { id: "g-side", name: "Side projects" },
  ],
  projects: [
    { id: "alpha", name: "Alpha", root: "Projects/alpha", group: "g-side" },
    { id: "notes", name: "notes", root: "notes", group: "g-os" },
    { id: "pomade", name: "Pomade", root: "Projects/Pomade", group: "g-pomade" },
    { id: "pomade-kit", name: "pomade-kit", root: "Projects/pomade-kit", group: "g-pomade" },
    { id: "pomade-runner", name: "pomade-runner", root: "Projects/pomade-runner", group: "g-pomade" },
    { id: "blog", name: "blog", root: "Projects/blog", group: "g-side" },
    { id: "shop", name: "shop", root: "Projects/shop", group: "g-side" },
  ],
};

const fakeHost = createFakeHost({
  manifest,
  pomadeVersion: "0.0.0-e2e",
  ...(projects === "prototype" ? PROTOTYPE_PROJECTS : { projects: projects === null ? [{ id: "alpha", name: "Alpha", root: "Projects/alpha" }] : (JSON.parse(projects) as { id: string; name: string; root: string }[]) }),
  activeProject: query.get("active") ?? "alpha",
  // The workspace's one repo, as Pomade's git state reads it: the name git jobs name it by.
  // `?repos=a,b` names more, for the screenshots that compare with the prototype's.
  git: ["notes", ...(query.get("repos")?.split(",") ?? [])].map((name) => ({ name, root: name, absPath: `/fake/workspace/${name}`, remoteUrl: null, branch: "main", upstream: null, ahead: 0, behind: 0, hasCommits: true, changes: [] })),
  ...(hostApi === null ? {} : { hostApi: Number(hostApi) }),
  apps: agentsStandIn(query.get("agents")),
  roster: HARNESS_ROSTER,
  // The sessions Open session resumes: the result cards' agent runs.
  sessions: [{ agentId: "claude", sessionId: "5f0c2a1e-7b3d-4c8e-9a61-0d2f4b6e8c90" }],
});
window.fakeHost = fakeHost;

if (query.get("scheduler") !== "none" && hostApi === null) await startFakeScheduler(fakeHost);
const route = query.get("route");
if (query.get("surface") === "panel") {
  window.mounted = mountApp(fakeHost, { src: app, surface: "panel", icon: STRIP_ICON });
  window.mounted.iframe.dataset.frame = "main";
} else {
  // The Runner tab is one of the app's tabs in the fake tab strip, so the frame's own tab calls
  // (`tabs.setRoute`, `tabs.close`) and a `tabs.openApp` to it reach it as in Pomade.
  const main = fakeHost.openAppTab({ route: route ?? "" });
  window.mounted = mountApp(fakeHost, { src: app, tabId: main.tabId });
  window.mounted.iframe.dataset.frame = "main";
  // Every keyed tab the app opens (a run's output tab) gets its frame, `data-frame` its key; the
  // focused tab's frame is the one shown, as in Pomade's tab strip.
  const frames = new Map<string, MountedApp>([[main.tabId, window.mounted]]);
  const show = (tabId: string): void => {
    for (const [id, frame] of frames) frame.setHidden(id !== tabId);
  };
  fakeHost.onAppTab(({ change, tab }) => {
    if (change === "open" && tab.key !== undefined) {
      const frame = mountApp(fakeHost, { src: app, tabId: tab.tabId });
      frame.iframe.dataset.frame = tab.key;
      frames.set(tab.tabId, frame);
      show(tab.tabId);
    } else if (change === "focus" && frames.has(tab.tabId)) show(tab.tabId);
    else if (change === "close" && tab.tabId !== main.tabId) {
      frames.get(tab.tabId)?.close();
      frames.delete(tab.tabId);
      show(main.tabId);
    }
  });
}
