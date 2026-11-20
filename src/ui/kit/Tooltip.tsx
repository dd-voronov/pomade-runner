// The one tooltip of a Runner surface, as the prototype's: any element with `data-tip` (a plain
// line) or `data-help` (a key of `help.ts`: the text and its example) shows it on hover, and on
// keyboard focus. It sits above the element, centred, kept inside the frame, below when there is no
// room above; scrolling, Esc, leaving or blurring hides it. `TooltipLayer` is mounted once per surface.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { HELP, isHelpKey } from "../help";
import styles from "./Tooltip.module.css";

const TIP_ID = "runner-tip";
const GAP = 6;
const EDGE = 6;

interface Shown {
  target: HTMLElement;
  lines: readonly [string] | readonly [string, string];
}

/** What `el`'s tooltip says; `null` when nothing (an unknown help key says nothing). */
function linesOf(el: HTMLElement): Shown["lines"] | null {
  const key = el.dataset.help;
  if (key !== undefined) return isHelpKey(key) ? HELP[key] : null;
  const tip = el.dataset.tip;
  return tip === undefined || tip === "" ? null : [tip];
}

function targetOf(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element ? node.closest<HTMLElement>("[data-help],[data-tip]") : null;
}

export function TooltipLayer(): React.JSX.Element | null {
  const [shown, setShown] = useState<Shown | null>(null);
  const tip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const show = (target: HTMLElement | null): void => {
      const lines = target === null ? null : linesOf(target);
      setShown(target === null || lines === null ? null : { target, lines });
    };
    const hide = (): void => setShown(null);
    const over = (event: MouseEvent): void => show(targetOf(event.target));
    const focus = (event: FocusEvent): void => {
      const target = targetOf(event.target);
      if (target !== null && target.matches(":focus-visible")) show(target);
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("mouseover", over);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", hide);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("keydown", key);
    document.documentElement.addEventListener("mouseleave", hide);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("keydown", key);
      document.documentElement.removeEventListener("mouseleave", hide);
    };
  }, []);

  // A shown tip describes its element for assistive technology, and goes when the element does.
  useEffect(() => {
    if (shown === null) return;
    const { target } = shown;
    const before = target.getAttribute("aria-describedby");
    target.setAttribute("aria-describedby", TIP_ID);
    const gone = new MutationObserver(() => {
      if (!target.isConnected) setShown(null);
    });
    gone.observe(document.body, { childList: true, subtree: true });
    return () => {
      gone.disconnect();
      if (before === null) target.removeAttribute("aria-describedby");
      else target.setAttribute("aria-describedby", before);
    };
  }, [shown]);

  useLayoutEffect(() => {
    const el = tip.current;
    if (shown === null || el === null) return;
    const r = shown.target.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = el;
    let top = r.top - h - GAP;
    if (top < 4) top = r.bottom + GAP;
    el.style.left = `${Math.max(EDGE, Math.min(window.innerWidth - w - EDGE, r.left + r.width / 2 - w / 2))}px`;
    el.style.top = `${top}px`;
  }, [shown]);

  if (shown === null) return null;
  const [text, example] = shown.lines;
  return (
    <div ref={tip} id={TIP_ID} role="tooltip" className={example === undefined ? `${styles.tip} ${styles.plain}` : styles.tip} data-testid="tooltip">
      <span>{text}</span>
      {example !== undefined && <span className={styles.example}>{example}</span>}
    </div>
  );
}
