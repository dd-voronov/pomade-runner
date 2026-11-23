// What Runner's Settings view shows about the Mac around it, read-only: whether macOS lets Runner
// notify while Pomade is closed, and where the agent skill's copy is. The scheduler runs on the Mac
// and sees both (`read-environment.ts`). Pure: the UI shares it.

/** The agent skill's name: the folder its copy is in. */
export const AGENT_SKILL = "pomade-runner-jobs";

/** Whether Needs-you items reach the person as macOS notifications while Pomade is closed.
 *  `unavailable`: Runner's scheduler posts none. */
export const NOTIFICATION_STATES = ["allowed", "denied", "not-asked", "unavailable"] as const;
export type NotificationState = (typeof NOTIFICATION_STATES)[number];

export interface EnvironmentReport {
  notifications: NotificationState;
  /** The agent skill's copy: its folder, workspace-relative (`<skills folder>/pomade-runner-jobs`),
   *  and why it could not be written there (`null`: it holds the installed version's skill). */
  skill: { folder: string; problem: string | null };
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
    typeof skill.folder === "string" &&
    (skill.problem === null || typeof skill.problem === "string")
  );
}
