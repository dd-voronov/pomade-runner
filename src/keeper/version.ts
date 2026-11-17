// The keeper's version: a digest of what makes up the keeper Runner ships — its bundled entry and
// the packages it loads at run time — so it changes exactly when a Runner build ships a different
// keeper. The build computes it; the scheduler starts the keeper with it and compares it with the
// one a running keeper reports. Pure, with no imports of this repo: `scripts/build.mjs` imports it.

import { createHash } from "node:crypto";

export interface RuntimePackage {
  name: string;
  version: string;
}

/** The version of a keeper made of `entry` (the bundle's bytes) and `packages`; 12 hex digits. */
export function keeperVersion(entry: Uint8Array, packages: readonly RuntimePackage[]): string {
  const hash = createHash("sha256").update(entry);
  for (const { name, version } of [...packages].sort((a, b) => a.name.localeCompare(b.name))) hash.update(`\n${name}@${version}`);
  return hash.digest("hex").slice(0, 12);
}

/** Whether a running keeper is to be updated to the shipped one: the versions differ. A keeper of
 *  an older or a newer build alike is replaced — the shipped one is what this scheduler speaks to. */
export function keeperNeedsUpdate(running: string, shipped: string): boolean {
  return running !== shipped;
}
