// Small presentational primitives shared by the main window, settings and tray.
// Ports of the Swift helpers in Formatting.swift (StatTile / EqualHeightRow / SectionBar /
// SectionHeader) plus a few controls that SwiftUI provided for free.
import type { CSSProperties, ReactNode } from "react";

// MARK: - Sections

export function SectionHeader({ title, subtitle }: { title: string; subtitle?: string | undefined }) {
  return (
    <div className="section-header">
      <div className="section-title">{title}</div>
      {subtitle != null && subtitle.length > 0 && <div className="section-subtitle">{subtitle}</div>}
    </div>
  );
}

export function SectionBar({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="section-bar">
      <SectionHeader title={title} subtitle={subtitle} />
      <div className="section-controls">{children}</div>
    </div>
  );
}

/** Lays children out with equal widths and the height of the tallest child. */
export function EqualHeightRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className == null ? "equal-row" : "equal-row " + className}>{children}</div>;
}

// MARK: - Tiles

export function StatTile({ title, value, caption }: { title: string; value: string; caption?: string | null }) {
  return (
    <div className="card stat-tile">
      <div className="stat-label">{title}</div>
      <div className="stat-value" title={value}>{value}</div>
      {caption != null && caption.length > 0 && <div className="stat-caption">{caption}</div>}
    </div>
  );
}

// MARK: - Badges

export function Badge({ children, tone }: { children: ReactNode; tone?: "neutral" | "server" | "warn" | "error" }) {
  const className = "badge" + (tone != null && tone !== "neutral" ? " badge-" + tone : "");
  return <span className={className}>{children}</span>;
}

export function StatusDot({ tone }: { tone: "green" | "orange" | "red" | "gray" }) {
  return <span className={"status-dot status-dot-" + tone} />;
}

