// What Runner's Settings view shows about the Mac around it, read-only: whether macOS lets Runner
// notify while Pomade is closed, and whether the agent skill is linked into the agents' skills
// folders. The scheduler runs on the Mac and sees both (`read-environment.ts`). Pure: the UI shares it.

/** The agent skill's name: the folder every link is named after. */
export const AGENT_SKILL = "pomade-runner-jobs";

/** Whether Needs-you items reach the person as macOS notifications while Pomade is closed.
 *  `unavailable`: Runner's scheduler posts none. */
export const NOTIFICATION_STATES = ["allowed", "denied", "not-asked", "unavailable"] as const;
export type NotificationState = (typeof NOTIFICATION_STATES)[number];

export interface EnvironmentReport {
  notifications: NotificationState;
  /** The agent skill: linked into `linked` of `folders` skills folders (the user's and each agent's). */
  skill: { linked: number; folders: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The shape check a caller runs on an environment report before trusting it. */
export function isEnvironmentReport(value: unknown): value is EnvironmentReport {
  if (!isRecord(value) || !isRecord(value.skill)) return false;
  const { notifications, skill } = value;
  return (
    typeof notifications === "string" &&
    (NOTIFICATION_STATES as readonly string[]).includes(notifications) &&
    typeof skill.linked === "number" &&
    typeof skill.folders === "number"
  );
}
