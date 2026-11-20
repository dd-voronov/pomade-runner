import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden]"));
}

/** While mounted, keeps keyboard focus inside `root`: focuses `initial` (the root itself when none)
 *  on mount, wraps Tab and Shift+Tab, calls `onEscape` on Esc, and gives focus back
 *  to what had it on unmount. */
export function useFocusTrap(root: RefObject<HTMLElement | null>, onEscape: () => void, initial?: RefObject<HTMLElement | null>): void {
  const escape = useRef(onEscape);
  useEffect(() => {
    escape.current = onEscape;
  });
  useEffect(() => {
    const el = root.current;
    if (el === null) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initial?.current ?? el).focus();
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        escape.current();
        return;
      }
      if (event.key !== "Tab") return;
      const all = focusables(el);
      const first = all[0];
      const last = all[all.length - 1];
      if (first === undefined || last === undefined) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === el || !el.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !el.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      if (before?.isConnected === true) before.focus();
    };
  }, [root, initial]);
}