// MARK: - Controls

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  size?: "regular" | "small";
}) {
  return (
    <div className={"segmented" + (size === "small" ? " segmented-small" : "")} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? "segment segment-active" : "segment"}
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  title,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  ariaLabel?: string;
  title?: string;
}) {
  return (
    <select
      className="select"
      value={value}
      aria-label={ariaLabel}
      title={title}
      onChange={(event) => onChange(event.target.value as T)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Button({
  children,
  onClick,
  variant,
  disabled,
  title,
  type,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "borderless" | "danger";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
}) {
  const className =
    "button" +
    (variant === "primary" ? " button-primary" : variant === "borderless" ? " button-borderless" : variant === "danger" ? " button-danger" : "");
  return (
    <button type={type ?? "button"} className={className} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={small === true ? "spinner spinner-small" : "spinner"} aria-label="加载中" />;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

export function Field({
  label,
  children,
  caption,
  top,
}: {
  label: string;
  children: ReactNode;
  caption?: ReactNode;
  top?: boolean;
}) {
  return (
    <div className={top === true ? "field field-top" : "field"}>
      <div className="field-label">{label}</div>
      <div className="field-control">{children}</div>
      {caption != null && <div className="field-caption">{caption}</div>}
    </div>
  );
}

export function Separator() {
  return <div className="separator" role="separator" />;
}

// MARK: - Settings tabs (macOS settings-style tab bar)

export interface SettingsTabOption<T extends string> {
  value: T;
  label: string;
}

export function SettingsTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly SettingsTabOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="settings-tabbar" role="tablist" aria-label="设置">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          className={tab.value === value ? "settings-tab settings-tab-active" : "settings-tab"}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// MARK: - Icons (inline SVG, 1.6px strokes like SF Symbols)

interface IconProps {
  size?: number;
  className?: string;
}

function svgProps(size: number, className?: string): { width: number; height: number; viewBox: string; className: string; "aria-hidden": true } {
  return { width: size, height: size, viewBox: "0 0 20 20", className: className ?? "icon", "aria-hidden": true };
}

export function IconChart({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 16.5h14" />
      <path d="M4.5 13.5 8 8.5l2.8 2.2L15.5 4" />
    </svg>
  );
}

export function IconRefresh({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6" />
      <path d="M16.5 4v4h-4" />
    </svg>
  );
}

export function IconSearch({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="9" cy="9" r="4.6" />
      <path d="m12.6 12.6 3.4 3.4" />
    </svg>
  );
}

export function IconSort({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4v12" />
      <path d="m3.5 13.5 2.5 2.5 2.5-2.5" />
      <path d="M14 16V4" />
      <path d="m11.5 6.5 2.5-2.5 2.5 2.5" />
    </svg>
  );
}

export function IconWarning({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="currentColor">
      <path d="M10 2.4c.4 0 .8.2 1 .6l7 12.3c.4.7-.1 1.7-1 1.7H3c-.9 0-1.4-1-1-1.7l7-12.3c.2-.4.6-.6 1-.6Zm0 4.1a.9.9 0 0 0-.9 1v3.6a.9.9 0 0 0 1.8 0V7.5a.9.9 0 0 0-.9-1Zm0 6.2a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z" />
    </svg>
  );
}

export function IconOctagon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="currentColor">
      <path d="M6.7 2h6.6L18 6.7v6.6L13.3 18H6.7L2 13.3V6.7L6.7 2Zm.7 5.3a.9.9 0 0 0 0 1.3L9 10l-1.6 1.4a.9.9 0 1 0 1.2 1.3L10 11.3l1.4 1.4a.9.9 0 1 0 1.3-1.3L11.3 10l1.4-1.4a.9.9 0 1 0-1.3-1.3L10 8.7 8.6 7.3a.9.9 0 0 0-1.2 0Z" />
    </svg>
  );
}

export function IconCopy({ size = 13, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <rect x="7" y="7" width="9.5" height="9.5" rx="1.8" />
      <path d="M13 5.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v6.5A1.5 1.5 0 0 0 5 13h.5" />
    </svg>
  );
}

export function IconFolder({ size = 13, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.4l1.6 2h7A1.5 1.5 0 0 1 17.5 7.5v6A1.5 1.5 0 0 1 16 15H4a1.5 1.5 0 0 1-1.5-1.5v-8Z" />
    </svg>
  );
}

export function IconBranch({ size = 13, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="6" cy="4.5" r="1.8" />
      <circle cx="6" cy="15.5" r="1.8" />
      <circle cx="14" cy="7.5" r="1.8" />
      <path d="M6 6.3v7.4" />
      <path d="M14 9.3c0 3-2.2 4.4-6 4.6" />
    </svg>
  );
}

export function IconTerminal({ size = 13, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="m6 8 2.2 2L6 12" />
      <path d="M10.5 12.5h3.2" />
    </svg>
  );
}

export function IconPlus({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M10 4v12M4 10h12" />
    </svg>
  );
}

export function IconCheck({ size = 13, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m4 10.5 4 4L16 5.5" />
    </svg>
  );
}

export function IconChevronDown({ size = 12, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 7.5 5 5 5-5" />
    </svg>
  );
}

export function IconDesktop({ size = 13, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="3.5" width="15" height="9.5" rx="1.6" />
      <path d="M7 16.5h6M10 13v3.5" />
    </svg>
  );
}

export function IconCloud({ size = 13, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 15a3.5 3.5 0 0 1-.4-7A4.6 4.6 0 0 1 14.3 7 3.3 3.3 0 0 1 14 15H6Z" />
    </svg>
  );
}

export function IconServer({ size = 13, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="3" width="15" height="5.5" rx="1.4" />
      <rect x="2.5" y="11.5" width="15" height="5.5" rx="1.4" />
      <path d="M5.5 5.7h.01M5.5 14.2h.01" />
    </svg>
  );
}

export function colorStyleFor(seriesColorValue: string): CSSProperties {
  return { background: seriesColorValue };
}
