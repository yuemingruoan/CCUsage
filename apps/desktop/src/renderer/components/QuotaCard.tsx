// Current 5-hour or weekly subscription window (port of QuotaViews.swift QuotaCard).
import type { QuotaKind, QuotaStatus, QuotaWindow } from "@ccusage/core/pure";
import { dateTime, duration, resetText, usd, windowStartLabel, QUOTA_KIND_LABELS } from "../format";
import { quotaLevel, windowCostSinceReset } from "../data";
import type { QuotaLevel } from "../data";
import { Badge, IconOctagon, IconWarning } from "./ui";

function projection(status: QuotaStatus, kind: QuotaKind, now: number): string {
  if (status.exhaustionDate != null) {
    return status.exhaustionDate <= now ? "已用尽" : "约 " + resetText(status.exhaustionDate, kind) + " 用尽";
  }
  return status.burnRatePerHour > 0 ? "按当前速率够用到重置" : "近期无用量";
}

function footnote(status: QuotaStatus, window: QuotaWindow, kind: QuotaKind): string {
  const range = "窗口 " + windowStartLabel(window.start, kind) + " – " + resetText(window.end, kind);
  const source = window.isConfirmed ? "重置时间来自 CC" : "重置时间为推断";
  const reset =
    window.resetAt != null
      ? "CC 于 " + dateTime(window.resetAt) + " 后提前重置，此前的 " + usd(window.costBeforeReset) + " 不计入"
      : null;
  const observation =
    status.latestObservation != null
      ? "CC 上报 " + Math.round(status.latestObservation.usedPercentage) + "%（" + dateTime(status.latestObservation.observedAt) + "）"
      : "尚无 CC 上报的百分比";
  const estimated = status.percentageIsReported ? null : "之后的用量按预估限额折算";
  return [range, source, reset, observation, estimated].filter((part): part is string => part != null).join(" · ");
}

function Metric({
  title,
  value,
  detail,
  level,
}: {
  title: string;
  value: string;
  detail: string;
  level?: QuotaLevel;
}) {
  return (
    <div className="quota-metric">
      <div className="quota-metric-label">{title}</div>
      <div className={level != null && level !== "normal" ? "quota-metric-value quota-level-" + level : "quota-metric-value"}>
        {level === "warning" && <IconWarning size={15} className="quota-icon" />}
        {level === "critical" && <IconOctagon size={15} className="quota-icon" />}
        <span title={value}>{value}</span>
      </div>
      <div className="quota-metric-detail" title={detail}>{detail}</div>
    </div>
  );
}

export function QuotaCard({
  status,
  kind,
  now,
  compact,
  serverDeviceCount,
}: {
  status: QuotaStatus | undefined;
  kind: QuotaKind;
  now: number;
  compact?: boolean;
  serverDeviceCount?: number | null;
}) {
  const window = status?.window;
  const percentage = status?.percentage;
  const level = quotaLevel(percentage);
  const clamped = Math.min(Math.max(percentage ?? 0, 0), 100);
  const costSinceReset = window != null ? windowCostSinceReset(window) : 0;
  const limit = status?.estimate?.cost;
  const sample = status?.estimate?.sample;
  const lowerBound = status?.estimate?.lowerBound;

  let limitValue = "未知";
  let limitDetail = "等待 CC 上报百分比";
  if (limit != null && sample != null) {
    limitValue = "≈ " + usd(limit);
    limitDetail = usd(sample.cost) + " ÷ " + Math.round(sample.usedPercentage) + "%";
  } else if (lowerBound != null && lowerBound > costSinceReset + 0.005) {
    limitDetail = "至少 " + usd(lowerBound);
  }

  const remainingValue = limit != null && percentage != null ? "≈ " + usd(Math.max(limit * (1 - percentage / 100), 0)) : "—";
  const remainingDetail =
    limit != null && percentage != null
      ? projection(status as QuotaStatus, kind, now)
      : "速率 " + usd(status?.burnRatePerHour ?? 0) + "/小时";

  const showServerBadge = serverDeviceCount != null && serverDeviceCount > 0;

  if (compact === true) {
    // Narrow tray popover: label/value rows keep every number readable at ~180px per card.
    return (
      <div className="card quota-card quota-card-compact">
        <div className="quota-compact-header">
          <span className="quota-compact-title">{QUOTA_KIND_LABELS[kind]}额度</span>
          {showServerBadge && (
            <span className="badge badge-server quota-compact-badge">含 {serverDeviceCount} 台设备</span>
          )}
        </div>
        {status != null && window != null ? (
          <>
            <div className="quota-compact-reset">还有 {duration(window.end - now)}</div>
            <div className="quota-compact-metrics">
              <div className="quota-compact-row">
                <span className="quota-compact-label">已用</span>
                <span
                  className={
                    level !== "normal"
                      ? "quota-compact-value quota-level-" + level
                      : "quota-compact-value"
                  }
                >
                  {percentage != null ? Math.round(percentage) + "%" : "—"}
                </span>
              </div>
              <div className="quota-compact-row">
                <span className="quota-compact-label">限额（预估）</span>
                <span className="quota-compact-value" title={limitDetail}>{limitValue}</span>
              </div>
              <div className="quota-compact-row">
                <span className="quota-compact-label">剩余</span>
                <span className="quota-compact-value">{remainingValue}</span>
              </div>
            </div>
            <div
              className="quota-bar"
              role="progressbar"
              aria-label={"已用 " + Math.round(percentage ?? 0) + "%"}
              aria-valuenow={Math.round(clamped)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className={"quota-bar-fill quota-level-bg-" + level} style={{ width: clamped + "%" }} />
            </div>
          </>
        ) : (
          <>
            <div className="quota-empty quota-empty-compact">
              {kind === "fiveHour" ? "没有进行中的窗口" : "暂无本周窗口数据"}
            </div>
            <div className="quota-bar">
              <div className="quota-bar-fill quota-level-bg-normal" style={{ width: "0%" }} />
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="card quota-card">
      <div className="quota-header">
        <div className="quota-title-row">
          <span className="quota-title">{QUOTA_KIND_LABELS[kind]}额度</span>
          {showServerBadge && <Badge tone="server">含 {serverDeviceCount} 台设备</Badge>}
        </div>
        {window != null && (
          <span className="quota-reset" title="重置时间与剩余时长">
            {resetText(window.end, kind)} 重置 · 还有 {duration(window.end - now)}
          </span>
        )}
      </div>
      {status != null && window != null ? (
        <>
          <div className="quota-metrics">
            <Metric
              title="已用"
              value={percentage != null ? Math.round(percentage) + "%" : "—"}
              detail={"折算 " + usd(costSinceReset)}
              level={percentage != null ? level : undefined}
            />
            <Metric title="限额（预估）" value={limitValue} detail={limitDetail} />
            <Metric title="剩余" value={remainingValue} detail={remainingDetail} />
          </div>
          <div
            className="quota-bar"
            role="progressbar"
            aria-label={"已用 " + Math.round(percentage ?? 0) + "%"}
            aria-valuenow={Math.round(clamped)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className={"quota-bar-fill quota-level-bg-" + level} style={{ width: clamped + "%" }} />
          </div>
          <div className="quota-footnote">{footnote(status, window, kind)}</div>
        </>
      ) : (
        <>
          <div className="quota-empty">
            {kind === "fiveHour" ? "没有进行中的窗口，下一条请求将开启新窗口" : "暂无本周窗口数据"}
          </div>
          <div className="quota-bar">
            <div className="quota-bar-fill quota-level-bg-normal" style={{ width: "0%" }} />
          </div>
        </>
      )}
    </div>
  );
}
