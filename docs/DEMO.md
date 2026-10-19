# CCUsage 2.0 — 验收 / 演示指南

## 一次性准备

    npm install
    npm run build          # gen:mod + core + server + desktop
    npm test               # core / mod / server 单元测试
    npm run smoke:mod      # mod <-> app socket 端到端冒烟（无需 Electron）
    npm run parity         # TS 扫描器与 Swift 原版报告对齐（本机 ~/.claude）

## 演示 UI（不碰真实 ~/.claude）

    npm run seed           # 生成 demo-data/：6 个会话、多天用量、5h/7d 上报
    npm run screenshot     # 启动本地同步服务 + 两个模拟设备 + Electron，输出：
                           # screenshots/main.png、settings.png、tray.png

截图说明：overview 里可见 5 小时 / 每周额度卡（含「含 2 台设备」徽标）、按时间段折线图、
额度窗口表、按模型表、花费最多的会话、设备表（Demo MacBook / Demo Studio）；
settings.png 是「服务端」标签页（登录状态 + 设备列表）；tray.png 是菜单栏弹窗。

## 交互式演示

    # 终端 1: 同步服务端（Express + SQLite），自动播种 demo 账号/2 台设备
    npm run seed-server

    # 终端 2: demo 模式的桌面 app（已带 demo-data/settings.json，自动连本地服务端）
    npm run demo

真实数据模式：

    npm start              # 读取真实 ~/.claude，自动扫描 / 自动刷新
    npm run server         # 可选：起同步服务端（默认 127.0.0.1:8787），app 设置里登录

## 实时额度链路（mod -> app）

1. app 设置里「安装 CC mod」把 packages/mod/plugin 写入 <claudeDir>/skills/ccusage/；
2. app 在 ~/Library/Application Support/CCUsage/bridge.sock 上监听，并写 bridge.json
   （token / pollMs / refreshId）；
3. Claude Code 会话里的 mod 每 2s 检查 bridge.json：refreshId 变化或 pollMs 到期时
   $.session.usage() 并 POST /report；app 可随时点「刷新」把 refreshId +1，让 mod
   立刻上报；session.measure 事件也会即时上报；
4. app 自身每 60s 扫描 transcript（设置可调），收到上报后立即重算 5h/7d 并把当日用量
   转发给同步服务端；rate-limits.jsonl 作为 app 未运行时的回退日志。

## 多设备同步语义

- 每台设备上报自己的 UsageEntry（按 message.id:requestId 去重）与额度观测；
- 服务端按账号汇总、跨设备去重，并用 buildQuotaSnapshotFromData 计算包含所有设备的
  5h/7d 窗口；
- app 每 30s ingest + pull：拉取其它设备的条目（带 deviceId）合并展示，额度卡优先使用
  服务端计算的快照（显示「含 N 台设备」）；离线时用本地合并结果。
## 打包与部署

    npm run dist:mac      # dist/packages/CCUsage-<version>-mac-arm64.zip
    npm run dist:win      # dist/packages/CCUsage-<version>-win-x64.zip（含 CCUsage.exe）
    npm run dist:server   # dist/server/ 独立服务端

服务端独立部署（只需 Node.js >= 22.5）：

    cd dist/server
    ./start.sh init               # 命令行引导：用户名 + 两次密码（不回显）
    PORT=8787 HOST=0.0.0.0 ./start.sh

Windows: `start.cmd init` / `start.cmd`。app 设置 → 服务端填 http://<主机>:8787 用该账号登录。

macOS 包为本地 ad-hoc 签名；首次打开如被 Gatekeeper 拦截：右键 → 打开。