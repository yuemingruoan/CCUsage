# CCUsage UI style guide (ported from the SwiftUI app)

Goal: keep the macOS SwiftUI look and Chinese copy. The renderer is plain React + CSS
(no component library) so the styling is fully controllable.

## Typography

- Font stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif`.
- Numbers use `font-variant-numeric: tabular-nums` everywhere a value is shown.
- Sizes: page title 17px/600; section header 17px/600 with 11px secondary subtitle;
  card metric label 11px secondary, metric value 24px/600; body 13px; captions 11px; table 12-13px.

## Colors (same as Swift `SeriesPalette`)

Light / dark pairs:
```
blue    #2A78D6 / #3987E5    orange  #EB6834 / #D95926   aqua   #1BAF7A / #199E70
yellow  #EDA100 / #C98500    magenta #E87BA4 / #D55181   green  #008300 / #008300
violet  #4A3AA7 / #9085E9    red     #E34948 / #E66767   other  tertiary label
```
- App background: system window background (light `#ECECEC`, dark `#1E1E1E` approximately);
  content background slightly lighter/darker.
- Cards/quaternary fill: `rgba(120,120,128,.12)` (light), `rgba(120,120,128,.20)` (dark);
  border-radius 8px; card padding 12-14px.
- Secondary text: `rgba(60,60,67,.6)` light / `rgba(235,235,245,.6)` dark.
- Separators: `rgba(60,60,67,.18)` / `rgba(235,235,245,.16)`.
- Button chrome: macOS-like 6px radius, subtle border; primary = accent blue.
- Theme follows system (`prefers-color-scheme`), with a setting override.

## Window shell

- Main window: min 960x640, default 1200x800.
- `NavigationSplitView` equivalent: left sidebar 260-320px + detail.
- Sidebar: top row "概览" (chart icon); section header "会话 (N)" with a sort menu
  (最近活动 / 金额); session rows: title 13px (1 line), meta caption
  "项目 · 相对时间 · N 子代理", right-aligned USD cost 13px tabular; search field
  placeholder "搜索标题 / 项目 / ID"; bottom status bar caption:
  "125 个记录文件 · 扫描 16.1 秒" / "更新于 00:00:00".
- Toolbar: principal segmented control 今天 / 近 7 天 / 近 30 天 / 全部;
  refresh button (⌘R) with tooltip "重新扫描会话记录（⌘R）".
- Detail: overview or session detail (routing by sidebar selection).

## Components (copy exactly)

- `QuotaCard`: title "5 小时额度" / "每周额度", right caption
  "MM/DD HH:mm 重置 · 还有 3 小时"; three metrics: 已用 (big %, caption "折算 $X"),
  限额（预估）(≈ $X, caption "$cost ÷ N%"), 剩余 (≈ $X, caption projection);
  8px capsule progress bar; color by percentage: <75 blue, <90 orange, >=90 red
  (warning triangle / octagon icon); footnote caption with window range,
  "CC 上报 N%（时间）", "之后的用量按预估限额折算"; when data came from the server,
  add a small badge "含 N 台设备".
- StatTile: label caption, value 20px semibold tabular, optional caption 11px.
- SectionHeader / SectionBar: title + optional subtitle; controls right aligned.
- Sparkline chart: 2px round lines per series; point markers when <= 31 buckets;
  legend top-left chips; hover = vertical rule + tooltip card (date range, per-series
  rows, divider, "合计 · N 次请求"); Y axis labels via format (USD/tokens); empty
  state "该时间范围内没有用量".
- Tables (`Table` equivalent): header 11px secondary, rows 12-13px, hover row
  highlight, columns per Swift tables (see views):
  - 额度窗口: 窗口 / 来源(CC 确认|推断) / 请求 / 会话 / Tokens / 折算金额 / CC 最高 / 预估占比
  - 按模型: 模型(color swatch + "无定价") / 请求 / 输入 / 输出 / 缓存读 / 缓存写 / 折算金额 / 占比
  - 花费最多的会话: 会话 / 项目 / 占比(bar) / 折算金额
  - 设备 (new): 设备名 / 平台 / 最近活跃 / 今日请求 / 今日折算 / 标记（本机）
- Overview order: 订阅额度 (two QuotaCards + mod banner) → 4 StatTiles (折算金额, 请求,
  Tokens, 缓存) → 按时间段 chart (260px) → 额度窗口 table (240px) → 按模型 (150px) →
  花费最多的会话 (300px).
- Session detail: header (title, cwd/branch/version labels, session id + "复制 resume 命令"),
  4 StatTiles (折算金额, CC lastCost when present, Tokens, 时长), 费用构成 grid with bars,
  按时间段 (series picker 按模型 / 主会话/子代理, metric + granularity, chart 240px,
  bucket table 260px), 按模型 table 140px.
- Settings tabs: 通用 / 额度 / 定价 / 服务端 (new).
  - 通用: 会话记录目录 + 选择…/默认; 自动刷新 30 秒/1 分钟/5 分钟/15 分钟; CC 成本记录 path.
  - 额度: 当前套餐; CC mod 状态 + 安装/卸载/更新; 上报记录 "N 条 · path"; 5 小时窗口 picker
    (首条请求开启窗口 / 固定周期滚动); the long caption text from the Swift app.
  - 定价: table 模型 / 输入 / 输出 / 缓存读 / 缓存写 5m / 缓存写 1h / Fast, plus caption.
  - 服务端: 开关、服务器 URL、用户名/密码（登录/注册）、设备名、同步状态
    (在线/离线/错误 + 上次同步时间)、设备列表（名称/平台/最近活跃/本机标记）、
    "立即同步" 按钮.
- Tray popover (400px wide): two compact QuotaCards; "今天折算 $X"; top 5 sessions today
  (title + USD); divider; buttons 打开主窗口 / 刷新 / 退出. Tray title shows
  "5h N%" (or today's USD when no quota), monochrome template icon.
- Chinese copy lists live in the Swift views; reuse them verbatim
  (see `legacy/swift/Sources/CCUsage/*.swift`).
