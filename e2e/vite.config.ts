import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

// Serves the fake-host harness page. The Runner build under test is served separately, on another
// origin, as Pomade serves it.
export default defineConfig({
  root: fileURLToPath(new URL("./harness", import.meta.url)),
});
