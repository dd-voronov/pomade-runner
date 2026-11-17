import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/** The port of the UI's dev server, the target of a dev-server link (`pomade apps link http://localhost:5273`). */
export const DEV_PORT = 5273;

// The UI build is the root of the Pomade app folder: `index.html` and its assets with relative
// URLs, next to the static files of `app/` (`manifest.json`, the icon). `scripts/build.mjs` adds
// the bundled backend and command entries.
export default defineConfig({
  root: at("src/ui"),
  publicDir: at("app"),
  base: "./",
  plugins: [react()],
  build: { outDir: at("dist"), emptyOutDir: true },
  server: { port: DEV_PORT, strictPort: true },
});
