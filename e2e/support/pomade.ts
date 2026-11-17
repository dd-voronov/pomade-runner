// The Pomade checkout the specs run Runner in: `POMADE_REPO`, default the sibling repo `../Pomade`.
// It is used as it stands — its built Electron app (`out/`), its Electron runtime and its `pomade`
// command — and never built or changed from here.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { REPO, cleanEnv } from "./env";

export interface PomadeCheckout {
  root: string;
  /** Pomade's runtime: the Electron binary, which also runs backends and commands in Node mode. */
  runtime: string;
  /** The built main-process entry. */
  main: string;
  /** The `pomade` command. */
  bin: string;
}

export function pomadeCheckout(): PomadeCheckout {
  const root = resolve(REPO, process.env.POMADE_REPO ?? "../Pomade");
  const checkout: PomadeCheckout = {
    root,
    runtime: join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
    main: join(root, "out/main/index.js"),
    bin: join(root, "bin/pomade"),
  };
  const missing = [checkout.runtime, checkout.main, checkout.bin].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `No usable Pomade checkout at ${root} (missing ${missing.join(", ")}). ` +
        "Point POMADE_REPO at a Pomade checkout with dependencies installed and `npm run build` done.",
    );
  }
  return checkout;
}

export interface PomadeFolders {
  workspace: string;
  userData: string;
  home: string;
}

/** The environment of a test Pomade and of its `pomade` command: test mode — an unobtrusive window,
 *  no login items — on its own workspace, user data and home, so nothing of a Pomade the user runs
 *  is read or written. */
export function pomadeEnv(folders: PomadeFolders, extra: Record<string, string> = {}): Record<string, string> {
  return cleanEnv({
    NODE_ENV: "test",
    POMADE_WORKSPACE: folders.workspace,
    POMADE_USER_DATA: folders.userData,
    POMADE_HOME: folders.home,
    ...extra,
  });
}
