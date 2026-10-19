# CCUsage

Claude Code 用量统计与订阅额度追踪：读取本地会话记录，计算 API 等值花费、按模型/时间聚合，
追踪 5 小时 / 每周订阅窗口；桌面端为 Electron（macOS / Windows / Linux），附带 Claude Code
mod 与自托管多设备同步服务端。

- **多设备视图**：设备列表可点进设备详情（按日期用量 + 该设备的会话）；远端会话显示真实标题与
  具体时间段，未定价模型标记「未定价」而不是 $0.00。

## 环境要求

| 组件 | 要求 |
|---|---|
| Node.js | >= 22.5（服务端使用 node:sqlite） |
| npm | 随 Node.js 提供 |
| 桌面端平台 | macOS / Windows / Linux |
| 构建依赖 | TypeScript + esbuild（npm 安装）；Electron 44（npm 安装） |
| 打包环境 | macOS 包需在 macOS 构建；Windows 包可在 macOS/Windows 交叉构建 |

## 安装 / 构建 / 测试

```sh
npm install
npm run build            # gen:mod + core + server + desktop
npm test                 # 105 个单元/集成测试
npm run smoke:mod        # mod <-> app socket 端到端冒烟
npm run parity           # 与本机 ~/.claude 的对照报告（可选）
```

## 运行

```sh
npm start                # 桌面 app（读取真实 ~/.claude）
npm run demo             # demo 数据模式
npm run server:init      # 命令行引导创建同步服务端账号
npm run server           # 同步服务端（默认 127.0.0.1:8787）
npm run seed && npm run screenshot   # 生成 demo 数据并截图
```

## 打包

```sh
npm run dist:mac         # -> dist/packages/CCUsage-<version>-mac-arm64.zip（含 .app）
npm run dist:win         # -> dist/packages/CCUsage-<version>-win-x64.zip（含 CCUsage.exe）
npm run dist:server      # -> dist/server/（单文件服务端 + start.sh / start.cmd）
npm run dist             # 以上全部
```

## 服务端部署（环境与步骤）

服务端产物是单个 Node.js 文件，运行环境只需 Node.js >= 22.5；默认监听 127.0.0.1:8787，
数据保存在 SQLite（默认 ./data/ccusage.sqlite）。

```sh
cd dist/server
./start.sh init                     # 命令行引导：用户名 + 两次密码
PORT=8787 HOST=0.0.0.0 ./start.sh   # 对外监听示例
```

环境变量：`CCUSAGE_DB`（数据库路径）、`PORT`（端口）、`HOST`（绑定地址）。

systemd 部署示例（路径按需修改）：

```ini
[Unit]
Description=CCUsage sync server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/ccusage-server
Environment=HOST=0.0.0.0
Environment=PORT=8787
Environment=CCUSAGE_DB=/opt/ccusage-server/data/ccusage.sqlite
ExecStart=/usr/bin/node /opt/ccusage-server/ccusage-server.cjs serve
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

安全提示：服务端是 HTTP 明文，公网部署请置于 nginx/caddy 反向代理后并启用 HTTPS，
并使用强密码；服务端无需也不应把密码写入仓库。

## 文档

- `docs/ARCHITECTURE.md` — 架构与数据流
- `docs/CONTRACTS.md` — 接口/协议契约
- `docs/UI-STYLE.md` — UI 风格
- `docs/DEMO.md` — 演示与验收
- `docs/DEPLOY.md` — 服务端部署指南（通用模板）
- `docs/STATUS.md` — 交付状态与已知边界
- `legacy/swift/` — 原 SwiftUI 实现（参考）
