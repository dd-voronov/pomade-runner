// The scheduler's control protocol: how the `pomade-runner` command talks to the scheduler
// directly, with Pomade open or closed. One JSON object per line over the scheduler's own unix
// socket (`schedulerSocketPath`); a request names the protocol version it speaks, and every
// response carries the scheduler's, so a command and a scheduler of different builds — an update
// replaces the command at once and the running scheduler a moment later — tell each other apart
// with a message instead of misreading each other.

export const CONTROL_PROTOCOL = 1;

/** Where the scheduler's connection to Pomade stands. */
export type PomadeLinkState = "connected" | "disconnected" | "rejected";

export interface SchedulerStatus {
  /** The running scheduler's build. */
  version: string;
  pid: number;
  /** ISO time the scheduler started. */
  startedAt: string;
  /** ISO time of its latest tick; `null` before the first. */
  lastTickAt: string | null;
  pomade: PomadeLinkState;
}

/** Every method, with the value it answers. */
export interface ControlMethods {
  status: SchedulerStatus;
}

export type ControlMethod = keyof ControlMethods;

export type ControlErrorCode = "invalid-request" | "protocol-mismatch" | "unknown-method";

export interface ControlRequest {
  protocol: number;
  /** Chosen by the caller; the response repeats it. */
  id: string;
  method: string;
}

export interface ControlError {
  code: ControlErrorCode;
  message: string;
}

export type ControlResponse =
  | { protocol: number; id: string; ok: true; value: unknown }
  | { protocol: number; id: string; ok: false; error: ControlError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ERROR_CODES: readonly string[] = ["invalid-request", "protocol-mismatch", "unknown-method"] satisfies ControlErrorCode[];
const LINK_STATES: readonly string[] = ["connected", "disconnected", "rejected"] satisfies PomadeLinkState[];

export function parseControlRequest(data: unknown): ControlRequest | null {
  if (!isRecord(data)) return null;
  const { protocol, id, method } = data;
  if (typeof protocol !== "number" || !Number.isInteger(protocol)) return null;
  if (typeof id !== "string" || typeof method !== "string") return null;
  return { protocol, id, method };
}

function parseControlError(data: unknown): ControlError | null {
  if (!isRecord(data)) return null;
  const { code, message } = data;
  if (typeof code !== "string" || !ERROR_CODES.includes(code) || typeof message !== "string") return null;
  return { code: code as ControlErrorCode, message };
}

export function parseControlResponse(data: unknown): ControlResponse | null {
  if (!isRecord(data)) return null;
  const { protocol, id, ok } = data;
  if (typeof protocol !== "number" || !Number.isInteger(protocol) || typeof id !== "string") return null;
  if (ok === true) return { protocol, id, ok, value: data.value };
  if (ok !== false) return null;
  const error = parseControlError(data.error);
  return error === null ? null : { protocol, id, ok, error };
}

export function isSchedulerStatus(value: unknown): value is SchedulerStatus {
  if (!isRecord(value)) return false;
  const { version, pid, startedAt, lastTickAt, pomade } = value;
  return (
    typeof version === "string" &&
    typeof pid === "number" &&
    typeof startedAt === "string" &&
    (lastTickAt === null || typeof lastTickAt === "string") &&
    typeof pomade === "string" &&
    LINK_STATES.includes(pomade)
  );
}

/** The check a caller runs on each method's answer before trusting its shape. */
export const RESULT_GUARDS: { [M in ControlMethod]: (value: unknown) => value is ControlMethods[M] } = {
  status: isSchedulerStatus,
};

export function isControlMethod(method: string): method is ControlMethod {
  return Object.hasOwn(RESULT_GUARDS, method);
}
