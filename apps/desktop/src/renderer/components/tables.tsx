// Sticky-header tables ported from the Swift Table views, plus the new devices table.
import type { ReactNode } from "react";
import type {
  CostBreakdown,
  DeviceInfo,
  LimitEstimate,
  ModelTotal,
  QuotaKind,
  QuotaWindow,
  SyncState,
  TimeGranularity,
  TokenCounts,
  UsageBucket,
} from "@ccusage/core/pure";
import { Pricing } from "@ccusage/core/pure";
import type { DeviceUsage, SeriesScale, TopSessionRow } from "../data";
import {
  cacheWriteTotal,
  costTotal,
  deviceStatKey,
  platformLabel,
  tokenTotal,
  windowContains,
  windowCostSinceReset,
  windowMaxObserved,
} from "../data";
import {
  bucketLabel,
  dateTime,
  formatTokens,
  price,
  relativeTime,
  usd,
  windowEndLabel,
  windowStartLabel,
} from "../format";
import { Badge, SectionHeader, StatusDot } from "./ui";

// MARK: - Generic table

export interface TableColumn<T> {
  key: string;
  title: string;
  width?: string;
  align?: "left" | "right";
  render(row: T): ReactNode;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  height,
  emptyText,
  onRowClick,
  rowClassName,
  ariaLabel,
}: {
  rows: readonly T[];
  columns: readonly TableColumn<T>[];
  rowKey: (row: T) => string;
  height?: number | undefined;
  emptyText?: string | undefined;
  onRowClick?: ((row: T) => void) | undefined;
  rowClassName?: ((row: T) => string | undefined) | undefined;
  ariaLabel?: string | undefined;
}) {
  const template = columns.map((column) => column.width ?? "minmax(72px, 1fr)").join(" ");
  const head = (
    <div className="table-head" style={{ gridTemplateColumns: template }} role="row">
      {columns.map((column) => (
        <div
          key={column.key}
          className={column.align === "right" ? "table-th table-th-right" : "table-th"}
          role="columnheader"
        >
          {column.title}
        </div>
      ))}
    </div>
  );
  return (
    <div className="table" style={height != null ? { height } : undefined} aria-label={ariaLabel} role="table">
      {head}
      <div className="table-body" role="rowgroup">
        {rows.length === 0 ? (
          <div className="table-empty">{emptyText ?? "暂无数据"}</div>
        ) : (
          rows.map((row) => {
            const extra = rowClassName?.(row);
            const className = "table-row" + (onRowClick != null ? " table-row-clickable" : "") + (extra != null ? " " + extra : "");
            return (
              <div
                key={rowKey(row)}
                className={className}
                style={{ gridTemplateColumns: template }}
                role="row"
                tabIndex={onRowClick != null ? 0 : undefined}
                onClick={onRowClick != null ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick != null
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
              >
                {columns.map((column) => (
                  <div
                    key={column.key}
                    className={column.align === "right" ? "table-td table-td-right" : "table-td"}
                    role="cell"
                  >
                    {column.render(row)}
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// MARK: - 按模型

export function ModelTable({
  totals,
  scale,
  height,
}: {
  totals: readonly ModelTotal[];
  scale: SeriesScale;
  height?: number | undefined;
}) {
  let sum = 0;
  for (const total of totals) sum += total.cost;
  const denominator = sum > 0 ? sum : 1;
  const columns: TableColumn<ModelTotal>[] = [
    {
      key: "model",
      title: "模型",
      width: "minmax(140px, 1.8fr)",
      render: (total) => (
        <span className="model-cell">
          <span className="legend-swatch" style={{ background: scale.color(total.name) }} />
          <span className="ellipsis" title={total.name}>{total.name}</span>
          {total.hasUnpricedRequests && <span className="caption-secondary">无定价</span>}
        </span>
      ),
    },
    { key: "requests", title: "请求", width: "60px", align: "right", render: (total) => total.requestCount },
    { key: "input", title: "输入", width: "74px", align: "right", render: (total) => formatTokens(total.tokens.input) },
    { key: "output", title: "输出", width: "74px", align: "right", render: (total) => formatTokens(total.tokens.output) },
    { key: "cacheRead", title: "缓存读", width: "82px", align: "right", render: (total) => formatTokens(total.tokens.cacheRead) },
    {
      key: "cacheWrite",
      title: "缓存写",
      width: "82px",
      align: "right",
      render: (total) => formatTokens(cacheWriteTotal(total.tokens)),
    },
    { key: "cost", title: "折算金额", width: "92px", align: "right", render: (total) => usd(total.cost) },
    {
      key: "share",
      title: "占比",
      width: "minmax(64px, 0.6fr)",
      align: "right",
      render: (total) => ((total.cost / denominator) * 100).toFixed(1) + "%",
    },
  ];
  return (
    <DataTable
      rows={totals}
      columns={columns}
      rowKey={(total) => total.name}
      height={height}
      ariaLabel="按模型"
      emptyText="该时间范围内没有用量"
    />
  );
}

// MARK: - 额度窗口

export function QuotaWindowTable({
  windows,
  kind,
  estimate,
  now,
  height,
}: {
  windows: readonly QuotaWindow[];
  kind: QuotaKind;
  estimate: LimitEstimate | undefined;
  now: number;
  height?: number | undefined;
}) {
  const rows = [...windows].reverse();
  const estimatedLimit = estimate?.cost;
  const columns: TableColumn<QuotaWindow>[] = [
    {
      key: "window",
      title: "窗口",
      width: "minmax(210px, 1.6fr)",
      render: (window) => (
        <span className="window-cell">
          <span className="mono">
            {windowStartLabel(window.start, kind)} – {windowEndLabel(window.end, window.start, kind)}
          </span>
          {windowContains(window, now) && <span className="chip">进行中</span>}
        </span>
      ),
    },
    {
      key: "source",
      title: "来源",
      width: "68px",
      render: (window) =>
        window.isConfirmed ? <span>CC 确认</span> : <span className="caption-secondary">推断</span>,
    },
    { key: "requests", title: "请求", width: "56px", align: "right", render: (window) => window.requestCount },
    { key: "sessions", title: "会话", width: "48px", align: "right", render: (window) => window.sessionIds.length },
    { key: "tokens", title: "Tokens", width: "76px", align: "right", render: (window) => formatTokens(tokenTotal(window.tokens)) },
    { key: "cost", title: "折算金额", width: "86px", align: "right", render: (window) => usd(window.cost) },
    {
      key: "ccMax",
      title: "CC 最高",
      width: "66px",
      align: "right",
      render: (window) => {
        const max = windowMaxObserved(window);
        return max != null ? Math.round(max) + "%" : "—";
      },
    },
    {
      key: "estimate",
      title: "预估占比",
      width: "minmax(66px, 0.6fr)",
      align: "right",
      render: (window) =>
        estimatedLimit != null && estimatedLimit > 0 ? (
          <span className="caption-secondary">≈ {Math.round((windowCostSinceReset(window) / estimatedLimit) * 100)}%</span>
        ) : (
          <span className="caption-secondary">—</span>
        ),
    },
  ];
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(window) => String(window.start)}
      height={height}
      ariaLabel="额度窗口"
      emptyText="暂无额度窗口"
    />
  );
}

// MARK: - 花费最多的会话

export function TopSessionsTable({
  rows,
  height,
  onSelect,
}: {
  rows: readonly TopSessionRow[];
  height?: number | undefined;
  onSelect?: ((id: string) => void) | undefined;
}) {
  const columns: TableColumn<TopSessionRow>[] = [
    {
      key: "session",
      title: "会话",
      width: "minmax(200px, 2fr)",
      render: (row) => (
        <span className="ellipsis" title={row.session?.title ?? row.id}>
          {row.session?.title ?? row.id}
        </span>
      ),
    },
    {
      key: "project",
      title: "项目",
      width: "minmax(80px, 1fr)",
      render: (row) => <span className="caption-secondary ellipsis">{row.session?.projectName ?? ""}</span>,
    },
    {
      key: "share",
      title: "占比",
      width: "minmax(100px, 1.4fr)",
      render: (row) => (
        <span className="share-bar">
          <span className="share-bar-fill" style={{ width: Math.max(row.share * 100, 2) + "%" }} />
        </span>
      ),
    },
    { key: "cost", title: "折算金额", width: "88px", align: "right", render: (row) => usd(row.cost) },
  ];
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(row) => row.id}
      height={height}
      ariaLabel="花费最多的会话"
      emptyText="该时间范围内没有会话"
      onRowClick={onSelect != null ? (row: TopSessionRow) => onSelect(row.id) : undefined}
    />
  );
}

// MARK: - 费用构成 (SessionDetail costComposition)

const COMPOSITION_ROWS = ["输入", "输出", "缓存读取", "缓存写入", "网页搜索"] as const;

export function CostComposition({ cost, tokens }: { cost: CostBreakdown; tokens: TokenCounts }) {
  const total = Math.max(costTotal(cost), 1e-9);
  const rows: { name: string; amount: string; value: number }[] = [
    { name: COMPOSITION_ROWS[0], amount: formatTokens(tokens.input), value: cost.input },
    { name: COMPOSITION_ROWS[1], amount: formatTokens(tokens.output), value: cost.output },
    { name: COMPOSITION_ROWS[2], amount: formatTokens(tokens.cacheRead), value: cost.cacheRead },
    { name: COMPOSITION_ROWS[3], amount: formatTokens(tokens.cacheWrite5m) + " 5m · " + formatTokens(tokens.cacheWrite1h) + " 1h", value: cost.cacheWrite },
    { name: COMPOSITION_ROWS[4], amount: tokens.webSearches + " 次", value: cost.webSearch },
  ];
  return (
    <div className="composition">
      <SectionHeader title="费用构成" />
      <div className="composition-grid">
        {rows.map((row) => (
          <div className="composition-row" key={row.name}>
            <span className="composition-name">{row.name}</span>
            <span className="composition-amount">{row.amount}</span>
            <span className="composition-usd">{usd(row.value)}</span>
            <span className="composition-bar">
              <span
                className="composition-bar-fill"
                style={{ width: (row.value > 0 ? Math.max((row.value / total) * 100, 1) : 0) + "%" }}
              />
            </span>
            <span className="composition-share">{((row.value / total) * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// MARK: - 按时间段 bucket table (UsageChart.swift BucketTable)

interface BucketRow {
  start: number;
  tokens: TokenCounts;
  cost: number;
  requestCount: number;
}

function bucketRows(buckets: readonly UsageBucket[]): BucketRow[] {
  const grouped = new Map<number, BucketRow>();
  for (const bucket of buckets) {
    const current = grouped.get(bucket.start);
    if (current == null) {
      grouped.set(bucket.start, {
        start: bucket.start,
        tokens: { ...bucket.tokens },
        cost: bucket.cost,
        requestCount: bucket.requestCount,
      });
    } else {
      current.tokens.input += bucket.tokens.input;
      current.tokens.output += bucket.tokens.output;
      current.tokens.cacheRead += bucket.tokens.cacheRead;
      current.tokens.cacheWrite5m += bucket.tokens.cacheWrite5m;
      current.tokens.cacheWrite1h += bucket.tokens.cacheWrite1h;
      current.tokens.webSearches += bucket.tokens.webSearches;
      current.cost += bucket.cost;
      current.requestCount += bucket.requestCount;
    }
  }
  return [...grouped.values()].sort((a, b) => b.start - a.start);
}

export function BucketTable({
  buckets,
  granularity,
  height,
}: {
  buckets: readonly UsageBucket[];
  granularity: TimeGranularity;
  height?: number | undefined;
}) {
  const rows = bucketRows(buckets);
  const columns: TableColumn<BucketRow>[] = [
    { key: "start", title: "时间段", width: "minmax(150px, 1.6fr)", render: (row) => bucketLabel(row.start, granularity) },
    { key: "requests", title: "请求", width: "60px", align: "right", render: (row) => row.requestCount },
    { key: "input", title: "输入", width: "74px", align: "right", render: (row) => formatTokens(row.tokens.input) },
    { key: "output", title: "输出", width: "74px", align: "right", render: (row) => formatTokens(row.tokens.output) },
    { key: "cacheRead", title: "缓存读", width: "82px", align: "right", render: (row) => formatTokens(row.tokens.cacheRead) },
    { key: "cacheWrite", title: "缓存写", width: "82px", align: "right", render: (row) => formatTokens(cacheWriteTotal(row.tokens)) },
    { key: "cost", title: "折算金额", width: "minmax(88px, 0.8fr)", align: "right", render: (row) => usd(row.cost) },
  ];
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(row) => String(row.start)}
      height={height}
      ariaLabel="按时间段"
      emptyText="该时间范围内没有用量"
    />
  );
}

// MARK: - 设备 (new)

export function DeviceTable({
  devices,
  selfDeviceId,
  todayStats,
  now,
  height,
}: {
  devices: readonly DeviceInfo[];
  selfDeviceId?: string | undefined;
  todayStats: ReadonlyMap<string, DeviceUsage>;
  now: number;
  height?: number | undefined;
}) {
  const sorted = [...devices].sort((a, b) => Number(isSelf(b, selfDeviceId)) - Number(isSelf(a, selfDeviceId)));
  const columns: TableColumn<DeviceInfo>[] = [
    {
      key: "name",
      title: "设备名",
      width: "minmax(140px, 1.6fr)",
      render: (device) => (
        <span className="device-cell">
          <span className="ellipsis" title={device.name}>{device.name}</span>
        </span>
      ),
    },
    { key: "platform", title: "平台", width: "82px", render: (device) => platformLabel(device.platform) },
    {
      key: "lastSeen",
      title: "最近活跃",
      width: "minmax(100px, 1fr)",
      render: (device) => relativeTime(device.lastSeenAt, now),
    },
    {
      key: "requests",
      title: "今日请求",
      width: "74px",
      align: "right",
      render: (device) => {
        const stats = todayStats.get(deviceStatKey(device, selfDeviceId));
        return stats != null ? stats.requests : 0;
      },
    },
    {
      key: "cost",
      title: "今日折算",
      width: "88px",
      align: "right",
      render: (device) => {
        const stats = todayStats.get(deviceStatKey(device, selfDeviceId));
        return stats != null ? usd(stats.cost) : "—";
      },
    },
    {
      key: "mark",
      title: "标记",
      width: "60px",
      render: (device) => (isSelf(device, selfDeviceId) ? <Badge tone="server">本机</Badge> : null),
    },
  ];
  return (
    <DataTable
      rows={sorted}
      columns={columns}
      rowKey={(device) => device.id}
      height={height}
      ariaLabel="设备"
      emptyText="暂无设备 · 在设置的「服务端」中登录后显示"
    />
  );
}

function isSelf(device: DeviceInfo, selfDeviceId: string | undefined): boolean {
  return device.isSelf === true || (selfDeviceId != null && device.id === selfDeviceId);
}

// MARK: - Sync badge

export function SyncBadge({ sync }: { sync: SyncState }) {
  let tone: "green" | "orange" | "red" | "gray" = "gray";
  let label = "未启用同步";
  switch (sync.status) {
    case "online":
      tone = "green";
      label = sync.devices.length > 0 ? "已同步 " + sync.devices.length + " 台设备" : "已连接";
      break;
    case "connecting":
      tone = "orange";
      label = "正在连接…";
      break;
    case "offline":
      tone = "orange";
      label = "离线";
      break;
    case "error":
      tone = "red";
      label = "同步错误";
      break;
    case "disabled":
      break;
  }
  const titleParts: string[] = [];
  if (sync.lastSyncAt != null) titleParts.push("上次同步 " + dateTime(sync.lastSyncAt));
  if (sync.error != null && sync.error.length > 0) titleParts.push(sync.error);
  if (sync.account != null) titleParts.push("账号 " + sync.account.username);
  return (
    <span className="sync-badge" title={titleParts.join(" · ")}>
      <StatusDot tone={tone} />
      {label}
    </span>
  );
}

// MARK: - 定价 (SettingsView.swift PricingTable)

export function PricingTable({ height }: { height?: number | undefined }) {
  const models = [...Pricing.models].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const columns: TableColumn<(typeof models)[number]>[] = [
    { key: "model", title: "模型", width: "minmax(140px, 1.8fr)", render: (model) => model.displayName },
    { key: "input", title: "输入", width: "80px", align: "right", render: (model) => price(model.price.input) },
    { key: "output", title: "输出", width: "80px", align: "right", render: (model) => price(model.price.output) },
    { key: "cacheRead", title: "缓存读", width: "80px", align: "right", render: (model) => price(model.price.cacheRead) },
    { key: "cacheWrite5m", title: "缓存写 5m", width: "96px", align: "right", render: (model) => price(model.price.cacheWrite5m) },
    { key: "cacheWrite1h", title: "缓存写 1h", width: "96px", align: "right", render: (model) => price(model.price.cacheWrite1h) },
    {
      key: "fast",
      title: "Fast",
      width: "72px",
      align: "right",
      render: (model) => (model.price.fastMultiplier != null ? model.price.fastMultiplier + "×" : "—"),
    },
  ];
  return (
    <DataTable
      rows={models}
      columns={columns}
      rowKey={(model) => model.prefix + "|" + model.displayName}
      height={height}
      ariaLabel="定价"
      emptyText="暂无定价数据"
    />
  );
}
