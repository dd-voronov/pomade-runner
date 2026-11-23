// The Services view's Command column: its width limits, the clamp, and the width kept on this Mac
// (`localStorage`, per viewer). Storage that is missing or refuses leaves the default.

/** The narrowest the column is dragged to, and the widest. */
export const COMMAND_MIN = 120;
export const COMMAND_MAX = 720;
export const COMMAND_DEFAULT = 260;
/** An arrow key moves the grip by this much; with Shift, by the larger one. */
export const COMMAND_STEP = 16;
export const COMMAND_STEP_LARGE = 64;
/** What the other columns of a row take, in px: the kind icon, the Service column's least, Status,
 *  the actions and the four gaps between the five columns. The Command column gets the rest; where
 *  that is under `COMMAND_MIN` (a view narrower than 800 px, in `ServicesView.module.css`) the
 *  column gives way. */
export const COMMAND_RESERVED = 16 + 120 + 176 + 262 + 4 * 12;

const KEY = "pomade-runner.services.command-width";

/** `width` kept within the limits and, when `room` (what the row has to give) is known, within that. */
export function clampCommandWidth(width: number, room: number = COMMAND_MAX): number {
  if (!Number.isFinite(width)) return COMMAND_DEFAULT;
  return Math.round(Math.min(Math.max(width, COMMAND_MIN), Math.max(COMMAND_MIN, Math.min(room, COMMAND_MAX))));
}

/** What a row of `rowWidth` px content leaves for the Command column. */
export const commandRoom = (rowWidth: number): number => rowWidth - COMMAND_RESERVED;

/** The browser's `localStorage`, or `null` where it is blocked. */
export function viewerStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The remembered width, or the default when none is kept or it is not a number. */
export function loadCommandWidth(storage: Pick<Storage, "getItem"> | null): number {
  try {
    const kept = storage?.getItem(KEY);
    if (kept === null || kept === undefined || kept === "") return COMMAND_DEFAULT;
    return clampCommandWidth(Number(kept));
  } catch {
    return COMMAND_DEFAULT;
  }
}

/** Remember `width`; a refusing store is no failure of the view. */
export function saveCommandWidth(storage: Pick<Storage, "setItem"> | null, width: number): void {
  try {
    storage?.setItem(KEY, String(clampCommandWidth(width)));
  } catch {
    // The width stays for this view only.
  }
}
