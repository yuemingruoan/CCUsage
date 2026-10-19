// Session detail page. Port of SessionDetailView.swift.
import { useEffect, useMemo, useState } from "react";
import { buckets as coreBuckets, modelTotals } from "@ccusage/core/pure";
import type { AppState, SessionSummary, TimeGranularity, UsageEntry } from "@ccusage/core/pure";
import {
  CHART_METRICS,
  MAIN_SUBAGENT_SCALE,
  SUBAGENT_SERIES,
  MAIN_SERIES,
  buildModelOrder,
  costTotal,
  makeModelSeries,
  modelScale,
  suggestedGranularity,
  tokenTotal,
} from "../data";
import type { ChartMetric } from "../data";
import { formatTokens, duration, dateTime, shellQuote, usd, GRANULARITY_LABELS, GRANULARITY_ORDER } from "../format";
import { UsageChart } from "../components/UsageChart";
import { BucketTable, CostComposition, ModelTable } from "../components/tables";
import {
  Button,
  EqualHeightRow,
  IconBranch,
  IconCheck,
  IconCopy,
  IconFolder,
  IconTerminal,
  SectionBar,
  SectionHeader,
  Segmented,
  Select,
  StatTile,
} from "../components/ui";

type SeriesMode = "model" | "agent";

export function SessionDetail({ state, session }: { state: AppState; session: SessionSummary }) {
  const entries = state.snapshot.entriesBySession[session.id] ?? [];
  const modelOrder = useMemo(() => buildModelOrder(state.snapshot.entries), [state.snapshot.entries]);
  const modelSeries = useMemo(() => makeModelSeries(modelOrder), [modelOrder]);
  const [granularity, setGranularity] = useState<TimeGranularity>("fifteenMinutes");
  const [metric, setMetric] = useState<ChartMetric>("cost");
  const [seriesMode, setSeriesMode] = useState<SeriesMode>("model");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setGranularity(suggestedGranularity(Math.max(session.end - session.start, 0)));
  }, [session.id, session.start, session.end]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const seriesOf = useMemo(() => {
    if (seriesMode === "model") return modelSeries;
    return (entry: UsageEntry) => (entry.agentId != null ? SUBAGENT_SERIES : MAIN_SERIES);
  }, [seriesMode, modelSeries]);

  const chartBuckets = useMemo(
    () => coreBuckets(entries, granularity, seriesOf),
    [entries, granularity, seriesOf],
  );
  const present = useMemo(() => new Set(chartBuckets.map((bucket) => bucket.series)), [chartBuckets]);
  const scale = seriesMode === "model" ? modelScale(modelOrder, present) : MAIN_SUBAGENT_SCALE;
  const models = useMemo(() => modelTotals(entries), [entries]);
  const modelTableScale = useMemo(() => modelScale(modelOrder, new Set(modelOrder)), [modelOrder]);

  async function copyResume() {
    const command =
      (session.cwd != null ? "cd " + shellQuote(session.cwd) + " && " : "") + "claude --resume " + session.id;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      return;
    } catch {
      // Clipboard API can be unavailable in some window contexts; fall back below.
    }
    try {
      const textarea = document.createElement("textarea");
      textarea.value = command;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(ok);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="page session-detail">
      <header className="session-header">
        <div className="session-title">{session.title}</div>
        <div className="session-meta">
          <span className="meta-item" title={session.cwd ?? session.projectName}>
            <IconFolder />
            {session.cwd ?? session.projectName}
          </span>
          {session.gitBranch != null && session.gitBranch.length > 0 && (
            <span className="meta-item">
              <IconBranch />
              {session.gitBranch}
            </span>
          )}
          {session.version != null && session.version.length > 0 && (
            <span className="meta-item">
              <IconTerminal />v{session.version}
            </span>
          )}
        </div>
        <div className="session-id-row">
          <span className="session-id mono" title={session.id}>{session.id}</span>
          <Button variant="borderless" onClick={() => void copyResume()} title="复制 claude --resume 命令">
            {copied ? <IconCheck /> : <IconCopy />}
            {copied ? "已复制" : "复制 resume 命令"}
          </Button>
        </div>
      </header>

      <EqualHeightRow>
        <StatTile
          title="折算金额（API 价）"
          value={usd(costTotal(session.cost))}
          caption={
            session.subagentCount > 0
              ? "含 " + session.subagentCount + " 个子代理 " + usd(session.subagentCost)
              : session.hasUnpricedRequests
                ? "部分模型无定价，未计入"
                : null
          }
        />
        {session.recordedCost != null && (
          <StatTile
            title="CC 记录的 lastCost"
            value={usd(session.recordedCost)}
            caption="来自 ~/.claude.json，CC 进程最后一次退出时写入"
          />
        )}
        <StatTile
          title="Tokens"
          value={formatTokens(tokenTotal(session.tokens))}
          caption={session.requestCount + " 次请求"}
        />
        <StatTile
          title="时长"
          value={duration(session.end - session.start)}
          caption={dateTime(session.start) + " – " + dateTime(session.end)}
        />
      </EqualHeightRow>

      <CostComposition cost={session.cost} tokens={session.tokens} />

      <section className="detail-section">
        <SectionBar title="按时间段" subtitle="悬停查看明细；下表为同一粒度的逐段数据">
          <Segmented
            size="small"
            ariaLabel="系列"
            value={seriesMode}
            onChange={setSeriesMode}
            options={[
              { value: "model", label: "按模型" },
              { value: "agent", label: "主会话 / 子代理" },
            ]}
          />
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
        <UsageChart buckets={chartBuckets} scale={scale} metric={metric} granularity={granularity} height={240} />
        <BucketTable buckets={chartBuckets} granularity={granularity} height={260} />
      </section>

      <section className="detail-section">
        <SectionHeader title="按模型" />
        <ModelTable totals={models} scale={modelTableScale} height={140} />
      </section>
    </div>
  );
}
