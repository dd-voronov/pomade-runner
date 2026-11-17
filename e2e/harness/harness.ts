// pomade-kit's fake host as the parent window of a Runner frame: the page the UI specs open
// instead of Pomade. `?app=<url>` is the Runner page to load; `?surface=panel` opens it as the
// side panel of the strip icon, otherwise as a tab, at `?route=<route>` when given;
// `?hostApi=<n>` makes the host speak another Host API version, so the handshake is refused;
// `?scheduler=none` leaves out the stand-in scheduler that serves Runner's API. The fake host is
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

const fakeHost = createFakeHost({
  manifest,
  pomadeVersion: "0.0.0-e2e",
  projects: [{ id: "alpha", name: "Alpha", root: "Projects/alpha" }],
  activeProject: "alpha",
  ...(hostApi === null ? {} : { hostApi: Number(hostApi) }),
});
window.fakeHost = fakeHost;

if (query.get("scheduler") !== "none" && hostApi === null) await startFakeScheduler(fakeHost);
const route = query.get("route");
window.mounted = mountApp(fakeHost, { src: app, ...(query.get("surface") === "panel" ? { surface: "panel", icon: STRIP_ICON } : {}), ...(route === null ? {} : { route }) });
