// Builds the Pomade app folder `dist/`: the UI (Vite) at its root with the static files of `app/`
// (manifest, icon), the backend and command entries the manifest names, and the keeper's entry the
// scheduler starts — each bundled into one file with everything it imports. An installed copy
// (`<userData>/apps/pomade-runner/`) has no `node_modules` of the repo, so an entry must run from
// the folder alone, on Pomade's runtime. The keeper loads four packages with `require` at run time,
// which a bundle cannot carry: the build ships them in `dist/node_modules/`, where the keeper's
// `require` finds them.

import { access, chmod, cp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build as bundle } from "esbuild";
import { parseManifest } from "pomade-kit/protocol";
import { build as buildUi } from "vite";

import { keeperVersion } from "../src/keeper/version.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");

/** Each bundled entry the manifest names: its path in the build folder → its source. */
const NODE_ENTRIES = {
  "backend/scheduler.mjs": "src/scheduler/main.ts",
  "cli/pomade-runner.mjs": "src/jobs/cli/main.ts",
};

/** The keeper's entry, next to the scheduler, which starts it. */
const KEEPER_ENTRY = { out: "backend/keeper.mjs", source: "src/keeper/entry.ts" };

/** What the keeper loads at run time, and the parts of each package it needs. `node-pty`'s prebuilt
 *  binary is N-API, so it loads in any Pomade runtime without a rebuild. */
const KEEPER_PACKAGES = {
  "node-pty": ["package.json", "LICENSE", "lib", "prebuilds/darwin-arm64", "prebuilds/darwin-x64"],
  "@xterm/headless": ["package.json", "lib-headless"],
  "@xterm/addon-serialize": ["package.json", "lib"],
  "@xterm/addon-unicode11": ["package.json", "LICENSE", "lib"],
};

/** Bundle `entries` (build-folder path → source), with `define` substituted. */
function bundleNode(entries, define = {}) {
  return bundle({
    absWorkingDir: root,
    entryPoints: Object.entries(entries).map(([out, source]) => ({ in: source, out: out.replace(/\.mjs$/, "") })),
    outdir: dist,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    // The oldest Node an Electron that runs Pomade carries.
    target: "node22",
    legalComments: "none",
    define,
    // CommonJS dependencies bundled into ESM (yaml) call `require` for Node's built-ins.
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    logLevel: "warning",
  });
}

await buildUi({ configFile: join(root, "vite.config.ts"), logLevel: "warn" });

// The keeper first: its version is a digest of its bundle and the packages it ships with, and the
// scheduler is built knowing it.
await bundleNode({ [KEEPER_ENTRY.out]: KEEPER_ENTRY.source });
// Resolved as pomade-kit resolves them, so the versions shipped are the ones it was built against.
const requireFromKit = createRequire(createRequire(join(root, "package.json")).resolve("pomade-kit/package.json"));
const shipped = [];
for (const [name, parts] of Object.entries(KEEPER_PACKAGES)) {
  const from = dirname(requireFromKit.resolve(`${name}/package.json`));
  const to = join(dist, "node_modules", name);
  await mkdir(to, { recursive: true });
  for (const part of parts) await cp(join(from, part), join(to, part), { recursive: true });
  const { version } = JSON.parse(await readFile(join(from, "package.json"), "utf8"));
  shipped.push({ name, version });
}
// npm unpacks node-pty's helper without its executable bit; every spawn runs it.
for (const arch of ["darwin-arm64", "darwin-x64"]) await chmod(join(dist, "node_modules/node-pty/prebuilds", arch, "spawn-helper"), 0o755);
const version = keeperVersion(await readFile(join(dist, KEEPER_ENTRY.out)), shipped);

await bundleNode(NODE_ENTRIES, { KEEPER_VERSION: JSON.stringify(version) });

// The folder is installable only when the manifest is valid and names files that are there.
const parsed = parseManifest(JSON.parse(await readFile(join(dist, "manifest.json"), "utf8")));
if (!parsed.ok) {
  throw new Error(`dist/manifest.json is invalid: ${parsed.errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`);
}
const { manifest } = parsed;
const named = [
  manifest.entry,
  manifest.icon,
  ...Object.values(manifest.tabKinds ?? {}).map((kind) => kind.icon),
  manifest.backend?.entry,
  ...(manifest.commands ?? []).map((c) => c.entry),
  ...(manifest.skills ?? []).map((skill) => `${skill.path}/SKILL.md`),
].filter(
  (path) => path !== undefined,
);
for (const path of named) {
  await access(join(dist, path)).catch(() => {
    throw new Error(`the manifest names "${path}", which the build did not produce`);
  });
}
for (const out of Object.keys(NODE_ENTRIES)) {
  if (!named.includes(out)) throw new Error(`the build produced "${out}", which the manifest does not name`);
}

console.log(`Built ${manifest.name} ${manifest.version} (keeper ${version}) into ${dist}`);
