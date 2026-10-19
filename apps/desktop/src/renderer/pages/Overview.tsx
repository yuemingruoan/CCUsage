// Overview page. Port of OverviewView.swift with the new device table + sync badge.
import { useEffect, useMemo, useState } from "react";
import { buckets as coreBuckets, modelTotals } from "@ccusage/core/pure";
import type { AppState, QuotaKind, TimeGranularity } from "@ccusage/core/pure";
import {
  CHART_METRICS,
  RANGES,
  buildModelOrder,
  deviceTodayStats,
  entriesSince,
  makeModelSeries,
  modelScale,
  quotaSource,
  rangeStart,
  suggestedGranularity,
  sumEntries,
  topSessionRows,
} from "../data";
import type { ChartMetric, RangeKey } from "../data";
import { formatTokens, usd, GRANULARITY_LABELS, GRANULARITY_ORDER, WINDOW_MODE_LABELS } from "../format";
import { ModBanner } from "../components/ModBanner";
import { QuotaCard } from "../components/QuotaCard";
import { UsageChart } from "../components/UsageChart";
import {
  DeviceTable,
  ModelTable,
  QuotaWindowTable,
  SyncBadge,
  TopSessionsTable,
} from "../components/tables";
import { EqualHeightRow, SectionBar, SectionHeader, Segmented, Select, StatTile } from "../components/ui";

