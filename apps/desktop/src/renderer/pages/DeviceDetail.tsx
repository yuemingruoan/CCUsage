// Device detail page: a peer's (or the local) usage with a per-day breakdown and its sessions.
// Remote sessions carry a synced title now (protocol: SyncSessionMeta), so this page answers
// "which days did that device use, and what did it work on".
import { useMemo } from "react";
import type { AppState, DeviceInfo } from "@ccusage/core/pure";
import {
  costTotal,
  dailyUsage,
  entriesForDevice,
  platformLabel,
  sessionsForDevice,
  sumEntries,
  tokenTotal,
} from "../data";
import type { DailyUsage } from "../data";
import { dateRange, dateTimeShort, dayLabel, formatTokens, relativeTime, usd } from "../format";
import { DataTable } from "../components/tables";
import type { TableColumn } from "../components/tables";
import { AuthBadge, Badge, Button, EqualHeightRow, SectionBar, SectionHeader, StatTile } from "../components/ui";

export function DeviceDetail({
  state,
  deviceId,
  now,
  onSelectSession,
  onBack,
}: {
  state: AppState;
  deviceId: string;
  now: number;
  onSelectSession: (id: string) => void;
  onBack: () => void;
}) {
  const selfDeviceId = state.settings.server.deviceId;
  const device = useMemo<DeviceInfo | undefined>(() => {
    const known = state.sync.devices.find((candidate) => candidate.id === deviceId);
    if (known) return known;
    if (deviceId === selfDeviceId) {
      return {
        id: deviceId,
        name: state.settings.server.deviceName || "本机",
        platform: "darwin",
        appVersion: "",
        lastSeenAt: state.scan.scannedAt,
        isSelf: true,
      };
    }
    return undefined;
  }, [state, deviceId, selfDeviceId]);

  const entries = useMemo(
    () => (device == null ? [] : entriesForDevice(state.snapshot.entries, device, selfDeviceId)),
    [state.snapshot.entries, device, selfDeviceId],
  );
  const totals = useMemo(() => sumEntries(entries), [entries]);
  const days = useMemo(() => dailyUsage(entries), [entries]);
  const sessions = useMemo(() => {
    if (device == null) return [];
    return sessionsForDevice(state.snapshot.sessions, device, selfDeviceId).sort((a, b) => b.end - a.end);
  }, [state.snapshot.sessions, device, selfDeviceId]);

  if (device == null) {
    return (
      <div className="page empty-page">
        <SectionHeader title="设备" subtitle="该设备已不在同步设备列表中" />
        <Button onClick={onBack}>返回概览</Button>
      </div>
    );
  }

  const isSelf = device.isSelf === true || device.id === selfDeviceId;
  const unpriced = totals.cost === 0 && entries.some((entry) => !entry.isPriced);
  const first = entries.length > 0 ? entries.reduce((min, entry) => Math.min(min, entry.timestamp), entries[0]!.timestamp) : undefined;
  const last = entries.length > 0 ? entries.reduce((max, entry) => Math.max(max, entry.timestamp), entries[0]!.timestamp) : undefined;

  const dayColumns: TableColumn<DailyUsage>[] = [
    { key: "day", title: "日期", width: "minmax(120px, 1.2fr)", render: (row) => dayLabel(row.day) },
    { key: "requests", title: "请求", width: "80px", align: "right", render: (row) => String(row.requests) },
    {
      key: "tokens",
      title: "Tokens",
      width: "120px",
      align: "right",
      render: (row) => <span title={"输入 " + formatTokens(row.tokens.input) + " · 输出 " + formatTokens(row.tokens.output) + " · 缓存读 " + formatTokens(row.tokens.cacheRead)}>{formatTokens(tokenTotal(row.tokens))}</span>,
    },
    {
      key: "cost",
      title: "折算金额",
      width: "110px",
      align: "right",
      render: (row) => (row.hasUnpricedRequests && row.cost === 0 ? <span className="muted">未定价</span> : usd(row.cost)),
    },
  ];

  const sessionColumns: TableColumn<(typeof sessions)[number]>[] = [
    {
      key: "title",
      title: "会话",
      width: "minmax(200px, 3fr)",
      render: (session) => (
        <span className="ellipsis" title={session.title}>
          {session.title}
        </span>
      ),
    },
    {
      key: "range",
      title: "时间段",
      width: "minmax(190px, 1.6fr)",
      render: (session) => dateRange(session.start, session.end),
    },
    {
      key: "auth",
      title: "来源",
      width: "110px",
      render: (session) => <AuthBadge mode={session.authMode} />,
    },
    { key: "requests", title: "请求", width: "70px", align: "right", render: (session) => String(session.requestCount) },
    {
      key: "cost",
      title: "折算金额",
      width: "110px",
      align: "right",
      render: (session) =>
        session.hasUnpricedRequests && costTotal(session.cost) === 0 ? <span className="muted">未定价</span> : usd(costTotal(session.cost)),
    },
  ];

  return (
    <div className="page device-page">
      <div className="device-header">
        <Button variant="borderless" onClick={onBack}>← 概览</Button>
        <div className="device-header-main">
          <div className="device-title">
            {device.name}
            {isSelf && <Badge tone="server">本机</Badge>}
          </div>
          <div className="device-meta">
            {platformLabel(device.platform)}
            {" · "}最近活跃 {relativeTime(device.lastSeenAt, now)}
            {" · "}记录于 {first != null ? dateTimeShort(first) : "—"}
            {last != null ? " – " + dateTimeShort(last) : ""}
          </div>
        </div>
      </div>

      <EqualHeightRow>
        <StatTile title="请求" value={String(entries.length)} caption={sessions.length + " 个会话"} />
        <StatTile title="Tokens" value={formatTokens(tokenTotal(totals.tokens))} caption={"输入 " + formatTokens(totals.tokens.input) + " · 输出 " + formatTokens(totals.tokens.output)} />
        <StatTile title="折算金额" value={unpriced ? "未定价" : usd(totals.cost)} caption={unpriced ? "该设备的模型不在定价表中" : "API 等值"} />
        <StatTile title="按日期" value={String(days.length)} caption={days.length > 0 ? "最近一天 " + dayLabel(days[0]!.day) : "暂无用量"} />
      </EqualHeightRow>

      <section className="overview-section">
        <SectionHeader title="按日期" subtitle="该设备每天的用量（来自同步的用量条目）" />
        <DataTable
          rows={days}
          columns={dayColumns}
          rowKey={(row) => String(row.day)}
          height={260}
          ariaLabel="设备按日期用量"
          emptyText="该设备还没有上传用量"
        />
      </section>

      <section className="overview-section">
        <SectionBar title="该设备的会话" subtitle="点击会话查看详情；远端会话标题来自对端上报的会话元数据" />
        <DataTable
          rows={sessions}
          columns={sessionColumns}
          rowKey={(session) => session.id}
          height={300}
          ariaLabel="设备会话"
          emptyText="该设备还没有同步会话"
          onRowClick={(session) => onSelectSession(session.id)}
        />
      </section>
    </div>
  );
}
