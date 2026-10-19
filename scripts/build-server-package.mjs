#!/usr/bin/env node
// Builds the standalone sync server package: dist/server/ (single-file bundle + launchers + docs).
import { build } from "esbuild";
import { chmodSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "dist/server");
const outFile = join(outDir, "ccusage-server.cjs");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, "services/server/src/index.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "warning",
});
// esbuild's banner lands after its CJS prologue, so prepend the shebang ourselves.
{
  const body = readFileSync(outFile, "utf8");
  if (!body.startsWith("#!")) writeFileSync(outFile, "#!/usr/bin/env node\n" + body);
}
chmodSync(outFile, 0o755);

writeFileSync(join(outDir, "package.json"), JSON.stringify({
  name: "ccusage-server",
  version,
  private: true,
  description: "CCUsage multi-device usage sync server (Express + SQLite)",
  main: "ccusage-server.cjs",
  engines: { node: ">=22.5.0" },
  scripts: { start: "node ccusage-server.cjs serve", init: "node ccusage-server.cjs init" },
}, null, 2) + "\n");

writeFileSync(join(outDir, "start.sh"), [
  "#!/bin/sh",
  'cd "$(dirname "$0")" || exit 1',
  'exec node ccusage-server.cjs "$@"',
  "",
].join("\n"));
chmodSync(join(outDir, "start.sh"), 0o755);

writeFileSync(join(outDir, "start.cmd"), [
  "@echo off",
  'cd /d "%~dp0"',
  "node ccusage-server.cjs %*",
  "",
].join("\r\n"));

writeFileSync(join(outDir, ".env.example"), [
  "# CCUSAGE_DB=./data/ccusage.sqlite",
  "# PORT=8787",
  "# HOST=127.0.0.1",
  "",
].join("\n"));

const readme = [
  "# CCUsage 同步服务端",
  "",
  "独立构建产物：单文件 ccusage-server.cjs（Express 5 + node:sqlite），需要 Node.js >= 22.5。",
  "",
  "## 1. 初始化账号（命令行引导）",
  "",
  "    ./start.sh init              # macOS / Linux（Windows: start.cmd init）",
  "    node ccusage-server.cjs init # 或直接运行",
  "",
  "按提示输入用户名和两次密码（输入不回显）。也可以非交互：",
  "",
  "    node ccusage-server.cjs init --username admin --password 你的密码",
  "    node ccusage-server.cjs init --username admin --password 新密码 --reset  # 重置密码",
  "",
  "## 2. 启动服务",
  "",
  "    ./start.sh                          # 默认 http://127.0.0.1:8787/api/v1",
  "    PORT=8787 HOST=0.0.0.0 ./start.sh   # 局域网共享",
  "    CCUSAGE_DB=/var/lib/ccusage/server.sqlite ./start.sh",
  "",
  "数据库默认在启动目录的 data/ccusage.sqlite；账号密码只以 scrypt 哈希存储。",
  "",
  "## 3. app 连接",
  "",
  "桌面 app → 设置 → 服务端：服务器 URL 填 http://<主机>:8787，用 init 创建的账号登录。",
  "",
  "## 其他命令",
  "",
  "    node ccusage-server.cjs accounts   # 列出账号",
  "    node ccusage-server.cjs --help",
  "",
  "> 服务端按内网自托管设计，不含 TLS/反向代理；对外暴露请自行加 HTTPS。",
  "",
].join("\n");
writeFileSync(join(outDir, "README.md"), readme);

const bytes = statSync(outFile).size;
console.log("server package ->", outDir);
for (const file of ["ccusage-server.cjs", "start.sh", "start.cmd", "README.md", "package.json", ".env.example"]) {
  console.log("  " + file + "  " + statSync(join(outDir, file)).size + " bytes");
}
console.log("bundle size:", (bytes / 1024 / 1024).toFixed(2), "MB");