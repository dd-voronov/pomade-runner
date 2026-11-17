import type { ConnectResult } from "pomade-kit/sdk";

import { APP_NAME, APP_VERSION } from "../app";
import { EmptyState } from "./EmptyState";
import { Panel } from "./Panel";
import { RunnerTab } from "./RunnerTab";

const REJECTED: Record<Extract<ConnectResult, { status: "rejected" }>["reason"], { title: string; text: string }> = {
  "needs-newer-pomade": {
    title: "Runner needs a newer Pomade",
    text: `${APP_NAME} ${APP_VERSION} speaks a newer Host API than this Pomade. Update Pomade to use it.`,
  },
  "app-too-old": {
    title: "Runner needs an update",
    text: `${APP_NAME} ${APP_VERSION} speaks an older Host API than this Pomade. Update Runner: run ./install in its repo.`,
  },
  unauthorized: {
    title: "Pomade refused Runner",
    text: "Pomade did not accept this frame as Runner. Reinstall Runner: run ./install in its repo.",
  },
};

export function App({ connection }: { connection: ConnectResult }): React.JSX.Element {
  if (connection.status === "no-host") {
    return (
      <EmptyState testId="no-host" title="No Pomade host">
        Runner is a Pomade app: it shows its jobs inside Pomade. Open it from the Runner icon on Pomade's left strip.
      </EmptyState>
    );
  }
  if (connection.status === "rejected") {
    const { title, text } = REJECTED[connection.reason];
    return (
      <EmptyState testId="rejected" title={title}>
        {text}
      </EmptyState>
    );
  }
  const { host } = connection;
  return host.welcome.surface === "panel" ? <Panel host={host} /> : <RunnerTab host={host} />;
}