export function Overview({
  state,
  range,
  now,
  onSelectSession,
  onRefreshState,
  onSelectDevice,
}: {
  state: AppState;
  range: RangeKey;
  now: number;
  onSelectSession: (id: string) => void;
  onRefreshState: () => Promise<void>;
  onSelectDevice?: ((id: string) => void) | undefined;
}) {
  const quota = quotaSource(state).quota;
  const serverDeviceCount = quotaSource(state).serverDeviceCount;
  const [granularity, setGranularity] = useState<TimeGranularity>("hour");
  const [metric, setMetric] = useState<ChartMetric>("cost");
  const [windowKind, setWindowKind] = useState<QuotaKind>("fiveHour");

  const rangeStartMs = rangeStart(range, now);
  const rangeLabel = RANGES.find((option) => option.key === range)?.label ?? "";
  const entries = useMemo(
    () => entriesSince(state.snapshot.entries, rangeStartMs),
    [state.snapshot.entries, rangeStartMs],
  );
  const modelOrder = useMemo(() => buildModelOrder(state.snapshot.entries), [state.snapshot.entries]);
  const modelSeries = useMemo(() => makeModelSeries(modelOrder), [modelOrder]);
  const chartBuckets = useMemo(
    () => coreBuckets(entries, granularity, modelSeries),
    [entries, granularity, modelSeries],
  );
  const presentModels = useMemo(() => new Set(chartBuckets.map((bucket) => bucket.series)), [chartBuckets]);
  const chartScale = useMemo(() => modelScale(modelOrder, presentModels), [modelOrder, presentModels]);
  const totals = useMemo(() => sumEntries(entries), [entries]);
  const models = useMemo(() => modelTotals(entries), [entries]);
  const topSessions = useMemo(
    () => topSessionRows(entries, state.snapshot.sessions, 10),
    [entries, state.snapshot.sessions],
  );
  const deviceStats = useMemo(() => deviceTodayStats(state.snapshot.entries, now), [state.snapshot.entries, now]);

  // Suggested granularity follows the range like the Swift .task(id:) (loaded once).
  const entryCount = state.snapshot.entries.length;
  useEffect(() => {
    const firstEntry = state.snapshot.entries[0];
    const start = rangeStartMs ?? firstEntry?.timestamp ?? Date.now();
    setGranularity(suggestedGranularity(Math.max(Date.now() - start, 0)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, entryCount]);

  const windows = quota.windows[windowKind] ?? [];
  const visibleWindows = rangeStartMs == null ? windows : windows.filter((window) => window.end >= rangeStartMs);
  const estimate = quota.status[windowKind]?.estimate;
  const quotaSubtitle =
    "百分比与重置时间来自 Claude Code；预估额度 = 已用折算金额 ÷ CC 上报的已用百分比，只取当前套餐的最新数据，CC 上报的百分比也包含 claude.ai 等其他端的用量";

  return (
    <div className="page overview">
      <section className="overview-section">
        <SectionHeader title="订阅额度" subtitle={quotaSubtitle} />
        <EqualHeightRow>
          <QuotaCard
            status={quota.status.fiveHour}
            kind="fiveHour"
            now={now}
            serverDeviceCount={serverDeviceCount}
          />
          <QuotaCard
            status={quota.status.sevenDay}
            kind="sevenDay"
            now={now}
            serverDeviceCount={serverDeviceCount}
          />
        </EqualHeightRow>
        {state.modState !== "installed" ? (
          <ModBanner modState={state.modState} onChanged={onRefreshState} />
        ) : quota.statusLineObservationCount === 0 ? (
          <div className="mod-hint">CC mod 已安装，新开的 Claude Code 会话在下一次响应后开始上报</div>
        ) : null}
      </section>

      <section className="overview-section">
        <EqualHeightRow>
          <StatTile title="折算金额（API 价）" value={usd(totals.cost)} caption={rangeLabel} />
          <StatTile
            title="请求"
            value={String(entries.length)}
            caption={totals.sessions + " 个会话"}
          />
          <StatTile
            title="Tokens"
            value={formatTokens(tokensOf(totals))}
            caption={"输入 " + formatTokens(totals.tokens.input) + " · 输出 " + formatTokens(totals.tokens.output)}
          />
          <StatTile
            title="缓存"
            value={formatTokens(totals.tokens.cacheRead + totals.tokens.cacheWrite5m + totals.tokens.cacheWrite1h)}
            caption={
              "读 " +
              formatTokens(totals.tokens.cacheRead) +
              " · 写 " +
              formatTokens(totals.tokens.cacheWrite5m + totals.tokens.cacheWrite1h)
            }
          />
        </EqualHeightRow>
      </section>

      <section className="overview-section">
        <SectionBar title="按时间段" subtitle="悬停查看每个时间段的明细">
          <Segmented
            size="small"
            ariaLabel="指标"
            value={metric}
            onChange={setMetric}
            options={CHART_METRICS.map((option) => ({ value: option.key, label: option.label }))}
          />
          <Select
            value={granularity}
            onChange={setGranularity}
            options={GRANULARITY_ORDER.map((value) => ({ value, label: "按" + GRANULARITY_LABELS[value] }))}
            title="粒度"
          />
        </SectionBar>
        <UsageChart buckets={chartBuckets} scale={chartScale} metric={metric} granularity={granularity} height={260} />
      </section>

      <section className="overview-section">
        <SectionBar
          title="额度窗口"
          subtitle={
            windowKind === "fiveHour"
              ? "5 小时窗口 · " +
                WINDOW_MODE_LABELS[state.settings.windowMode] +
                "（可在设置中切换）；“CC 确认”表示重置时间来自 Claude Code；第三方 API 会话不计入"
              : "每周窗口 · 有 CC 上报时按其重置时间对齐"
          }
        >
          <Segmented
            size="small"
            ariaLabel="窗口种类"
            value={windowKind}
            onChange={setWindowKind}
            options={[
              { value: "fiveHour", label: "5 小时" },
              { value: "sevenDay", label: "每周" },
            ]}
          />
        </SectionBar>
        <QuotaWindowTable windows={visibleWindows} kind={windowKind} estimate={estimate} now={now} height={240} />
      </section>

      <section className="overview-section">
        <SectionHeader title="按模型" />
        <ModelTable totals={models} scale={modelScale(modelOrder, new Set(modelOrder))} height={150} />
      </section>

      <section className="overview-section">
        <SectionHeader title="花费最多的会话" subtitle="金额为所选时间范围内的部分，点击查看详情" />
        <TopSessionsTable rows={topSessions} height={300} onSelect={onSelectSession} />
      </section>

      <section className="overview-section">
        <SectionBar title="设备" subtitle="多设备同步后的本机与远端设备">
          <SyncBadge sync={state.sync} />
        </SectionBar>
        <DeviceTable
          devices={state.sync.devices}
          selfDeviceId={state.settings.server.deviceId}
          todayStats={deviceStats}
          now={now}
          height={168}
        />
      </section>
    </div>
  );
}

function tokensOf(totals: { tokens: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number } }): number {
  return totals.tokens.input + totals.tokens.output + totals.tokens.cacheRead + totals.tokens.cacheWrite5m + totals.tokens.cacheWrite1h;
}