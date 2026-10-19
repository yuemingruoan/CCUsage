// App state plumbing: subscribe to window.ccusage.onState and keep the last AppState.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { AppSettings, AppState, QuotaSnapshot } from "@ccusage/core/pure";
import { quotaSource } from "./data";

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function applyTheme(theme: AppSettings["theme"]): void {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset["theme"] = theme;
  else delete root.dataset["theme"];
}

interface AppStateContextValue {
  state: AppState | null;
  error: string | null;
  refreshState: () => Promise<void>;
}

const AppStateContext = createContext<AppStateContextValue>({
  state: null,
  error: null,
  refreshState: async () => {},
});

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = window.ccusage.onState((next) => {
        if (alive) setState(next);
      });
    } catch (err) {
      setError(errorMessage(err));
    }
    window.ccusage
      .getState()
      .then((next) => {
        if (alive) setState(next);
      })
      .catch((err) => {
        if (alive) setError(errorMessage(err));
      });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const next = await window.ccusage.getState();
      setState(next);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const theme = state?.settings.theme ?? "system";
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const value = useMemo(
    () => ({ state, error, refreshState }),
    [state, error, refreshState],
  );
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateContextValue {
  return useContext(AppStateContext);
}

/** Re-render on a timer so countdowns and relative times stay fresh. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Display quota: the server snapshot (all devices) when available, local otherwise. */
export function useQuota(): { quota: QuotaSnapshot; serverDeviceCount: number | null } {
  const { state } = useAppState();
  return useMemo(() => quotaSource(state), [state]);
}

/** True once a first scan has produced an AppState. */
export function hasLoaded(state: AppState | null): boolean {
  if (!state) return false;
  return state.scan.scannedAt > 0 || state.snapshot.generatedAt > 0;
}
