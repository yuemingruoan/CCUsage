# CCUsage 2.0 — 交付状态 (STATUS)

## 需求对照

| 需求 | 实现 | 位置 |
|---|---|---|
| 1. socket 实现 app<->mod 主动刷新 | Unix socket HTTP 桥 + bridge.json（token/pollMs/refreshId）；mod 每 2s tick，app 点刷新 bump refreshId，mod 立即上报；session.measure 即时上报；JSONL 回退 | packages/mod/plugin/hooks/register.ts, apps/desktop/src/main/bridge.ts |
| 2. Node.js + Electron 重写 app/UI（保持风格） | Electron 44 + React 19 + 手写 SVG 图表；中文文案、配色、布局按原 SwiftUI；主窗口/设置/托盘弹窗 | apps/desktop, docs/UI-STYLE.md |
| 3. Node.js+Express 服务端，多设备汇总/反向同步，5h/7d 合并估算 | Express 5 + node:sqlite；账号/设备/token；ingest 去重、pull 其它设备、服务端合并额度；app 在线时用 serverQuota 并显示「含 N 台设备」 | services/server, apps/desktop/src/main/sync.ts |
| 4. 测试数据与验证 | 单元/集成测试 105 个；demo 数据生成器 + 截图脚本；本地真实数据 parity 验证 | packages/*/test, services/server/test, scripts/ |
| 5. 变成 git 仓库 | git init + 分阶段提交；legacy Swift 保留在 legacy/swift 与历史中 | .git |

## 验证结果（2026-10-19 00:40 复查）

- npm install：100 包（electron 44.9.0 / react 19 / express 5 / esbuild / tsx / typescript）。
- npm run build：gen:mod + core(tsc) + server(tsc) + desktop(esbuild 5/5 entries) 全绿。
- npm test：113 tests / 113 pass（core 64、server 42、mod 7）。
- npm run smoke:mod：真实 register.ts + 假 engine + 真 Unix socket 服务，6 次推送 / 1 条回退日志，刷新/measure/refreshId/reportNow/回退全部验证。
- npm run parity：125 files, 48191 requests, 86 sessions, total $6327.55 —— 与原 Swift 版报告逐字节一致（PARITY OK）。
- npm run screenshot：本地起服务端 + 2 设备播种 + Electron 截图；main.png / settings.png / tray.png 均非空（含 2 台设备徽标、服务端额度、设备表）。
- npm run seed-server：demo 账号 demo/demo123 + 2 台设备，/sync 返回对方设备 90 条用量 + 双设备合并 5h 窗口，/health 200。
- 真实数据模式（隔离配置目录）已验证 UI 正常；真实数据与统计明细不随仓库分发。

## 多设备会话标题 / 设备详情（2026-10-19）

- 同步协议新增 SyncSessionMeta：设备 ingest 时随用量上报会话元数据（标题/项目/cwd/起止时间），
  服务端聚合每个对端会话的请求数/tokens/折算金额并在 pull 时返回；
- 会话列表里远端会话显示**真实标题**（如「Studio 渲染管线优化」）与设备名 + 具体时间段，
  不再是重复的「<设备> 的用量」；未定价模型显示「未定价」而不是 $0.00；
- 概览「设备」表可点击进入**设备详情页**：该设备按日期汇总表 + 该设备会话列表（标题/时间段/请求/折算），
  可继续点进会话详情；
- 服务端 sessions 表存储元数据；旧客户端未上报 sessions 时回退到按条目聚合的占位标题；
- 截图新增 screenshots/device.png（demo 数据）。

## 订阅 vs 第三方 API 识别（2026-10-19）

- 新增 core/auth.ts：根据 **缓存 TTL 比例**（订阅写 1h 缓存、API Key/三方中转基本只写 5m）、
  Anthropic 请求 ID 形状、模型名三路信号，判定会话来源为订阅 / 第三方 API / 混合 / 未知；
- 实测分离度：Mac 订阅设备 97.5% 缓存 token 是 1h（89 会话中 84 订阅、1 混合、1 API 型）；
  Windows 三方设备 97.7% 是 5m（180 会话中 133 第三方、4 订阅、41 纯第三方模型）；
- 会话列表 / 会话详情 / 设备详情新增「订阅 / 第三方 API / 混合」徽标；
- 额度窗口（5h / 7d）只统计订阅会话（未知按订阅保守计入，混合会话只剔除第三方请求），
  Windows 上走第三方 API 的 claude-* 请求不再虚增订阅额度；
- authMode 随 SyncSessionMeta 同步到服务端 sessions 表，服务端对旧客户端也可用条目聚合兜底判定；
- 新增 packages/core/test/auth.test.ts（5 个用例）。

## 权威 auth 指纹（mod 上报，2026-10-19）

- 针对「中转商反代官方 Claude，响应内容/模型名/请求 ID/价格全部与订阅一致」的情况：
  仅凭 transcript 无法区分，改用 Claude Code 进程内的权威信号；
- mod 每个 session 读取 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY /
  CLAUDE_CODE_OAUTH_TOKEN 以及合并设置里的 env / apiKeyHelper，随每次 bridge 上报 auth 指纹；
- 应用把指纹作为权威判定覆盖启发式（自定义 BASE_URL 或 API-key/token/helper = 第三方；
  /login managed key + *.anthropic.com = 订阅），持久化到 session-auth.json；
- 指纹随 SessionMeta.authMode 同步；服务端 quota 使用 sessions.auth_mode 覆盖；
- 仍无法区分的极端情况：中转注入 OAuth token 且保持官方 host（此时消耗的是该账号的订阅额度，
  需要比较 oauthAccount 身份才能判定「谁」的订阅，留作下一步）。

## 2.4.1 修复（2026-10-19）

- 修复 2.4.0 启动后首轮扫描报「Cannot read properties of undefined (reading 'size')」：
  AppController 的 authHints 字段在补丁中漏加声明，applyAuthHints 访问 undefined；
  已补上字段，并把启发式 authMode 写回本地会话（之前只有远端会话带分类）。

## 2.4.2 额度口径调整（2026-10-19）

- 额度估算改为按**全部已同步用量**折算（含第三方 API / 中转），不再剔除第三方会话：
  实测 Windows 中转的 claude-* 用量与 CC 上报的 7d 百分比同步上涨，剔除会让限额估算偏低；
- 会话来源徽标仍保留；filterSubscriptionEntries / costBasis 保留可切换口径的能力；
- 清理服务端遗留的两台验证设备（lead-verify-v230），设备数回到 2。

## 打包产物（npm run dist）

- `dist/packages/CCUsage-<version>-mac-arm64.zip`（~122 MB）— macOS .app，electron-packager + ad-hoc codesign（已 `codesign --verify`）；解压后顶层为 CCUsage.app
- `dist/packages/CCUsage-<version>-win-x64.zip`（~152 MB）— Windows portable，PE32+ GUI x86-64 的 CCUsage.exe + resources/app.asar（无 AppleDouble 垃圾文件）
- `dist/server/`（bundle ~1.17 MB）— 单文件 Express+SQLite 服务端 ccusage-server.cjs + start.sh / start.cmd / README / .env.example
- 服务端账号初始化：`./start.sh init` / `node ccusage-server.cjs init`（命令行引导：用户名 + 两次密码，密码不回显；`--username/--password/--reset` 可非交互/重置）
- 服务端 CLI 有 6 个自动化测试（交互 stdin、非交互、重复/重置、accounts、serve+/health+SIGTERM），服务端测试共 39 个

### 打包验证

- 打包后的 macOS app（dist/packages/…/CCUsage.app）以 demo 配置 + 本地种子服务端启动，截图成功（asar、tray 资产、renderer、sync UI 均正常）。
- 打包脚本会先 ad-hoc 签名并校验，再生成 zip；解压后可直接双击运行（非公证，首次可右键打开）。
- Windows 包结构校验：zip 内含 CCUsage.exe / resources/app.asar；本机为 macOS，未执行 .exe。
- 服务端 bundle：init（交互+非交互）→ serve → /health 200 → /login 返回 token，CPU/内存正常。

## 验收步骤

1. npm install && npm run build && npm test（应全绿）
2. npm run seed && npm run screenshot，查看 screenshots/*.png
3. npm run seed-server（终端 1，保持运行） + npm run demo（终端 2）交互体验多设备同步
4. npm start 使用真实 ~/.claude；设置 → 额度 → 更新 CC mod；在 Claude Code 里跑一轮后点 app 刷新，可见 ≤2s 内额度更新

## 已知边界 / 说明

- 演示数据中的 5h/7d 百分比（42%/78%）与限额金额是按 fixture 花费自洽生成的合成值，不代表真实套餐额度。
- 真实模式首次扫描约 1-2s（缓存后更快）；worker_threads 扫描，不阻塞 UI。
- Windows 的 mod 桥使用 TCP loopback（未在 macOS 上验证）；Linux/Windows 托盘标题行为有降级。
- 服务端无 token 过期 / TLS / 反向代理配置，定位为内网自托管。
- observ推保留 30 天；quota 读取 90 天条目 / 14 天观测 / 2 万行上限。
- 额度 tab 的「上报记录」路径来自 app 的 getPaths()；mod 安装路径 = <claudeDir>/skills/ccusage。
- 旧 Swift app 保留在 legacy/swift（不参与构建）；legacy/reference-report.txt 仅保留历史 parity 头（明细已移除）。

## 目录

    packages/core      @ccusage/core：transcript 解析、定价、聚合、额度窗口、SyncClient、mod 源码内嵌
    packages/mod       Claude Code 插件（socket 上报 + JSONL 回退）及测试
    apps/desktop       Electron：main/preload/renderer/tray + esbuild 构建
    services/server    Express 5 + SQLite 同步服务端
    scripts/           gen-mod-source / seed-demo / seed-server / screenshot / parity / mod-bridge-smoke / demo-fixtures
    docs/              ARCHITECTURE / CONTRACTS / UI-STYLE / DEMO / STATUS
    legacy/swift       原 SwiftUI 工程（参考）
## 公网部署（2026-10-19）

- 已按 docs/DEPLOY.md 的步骤在自托管 Linux 服务器上完成一次部署验证（systemd + 反向代理端口放行）；
- 具体主机、端口、账号等信息不记录在仓库中，请以实际部署环境为准。