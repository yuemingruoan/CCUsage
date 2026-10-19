// Hand written SVG line chart, port of the Swift Charts usage chart (UsageChart.swift).
// 2px round lines per series, point markers on <=31 buckets, hover rule + tooltip card,
// legend chips and an empty state.
import { useEffect, useMemo, useRef, useState } from "react";
import type { UsageBucket, TimeGranularity } from "@ccusage/core/pure";
import type { ChartColumn, ChartMetric, SeriesScale } from "../data";
import { bucketMetricValue, chartColumns, formatMetricValue } from "../data";
import { bucketRange, timeShort } from "../format";

const PADDING = { top: 26, right: 14, bottom: 26, left: 64 };
const MAX_MARKED_COLUMNS = 31;
const TICK_COUNT = 4;

function niceTop(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.pow(10, Math.floor(Math.log10(value)));
  const fraction = value / exponent;
  const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const nice = steps.find((step) => fraction <= step) ?? 10;
  return nice * exponent;
}

function axisLabel(start: number, granularity: TimeGranularity): string {
  if (granularity === "day" || granularity === "week") {
    const date = new Date(start);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return month + "/" + day;
  }
  return timeShort(start);
}

function xLabels(columns: readonly ChartColumn[], granularity: TimeGranularity): number[] {
  const count = columns.length;
  if (count <= 1) return count === 1 ? [0] : [];
  if (count <= 6) return columns.map((_, index) => index);
  const indices = new Set<number>();
  for (let step = 0; step <= TICK_COUNT; step++) {
    indices.add(Math.round((step / TICK_COUNT) * (count - 1)));
  }
  return [...indices].sort((a, b) => a - b);
}

