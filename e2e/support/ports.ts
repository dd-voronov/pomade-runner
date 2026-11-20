/** Where the e2e run serves the built Runner (`vite preview`) and the fake-host harness page: two
 *  ports from `RUNNER_E2E_PORT_BASE` (4327 by default) — another base lets a second checkout run its
 *  e2e at the same time. */
export const PORT_BASE = portBase(process.env.RUNNER_E2E_PORT_BASE);
export const APP_PORT = PORT_BASE;
export const HARNESS_PORT = PORT_BASE + 1;

function portBase(value: string | undefined): number {
  if (value === undefined || value === "") return 4327;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65534) throw new Error(`RUNNER_E2E_PORT_BASE: "${value}" is not a port from 1024 to 65534`);
  return port;
}
