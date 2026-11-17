// Runner's identity, read from the manifest it ships: one source for the UI, the scheduler and the
// command.

import manifest from "../app/manifest.json";

export const APP_ID = manifest.id;
export const APP_NAME = manifest.name;
export const APP_VERSION = manifest.version;

/** The strip icon whose panel is Runner's side panel. */
export const STRIP_ICON = "runner";
