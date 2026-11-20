import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import styles from "./Menu.module.css";

/** Closes the open menu: what choosing an item does first. */
const MenuClose = createContext<() => void>(() => undefined);

const EDGE = 6;
const GAP = 4;

/** A popover menu under `anchor` (above it when there is no room below), the prototype's `openMenu`:
 *  a click outside, Esc or choosing an item closes it; ↑ ↓ Home End move between items; focus
 *  starts on the first item and goes back to the anchor. Render it while open. */
export function Menu({ anchor, onClose, label, children, testId }: { anchor: HTMLElement; onClose: () => void; label: string; children: ReactNode; testId?: string | undefined }): React.JSX.Element {
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = menu.current;
    if (el === null) return;
    const r = anchor.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = el;
    el.style.left = `${Math.max(EDGE, Math.min(window.innerWidth - w - EDGE, r.left))}px`;
    el.style.top = `${r.bottom + GAP + h > window.innerHeight ? Math.max(EDGE, r.top - h - GAP) : r.bottom + GAP}px`;
    el.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    return () => {
      if (anchor.isConnected) anchor.focus();
    };
  }, [anchor]);

  const move = (event: React.KeyboardEvent): void => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (index: number): void => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(items.length - 1);
    else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return createPortal(
    <>
      <div
        className={styles.scrim}
        onMouseDown={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div ref={menu} className={styles.menu} role="menu" aria-label={label} onKeyDown={move} data-testid={testId}>
        <MenuClose.Provider value={onClose}>{children}</MenuClose.Provider>
      </div>
    </>,
    document.body,
  );
}

/** A menu item: its words, a faint `sub` at its end (a path, a hint); `checked` marks the current
 *  choice. Choosing it closes the menu, then calls `onSelect`. */
export function MenuItem({ onSelect, sub, checked, children, testId }: { onSelect: () => void; sub?: ReactNode | undefined; checked?: boolean | undefined; children: ReactNode; testId?: string | undefined }): React.JSX.Element {
  const close = useContext(MenuClose);
  return (
    <button
      type="button"
      className={styles.item}
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      tabIndex={-1}
      data-testid={testId}
      onClick={() => {
        close();
        onSelect();
      }}
    >
      {children}
      {sub !== undefined && <span className={styles.sub}>{sub}</span>}
    </button>
  );
}

/** A group's heading inside a menu ("Workspace", "Projects"). */
export function MenuHeader({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className={styles.header} role="presentation">
      {children}
    </div>
  );
}

export function MenuSeparator(): React.JSX.Element {
  return <div className={styles.separator} role="separator" />;
}
