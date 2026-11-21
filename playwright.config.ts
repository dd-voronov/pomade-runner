import { defineConfig, devices } from "@playwright/test";

import { APP_PORT, HARNESS_PORT } from "./e2e/support/ports";

// Ten projects over the built app folder `dist/` (the first web server builds it before any test
// runs): the UI in pomade-kit's fake host · the scheduler and the command as processes · the keeper
// and its sessions as processes · service supervision as processes · scheduled scripts as
// processes · missed runs and load as processes · chains and login hooks as processes · Runner
// hosted by a real Pomade (`POMADE_REPO`) · a missed run that waits for you in a real Pomade · the
// install script, which rebuilds `dist/` and so runs after the others.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  projects: [
    { name: "ui", testMatch: "ui.spec.ts", use: { ...devices["Desktop Chrome"] } },
    { name: "background", testMatch: "background.spec.ts" },
    { name: "keeper", testMatch: "keeper.spec.ts" },
    { name: "services", testMatch: "services.spec.ts" },
    { name: "runs", testMatch: "runs.spec.ts" },
    { name: "load", testMatch: "load.spec.ts" },
    { name: "chains", testMatch: "chains.spec.ts" },
    { name: "git", testMatch: "git.spec.ts" },
    { name: "pomade", testMatch: "pomade.spec.ts" },
    { name: "pomade-load", testMatch: "pomade-load.spec.ts" },
    { name: "pomade-git", testMatch: "pomade-git.spec.ts" },
    { name: "pomade-agents", testMatch: "pomade-agents.spec.ts" },
    { name: "install", testMatch: "install.spec.ts", dependencies: ["ui", "background", "keeper", "services", "runs", "load", "chains", "git", "pomade", "pomade-load", "pomade-git", "pomade-agents"] },
  ],
  webServer: [
    {
      command: `npm run build && npx vite preview --port ${APP_PORT} --strictPort`,
      url: `http://localhost:${APP_PORT}/manifest.json`,
      reuseExistingServer: false,
    },
    {
      command: `npx vite --config e2e/vite.config.ts --port ${HARNESS_PORT} --strictPort`,
      url: `http://localhost:${HARNESS_PORT}/harness.html`,
      reuseExistingServer: false,
    },
  ],
});
