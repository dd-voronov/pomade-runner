import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import styles from "./Toast.module.css";

/** How long a toast stays, and how many show at once. */
const TOAST_MS = 3200;
const MAX_TOASTS = 3;

type ShowToast = (message: ReactNode, source?: string) => void;

const ToastContext = createContext<ShowToast | null>(null);

interface Shown {
  id: number;
  message: ReactNode;
  source: string;
}

/** Hosts the surface's toasts: bottom right, newest last, at most three, each gone after 3.2 s.
 *  Mounted once per surface; `useToast` shows one. */
export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<readonly Shown[]>([]);
  const next = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);

  const show = useCallback<ShowToast>((message, source = "Runner") => {
    const id = next.current++;
    setToasts((shown) => [...shown, { id, message, source }].slice(-MAX_TOASTS));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setToasts((shown) => shown.filter((toast) => toast.id !== id));
    }, TOAST_MS);
    timers.current.add(timer);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className={styles.host} role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={styles.toast} data-testid="toast">
            <span className={styles.source}>{toast.source}</span>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Shows a toast: `toast("Created …")`, with `source` above it ("Runner" by default). */
export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (show === null) throw new Error("useToast outside a ToastProvider");
  return show;
}
