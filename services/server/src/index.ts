#!/usr/bin/env node
// CCUsage sync server entry point. See cli.ts for commands (serve/init/accounts).
import { runCli } from "./cli.js";

void runCli(process.argv.slice(2)).then((code) => {
  if (code !== 0) process.exitCode = code;
}).catch((error) => {
  console.error("[ccusage-server]", error);
  process.exitCode = 1;
});
