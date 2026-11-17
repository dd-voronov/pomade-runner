// Builds the Pomade app folder `dist/`: the UI (Vite) at its root with the static files of `app/`
// (manifest, icon), and the backend and command entries the manifest names, each bundled into one
// file with everything it imports. An installed copy (`<userData>/apps/pomade-runner/`) has no
// `node_modules`, so an entry must run from the folder alone, on Pomade's runtime.

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build as bundle } from "esbuild";
import { parseManifest } from "pomade-kit/protocol";
import { build as buildUi } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");

/** Each bundled entry: its path in the build folder (as the manifest names it) → its source. */
const NODE_ENTRIES = {
  "backend/scheduler.mjs": "src/scheduler/main.ts",
  "cli/pomade-runner.mjs": "src/jobs/cli/main.ts",
};

await buildUi({ configFile: join(root, "vite.config.ts"), logLevel: "warn" });

await bundle({
  absWorkingDir: root,
  entryPoints: Object.entries(NODE_ENTRIES).map(([out, source]) => ({ in: source, out: out.replace(/\.mjs$/, "") })),
  outdir: dist,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  // The oldest Node an Electron that runs Pomade carries.
  target: "node22",
  legalComments: "none",
  // CommonJS dependencies bundled into ESM (yaml) call `require` for Node's built-ins.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  logLevel: "warning",
});

// The folder is installable only when the manifest is valid and names files that are there.
const parsed = parseManifest(JSON.parse(await readFile(join(dist, "manifest.json"), "utf8")));
if (!parsed.ok) {
  throw new Error(`dist/manifest.json is invalid: ${parsed.errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`);
}
const { manifest } = parsed;
const named = [
  manifest.entry,
  manifest.icon,
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

console.log(`Built ${manifest.name} ${manifest.version} into ${dist}`);
