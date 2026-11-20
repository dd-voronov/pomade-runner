import type { ReactNode } from "react";

import styles from "./TabShell.module.css";

/** The Runner tab's four views, in the header's order, and the route each one opens. */
export const TAB_VIEWS = [
  { view: "jobs", label: "Jobs", route: "" },
  { view: "history", label: "History", route: "history" },
  { view: "services", label: "Services", route: "services" },
  { view: "settings", label: "Settings", route: "settings" },
] as const;

export type TabView = (typeof TAB_VIEWS)[number]["view"];

/** The Runner tab's frame: the header — the views (Jobs · History · Services · Settings, a count
 *  beside Jobs and Services, the current one underlined) and, at its right end, `actions` (where
 *  "New job" goes) — then the page in its scroll region, 1040 px at most. */
export function TabShell({
  current,
  counts,
  open,
  actions,
  children,
  testId,
}: {
  current: TabView;
  /** Jobs' and Services' counts; a view without one shows none. */
  counts: Partial<Record<TabView, number>>;
  /** Navigates the tab to a route. */
  open: (route: string) => void;
  actions?: ReactNode | undefined;
  children?: ReactNode | undefined;
  testId: string;
}): React.JSX.Element {
  return (
    <main className={styles.root} data-testid={testId}>
      <header className={styles.head}>
        <nav className={styles.views} aria-label="Runner views">
          {TAB_VIEWS.map(({ view, label, route }) => (
            <button key={view} type="button" className={styles.view} aria-current={view === current ? "page" : undefined} data-testid={`nav-${view}`} onClick={() => open(route)}>
              {label}
              {counts[view] !== undefined && <span className={styles.count}>{counts[view]}</span>}
            </button>
          ))}
        </nav>
        {actions !== undefined && <div className={styles.actions}>{actions}</div>}
      </header>
      <div className={styles.scroll}>
        <div className={styles.page}>{children}</div>
      </div>
    </main>
  );
}

/** A view's filter row: its chips, then `summary` faint at the right end ("12 jobs"). */
export function ViewFilters({ children, summary }: { children?: ReactNode | undefined; summary?: ReactNode | undefined }): React.JSX.Element {
  return (
    <div className={styles.filters}>
      {children}
      {summary !== undefined && <span className={styles.summary}>{summary}</span>}
    </div>
  );
}
