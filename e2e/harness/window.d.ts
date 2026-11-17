import type { FakeHost } from "pomade-kit/fake-host";

import type { ServiceStatus } from "../../src/keeper/model";

declare global {
  interface Window {
    fakeHost: FakeHost;
    /** Set what the stand-in scheduler says of a service (`harness/scheduler.ts`). */
    setServiceStatus(job: string, status: Partial<ServiceStatus>): void;
  }
}
