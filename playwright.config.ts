import { defineConfig, devices } from "@playwright/test";

import { APP_PORT, HARNESS_PORT } from "./e2e/support/ports";

// Six projects over the built app folder `dist/` (the first web server builds it before any test
// runs): the UI in pomade-kit's fake host · the scheduler and the command as processes · the keeper
// and its sessions as processes · service supervision as processes · Runner hosted by a real Pomade
// (`POMADE_REPO`) · the install script, which rebuilds `dist/` and so runs after the others.
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
    { name: "pomade", testMatch: "pomade.spec.ts" },
    { name: "install", testMatch: "install.spec.ts", dependencies: ["ui", "background", "keeper", "services", "pomade"] },
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
