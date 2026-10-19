// Main window entry: sidebar + toolbar + overview/session detail routing.
// Port of ContentView.swift with the toolbar range picker and refresh button.
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionSummary } from "@ccusage/core/pure";
import { AppStateProvider, hasLoaded, useAppState, useNow } from "./state";
import {
  RANGES,
  SESSION_SORTS,
  costTotal,
  filterSessions,
  rangeStart,
} from "./data";
import type { RangeKey, SessionSort } from "./data";
import { dateRange, relativeTime, scanDuration, timeHMS, usd } from "./format";
import { DeviceDetail } from "./pages/DeviceDetail";
import { Overview } from "./pages/Overview";
import { SessionDetail } from "./pages/SessionDetail";
import { SettingsWindow } from "./pages/Settings";
import {
  AuthBadge,
  Button,
  IconChart,
  IconCheck,
  IconChevronDown,
  IconRefresh,
  IconSearch,
  IconSort,
  Segmented,
  Spinner,
} from "./components/ui";

type Selection = { kind: "overview" } | { kind: "session"; id: string } | { kind: "device"; id: string };

/** Initial selection from the URL (?view=device&device=<id>), used by the screenshot harness. */
function initialSelection(): Selection {
  const params = new URLSearchParams(window.location.search);
  const device = params.get("device");
  if (params.get("view") === "device" && device != null && device.length > 0) return { kind: "device", id: device };
  return { kind: "overview" };
}

