// pomade-kit's fake host as the parent window of a Runner frame: the page the UI specs open
// instead of Pomade. `?app=<url>` is the Runner page to load; `?surface=panel` opens it as the
// side panel of the strip icon, otherwise as a tab, at `?route=<route>` when given;
// `?hostApi=<n>` makes the host speak another Host API version, so the handshake is refused;
// `?scheduler=none` leaves out the stand-in scheduler that serves Runner's API; `?projects=prototype`
// gives it the prototype's projects. The fake host is
// on `window.fakeHost` for the specs to read what the app did and to write job files, the mounted
// frame on `window.mounted` to navigate it.

import { createFakeHost, mountApp } from "pomade-kit/fake-host";

import manifest from "../../app/manifest.json" with { type: "json" };
import { STRIP_ICON } from "../../src/app";
import { startFakeScheduler } from "./scheduler";

const query = new URLSearchParams(location.search);
const app = query.get("app");
if (!app) throw new Error("harness: missing ?app=<url>");
const hostApi = query.get("hostApi");

// `?projects=prototype` gives the host the approved prototype's projects and groups, for the
// screenshots that compare with it (`scripts/shots.mjs`).
const PROTOTYPE_PROJECTS = {
  groups: [
    { id: "g-os", name: "Personal OS" },
    { id: "g-pomade", name: "Pomade" },
    { id: "g-side", name: "Side projects" },
  ],
  projects: [
    { id: "alpha", name: "Alpha", root: "Projects/alpha", group: "g-side" },
    { id: "knowledge", name: "Knowledge", root: "Knowledge", group: "g-os" },
    { id: "pomade", name: "Pomade", root: "Projects/Pomade", group: "g-pomade" },
    { id: "pomade-kit", name: "pomade-kit", root: "Projects/pomade-kit", group: "g-pomade" },
    { id: "pomade-runner", name: "pomade-runner", root: "Projects/pomade-runner", group: "g-pomade" },
    { id: "coda-helper", name: "coda-helper", root: "Projects/coda-helper", group: "g-side" },
    { id: "job-hunt", name: "job-hunt", root: "Projects/job-hunt", group: "g-side" },
  ],
};

const fakeHost = createFakeHost({
  manifest,
  pomadeVersion: "0.0.0-e2e",
  ...(query.get("projects") === "prototype" ? PROTOTYPE_PROJECTS : { projects: [{ id: "alpha", name: "Alpha", root: "Projects/alpha" }] }),
  activeProject: "alpha",
  // The workspace's one repo, as Pomade's git state reads it: the name git jobs name it by.
  git: [{ name: "Knowledge", root: "Knowledge", absPath: "/fake/workspace/Knowledge", remoteUrl: null, branch: "main", upstream: null, ahead: 0, behind: 0, hasCommits: true, changes: [] }],
  ...(hostApi === null ? {} : { hostApi: Number(hostApi) }),
});
window.fakeHost = fakeHost;

if (query.get("scheduler") !== "none" && hostApi === null) await startFakeScheduler(fakeHost);
const route = query.get("route");
window.mounted = mountApp(fakeHost, { src: app, ...(query.get("surface") === "panel" ? { surface: "panel", icon: STRIP_ICON } : {}), ...(route === null ? {} : { route }) });
