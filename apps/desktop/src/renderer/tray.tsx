// Tray popover (400px): compact quota cards, today's cost, top 5 sessions, actions.
// Port of MenuBarView.swift.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppStateProvider, useAppState, useNow, useQuota } from "./state";
import { entriesSince, startOfDay, sumEntries, topSessionRows } from "./data";
import { usd } from "./format";
import { QuotaCard } from "./components/QuotaCard";
import { Button, EqualHeightRow, Separator, Spinner } from "./components/ui";

function TrayApp() {
  const { state } = useAppState();
  const now = useNow(30_000);
  const quotaInfo = useQuota();
  const [refreshing, setRefreshing] = useState(false);

  if (state == null) {
    return (
      <div className="tray">
        <div className="tray-loading">
          <Spinner small />
          <span>正在读取…</span>
        </div>
      </div>
    );
  }

  const quota = quotaInfo.quota;
  const todayEntries = entriesSince(state.snapshot.entries, startOfDay(now));
  const todayCost = sumEntries(todayEntries).cost;
  const topSessions = topSessionRows(todayEntries, state.snapshot.sessions, 5);

  async function refresh() {
    setRefreshing(true);
    try {
      await window.ccusage.refresh();
      try {
        await window.ccusage.bridgeRefresh();
      } catch {
        // optional bridge
      }
    } catch {
      // errors arrive through app:state:updated
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="tray">
      <EqualHeightRow>
        <QuotaCard
          compact
          status={quota.status.fiveHour}
          kind="fiveHour"
          now={now}
          serverDeviceCount={quotaInfo.serverDeviceCount}
        />
        <QuotaCard
          compact
          status={quota.status.sevenDay}
          kind="sevenDay"
          now={now}
          serverDeviceCount={quotaInfo.serverDeviceCount}
        />
      </EqualHeightRow>

      <div className="tray-today">
        <span className="tray-today-label">今天折算</span>
        <span className="tray-today-value">{usd(todayCost)}</span>
      </div>

      {topSessions.length > 0 && (
        <>
          <Separator />
          <div className="tray-sessions">
            {topSessions.map((row) => (
              <div className="tray-session-row" key={row.id}>
                <span className="tray-session-title ellipsis" title={row.session?.title ?? row.id}>
                  {row.session?.title ?? row.id}
                </span>
                <span className="tray-session-cost">{usd(row.cost)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <Separator />
      <div className="tray-actions">
        <Button onClick={() => void window.ccusage.openMainWindow()}>打开主窗口</Button>
        <Button disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? "刷新中…" : "刷新"}
        </Button>
        <span className="tray-spacer" />
        <Button onClick={() => void window.ccusage.quit()}>退出</Button>
      </div>
    </div>
  );
}

const container = document.getElementById("root");
if (container == null) throw new Error("missing #root");
createRoot(container).render(
  <StrictMode>
    <AppStateProvider>
      <TrayApp />
    </AppStateProvider>
  </StrictMode>,
);
