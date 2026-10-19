// Command line interface for the CCUsage sync server.
//
//   ccusage-server                 start serving (same as: serve)
//   ccusage-server serve           start the HTTP API
//   ccusage-server init            create the account the desktop apps log in with
//   ccusage-server accounts        list accounts in the database
//   ccusage-server --help
//
// Environment: PORT, HOST, CCUSAGE_DB (default <cwd>/data/ccusage.sqlite).
//
// The init command is the guided account setup: it asks for a username and a
// password (twice, hidden when the terminal allows it) and writes the scrypt
// hash into the server database. --username/--password/--reset make it scriptable.

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "./app.js";
import { generateId, hashPassword, verifyPassword } from "./auth.js";
import { SyncStore } from "./store.js";

export type Command = "serve" | "init" | "accounts" | "help";

export interface CliOptions {
  command: Command;
  db: string;
  port: number;
  host: string;
  username?: string;
  password?: string;
  reset: boolean;
}

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";

export function defaultDbPath(): string {
  const fromEnv = process.env.CCUSAGE_DB?.trim();
  if (fromEnv) return fromEnv;
  return resolve(process.cwd(), "data", "ccusage.sqlite");
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("invalid port: " + raw + " (0-65535)");
  }
  return port;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: "serve",
    db: defaultDbPath(),
    port: parsePort(process.env.PORT),
    host: process.env.HOST?.trim() || DEFAULT_HOST,
    reset: false,
  };
  let commandSeen = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error("missing value for " + arg);
      return next;
    };
    if (arg === "--help" || arg === "-h" || arg === "help") {
      options.command = "help";
    } else if (arg === "--db" || arg === "-d") {
      options.db = resolve(value());
    } else if (arg === "--port" || arg === "-p") {
      options.port = parsePort(value());
    } else if (arg === "--host") {
      options.host = value();
    } else if (arg === "--username" || arg === "-u") {
      options.username = value();
    } else if (arg === "--password") {
      options.password = value();
    } else if (arg === "--reset") {
      options.reset = true;
    } else if (!arg.startsWith("-") && !commandSeen) {
      const command = arg === "start" ? "serve" : arg;
      if (command !== "serve" && command !== "init" && command !== "accounts") {
        throw new Error("unknown command: " + arg);
      }
      options.command = command;
      commandSeen = true;
    } else {
      throw new Error("unknown option: " + arg);
    }
  }
  return options;
}

const HELP = [
  "CCUsage 同步服务端 (ccusage-server)",
  "",
  "用法:",
  "  ccusage-server [serve] [--port 8787] [--host 127.0.0.1] [--db <path>]",
  "  ccusage-server init [--username <name>] [--password <pw>] [--reset] [--db <path>]",
  "  ccusage-server accounts [--db <path>]",
  "  ccusage-server --help",
  "",
  "说明:",
  "  serve      启动 HTTP API（默认命令），监听 /api/v1",
  "  init       引导初始化登录账号（用户名 + 两次密码），供桌面 app 连接使用",
  "             --username/--password 可跳过交互；--reset 重置已存在账号的密码",
  "  accounts   列出数据库中的账号",
  "",
  "环境变量:",
  "  CCUSAGE_DB   SQLite 文件路径（默认 <当前目录>/data/ccusage.sqlite）",
  "  PORT         监听端口（默认 8787）",
  "  HOST         绑定地址（默认 127.0.0.1，局域网共享可用 0.0.0.0）",
].join("\n");

interface Prompter {
  text(question: string): Promise<string>;
  password(question: string): Promise<string>;
  close(): void;
}

/**
 * Prompt source for one command. A real terminal gets echo-free password input;
 * piped stdin (scripts, tests, CI) is read up-front line by line so a buffered
 * pipe cannot be lost between questions.
 */
