import type { FakeHost, MountedApp } from "pomade-kit/fake-host";

import type { JsonValue } from "pomade-kit/protocol";

import type { ServiceStatus } from "../../src/keeper/model";
import type { RunRecord, RunsReport } from "../../src/scheduler/model";

declare global {
  interface Window {
    fakeHost: FakeHost;
    /** The Runner frame the harness mounted. */
    mounted: MountedApp;
    /** Set what the stand-in scheduler says of a service (`harness/scheduler.ts`). */
    setServiceStatus(job: string, status: Partial<ServiceStatus>): void;
    /** Set what the stand-in scheduler says of the runs: the report, the history, any run's output. */
    setRuns(runs: Partial<{ report: RunsReport; history: RunRecord[]; output: string }>): void;
    /** Set what the stand-in scheduler says of the settings: the settings file's text, `null` for none. */
    setSettings(text: string | null): void;
    /** The actions the UI asked of the stand-in scheduler, in order. */
    runnerCalls: { method: string; params: JsonValue }[];
  }
}
