import type { FakeHost, MountedApp } from "pomade-kit/fake-host";

import type { JsonValue } from "pomade-kit/protocol";

import type { ServiceStatus } from "../../src/keeper/model";
import type { EnvironmentReport } from "../../src/scheduler/environment";
import type { RunRecord, RunsReport } from "../../src/scheduler/model";

declare global {
  interface Window {
    fakeHost: FakeHost;
    /** The Runner frame the harness mounted. */
    mounted: MountedApp;
    /** Set what the stand-in scheduler says of a service (`harness/scheduler.ts`). */
    setServiceStatus(job: string, status: Partial<ServiceStatus>): void;
    /** Set what the stand-in scheduler says of the runs: the report, the history, any run's output,
     *  and whether that output is not on this Mac. */
    setRuns(runs: Partial<{ report: RunsReport; history: RunRecord[]; output: string; outputMissing: boolean }>): void;
    /** Set what the stand-in scheduler says of the settings: the settings file's text, `null` for none. */
    setSettings(text: string | null): void;
    /** The settings file's text as the stand-in scheduler holds it: what a setting the UI wrote left in it. */
    settingsText(): string | null;
    /** Set what the stand-in scheduler says of the Mac: the notification permission and the skill's links. */
    setEnvironment(environment: EnvironmentReport): void;
    /** The actions the UI asked of the stand-in scheduler, in order. */
    runnerCalls: { method: string; params: JsonValue }[];
    /** While set, the stand-in scheduler refuses Delete with this reason. */
    refuseDelete: string | null;
    /** While set, the stand-in scheduler refuses Run now and Enable / Disable with this reason. */
    refuseActions: string | null;
    /** What the app wrote to the stand-in clipboard (`ui.spec.ts` `stubClipboard`), in order. */
    copied: string[];
    /** While set, the stand-in clipboard refuses a write with this message. */
    refuseCopy: string | null;
    /** The stand-in scheduler refuses an action (a method of `runner-api.ts`) with its reason while one is set. */
    refuse: Record<string, string>;
  }
}