export function UsageChart({
  buckets,
  scale,
  metric,
  granularity,
  height,
}: {
  buckets: readonly UsageBucket[];
  scale: SeriesScale;
  metric: ChartMetric;
  granularity: TimeGranularity;
  height: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (element == null) return;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const columns = useMemo(() => chartColumns(buckets, metric, scale), [buckets, metric, scale]);

  const chart = useMemo(() => {
    if (columns.length === 0 || width <= 0) return null;
    const innerWidth = Math.max(width - PADDING.left - PADDING.right, 10);
    const innerHeight = Math.max(height - PADDING.top - PADDING.bottom, 10);
    let maxValue = 0;
    for (const column of columns) {
      for (const part of column.parts) {
        const value = bucketMetricValue(part, metric);
        if (value > maxValue) maxValue = value;
      }
    }
    const top = niceTop(maxValue);
    const count = columns.length;
    const xFor = (index: number): number => {
      if (count <= 1) return PADDING.left + innerWidth / 2;
      return PADDING.left + (index / (count - 1)) * innerWidth;
    };
    const yFor = (value: number): number => PADDING.top + innerHeight - (Math.max(value, 0) / top) * innerHeight;
    const ticks: number[] = [];
    for (let step = 0; step <= TICK_COUNT; step++) ticks.push((step / TICK_COUNT) * top);

    const seriesPaths = scale.domain.map((series) => {
      const points: string[] = [];
      columns.forEach((column, index) => {
        let value = 0;
        for (const part of column.parts) {
          if (part.series === series) value = bucketMetricValue(part, metric);
        }
        points.push((points.length === 0 ? "M" : "L") + xFor(index) + "," + yFor(value));
      });
      return { series, color: scale.color(series), path: points.join(" ") };
    });

    return { innerWidth, innerHeight, top, ticks, xFor, yFor, seriesPaths };
  }, [columns, width, height, metric, scale]);

  const hoveredColumn = hovered != null ? columns[hovered] : undefined;

  if (columns.length === 0) {
    return (
      <div className="chart-frame empty-chart" style={{ height }}>
        该时间范围内没有用量
      </div>
    );
  }

  const tooltipLeft = (() => {
    if (hovered == null || chart == null) return 0;
    const x = chart.xFor(hovered);
    const estimatedWidth = 230;
    const left = x + 14;
    if (left + estimatedWidth > width - 8) return Math.max(x - estimatedWidth - 14, 8);
    return left;
  })();

  return (
    <div className="chart-frame" ref={containerRef} style={{ height }}>
      {scale.domain.length > 0 && (
        <div className="chart-legend" aria-hidden="true">
          {scale.domain.map((series) => (
            <span className="legend-chip" key={series}>
              <span className="legend-swatch" style={{ background: scale.color(series) }} />
              {series}
            </span>
          ))}
        </div>
      )}
      {width > 0 && chart != null && (
        <svg
          ref={svgRef}
          className="usage-chart"
          width={width}
          height={height}
          role="img"
          aria-label="按时间段的用量折线图"
          onPointerMove={(event) => {
            if (columns.length === 0) return;
            const rect = svgRef.current?.getBoundingClientRect();
            if (rect == null) return;
            const x = event.clientX - rect.left;
            const count = columns.length;
            const index = count <= 1 ? 0 : Math.round(((x - PADDING.left) / Math.max(width - PADDING.left - PADDING.right, 1)) * (count - 1));
            setHovered(Math.min(Math.max(index, 0), count - 1));
          }}
          onPointerLeave={() => setHovered(null)}
        >
          {chart.ticks.map((tick) => (
            <g key={"y" + tick}>
              <line
                x1={PADDING.left}
                x2={width - PADDING.right}
                y1={chart.yFor(tick)}
                y2={chart.yFor(tick)}
                className="chart-grid"
              />
              <text x={PADDING.left - 8} y={chart.yFor(tick) + 3.5} className="chart-axis-label" textAnchor="end">
                {formatMetricValue(metric, tick)}
              </text>
            </g>
          ))}
          {xLabels(columns, granularity).map((index) => {
            const column = columns[index];
            if (column == null) return null;
            return (
              <g key={"x" + column.start}>
                <line
                  x1={chart.xFor(index)}
                  x2={chart.xFor(index)}
                  y1={height - PADDING.bottom}
                  y2={height - PADDING.bottom + 4}
                  className="chart-tick"
                />
                <text
                  x={chart.xFor(index)}
                  y={height - 6}
                  className="chart-axis-label"
                  textAnchor={index === 0 ? "start" : index === columns.length - 1 ? "end" : "middle"}
                >
                  {axisLabel(column.start, granularity)}
                </text>
              </g>
            );
          })}
          {chart.seriesPaths.map((series) => (
            <path
              key={series.series}
              d={series.path}
              fill="none"
              stroke={series.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {columns.length <= MAX_MARKED_COLUMNS &&
            columns.map((column, index) =>
              column.parts.map((part) => (
                <circle
                  key={column.start + "|" + part.series}
                  cx={chart.xFor(index)}
                  cy={chart.yFor(bucketMetricValue(part, metric))}
                  r={3}
                  fill={scale.color(part.series)}
                />
              )),
            )}
          {hovered != null && hoveredColumn != null && (
            <g>
              <line
                x1={chart.xFor(hovered)}
                x2={chart.xFor(hovered)}
                y1={PADDING.top}
                y2={height - PADDING.bottom}
                className="chart-rule"
              />
              {hoveredColumn.parts.map((part) => (
                <circle
                  key={"hover|" + part.series}
                  cx={chart.xFor(hovered)}
                  cy={chart.yFor(bucketMetricValue(part, metric))}
                  r={5}
                  fill={scale.color(part.series)}
                  stroke="var(--chart-marker-ring)"
                  strokeWidth={1.5}
                />
              ))}
            </g>
          )}
        </svg>
      )}
      {hovered != null && hoveredColumn != null && (
        <div className="chart-tooltip" style={{ left: tooltipLeft, top: 8 }}>
          <div className="tooltip-title">{bucketRange(hoveredColumn.start, granularity)}</div>
          {[...hoveredColumn.parts].reverse().map((part) => (
            <div className="tooltip-row" key={part.series}>
              <span className="legend-swatch" style={{ background: scale.color(part.series) }} />
              <span className="tooltip-series">{part.series}</span>
              <span className="tooltip-value">{formatMetricValue(metric, bucketMetricValue(part, metric))}</span>
            </div>
          ))}
          <div className="tooltip-divider" />
          <div className="tooltip-row tooltip-total">
            <span>合计 · {hoveredColumn.requestCount} 次请求</span>
            <span className="tooltip-value">{formatMetricValue(metric, hoveredColumn.total)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