function SortMenu({ sort, onChange }: { sort: SessionSort; onChange: (sort: SessionSort) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const activeLabel = SESSION_SORTS.find((option) => option.key === sort)?.label ?? "";

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current != null && event.target instanceof Node && !ref.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  return (
    <div className="sort-menu" ref={ref}>
      <Button variant="borderless" onClick={() => setOpen((value) => !value)} title={"按" + activeLabel + "排序"}>
        <IconSort />
        <span className="sort-menu-label">{activeLabel}</span>
        <IconChevronDown />
      </Button>
      {open && (
        <div className="menu-popover" role="menu">
          {SESSION_SORTS.map((option) => (
            <button
              key={option.key}
              type="button"
              role="menuitemradio"
              aria-checked={option.key === sort}
              className={option.key === sort ? "menu-item menu-item-active" : "menu-item"}
              onClick={() => {
                onChange(option.key);
                setOpen(false);
              }}
            >
              <span>{option.label}</span>
              {option.key === sort && <IconCheck />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SessionRow({
  session,
  active,
  now,
  deviceName,
  onClick,
}: {
  session: SessionSummary;
  active: boolean;
  now: number;
  deviceName?: string | undefined;
  onClick: () => void;
}) {
  const remote = session.deviceIds != null && session.deviceIds.length > 0;
  const meta = remote
    ? (deviceName ?? "其他设备") + " · " + dateRange(session.start, session.end) +
      (session.subagentCount > 0 ? " · " + session.subagentCount + " 子代理" : "")
    : session.projectName +
      " · " +
      relativeTime(session.end, now) +
      (session.subagentCount > 0 ? " · " + session.subagentCount + " 子代理" : "");
  const cost = costTotal(session.cost);
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={active ? "session-row session-row-active" : "session-row"}
      onClick={onClick}
      title={session.title}
    >
      <span className="session-row-main">
        <span className="session-row-title">
            {session.title}
            <AuthBadge mode={session.authMode} />
          </span>
        <span className="session-row-meta">{meta}</span>
      </span>
      <span className="session-row-cost">
        {session.hasUnpricedRequests && cost === 0 ? "未定价" : usd(cost)}
      </span>
    </button>
  );
}

function MainWindow() {
  const { state, error: loadError, refreshState } = useAppState();
  const now = useNow(30_000);
  const [range, setRange] = useState<RangeKey>("week");
  const [sort, setSort] = useState<SessionSort>("recent");
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<Selection>(initialSelection);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);

  const doRefresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await window.ccusage.refresh();
      try {
        await window.ccusage.bridgeRefresh();
      } catch {
        // The mod bridge is optional; a failure here does not affect the transcript scan.
      }
    } catch {
      // The error is pushed through app:state:updated (lastError) by the main process.
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r") {
        event.preventDefault();
        void doRefresh();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [doRefresh]);

  const start = rangeStart(range, now);
  const sessions = useMemo(
    () => (state == null ? [] : filterSessions(state.snapshot.sessions, start, search, sort)),
    [state, start, search, sort],
  );
  const deviceNameById = useMemo(() => {
    const names = new Map<string, string>();
    for (const device of state?.sync.devices ?? []) names.set(device.id, device.name);
    return names;
  }, [state?.sync.devices]);

  if (state == null) {
    return (
      <div className="app-loading">
        <Spinner />
        <span>正在扫描…</span>
        {loadError != null && <div className="inline-error">{loadError}</div>}
      </div>
    );
  }

  const loaded = hasLoaded(state);
  const selectedSession =
    selection.kind === "session" ? state.snapshot.sessions.find((session) => session.id === selection.id) : undefined;

  let detail;
  if (selection.kind === "session" && selectedSession == null) {
    detail = <div className="page empty-page">会话不存在</div>;
  } else if (selectedSession != null) {
    detail = <SessionDetail state={state} session={selectedSession} />;
  } else if (selection.kind === "device") {
    detail = (
      <DeviceDetail
        state={state}
        deviceId={selection.id}
        now={now}
        onSelectSession={(id) => setSelection({ kind: "session", id })}
        onBack={() => setSelection({ kind: "overview" })}
      />
    );
  } else if (loaded) {
    detail = (
      <Overview
        state={state}
        range={range}
        now={now}
        onSelectSession={(id) => setSelection({ kind: "session", id })}
        onRefreshState={refreshState}
        onSelectDevice={(id) => setSelection({ kind: "device", id })}
      />
    );
  } else {
    detail = (
      <div className="page loading-page">
        <Spinner />
        <span>正在读取 {state.settings.projectsPath}…</span>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-top">
          <button
            type="button"
            className={selection.kind === "overview" ? "sidebar-overview sidebar-overview-active" : "sidebar-overview"}
            onClick={() => setSelection({ kind: "overview" })}
          >
            <IconChart size={15} />
            <span>概览</span>
          </button>
        </div>
        <div className="sidebar-section-header">
          <span className="sidebar-section-title">会话 ({sessions.length})</span>
          <SortMenu sort={sort} onChange={setSort} />
        </div>
        <div className="sidebar-search">
          <IconSearch />
          <input
            className="search-input"
            value={search}
            placeholder="搜索标题 / 项目 / ID"
            aria-label="搜索标题 / 项目 / ID"
            spellCheck={false}
            onChange={(event) => setSearch(event.target.value)}
          />
          {search.length > 0 && (
            <button type="button" className="search-clear" aria-label="清除搜索" onClick={() => setSearch("")}>
              ×
            </button>
          )}
        </div>
        <div className="session-list" role="listbox" aria-label="会话列表">
          {sessions.length === 0 ? (
            <div className="session-empty">{search.trim().length > 0 ? "没有匹配的会话" : "该时间范围内没有会话"}</div>
          ) : (
            sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                now={now}
                deviceName={
                  session.deviceIds != null && session.deviceIds.length > 0
                    ? deviceNameById.get(session.deviceIds[0]!)
                    : undefined
                }
                active={selection.kind === "session" && selection.id === session.id}
                onClick={() => setSelection({ kind: "session", id: session.id })}
              />
            ))
          )}
        </div>
        <div className="status-bar">
          {state.lastError != null ? (
            <div className="status-error" title={state.lastError}>
              {state.lastError}
            </div>
          ) : loaded ? (
            <>
              <div>
                {state.scan.fileCount} 个记录文件 · 扫描 {scanDuration(state.scan.scanDurationMs)}
              </div>
              <div>更新于 {timeHMS(state.snapshot.generatedAt)}</div>
            </>
          ) : (
            <div>正在扫描…</div>
          )}
        </div>
      </aside>

      <main className="main">
        <div className="toolbar">
          <div className="toolbar-center">
            <Segmented
              ariaLabel="时间范围"
              value={range}
              onChange={setRange}
              options={RANGES.map((option) => ({ value: option.key, label: option.label }))}
            />
          </div>
          <button
            type="button"
            className="icon-button"
            title="重新扫描会话记录（⌘R）"
            aria-label="刷新"
            disabled={refreshing}
            onClick={() => void doRefresh()}
          >
            {refreshing ? <Spinner small /> : <IconRefresh size={16} />}
          </button>
        </div>
        <div className="content">{detail}</div>
      </main>
    </div>
  );
}

function Root() {
  const params = new URLSearchParams(window.location.search);
  const isSettings = params.get("view") === "settings";
  if (isSettings) {
    document.title = "CC 用量设置";
    return (
      <AppStateProvider>
        <SettingsWindow initialTab={params.get("tab")} />
      </AppStateProvider>
    );
  }
  return (
    <AppStateProvider>
      <MainWindow />
    </AppStateProvider>
  );
}

const container = document.getElementById("root");
if (container == null) throw new Error("missing #root");
createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);