function createPrompter(): Prompter {
  if (!process.stdin.isTTY) {
    const lines = readFileSync(0, "utf8").split(/\r?\n/);
    let index = 0;
    const next = (question: string): Promise<string> => {
      process.stdout.write(question);
      const line = lines[index++] ?? "";
      process.stdout.write("\n");
      return Promise.resolve(line.trim());
    };
    return { text: next, password: next, close: () => {} };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const text = (question: string) => new Promise<string>((resolveAnswer) => {
    rl.question(question, (answer) => resolveAnswer(answer.trim()));
  });
  const password = (question: string) => new Promise<string>((resolveAnswer, reject) => {
    const stdin = process.stdin;
    let value = "";
    rl.pause();
    process.stdout.write(question);
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      rl.resume();
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 0x03) {
          cleanup();
          reject(new Error("cancelled"));
          return;
        }
        if (byte === 0x0d || byte === 0x0a) {
          cleanup();
          resolveAnswer(value);
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          value = value.slice(0, -1);
          continue;
        }
        value += String.fromCharCode(byte);
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
  return { text, password, close: () => rl.close() };
}

async function commandInit(options: CliOptions): Promise<number> {
  const db = options.db;
  if (db !== ":memory:") mkdirSync(dirname(db), { recursive: true });
  const store = new SyncStore(db);
  const prompts = createPrompter();
  try {
    const interactive = options.username === undefined || options.password === undefined;
    console.log("CCUsage 同步服务端 — 账号初始化");
    console.log("数据库: " + db);
    const entered = options.username ?? (await prompts.text("用户名 [admin]: "));
    const username = entered.trim() || "admin";
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) {
      console.error("用户名只能包含字母、数字、点、下划线或连字符（1-64 字符）");
      return 1;
    }
    let password = options.password;
    if (password === undefined) password = await prompts.password("密码（至少 4 位）: ");
    if (password.length < 4) {
      console.error("密码至少 4 位");
      return 1;
    }
    if (interactive) {
      const confirm = await prompts.password("再次输入密码: ");
      if (confirm !== password) {
        console.error("两次输入的密码不一致");
        return 1;
      }
    }
    const existing = store.accountByUsername(username);
    const hashed = hashPassword(password);
    if (existing !== undefined && !options.reset) {
      console.error("账号 " + username + " 已存在；如需重置密码请加 --reset");
      return 1;
    }
    if (existing !== undefined) {
      store.updatePassword(existing.id, hashed.passwordHash, hashed.salt);
      console.log("");
      console.log("已重置账号密码");
      console.log("  用户名: " + username);
    } else {
      const account = store.createAccount({
        id: generateId(), username, passwordHash: hashed.passwordHash, salt: hashed.salt, createdAt: Date.now(),
      });
      if (account === undefined) {
        console.error("创建账号失败（用户名冲突？）");
        return 1;
      }
      console.log("");
      console.log("账号创建成功");
      console.log("  用户名: " + username);
      console.log("  账号 ID: " + account.id);
    }
    console.log("  数据库: " + db);
    console.log("");
    console.log("下一步:");
    console.log("  1. 启动服务端: node ccusage-server.cjs serve" + (options.port === DEFAULT_PORT ? "" : " --port " + options.port));
    console.log("  2. 桌面 app → 设置 → 服务端: 填写 URL http://<主机>:" + options.port + " 和刚才的账号密码");
    return 0;
  } finally {
    prompts.close();
    store.close();
  }
}

function commandAccounts(options: CliOptions): number {
  const store = new SyncStore(options.db);
  try {
    const accounts = store.listAccounts();
    if (accounts.length === 0) {
      console.log("数据库中没有账号，请先运行: ccusage-server init");
      return 0;
    }
    console.log("账号列表 (" + options.db + "):");
    for (const account of accounts) {
      console.log("  " + account.username + "  (创建于 " + new Date(account.createdAt).toLocaleString() + ")");
    }
    return 0;
  } finally {
    store.close();
  }
}

async function commandServe(options: CliOptions): Promise<number> {
  const db = options.db;
  if (db !== ":memory:") mkdirSync(dirname(db), { recursive: true });
  const { app, close } = createServer({ dbPath: db });
  return await new Promise<number>((resolveExit) => {
    const server = app.listen(options.port, options.host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : options.port;
      const printableHost = options.host === "0.0.0.0" || options.host === "::" ? "127.0.0.1" : options.host;
      console.log("[ccusage-server] listening on http://" + printableHost + ":" + actualPort + "/api/v1 (db: " + db + ")");
      if (options.port === 0) console.log("[ccusage-server] actual port: " + actualPort);
    });
    server.on("error", (error) => {
      console.error("[ccusage-server] failed to start:", error);
      close();
      resolveExit(1);
    });
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log("[ccusage-server] " + signal + " received, shutting down");
      const force = setTimeout(() => { close(); process.exit(1); }, 5000);
      force.unref();
      server.close(() => { clearTimeout(force); close(); resolveExit(0); });
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });
}

export async function runCli(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error("[ccusage-server] " + (error instanceof Error ? error.message : String(error)));
    console.error("使用 --help 查看用法");
    return 1;
  }
  switch (options.command) {
    case "help":
      console.log(HELP);
      return 0;
    case "init":
      return commandInit(options);
    case "accounts":
      return commandAccounts(options);
    case "serve":
      return commandServe(options);
  }
}